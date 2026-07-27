import { PAGE_SIZE_MAX } from '@openbooks/shared-types';
import type { Account, CreateAccountRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/errors';
import { createAccount, deleteAccount, listAccounts } from '../../src/modules/accounts';
import type { RequestContext } from '../../src/context';
import { actorIn, useServiceDatabase } from './support';

/**
 * The list envelope and keyset pagination, on the chart of accounts (D-21, D-27).
 *
 * The ledger suite holds the case this convention was chosen for — paging while
 * entries are posted, including back-dated ones. What this file adds is the other
 * direction, which the ledger cannot produce because journals are never deleted: a
 * row *disappearing* from behind the reader. An account with no postings can be
 * hard-deleted, so the chart of accounts is where "the rows behind you move" is
 * reachable at all.
 *
 * The ordering is `(code, id)`, which is only safe because D-27 fixed an account's
 * code at creation. Nothing here stamps `created_at` any more: OB-031's ordering
 * needed that, because two accounts created in one millisecond came back in an
 * order no assertion could predict, and `code` is unique within an org by
 * construction.
 */
const db = useServiceDatabase();

const ACCOUNT: CreateAccountRequest = {
  code: '1000',
  name: 'Operating bank account',
  type: 'asset',
  normalBalance: 'debit',
};

/** `count` accounts, created in descending code order so the list has to sort them. */
async function chartOf(count: number, ctx: RequestContext): Promise<readonly Account[]> {
  const created: Account[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    created.unshift(
      await createAccount(
        { ...ACCOUNT, code: `${String(1000 + index)}`, name: `Account ${String(index)}` },
        ctx,
      ),
    );
  }

  return created;
}

describe('paginating the chart of accounts', () => {
  it('returns items and a cursor, and pages the whole list exactly once', async () => {
    const actor = await actorIn(db);
    const created = await chartOf(5, actor.ctx);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = await listAccounts(
        { limit: 2, ...(cursor === null ? {} : { cursor }) },
        actor.ctx,
      );
      seen.push(...page.items.map((account) => account.code));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(created.map((account) => account.code));
  });

  /**
   * The `OFFSET` failure in its other form.
   *
   * The reader has taken the first two accounts; one of them is then deleted. Under
   * `OFFSET 2` the third account has moved into position 2 and the next page starts
   * at position 3, so it is never returned — a row silently absent from a list, with
   * nothing in the response to say so. The cursor names the last row read, so the
   * deletion of a row before it changes nothing about where the next page begins.
   */
  it('skips nothing when a row behind the cursor is deleted', async () => {
    const actor = await actorIn(db);
    const created = await chartOf(6, actor.ctx);

    const page1 = await listAccounts({ limit: 2 }, actor.ctx);
    expect(page1.items.map((account) => account.code)).toEqual(['1000', '1001']);

    // An account with no postings deletes freely — see `deleteAccount`.
    await deleteAccount(created[0]?.id ?? '', actor.ctx);

    const page2 = await listAccounts({ limit: 2, cursor: page1.nextCursor ?? '' }, actor.ctx);
    expect(page2.items.map((account) => account.code)).toEqual(['1002', '1003']);

    const page3 = await listAccounts({ limit: 2, cursor: page2.nextCursor ?? '' }, actor.ctx);
    expect(page3.items.map((account) => account.code)).toEqual(['1004', '1005']);
    expect(page3.nextCursor).toBeNull();
  });

  /**
   * The failure D-27 exists to remove, asserted as absent rather than argued.
   *
   * Under the M1 contract this test could not be written. Renaming `1002` to `0500`
   * after page one had passed it moved the row *behind* the cursor, so it appeared
   * on no page at all — a row silently missing from a chart of accounts, which is
   * the outcome keyset pagination was chosen to prevent. The renaming operation no
   * longer exists, so the only way a row can arrive behind the reader is a fresh
   * insert, and an insert behind the cursor is correctly not on any later page: it
   * was not in the list when the reader passed that position.
   *
   * The distinction is the whole of D-27. A row that was never seen because it did
   * not exist yet is a consistent answer; the same row disappearing after it was
   * renamed is a lost account.
   */
  it('does not lose a row when accounts are inserted behind the cursor', async () => {
    const actor = await actorIn(db);
    const created = await chartOf(4, actor.ctx);

    const seen: string[] = [];
    let cursor: string | null = null;
    let inserted = 0;

    do {
      const page = await listAccounts(
        { limit: 2, ...(cursor === null ? {} : { cursor }) },
        actor.ctx,
      );
      seen.push(...page.items.map((account) => account.code));
      cursor = page.nextCursor;

      inserted += 1;
      await createAccount({ ...ACCOUNT, code: `0${String(500 + inserted)}` }, actor.ctx);
    } while (cursor !== null);

    expect(seen).toEqual(created.map((account) => account.code));

    // Deferred, not lost: a reader starting now sees every one of them.
    const complete = await listAccounts({ limit: 50 }, actor.ctx);
    expect(complete.items).toHaveLength(created.length + inserted);
  });

  /**
   * A cursor is a position in *this* query, filters included. A page of assets has
   * to end where the next page of assets begins — not where the unfiltered list
   * happened to be — which is why the predicate is added after the filters rather
   * than to a separate query.
   */
  it('carries the filters across a page boundary', async () => {
    const actor = await actorIn(db);
    const assets = await chartOf(2, actor.ctx);
    // Sorts between the two assets by code, so a page boundary that ignored the
    // filter would land on it.
    await createAccount(
      { code: '1000a', name: 'Sales', type: 'revenue', normalBalance: 'credit' },
      actor.ctx,
    );

    const page1 = await listAccounts({ limit: 1, type: 'asset' }, actor.ctx);
    expect(page1.items.map((account) => account.id)).toEqual([assets[0]?.id]);

    const page2 = await listAccounts(
      { limit: 1, type: 'asset', cursor: page1.nextCursor ?? '' },
      actor.ctx,
    );
    expect(page2.items.map((account) => account.id)).toEqual([assets[1]?.id]);
    expect(page2.nextCursor).toBeNull();
  });

  /**
   * Over the bound is refused rather than clamped: a caller who asked for 1,000 and
   * got 200 with no `nextCursor` could not tell a truncated answer from a complete
   * one. The bound is enforced below the transport, because an MCP tool reaching
   * the same service has no route schema in front of it (spec §12).
   */
  it('refuses a page size outside the bound', async () => {
    const actor = await actorIn(db);

    for (const limit of [0, -1, 1.5, PAGE_SIZE_MAX + 1, Number.NaN]) {
      await expect(listAccounts({ limit }, actor.ctx)).rejects.toBeInstanceOf(ValidationError);
    }

    await expect(listAccounts({ limit: PAGE_SIZE_MAX }, actor.ctx)).resolves.toBeDefined();
  });

  it('refuses a malformed cursor instead of restarting the list', async () => {
    const actor = await actorIn(db);
    await chartOf(2, actor.ctx);

    await expect(listAccounts({ cursor: 'nonsense' }, actor.ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  /**
   * A journal cursor has the same arity as an account cursor and entirely different
   * columns. It decodes, and then the column codecs refuse it — which is the reason
   * each column carries its own decoder rather than the tuple being parsed as
   * strings and handed to the driver.
   *
   * `'7'` is a plausible `code` and an impossible `id`, so this is refused by the
   * second column. That is the interesting direction: an ordering whose columns
   * were all text would accept another list's cursor and answer from the wrong
   * position rather than refusing.
   */
  it('refuses a cursor minted for a different list', async () => {
    const actor = await actorIn(db);
    await chartOf(2, actor.ctx);

    const journalShaped = Buffer.from('[1,"2026-01-01","7"]', 'utf8').toString('base64url');

    await expect(listAccounts({ cursor: journalShaped }, actor.ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  /**
   * A cursor segment longer than the column can hold did not come from a row of
   * this table, so it is a malformed cursor rather than a query that matches
   * nothing — the distinction `textKey` exists to make.
   */
  it('refuses a cursor carrying a code the column could not store', async () => {
    const actor = await actorIn(db);
    await chartOf(2, actor.ctx);

    const oversized = Buffer.from(
      JSON.stringify([1, 'x'.repeat(64), '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607']),
      'utf8',
    ).toString('base64url');

    await expect(listAccounts({ cursor: oversized }, actor.ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
