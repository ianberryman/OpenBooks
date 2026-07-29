import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../../context';
import { bufferToUuid } from '../../../db';
import { toWireError } from '../../../errors';
import { closePeriod } from '../../periods';
import {
  bankJournalIn,
  memberIn,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
} from '../../../../test/banking/clearing-support';
import { clearBankStatementLine } from '../clearing/clearing.service';

import {
  createReconciliationSession,
  finaliseReconciliationSession,
  getReconciliationSession,
  listReconciliationSessions,
  reopenReconciliationSession,
  updateReconciliationSession,
} from './reconciliation.service';

/**
 * The reconciliation session service against real MySQL (OB-082; acceptance E5, E6,
 * E7, E9). Never a mock, never SQLite (spec §11): the guarantees are the balances
 * summed from journal lines and clearings, the `open_marker` unique key, the membership
 * stamp on `bank_line_clearings`, and the org scoping `tenantDb` applies — none of which
 * a mock holds. Contention is `reconciliation.race.test.ts`.
 */

const db = useServiceDatabase();

const POSTED = '2026-01-15';
const END = '2026-01-31';

let scene: Scene;
beforeEach(async () => {
  scene = await sceneIn(db);
});

function run<T>(fn: () => Promise<T>, ctx: RequestContext = scene.ctx): Promise<T> {
  return runInContext(ctx, fn);
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => {
      throw new Error('expected a refusal, got success');
    },
    (error: unknown) => error,
  );
}

/** Clears a statement line by linking a freshly-posted bank journal of the same amount. */
async function clearedLine(amountMinor: bigint, postedDate = POSTED): Promise<void> {
  const line = await statementLineIn(db, scene, { amountMinor, postedDate });
  const journal = await bankJournalIn(db, scene, amountMinor, scene.revenue);
  await run(() =>
    clearBankStatementLine(line.uuid, {
      entries: [{ method: 'link_entry', journalId: journal.uuid }],
    }),
  );
}

function openSession(endDate: string, statementClosingBalance: string, startDate?: string) {
  return run(() =>
    createReconciliationSession({
      bankAccountId: scene.bankAccountUuid,
      endDate,
      statementClosingBalance,
      ...(startDate === undefined ? {} : { startDate }),
    }),
  );
}

async function clearingSessionId(db2 = db): Promise<ReadonlyMap<string, string | null>> {
  const rows = await db2.app
    .selectFrom('bank_line_clearings')
    .innerJoin('bank_statement_lines', (join) =>
      join
        .onRef('bank_statement_lines.id', '=', 'bank_line_clearings.statement_line_id')
        .onRef('bank_statement_lines.org_id', '=', 'bank_line_clearings.org_id'),
    )
    .where('bank_statement_lines.bank_account_id', '=', scene.bankAccountId)
    .select([
      'bank_statement_lines.amount_minor as amount',
      'bank_line_clearings.reconciliation_session_id as session',
    ])
    .execute();
  return new Map(
    rows.map((row) => [
      row.amount.toString(),
      row.session === null ? null : row.session.toString('hex'),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Open, and the start date it derives
// ---------------------------------------------------------------------------

describe('open', () => {
  it('opens a session and derives its start from the account’s earliest line', async () => {
    await statementLineIn(db, scene, { amountMinor: 100n, postedDate: '2026-01-05' });

    const session = await openSession(END, '0');

    expect(session.state).toBe('open');
    expect(session.startDate).toBe('2026-01-05');
    expect(session.endDate).toBe(END);
    expect(session.finalisedAt).toBeNull();
    expect(session.balances.statementClosingBalance).toBe('0');
    // The synthesized opened event (E6): actor and time, no assertion.
    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({
      type: 'opened',
      reason: null,
      statementClosingBalance: null,
      actorUserId: scene.userUuid,
    });
  });

  it('accepts a supplied start date that agrees, and carries it as the window', async () => {
    await statementLineIn(db, scene, { amountMinor: 100n, postedDate: '2026-01-05' });
    const session = await openSession(END, '0', '2026-01-05');
    expect(session.startDate).toBe('2026-01-05');
  });

  it('derives the second session’s start from the first’s end + 1 day', async () => {
    await openSession('2026-01-15', '0');
    const first = await finaliseFirst('2026-01-15');
    expect(first.state).toBe('finalised');

    const second = await openSession(END, '0');
    expect(second.startDate).toBe('2026-01-16');
    expect(second.balances.openingBalance).toBe('0');
  });

  it('refuses a second, forward-dated open session on the account — bank_account_has_open_session', async () => {
    await openSession('2026-01-15', '0');
    // A later end date clears the overlap guard, so the refusal is the open_marker
    // unique key: one open reconciliation per account.
    const error = await caught(() => openSession(END, '0'));
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'bank_account_has_open_session' },
    });
  });
});

/** Finalises the single open session on the account, whose end date is `endDate`. */
async function finaliseFirst(endDate: string) {
  const page = await run(() =>
    listReconciliationSessions({ bankAccountId: scene.bankAccountUuid, state: 'open' }),
  );
  const open = page.items.find((item) => item.endDate === endDate);
  if (open === undefined) throw new Error('no open session to finalise');
  return run(() => finaliseReconciliationSession(open.id));
}

// ---------------------------------------------------------------------------
// The balances, computed on read
// ---------------------------------------------------------------------------

describe('balances', () => {
  it('computes cleared, book, difference and uncleared across a mixed window', async () => {
    await clearedLine(5000n);
    await clearedLine(3000n);
    // An uncleared statement line (in the books of neither side) and an unpresented
    // cheque (in the ledger, not on the statement): the two kinds of reconciling gap.
    await statementLineIn(db, scene, { amountMinor: 2000n, postedDate: POSTED });
    await bankJournalIn(db, scene, -1500n, scene.expense);

    const session = await openSession(END, '8000');

    expect(session.balances).toEqual({
      openingBalance: '0',
      clearedBalance: '8000',
      statementClosingBalance: '8000',
      difference: '0',
      bookBalance: '6500',
      unclearedAmount: '-1500',
    });
    expect(session.clearedLineCount).toBe(2);
    expect(session.unclearedLineCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finalise — the assertion (D-50, E5)
// ---------------------------------------------------------------------------

describe('finalise', () => {
  it('asserts the cleared balance, and an unpresented cheque does not block it (D-50)', async () => {
    await clearedLine(5000n);
    // The book balance (3500) disagrees with the statement (5000) by an unpresented
    // cheque; the cleared balance (5000) agrees, so finalising is allowed.
    await bankJournalIn(db, scene, -1500n, scene.expense);

    const session = await openSession(END, '5000');
    expect(session.balances.bookBalance).toBe('3500');
    expect(session.balances.clearedBalance).toBe('5000');

    const finalised = await run(() => finaliseReconciliationSession(session.id));

    expect(finalised.state).toBe('finalised');
    expect(finalised.finalisedAt).not.toBeNull();
    expect(finalised.events.map((event) => event.type)).toEqual(['opened', 'finalised']);
    expect(finalised.events[1]).toMatchObject({
      type: 'finalised',
      statementClosingBalance: '5000',
      reason: null,
      actorUserId: scene.userUuid,
    });
  });

  it('refuses when the cleared balance disagrees — reconciliation_session_balance_mismatch', async () => {
    await clearedLine(5000n);
    const session = await openSession(END, '9999');

    const error = await caught(() => run(() => finaliseReconciliationSession(session.id)));
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_balance_mismatch' },
    });
    // Still open, and nothing stamped.
    const reread = await run(() => getReconciliationSession(session.id));
    expect(reread.state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Membership is frozen at finalisation, and reopen thaws it (D-51)
// ---------------------------------------------------------------------------

describe('membership', () => {
  it('freezes the covered set at finalisation and re-gathers it on reopen', async () => {
    await clearedLine(5000n);
    await clearedLine(3000n);
    const session = await openSession(END, '8000');
    const finalised = await run(() => finaliseReconciliationSession(session.id));

    // Both clearings are stamped with this session.
    const stamped = await clearingSessionId();
    expect(stamped.get('5000')).toBe(session.id.replace(/-/g, ''));
    expect(stamped.get('3000')).toBe(session.id.replace(/-/g, ''));

    // A clearing entered afterwards, dated inside the window, does not change what the
    // finalised session claimed.
    await clearedLine(1000n, '2026-01-16');
    const afterExtra = await run(() => getReconciliationSession(finalised.id));
    expect(afterExtra.clearedLineCount).toBe(2);
    expect(afterExtra.balances.clearedBalance).toBe('8000');
    expect((await clearingSessionId()).get('1000')).toBeNull();

    // Reopen un-stamps, logs the event, and lets the set be re-gathered — now including
    // the late clearing.
    const reopener = await memberIn(db, scene, 'bookkeeper');
    const reopened = await run(
      () => reopenReconciliationSession(finalised.id, { reason: 'bank restated a fee' }),
      reopener,
    );

    expect(reopened.state).toBe('open');
    expect(reopened.events.map((event) => event.type)).toEqual(['opened', 'finalised', 'reopened']);
    expect(reopened.events[2]).toMatchObject({ type: 'reopened', reason: 'bank restated a fee' });
    expect(reopened.clearedLineCount).toBe(3);
    expect(reopened.balances.clearedBalance).toBe('9000');
    const afterReopen = await clearingSessionId();
    expect(afterReopen.get('5000')).toBeNull();
    expect(afterReopen.get('3000')).toBeNull();
  });

  it('refuses to reopen a session that is already open — reconciliation_session_not_finalised', async () => {
    const session = await openSession(END, '0');
    const error = await caught(() =>
      run(() => reopenReconciliationSession(session.id, { reason: 'x' })),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_not_finalised' },
    });
  });
});

// ---------------------------------------------------------------------------
// Update — while open only
// ---------------------------------------------------------------------------

describe('update', () => {
  it('corrects the closing balance and end date while open', async () => {
    const session = await openSession(END, '0');
    const updated = await run(() =>
      updateReconciliationSession(session.id, {
        statementClosingBalance: '4200',
        endDate: '2026-01-20',
      }),
    );
    expect(updated.balances.statementClosingBalance).toBe('4200');
    expect(updated.endDate).toBe('2026-01-20');
  });

  it('refuses once finalised — reconciliation_session_already_finalised', async () => {
    const session = await openSession(END, '0');
    await run(() => finaliseReconciliationSession(session.id));

    const error = await caught(() =>
      run(() => updateReconciliationSession(session.id, { statementClosingBalance: '1' })),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_already_finalised' },
    });
  });
});

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

describe('overlap', () => {
  it('refuses a session ending on or before an existing one — reconciliation_session_overlaps', async () => {
    await openSession('2026-01-15', '0');
    await finaliseFirst('2026-01-15');

    const error = await caught(() => openSession('2026-01-10', '0'));
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_overlaps' },
    });
  });

  it('refuses a supplied start date that disagrees with the prior session', async () => {
    await openSession('2026-01-15', '0');
    await finaliseFirst('2026-01-15');

    // Derived start is 2026-01-16; a supplied 2026-01-20 disagrees.
    const error = await caught(() => openSession(END, '0', '2026-01-20'));
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_overlaps' },
    });
    // The agreeing one is accepted.
    const ok = await openSession(END, '0', '2026-01-16');
    expect(ok.startDate).toBe('2026-01-16');
  });
});

// ---------------------------------------------------------------------------
// E7 — the two locks are independent
// ---------------------------------------------------------------------------

describe('independence of the period lock (E7)', () => {
  async function periodSnapshot() {
    return db.app
      .selectFrom('fiscal_periods')
      .select(['status', 'closed_at', 'updated_at'])
      .where('id', '=', scene.periodId)
      .executeTakeFirstOrThrow();
  }

  it('finalises against a closed period and mutates no period state', async () => {
    await clearedLine(5000n);
    const session = await openSession(END, '5000');

    await run(() => closePeriod({ periodId: bufferToUuid(scene.periodId) }));
    const before = await periodSnapshot();
    expect(before.status).toBe('closed');

    const finalised = await run(() => finaliseReconciliationSession(session.id));
    expect(finalised.state).toBe('finalised');
    // The session carries no period reference at all.
    expect('periodId' in finalised).toBe(false);

    const after = await periodSnapshot();
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Cross-org and permission (E9)
// ---------------------------------------------------------------------------

describe('cross-org and permission', () => {
  it('is a 404 across orgs, byte-identical to nonexistent (E9)', async () => {
    const session = await openSession(END, '0');
    const other = await sceneIn(db);

    for (const call of [
      () => getReconciliationSession(session.id, other.ctx),
      () => finaliseReconciliationSession(session.id, other.ctx),
      () => updateReconciliationSession(session.id, { statementClosingBalance: '1' }, other.ctx),
      () => reopenReconciliationSession(session.id, { reason: 'x' }, other.ctx),
    ]) {
      const error = await caught(call);
      expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });
    }
  });

  it('gates open on banking.reconcile and reopen on banking.reopen', async () => {
    const reader = await memberIn(db, scene, 'readOnly');

    const openError = await caught(() =>
      run(
        () =>
          createReconciliationSession({
            bankAccountId: scene.bankAccountUuid,
            endDate: END,
            statementClosingBalance: '0',
          }),
        reader,
      ),
    );
    expect(toWireError(openError)).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'banking.reconcile' },
    });

    const session = await openSession(END, '0');
    await run(() => finaliseReconciliationSession(session.id));
    const reopenError = await caught(() =>
      run(() => reopenReconciliationSession(session.id, { reason: 'x' }), reader),
    );
    expect(toWireError(reopenError)).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'banking.reopen' },
    });
  });
});
