import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../../context';
import { toWireError } from '../../../errors';
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
} from './reconciliation.service';
import { getReconciliationReport } from './report.service';

/**
 * The bank reconciliation report against real MySQL (OB-083; acceptance E7, E9). Never a
 * mock, never SQLite (spec §11): the guarantee is that two independent aggregations —
 * the session's `unclearedAmount` (`bookBalance − clearedBalance`) and the report's
 * enumerated reconciling items — produce the same number, which only real journal lines,
 * clearings and the D-51 stamp can prove. `report.property.test.ts` puts the tie-out
 * under generated shapes; this file pins the specific ones the ticket names.
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

/**
 * Clears a line by linking a bank journal of the same amount — an exact clearing. The
 * journal is dated the line's own date, so clearing a line outside the window puts its
 * entry outside the window too.
 */
async function clearedLine(amountMinor: bigint, postedDate = POSTED): Promise<void> {
  const line = await statementLineIn(db, scene, { amountMinor, postedDate });
  const journal = await bankJournalIn(db, scene, amountMinor, scene.revenue, postedDate);
  await run(() =>
    clearBankStatementLine(line.uuid, { method: 'link_entry', journalId: journal.uuid }),
  );
}

function openSession(endDate: string, statementClosingBalance: string) {
  return run(() =>
    createReconciliationSession({
      bankAccountId: scene.bankAccountUuid,
      endDate,
      statementClosingBalance,
    }),
  );
}

/** The tie every assertion in this file rests on: the items are the gap, exactly. */
function sumItems(items: readonly { readonly amount: string }[]): bigint {
  return items.reduce((total, item) => total + BigInt(item.amount), 0n);
}

// ---------------------------------------------------------------------------
// The tie-out — the ticket's C8
// ---------------------------------------------------------------------------

describe('the tie-out', () => {
  it('itemises unclearedAmount over a mixed window: a cheque, an uncleared line', async () => {
    await clearedLine(5000n);
    await clearedLine(3000n);
    // An uncleared statement line (bank shows it, books have not caught it) and an
    // unpresented cheque (books show it, bank has not) — the two reconciling gaps.
    await statementLineIn(db, scene, { amountMinor: 2000n, postedDate: POSTED });
    await bankJournalIn(db, scene, -1500n, scene.expense);

    const session = await openSession(END, '8000');
    const report = await run(() => getReconciliationReport(session.id));

    expect(report.balances.clearedBalance).toBe('8000');
    expect(report.balances.bookBalance).toBe('6500');
    expect(report.balances.unclearedAmount).toBe('-1500');

    // The identity, exactly: Σ items === unclearedAmount, and clearedBalance + Σ === book.
    expect(sumItems(report.reconcilingItems).toString()).toBe('-1500');
    expect(
      (BigInt(report.balances.clearedBalance) + sumItems(report.reconcilingItems)).toString(),
    ).toBe(report.balances.bookBalance);

    // The reconciling item is the unpresented cheque, dated the ledger entry's own date.
    expect(report.reconcilingItems).toHaveLength(1);
    expect(report.reconcilingItems[0]).toMatchObject({ amount: '-1500', date: scene.date });

    // The statement-side backlog is the uncleared line, and it is *not* in the sum above.
    expect(report.unclearedStatementLines).toHaveLength(1);
    expect(report.unclearedStatementLines[0]).toMatchObject({ amount: '2000', date: POSTED });
  });

  it('counts a clearing’s difference journal as a reconciling item, and still ties', async () => {
    // A £990 line cleared against a £1,000 entry, £10 to bank charges (E4). The cleared
    // journal is a counted member; the difference journal moves the bank by −10 and is
    // no clearing’s `cleared_journal_id`, so it is correctly a reconciling item.
    const line = await statementLineIn(db, scene, { amountMinor: 990n, postedDate: POSTED });
    const journal = await bankJournalIn(db, scene, 1000n, scene.revenue);
    await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'link_entry',
        journalId: journal.uuid,
        differenceAccountId: scene.charges.uuid,
      }),
    );

    const session = await openSession(END, '1000');
    const report = await run(() => getReconciliationReport(session.id));

    expect(report.balances.clearedBalance).toBe('1000');
    expect(report.balances.bookBalance).toBe('990');
    expect(report.balances.unclearedAmount).toBe('-10');
    expect(sumItems(report.reconcilingItems).toString()).toBe('-10');
    expect(report.reconcilingItems).toHaveLength(1);
    expect(report.reconcilingItems[0]?.amount).toBe('-10');
    expect(report.unclearedStatementLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A fully-reconciled session reports nothing
// ---------------------------------------------------------------------------

describe('a fully reconciled session', () => {
  it('reports zero reconciling items, open and after finalising', async () => {
    await clearedLine(5000n);
    await clearedLine(3000n);
    const session = await openSession(END, '8000');

    const open = await run(() => getReconciliationReport(session.id));
    expect(open.balances.unclearedAmount).toBe('0');
    expect(open.reconcilingItems).toHaveLength(0);
    expect(open.unclearedStatementLines).toHaveLength(0);
    expect(sumItems(open.reconcilingItems)).toBe(0n);

    // Finalising freezes membership (D-51); the report reads it from the stamp and still
    // reports nothing — the book and the cleared balance agree.
    const finalised = await run(() => finaliseReconciliationSession(session.id));
    const after = await run(() => getReconciliationReport(finalised.id));
    expect(after.state).toBe('finalised');
    expect(after.reconcilingItems).toHaveLength(0);
    expect(after.balances.unclearedAmount).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// As-at reproducibility (D-40's requirement, D-32's warning)
// ---------------------------------------------------------------------------

describe('as-at reproducibility', () => {
  it('reads the same after later-dated activity on the account', async () => {
    await clearedLine(5000n);
    // An unpresented cheque, so the finalised report has something to be reproducible about.
    await bankJournalIn(db, scene, -1500n, scene.expense);
    const session = await openSession(END, '5000');
    const finalised = await run(() => finaliseReconciliationSession(session.id));

    const before = await run(() => getReconciliationReport(finalised.id));
    expect(before.reconcilingItems).toHaveLength(1);
    expect(before.balances.unclearedAmount).toBe('-1500');

    // Activity dated after `endDate`: a new statement line and the entry that clears it,
    // an uncleared line and an uncleared entry, all a month on. None of it is in this
    // session's window, so none may reach its as-at report.
    await clearedLine(9999n, '2026-03-01');
    await statementLineIn(db, scene, { amountMinor: 4242n, postedDate: '2026-03-02' });
    await bankJournalIn(db, scene, -777n, scene.expense, '2026-03-03');

    const after = await run(() => getReconciliationReport(finalised.id));
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

    const error = await caught(() => getReconciliationReport(session.id, other.ctx));
    expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });

    // A malformed id is the same 404, not a validation failure.
    const malformed = await caught(() => run(() => getReconciliationReport('not-a-uuid')));
    expect(toWireError(malformed)).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('requires banking.read, and only that — not banking.reconcile', async () => {
    const session = await openSession(END, '0');

    // `ap_only` holds no `banking.read`: refused.
    const apOnly = await memberIn(db, scene, 'apOnly');
    const denied = await caught(() => run(() => getReconciliationReport(session.id), apOnly));
    expect(toWireError(denied)).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'banking.read' },
    });

    // `read_only` holds `banking.read` but not `banking.reconcile`: it can read the
    // report, which is the point of gating it on `read` rather than `reconcile`.
    const reader = await memberIn(db, scene, 'readOnly');
    const report = await run(() => getReconciliationReport(session.id), reader);
    expect(report.sessionId).toBe(session.id);
  });
});
