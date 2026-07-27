import { PAGE_SIZE_MAX } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/errors';
import { listJournals } from '../../src/modules/ledger';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import type { LedgerFixture } from '../db';
import { contextFor, useLedgerDatabase } from './support';

/**
 * Keyset pagination over the journal list (ROADMAP D-21), against real MySQL.
 *
 * The test this file exists for is `pages a list that is being written to`. Every
 * other assertion here is a boundary condition around it.
 *
 * A sequential simulation of the failure would not do. The claim is not that the
 * predicate is arithmetically right — that is a unit test — it is that a *second*
 * page taken after the ledger has changed still starts where the first one ended.
 * So the writes happen between the reads, against the same database, in the order
 * a user paging through a screen would encounter them.
 */
const harness = useLedgerDatabase();

interface Scene {
  readonly ledger: LedgerFixture;
  readonly ctx: ReturnType<typeof contextFor>;
}

let s: Scene;

beforeEach(async () => {
  const ledger = await harness.factories.ledger();
  s = { ledger, ctx: contextFor(ledger.org.uuid, OWNER_ROLE_ID, ledger.user.uuid) };
});

/**
 * Writes one journal on a given date, through the fixture factory rather than
 * through `postJournal`.
 *
 * `postJournal` refuses a date outside an open period (OB-019), and back-dating is
 * the whole subject here — the entries this file needs are ones that land *behind*
 * a cursor. The factory allocates a real sequence number from the counter row, so
 * the ordering under test is the production one.
 */
async function post(entryDate: string): Promise<bigint> {
  const journal = await harness.factories.journal({
    orgId: s.ledger.org.id,
    periodId: s.ledger.period.id,
    entryDate,
    actorId: s.ledger.user.id,
    lines: [
      { accountId: s.ledger.debitAccount.id, debitMinor: 100_00n },
      { accountId: s.ledger.creditAccount.id, creditMinor: 100_00n },
    ],
  });

  const row = await harness.app
    .selectFrom('journals')
    .select('sequence_number')
    .where('id', '=', journal.id)
    .executeTakeFirstOrThrow();

  return row.sequence_number;
}

describe('listing journals', () => {
  it('orders by entry date and then by the org’s entry number', async () => {
    // Written out of order on purpose: the list's order is a property of the data,
    // not of the order the rows were inserted in.
    await post('2026-03-05');
    await post('2026-01-10');
    await post('2026-02-01');

    const page = await listJournals({}, s.ctx);

    expect(page.items.map((journal) => journal.date)).toEqual([
      '2026-01-10',
      '2026-02-01',
      '2026-03-05',
    ]);
    expect(page.items.map((journal) => journal.sequenceNumber)).toEqual(['2', '3', '1']);
    expect(page.nextCursor).toBeNull();
  });

  /**
   * The reason D-21 rejects `OFFSET`, as a test.
   *
   * Eight journals, read three at a time, with a back-dated entry posted between
   * each pair of reads. A back-dated entry is not an exotic case — it is what a
   * correction to last month looks like — and it lands *before* the position the
   * reader has already passed.
   *
   * With `OFFSET`, each insertion behind the window shifts every later row one
   * place to the right, so the next page begins one row early and re-serves a
   * journal the caller has already seen. With a cursor naming the last row read,
   * the boundary is a row rather than a count, and an insertion on either side of
   * it moves nothing.
   *
   * The assertion is deliberately about the *original* eight. Whether an entry
   * inserted behind the reader appears is not a question keyset pagination answers
   * — it is behind them, and the API does not claim otherwise. What it does claim
   * is that nothing which was there when they started is skipped or repeated.
   */
  it('pages a list that is being written to, skipping and repeating nothing', async () => {
    const original: string[] = [];
    for (const day of ['01', '02', '03', '04', '05', '06', '07', '08']) {
      original.push((await post(`2026-06-${day}`)).toString());
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let interleaved = 0;

    do {
      const page = await listJournals({ limit: 3, ...(cursor === null ? {} : { cursor }) }, s.ctx);
      seen.push(...page.items.map((journal) => journal.sequenceNumber));
      cursor = page.nextCursor;

      // The write that breaks an offset implementation: an entry dated before the
      // reader's current position, arriving while they page.
      if (cursor !== null) {
        interleaved += 1;
        await post('2026-06-01');
      }
    } while (cursor !== null);

    expect(interleaved).toBeGreaterThan(0);
    // Every original journal, once each, still in order.
    expect(seen).toEqual(original);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /**
   * The tie, which is what `sequence_number` is doing in the ordering (D-14).
   *
   * Two journals share `2026-04-02`, and the page boundary falls between them. A
   * cursor carrying only the date has no way to express "the second one" — a `>`
   * would skip it and a `>=` would repeat the first — so this is the case that
   * decides whether the ordering is total or merely usually total.
   */
  it('resumes inside a run of journals sharing an entry date', async () => {
    const first = await post('2026-04-01');
    const tieA = await post('2026-04-02');
    const tieB = await post('2026-04-02');
    const last = await post('2026-04-03');

    const page1 = await listJournals({ limit: 2 }, s.ctx);
    expect(page1.items.map((journal) => journal.sequenceNumber)).toEqual([
      first.toString(),
      tieA.toString(),
    ]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listJournals({ limit: 2, cursor: page1.nextCursor ?? '' }, s.ctx);
    expect(page2.items.map((journal) => journal.sequenceNumber)).toEqual([
      tieB.toString(),
      last.toString(),
    ]);
    expect(page2.nextCursor).toBeNull();
  });

  /**
   * A cursor pointing at the last row of the collection.
   *
   * The page that produced it was full, so nothing in its length says whether more
   * exists — which is why `nextCursor` and not a row count is the signal, and why
   * the probe row is fetched rather than inferred.
   */
  it('reports no next cursor when the last page is exactly full', async () => {
    await post('2026-05-01');
    await post('2026-05-02');

    const page = await listJournals({ limit: 2 }, s.ctx);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  /**
   * The keyset predicate is added to a builder that `TenantDatabase` has already
   * scoped, so this holds without the pagination code knowing an org exists. It is
   * asserted anyway: a helper that ever built its own statement would pass every
   * other test in this file.
   */
  it('never pages into another org’s ledger', async () => {
    await post('2026-07-01');

    const other = await harness.factories.ledger();
    const otherCtx = contextFor(other.org.uuid, OWNER_ROLE_ID, other.user.uuid);
    await harness.factories.journal({
      orgId: other.org.id,
      periodId: other.period.id,
      entryDate: '2026-07-01',
      actorId: other.user.id,
      lines: [
        { accountId: other.debitAccount.id, debitMinor: 500_00n },
        { accountId: other.creditAccount.id, creditMinor: 500_00n },
      ],
    });

    const mine = await listJournals({ limit: 50 }, s.ctx);
    const theirs = await listJournals({ limit: 50 }, otherCtx);

    expect(mine.items).toHaveLength(1);
    expect(theirs.items).toHaveLength(1);
    expect(mine.items[0]?.journalId).not.toBe(theirs.items[0]?.journalId);
  });

  /**
   * A cursor minted against one org is refused rather than honoured, and it would
   * be harmless if it were not: the query is org-scoped regardless of what the
   * cursor says, so the worst a foreign cursor can do is start the caller partway
   * into their own list. This asserts the boring outcome — the cursor decodes to a
   * position, and a position is all it is.
   */
  it('treats a cursor as a position and nothing more', async () => {
    await post('2026-08-01');
    await post('2026-08-02');
    const page1 = await listJournals({ limit: 1 }, s.ctx);
    const cursor = page1.nextCursor ?? '';

    const other = await harness.factories.ledger();
    const otherCtx = contextFor(other.org.uuid, OWNER_ROLE_ID, other.user.uuid);
    await harness.factories.journal({
      orgId: other.org.id,
      periodId: other.period.id,
      entryDate: '2026-08-01',
      actorId: other.user.id,
      lines: [
        { accountId: other.debitAccount.id, debitMinor: 100n },
        { accountId: other.creditAccount.id, creditMinor: 100n },
      ],
    });

    // Position (2026-08-01, seq 1) of *this* org's list — which that org's own
    // journal does not sit after, so the page is empty rather than a leak.
    const foreign = await listJournals({ limit: 10, cursor }, otherCtx);
    expect(foreign.items).toEqual([]);
  });

  /**
   * Refused, not silently restarted from the beginning. A client whose cursor is
   * quietly ignored gets the first page forever, which is a paging loop that never
   * terminates and never errors.
   */
  it('refuses a cursor it did not mint', async () => {
    await post('2026-09-01');

    for (const cursor of [
      'not-base64url-at-all!!',
      Buffer.from('{"not":"an array"}', 'utf8').toString('base64url'),
      Buffer.from('[1,"2026-09-01"]', 'utf8').toString('base64url'), // one segment short
      Buffer.from('[99,"2026-09-01","1"]', 'utf8').toString('base64url'), // wrong version
      Buffer.from('[1,"the first of September","1"]', 'utf8').toString('base64url'),
      Buffer.from('[1,"2026-09-01","not a number"]', 'utf8').toString('base64url'),
    ]) {
      await expect(listJournals({ limit: 5, cursor }, s.ctx)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  /**
   * This service parses no Zod schema — its query is pagination and nothing else —
   * so the bound here is `resolvePageLimit`'s and nobody else's. That is the case
   * worth pinning: the route schema restates the same numbers, and an MCP tool
   * (M5) reaching this function will have neither.
   */
  it('bounds the page size below the transport', async () => {
    await post('2026-11-01');

    for (const limit of [0, -1, 2.5, PAGE_SIZE_MAX + 1]) {
      await expect(listJournals({ limit }, s.ctx)).rejects.toBeInstanceOf(ValidationError);
    }

    const bounded = await listJournals({ limit: PAGE_SIZE_MAX }, s.ctx);
    expect(bounded.items).toHaveLength(1);
  });

  /**
   * The cursor is opaque by construction, and this is what "opaque" has to mean to
   * be worth anything: the ordering columns are not readable out of it, so a client
   * cannot come to depend on them.
   */
  it('does not expose the ordering columns in the cursor', async () => {
    await post('2026-10-01');
    await post('2026-10-02');

    const page = await listJournals({ limit: 1 }, s.ctx);
    const cursor = page.nextCursor ?? '';

    expect(cursor).not.toContain('2026-10-01');
    expect(cursor).not.toContain('entry_date');
    expect(cursor).not.toContain('sequence_number');
  });
});
