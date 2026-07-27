import type {
  ReconciliationReport,
  ReconcilingItem,
  UnclearedStatementLine,
} from '@openbooks/shared-types';

import { getContext, type RequestContext } from '../../../context';
import { bufferToUuid, tryUuidToBuffer } from '../../../db';
import type { TenantDatabase } from '../../../db';
import { assertFound } from '../../../errors';
import { requirePermission } from '../../permissions';

import {
  BANK_ACCOUNT_RESOURCE,
  orgScope,
  RECONCILIATION_SESSION_RESOURCE as RESOURCE,
  selectBankAccount,
  selectSessionById,
  selectUnclearedLedgerEntries,
  selectUnclearedStatementLines,
  type LedgerEntryRow,
  type SessionRow,
  type UnclearedLineRow,
} from './reconciliation.repository';
import { toSummary } from './reconciliation.service';

/**
 * The bank reconciliation report (OB-083; ROADMAP D-40, D-46, D-50, D-51; acceptance
 * E7, E9).
 *
 * A session says the books and the bank agree, and `balances.unclearedAmount` says by
 * how far they do not. This is the document that says *why*: it enumerates the entries
 * that make up that number, so `reconciliation-report.ts` can render "the ledger and
 * the bank disagree by 1,500 because of this unpresented cheque" rather than only the
 * 1,500. It is a pure read over what OB-081 and OB-082 already wrote — no schema of its
 * own, no write anywhere.
 *
 * ## It reuses the session's balances, it does not recompute them
 *
 * `readReport` reads the session, runs it through the session service's own `toSummary`
 * — the same `computeFigures`/`toBalances` every other read of the session uses — and
 * only then gathers the items. The report therefore inherits D-46 (nothing cached) and
 * D-51 (a finalised session's `clearedBalance` comes from its frozen stamp) for free,
 * and it cannot disagree with the session about the figure it is explaining, because it
 * did not compute a second one.
 *
 * ## What ties to what (D-50, the ticket's C8)
 *
 * `reconcilingItems` are the bank-account ledger movements this session did not clear,
 * and they sum to `unclearedAmount` exactly: `clearedBalance + Σ items === bookBalance`.
 * `reconciliation.repository.ts`'s `selectUnclearedLedgerEntries` states why the
 * subtraction of the counted clearings' journals leaves precisely that gap.
 * `unclearedStatementLines` is the statement's side — lines the books have not caught —
 * shown alongside but deliberately outside that identity, because a line with no
 * journal moves neither balance in it (`reconciliation-report.ts`).
 *
 * ## Reproducibility (D-40's requirement, D-32's warning)
 *
 * Built from a finalised session, the report reads the same tomorrow as today: the
 * membership that fixes `clearedBalance` and which entries are reconciling comes from
 * the D-51 stamp, not a re-query, and everything else is bounded by `endDate` over
 * append-only, immutably-dated rows. Later activity dated after `endDate` — a new
 * statement, a clearing on the next period — cannot reach it. The one residual is a
 * journal *back-dated* into the window after the fact, which `bookBalance` itself
 * carries and which the session already inherits from D-32; the report never diverges
 * from the session on it.
 *
 * ## Permission, cross-org
 *
 * `banking.read` — reading a reconciliation is reading, not reconciling; the seeded
 * roles that can view banking hold it, and `banking.reconcile` (which finalises) is a
 * strictly higher authority this read must not require. A session another org owns is
 * an indistinguishable 404 through `assertFound`, never a 403 (E9), exactly as every
 * other banking read.
 */
export async function getReconciliationReport(
  sessionId: string,
  ctx: RequestContext = getContext('getReconciliationReport()'),
): Promise<ReconciliationReport> {
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  // A malformed id is not-found, not a validation failure — the same 404 a cross-org id
  // gets (E9), so the two are indistinguishable.
  const idBytes = assertFound(tryUuidToBuffer(sessionId), RESOURCE);
  const session = assertFound(await selectSessionById(db, idBytes), RESOURCE);
  return readReport(db, session);
}

async function readReport(db: TenantDatabase, session: SessionRow): Promise<ReconciliationReport> {
  // The session's own balances, dates and state — the whole assembly OB-082 uses, so
  // the report's `balances` is byte-for-byte the session's (D-46).
  const summary = await toSummary(db, session);

  const bankAccount = assertFound(
    await selectBankAccount(db, session.bank_account_id),
    BANK_ACCOUNT_RESOURCE,
  );

  const [ledgerEntries, unclearedLines] = await Promise.all([
    selectUnclearedLedgerEntries(db, bankAccount.account_id, {
      bankAccountId: session.bank_account_id,
      startDate: summary.startDate,
      endDate: summary.endDate,
      sessionId: session.id,
      finalised: summary.state === 'finalised',
    }),
    selectUnclearedStatementLines(db, session.bank_account_id, summary.startDate, summary.endDate),
  ]);

  return {
    sessionId: summary.id,
    bankAccountId: summary.bankAccountId,
    startDate: summary.startDate,
    endDate: summary.endDate,
    state: summary.state,
    balances: summary.balances,
    reconcilingItems: ledgerEntries.map(toReconcilingItem),
    unclearedStatementLines: unclearedLines.map(toUnclearedStatementLine),
  };
}

/** D-13's single conversion out for a ledger item: `bigint` minor units to a string. */
function toReconcilingItem(row: LedgerEntryRow): ReconcilingItem {
  return {
    journalId: bufferToUuid(row.journalId),
    date: row.entryDate,
    amount: row.movement.toString(),
    description: row.memo,
    reference: row.reference,
  };
}

function toUnclearedStatementLine(row: UnclearedLineRow): UnclearedStatementLine {
  return {
    lineId: bufferToUuid(row.lineId),
    date: row.postedDate,
    amount: row.amount.toString(),
    description: row.description,
    reference: row.bankReference,
  };
}
