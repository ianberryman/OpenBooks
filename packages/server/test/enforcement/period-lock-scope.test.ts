import { describe, expect, it } from 'vitest';

import { runInContext } from '../../src/context';
import { createContact } from '../../src/modules/contacts';
import {
  createDimension,
  createDimensionValue,
  getJournalLineDimensions,
  setJournalLineDimensions,
} from '../../src/modules/dimensions';
import { getTrialBalance, postJournal, reverseJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { closePeriod } from '../../src/modules/periods';
import { getAccountBalances, getProfitAndLoss } from '../../src/modules/reports';
import { SYSTEM_ROLE_UUIDS } from '../db';
import { useServiceDatabase } from '../permissions/support';
import { contextFor } from './support';

/**
 * **D-32 — a closed period does not stop a retag, and still stops a posting.**
 *
 * Both halves, because each is only meaningful with the other. A period lock that
 * refused everything would satisfy "still blocks a posting" and destroy the case
 * D-32 was decided for; one that refused nothing would satisfy "does not block a
 * retag" and silently make A4 false. `setJournalLineDimensions` deliberately does
 * not call `assertPostable` — which is a deliberate *absence*, and an absence is
 * exactly the kind of thing a later edit adds back "for consistency" with no test
 * to say why it was missing.
 *
 * The third assertion is the argument itself rather than the behaviour. D-32's
 * reasoning is that a tag is not part of what the books say — "the trial balance,
 * the P&L, the balance sheet, every account total, and the entry itself" are
 * unchanged by a retag, and only how a *sliced* report divides an unchanged total
 * moves. That is a checkable claim, so it is checked: the same reports are read
 * before and after the retag and compared whole.
 */
const db = useServiceDatabase();

const CLOSED_MONTH = { start: '2026-03-01', end: '2026-03-31' };
const ENTRY_DATE = '2026-03-15';

interface Scene {
  readonly ctx: ReturnType<typeof contextFor>;
  readonly cashId: string;
  readonly revenueId: string;
  readonly journalId: string;
  readonly lineId: string;
  readonly north: string;
  readonly south: string;
  readonly dimensionId: string;
  readonly actorId: string;
  readonly orgUuid: string;
  readonly userId: string;
}

/** One org with a posting inside a period that is then closed. */
async function closedPeriodScene(): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id });

  const period = await db.factories.fiscalPeriod({
    orgId: org.id,
    startDate: CLOSED_MONTH.start,
    endDate: CLOSED_MONTH.end,
  });
  const cash = await db.factories.account({
    orgId: org.id,
    code: '1000',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenue = await db.factories.account({
    orgId: org.id,
    code: '4000',
    type: 'revenue',
    normalBalance: 'credit',
  });

  const ctx = contextFor(org.uuid, OWNER_ROLE_ID, user.uuid);

  const dimension = await runInContext(ctx, () =>
    createDimension({ code: 'REGION', name: 'Region' }, ctx),
  );
  const north = await runInContext(ctx, () =>
    createDimensionValue(dimension.id, { code: 'NORTH', name: 'North' }, ctx),
  );
  const south = await runInContext(ctx, () =>
    createDimensionValue(dimension.id, { code: 'SOUTH', name: 'South' }, ctx),
  );

  // Posted through the service, and tagged at posting time (OB-059), so the tag
  // being changed later is a tag that reached the ledger the way a real one does.
  const posted = await runInContext(ctx, () =>
    postJournal(
      {
        date: ENTRY_DATE,
        memo: 'March sale',
        actorType: 'user',
        actorId: user.uuid,
        lines: [
          { accountId: cash.uuid, side: 'debit', amount: 150000n },
          {
            accountId: revenue.uuid,
            side: 'credit',
            amount: 150000n,
            dimensionValueIds: [north.id],
          },
        ],
      },
      ctx,
    ),
  );

  const revenueLine = posted.lines.find((line) => line.side === 'credit');
  if (revenueLine === undefined) throw new Error('posting returned no credit line');

  await runInContext(ctx, () => closePeriod({ periodId: period.uuid }));

  return {
    ctx,
    cashId: cash.uuid,
    revenueId: revenue.uuid,
    journalId: posted.journalId,
    lineId: revenueLine.lineId,
    north: north.id,
    south: south.id,
    dimensionId: dimension.id,
    actorId: user.uuid,
    orgUuid: org.uuid,
    userId: user.uuid,
  };
}

describe('D-32 — the period lock covers the books, not the analysis over them', () => {
  it('lets a line be retagged after its period is closed', async () => {
    const s = await closedPeriodScene();

    await runInContext(s.ctx, () =>
      setJournalLineDimensions(s.lineId, { valueIds: [s.south] }, s.ctx),
    );

    const tags = await runInContext(s.ctx, () => getJournalLineDimensions(s.lineId, s.ctx));
    expect(tags.map((tag) => tag.dimensionValueId)).toEqual([s.south]);
  });

  it('still refuses a posting into the same closed period', async () => {
    const s = await closedPeriodScene();

    await expect(
      runInContext(s.ctx, () =>
        postJournal(
          {
            date: ENTRY_DATE,
            actorType: 'user',
            actorId: s.actorId,
            lines: [
              { accountId: s.cashId, side: 'debit', amount: 1000n },
              { accountId: s.revenueId, side: 'credit', amount: 1000n },
            ],
          },
          s.ctx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'period_closed' },
    });

    // And a reversal, which is the write most likely to be aimed at a closed period:
    // an error is usually found after the month is shut. `assertPostable` is what
    // makes the reversal land somewhere postable rather than restating a closed month.
    await expect(
      runInContext(s.ctx, () =>
        reverseJournal(
          { journalId: s.journalId, date: ENTRY_DATE, actorType: 'user', actorId: s.actorId },
          s.ctx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'period_closed' },
    });
  });

  /**
   * D-32's reasoning, as an assertion.
   *
   * Every statement a close is meant to freeze must be byte-identical across the
   * retag, and the sliced report must move — if the slice did not move the retag did
   * nothing and the first test above is vacuous.
   */
  it('changes no statement the close froze, and moves only the slice', async () => {
    const s = await closedPeriodScene();
    const range = { from: CLOSED_MONTH.start, to: CLOSED_MONTH.end };

    // Money is `bigint` minor units below the wire (spec §12), which `JSON.stringify`
    // refuses outright — rendered as its decimal digits, which is the same thing the
    // wire does (D-13) and keeps the comparison a comparison of bytes.
    const frozen = (value: unknown): string =>
      JSON.stringify(value, (_key, held: unknown) =>
        typeof held === 'bigint' ? held.toString() : held,
      );

    const statements = async (): Promise<string> =>
      runInContext(s.ctx, async () =>
        frozen({
          trialBalance: await getTrialBalance({ asOf: CLOSED_MONTH.end }, s.ctx),
          profitAndLoss: await getProfitAndLoss(range, s.ctx),
          totals: await getAccountBalances(range, s.ctx),
        }),
      );
    const sliced = async (): Promise<string> =>
      runInContext(s.ctx, async () =>
        frozen(await getAccountBalances({ ...range, groupBy: s.dimensionId }, s.ctx)),
      );

    const frozenBefore = await statements();
    const slicedBefore = await sliced();

    await runInContext(s.ctx, () =>
      setJournalLineDimensions(s.lineId, { valueIds: [s.south] }, s.ctx),
    );

    expect(await statements()).toBe(frozenBefore);
    expect(await sliced()).not.toBe(slicedBefore);
  });

  /**
   * The retag is `dimensions.write` and nothing more — it does not silently acquire
   * the period permissions by acting on a closed period's line.
   *
   * Worth its own assertion because the tempting fix for D-32, had it gone the other
   * way, is to let a retag through when the caller can reopen the period. That would
   * make a tag edit require `periods.reopen`, and Read-only / Accountant — the role
   * most likely to be reclassifying last year by a new axis — holds neither.
   */
  it('asks a retag for dimensions.write and no period permission', async () => {
    const s = await closedPeriodScene();

    const contact = await runInContext(s.ctx, () => createContact({ displayName: 'Acme' }, s.ctx));
    expect(contact.id).toMatch(/^[0-9a-f-]{36}$/);

    // A Read-only / Accountant context in the same org: it holds `dimensions.read`
    // but not `dimensions.write`, so the refusal names the tagging permission rather
    // than anything about the period.
    const readOnly = contextFor(s.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, s.userId);

    await expect(
      runInContext(readOnly, () =>
        setJournalLineDimensions(s.lineId, { valueIds: [s.north] }, readOnly),
      ),
    ).rejects.toMatchObject({ details: { permission: 'dimensions.write' } });
  });
});
