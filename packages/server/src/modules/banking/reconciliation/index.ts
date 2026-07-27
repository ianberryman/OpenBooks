/**
 * Reconciliation sessions, and the reopen (M4 wave 3, OB-082; ROADMAP D-45, D-46,
 * D-50, D-51; acceptance E5, E6, E7, E9).
 *
 * A session is the milestone's climax: the moment the books and the bank are stated to
 * have agreed. It names a bank account, an end date and the statement's closing
 * balance; lines are cleared into it until the *cleared* balance equals that figure,
 * and finalising records the assertion. Read `reconciliation.service.ts` for what
 * finalising asserts (the cleared balance, never the book balance — an unpresented
 * cheque is a reconciling difference, not a blocker), and `reconciliation.repository.ts`
 * for why the session row is the one thing a finalise can lock and why every figure but
 * the statement's own is computed on read.
 *
 * ## Membership is frozen at finalisation and thawed at reopen (D-51)
 *
 * While open, a session's membership is a date query; at finalisation the covered
 * clearings are stamped with the session id, snapshotting what the assertion measured;
 * reopen un-stamps them so the corrected session re-gathers its set. `reconciliation_session_id`
 * on `bank_line_clearings` is the only column this module writes on that table.
 *
 * ## The two locks are independent (E7)
 *
 * A reconciliation and a fiscal-period close are different assertions on different
 * cadences (D-45). Nothing here reads or writes period state; the only place the two
 * meet is that clearing posts a journal into an open period, which is clearing's
 * concern (OB-081), not the session's.
 *
 * ## Permissions this module enforces
 *
 * open, get, list, update and finalise gate on `banking.reconcile`; reopen on
 * `banking.reopen`. Both are latent until this service takes them live.
 *
 * There are no routes: `/v1` for M4 is OB-084, and the wire contracts in
 * `shared-types/src/banking/reconciliation.ts` carry no `.meta({ id })` until then.
 */
export {
  createReconciliationSession,
  finaliseReconciliationSession,
  getReconciliationSession,
  listReconciliationSessions,
  reopenReconciliationSession,
  updateReconciliationSession,
} from './reconciliation.service';
