import { beforeEach, describe, expect, it } from 'vitest';

import { uuidToBuffer } from '../../src/db';
import { toWireError } from '../../src/errors';
import { getTrialBalance, postJournal, reverseJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { contextFor, useLedgerDatabase, withContext } from './support';

/**
 * The ledger kernel: acceptance A2, A3, A4, and the reversal model (D-02).
 *
 * A1 ("post a manual balanced journal via REST") needs the route surface and belongs
 * to OB-023/OB-026; everything here is the service the route will call. A9 (posting
 * racing a period lock) needs two real connections and belongs to OB-026, which the
 * harness's `openAppConnection` exists for.
 */
const harness = useLedgerDatabase();

interface Scene {
  readonly ctx: ReturnType<typeof contextFor>;
  readonly cash: string;
  readonly revenue: string;
  readonly date: string;
  readonly orgUuid: string;
}

async function scene(): Promise<Scene> {
  const ledger = await harness.factories.ledger();
  return {
    ctx: contextFor(ledger.org.uuid, OWNER_ROLE_ID, ledger.user.uuid),
    cash: ledger.debitAccount.uuid,
    revenue: ledger.creditAccount.uuid,
    date: ledger.period.startDate,
    orgUuid: ledger.org.uuid,
  };
}

let s: Scene;
beforeEach(async () => {
  s = await scene();
});

const balanced = (s: Scene, amount = 150000n) => ({
  date: s.date,
  memo: 'Sale',
  actorType: 'user' as const,
  actorId: s.ctx.actorId,
  lines: [
    { accountId: s.cash, side: 'debit' as const, amount },
    { accountId: s.revenue, side: 'credit' as const, amount },
  ],
});

describe('posting a balanced journal', () => {
  it('stores it and reports what the database accepted', async () => {
    const posted = await withContext(s.ctx, () => postJournal(balanced(s)));

    expect(posted.journalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted.date).toBe(s.date);
    expect(posted.memo).toBe('Sale');
    expect(posted.actorType).toBe('user');
    expect(posted.invocationMode).toBeNull();
    expect(posted.reversesJournalId).toBeNull();
    expect(posted.lines).toHaveLength(2);

    // The side is read back from which column is non-zero, so this asserts the
    // {side, amount} contract actually mapped onto the two-column table correctly.
    const debit = posted.lines.find((line) => line.side === 'debit');
    const credit = posted.lines.find((line) => line.side === 'credit');
    expect(debit?.accountId).toBe(s.cash);
    expect(debit?.amount).toBe(150000n);
    expect(credit?.accountId).toBe(s.revenue);
    expect(credit?.amount).toBe(150000n);
  });

  it('allocates gapless, monotonic sequence numbers per org (D-14)', async () => {
    await withContext(s.ctx, () => postJournal(balanced(s, 100n)));
    await withContext(s.ctx, () => postJournal(balanced(s, 200n)));
    await withContext(s.ctx, () => postJournal(balanced(s, 300n)));

    const rows = await harness.app
      .selectFrom('journals')
      .select('sequence_number')
      .where('org_id', '=', uuidToBuffer(s.orgUuid))
      .orderBy('sequence_number')
      .execute();

    // Gapless is the property that matters: a hole is indistinguishable from a
    // deleted entry, which is what the append-only design exists to rule out.
    expect(rows.map((r) => r.sequence_number)).toEqual([1n, 2n, 3n]);
  });

  it('numbers sequences independently in each org', async () => {
    const other = await scene();
    await withContext(s.ctx, () => postJournal(balanced(s)));
    const second = await withContext(other.ctx, () => postJournal(balanced(other)));

    // A per-org counter, not a global one — an org's first journal is #1 regardless
    // of what any other org has done.
    const row = await harness.app
      .selectFrom('journals')
      .select('sequence_number')
      .where('id', '=', uuidToBuffer(second.journalId))
      .executeTakeFirstOrThrow();
    expect(row.sequence_number).toBe(1n);
  });

  it('accepts a many-line journal so long as it balances', async () => {
    const posted = await withContext(s.ctx, () =>
      postJournal({
        ...balanced(s),
        lines: [
          { accountId: s.cash, side: 'debit', amount: 60000n },
          { accountId: s.cash, side: 'debit', amount: 40000n },
          { accountId: s.revenue, side: 'credit', amount: 100000n },
        ],
      }),
    );
    expect(posted.lines).toHaveLength(3);
  });
});

describe('unbalanced and malformed postings are rejected (A3)', () => {
  it('rejects debits that do not equal credits, naming both totals', async () => {
    const error = await withContext(s.ctx, () =>
      postJournal({
        ...balanced(s),
        lines: [
          { accountId: s.cash, side: 'debit', amount: 150000n },
          { accountId: s.revenue, side: 'credit', amount: 149999n },
        ],
      }),
    ).catch((e: unknown) => toWireError(e));

    expect(error).toMatchObject({ code: 'validation_failed', status: 400 });
    // A one-cent imbalance must be rejected as firmly as a large one: in minor units
    // there is nothing for a tolerance to absorb, so there is no tolerance.
    expect(JSON.stringify(error)).toContain('149999');
  });

  it('rejects a single-line journal', async () => {
    await expect(
      withContext(s.ctx, () =>
        postJournal({
          ...balanced(s),
          lines: [{ accountId: s.cash, side: 'debit', amount: 1n }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects a zero or negative amount rather than reinterpreting the side', async () => {
    for (const amount of [0n, -1n]) {
      await expect(
        withContext(s.ctx, () =>
          postJournal({
            ...balanced(s),
            lines: [
              { accountId: s.cash, side: 'debit', amount },
              { accountId: s.revenue, side: 'credit', amount },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });

  it('rejects a journal that balances at zero', async () => {
    // Both sides equal and both zero is arithmetically balanced and financially
    // meaningless.
    await expect(
      withContext(s.ctx, () =>
        postJournal({
          ...balanced(s),
          lines: [
            { accountId: s.cash, side: 'debit', amount: 0n },
            { accountId: s.revenue, side: 'credit', amount: 0n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('writes nothing when validation fails', async () => {
    await withContext(s.ctx, () =>
      postJournal({
        ...balanced(s),
        lines: [
          { accountId: s.cash, side: 'debit', amount: 5n },
          { accountId: s.revenue, side: 'credit', amount: 4n },
        ],
      }),
    ).catch(() => undefined);

    const count = await harness.app
      .selectFrom('journals')
      .select(harness.app.fn.countAll().as('n'))
      .where('org_id', '=', uuidToBuffer(s.orgUuid))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });
});

describe('accounts must be postable', () => {
  it('treats an unknown account as not found', async () => {
    await expect(
      withContext(s.ctx, () =>
        postJournal({
          ...balanced(s),
          lines: [
            { accountId: '11111111-1111-4111-8111-111111111111', side: 'debit', amount: 1n },
            { accountId: s.revenue, side: 'credit', amount: 1n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('makes another org’s account indistinguishable from a nonexistent one (A7)', async () => {
    const other = await scene();

    const foreign = await withContext(s.ctx, () =>
      postJournal({
        ...balanced(s),
        lines: [
          { accountId: other.cash, side: 'debit', amount: 1n },
          { accountId: s.revenue, side: 'credit', amount: 1n },
        ],
      }),
    ).catch((e: unknown) => JSON.stringify(toWireError(e)));

    const unknown = await withContext(s.ctx, () =>
      postJournal({
        ...balanced(s),
        lines: [
          { accountId: '22222222-2222-4222-8222-222222222222', side: 'debit', amount: 1n },
          { accountId: s.revenue, side: 'credit', amount: 1n },
        ],
      }),
    ).catch((e: unknown) => JSON.stringify(toWireError(e)));

    // Byte-identical, and neither mentions the other org's account id.
    expect(foreign).toBe(unknown);
    expect(foreign).not.toContain(other.cash);
  });

  it('refuses a deactivated account', async () => {
    await harness.app
      .updateTable('accounts')
      .set({ is_active: 0 })
      .where('id', '=', uuidToBuffer(s.cash))
      .execute();

    await expect(withContext(s.ctx, () => postJournal(balanced(s)))).rejects.toMatchObject({
      code: 'precondition_failed',
      status: 412,
    });
  });
});

describe('period gating (A4)', () => {
  it('rejects a posting into a closed period', async () => {
    // Closed directly rather than through the periods service: this asserts the
    // posting path's reaction to a closed period, and routing through another
    // service's permission checks would make a failure ambiguous.
    await harness.app
      .updateTable('fiscal_periods')
      .set({ status: 'closed', closed_at: new Date() })
      .where('org_id', '=', uuidToBuffer(s.orgUuid))
      .execute();

    await expect(withContext(s.ctx, () => postJournal(balanced(s)))).rejects.toMatchObject({
      code: 'precondition_failed',
      status: 412,
    });
  });

  it('rejects a date no period covers', async () => {
    await expect(
      withContext(s.ctx, () => postJournal({ ...balanced(s), date: '1999-01-01' })),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });
});

describe('reversal (D-02)', () => {
  it('posts a new journal with inverted sides and never touches the original', async () => {
    const original = await withContext(s.ctx, () => postJournal(balanced(s)));

    const reversal = await withContext(s.ctx, () =>
      reverseJournal({
        journalId: original.journalId,
        date: s.date,
        actorType: 'user',
        actorId: s.ctx.actorId,
      }),
    );

    expect(reversal.journalId).not.toBe(original.journalId);
    expect(reversal.reversesJournalId).toBe(original.journalId);

    const reversedDebit = reversal.lines.find((line) => line.side === 'debit');
    // The original debited cash; the reversal credits it.
    expect(reversedDebit?.accountId).toBe(s.revenue);
    expect(reversal.lines.find((line) => line.side === 'credit')?.accountId).toBe(s.cash);

    // The original is byte-for-byte as posted — immutability is not "we don't", it is
    // "we cannot" (the app user holds no UPDATE grant).
    const stored = await harness.app
      .selectFrom('journals')
      .selectAll()
      .where('id', '=', uuidToBuffer(original.journalId))
      .executeTakeFirstOrThrow();
    expect(stored.memo).toBe('Sale');
    expect(stored.reverses_journal_id).toBeNull();
  });

  it('nets to zero per account, which is the point of a reversal', async () => {
    const original = await withContext(s.ctx, () => postJournal(balanced(s)));
    await withContext(s.ctx, () =>
      reverseJournal({
        journalId: original.journalId,
        date: s.date,
        actorType: 'user',
        actorId: s.ctx.actorId,
      }),
    );

    const tb = await withContext(s.ctx, () => getTrialBalance());
    for (const row of tb.rows) {
      expect(row.balance).toBe('0');
    }
    expect(tb.difference).toBe('0');
  });

  it('refuses a second reversal of the same journal', async () => {
    const original = await withContext(s.ctx, () => postJournal(balanced(s)));
    const reverse = () =>
      withContext(s.ctx, () =>
        reverseJournal({
          journalId: original.journalId,
          date: s.date,
          actorType: 'user',
          actorId: s.ctx.actorId,
        }),
      );

    await reverse();
    await expect(reverse()).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it('treats another org’s journal as not found', async () => {
    const other = await scene();
    const theirs = await withContext(other.ctx, () => postJournal(balanced(other)));

    await expect(
      withContext(s.ctx, () =>
        reverseJournal({
          journalId: theirs.journalId,
          date: s.date,
          actorType: 'user',
          actorId: s.ctx.actorId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('trial balance (A2)', () => {
  it('balances, and lists accounts with no postings', async () => {
    await withContext(s.ctx, () => postJournal(balanced(s, 150000n)));
    await withContext(s.ctx, () => postJournal(balanced(s, 25000n)));

    const tb = await withContext(s.ctx, () => getTrialBalance());

    expect(tb.totalDebits).toBe('175000');
    expect(tb.totalCredits).toBe('175000');
    expect(tb.difference).toBe('0');

    // Both accounts appear even though the report is driven by accounts, not lines.
    expect(tb.rows.map((row) => row.accountId).sort()).toEqual([s.cash, s.revenue].sort());
  });

  it('is exact well beyond the range a double could represent', async () => {
    // The reason money is bigint end to end and a string on the wire.
    const huge = 9007199254740993n;
    await withContext(s.ctx, () => postJournal(balanced(s, huge)));

    const tb = await withContext(s.ctx, () => getTrialBalance());
    expect(tb.totalDebits).toBe(huge.toString());
    expect(tb.difference).toBe('0');
  });

  it('excludes postings after the asOf date', async () => {
    await withContext(s.ctx, () => postJournal(balanced(s, 1000n)));

    const before = await withContext(s.ctx, () => getTrialBalance({ asOf: '1999-12-31' }));
    expect(before.totalDebits).toBe('0');
    // Accounts still listed, with zeros — an asOf window must not hide the chart.
    expect(before.rows.length).toBeGreaterThan(0);

    const after = await withContext(s.ctx, () => getTrialBalance({ asOf: s.date }));
    expect(after.totalDebits).toBe('1000');
  });

  it('never reports another org’s postings', async () => {
    const other = await scene();
    await withContext(other.ctx, () => postJournal(balanced(other, 999n)));

    const tb = await withContext(s.ctx, () => getTrialBalance());
    expect(tb.totalDebits).toBe('0');
  });
});
