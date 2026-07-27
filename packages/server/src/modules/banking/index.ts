/**
 * Banking (M4): statement import, matching, reconciliation.
 *
 * Wave 1 builds the statement import: the parser seam (`parser.ts`), the two format
 * parsers (OB-076 CSV, OB-077 OFX), and this ticket's dedupe/idempotency/queue
 * (OB-078). This barrel is where the format dispatch lives — the one file that names
 * both concrete parsers — and where the statement service is re-exported for the
 * transport (OB-084) and the worker to reach.
 *
 * Wave 2 adds the matching pipeline: the read-only proposal engine (OB-079), the
 * bank rules and their evaluator (OB-080), and clearing — the one write path (OB-081).
 * The engine consumes a `RuleEvaluator` by injection (`rule-evaluator.ts`), and this
 * barrel is the composition point that pairs it with the concrete `bankRuleEvaluator`,
 * the way `parseStatement` pairs the import service with the concrete parsers. The two
 * halves stayed parallel because neither imported the other; they meet here.
 *
 * ## The dispatch is the wave-1 integration seam
 *
 * `parseStatement` switches over `BankStatementFormat` exhaustively, exactly as
 * `selectEmailProvider` switches over its provider union: a third format could not be
 * added without a branch to answer for it. It imports the two sibling parsers by name
 * from `./csv` and `./ofx`. Those tickets are written in parallel, so **this file may
 * not typecheck until their exports land** — that is expected and is the only place in
 * OB-078 that depends on them. The statement service and its tests import neither
 * sibling: they take the parser as an injected `StatementParseFn`, so the dedupe and
 * the async lifecycle are provable while the parsers are still in flight.
 */
import type {
  BankMatchProposalList,
  BankMatchProposalsRequest,
  BankStatementImportPreview,
  PreviewBankStatementImportRequest,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';

import { csvStatementParser } from './csv';
import { proposeMatches } from './matching';
import type { MatchProposalDeps } from './matching';
import { ofxStatementParser } from './ofx';
import { bankRuleEvaluator } from './rules';
import { previewImport } from './statements/service';
import type { StatementParseFn } from './statements/service';

/**
 * Bytes and a format in, bank facts out (`parser.ts`).
 *
 * The sibling export names wired here (`csvStatementParser`, `ofxStatementParser`) are
 * OB-078's best guess at names OB-076/OB-077 have not finalised; a mismatch at
 * integration is a one-line reconciliation in this file and nowhere else.
 */
export const parseStatement: StatementParseFn = ({ format, raw, mapping }) => {
  switch (format) {
    case 'csv':
      if (mapping === null) {
        // Unreachable through the service — `resolveReading` returns a definition for
        // every CSV (the request schema guarantees one). Defensive, and named so a
        // future caller that skipped the service learns why rather than segfaulting.
        throw new Error('A CSV statement import requires a column mapping.');
      }
      return csvStatementParser.parse(raw, mapping);
    case 'ofx':
      return ofxStatementParser.parse(raw, undefined);
  }
};

/**
 * Preview an import, wired to the concrete parsers — the composition wrapper the
 * transport reaches, so a route (OB-084) calls one function rather than assembling the
 * parser seam itself. The same shape as `proposeMatchesWithRules`: `previewImport`
 * takes its `StatementParseFn` injected (the dedupe is testable without the parsers),
 * and this barrel is where the injection is made, pairing it with `parseStatement`
 * above. `startImport` needs no wrapper — it enqueues, and the worker parses.
 */
export function previewImportWithParsers(
  input: PreviewBankStatementImportRequest,
  ctx?: RequestContext,
): Promise<BankStatementImportPreview> {
  return previewImport(input, parseStatement, ctx);
}

export {
  createStatementImportHandler,
  previewImport,
  processStatementImport,
  registerStatementImportJob,
  startImport,
} from './statements/service';
export { getBankStatementImport, listBankStatementImports } from './statements/reads';
export type { StartedImport, StatementImportDeps, StatementParseFn } from './statements/service';
export { STATEMENT_IMPORT_QUEUE } from './statements/job';
export type { StatementImportJob, StatementImportJobContext } from './statements/job';

/**
 * Propose matches for a page of lines, wired to the concrete rule evaluator.
 *
 * The engine takes its `RuleEvaluator` injected (OB-079 never imports OB-080); this
 * is where the two are joined, so a caller — the transport (OB-084), a test that
 * wants the real rules — reaches one function rather than assembling `deps`. A test
 * that wants a fake evaluator still calls `proposeMatches` directly with its own
 * `deps`, which is why the engine keeps the seam and this is a convenience over it.
 */
export function proposeMatchesWithRules(
  input: BankMatchProposalsRequest,
  ctx?: RequestContext,
): Promise<BankMatchProposalList> {
  const deps: MatchProposalDeps = { ruleEvaluator: bankRuleEvaluator };
  return proposeMatches(input, deps, ctx);
}

export { proposeMatches } from './matching';
export type { MatchProposalDeps } from './matching';
export {
  createBankRule,
  getBankRule,
  listBankRules,
  updateBankRule,
  bankRuleEvaluator,
} from './rules';
export { assertClearingBalances, clearBankStatementLine, removeBankLineClearing } from './clearing';
export {
  getBankImportMapping,
  listBankImportMappings,
  mostRecentlyUsedMapping,
  saveBankImportMapping,
} from './csv';
export {
  createReconciliationSession,
  finaliseReconciliationSession,
  getReconciliationReport,
  getReconciliationSession,
  listReconciliationSessions,
  reopenReconciliationSession,
  updateReconciliationSession,
} from './reconciliation';

/**
 * The thin read/create surfaces OB-084 had to add: no earlier wave built a bank-account
 * register/list/get/update or a statement-line list, because waves 1–3 only ever read a
 * bank account by id and a line one at a time. See each module's header.
 */
export {
  createBankAccount,
  getBankAccount,
  listBankAccounts,
  updateBankAccount,
} from './bank-accounts/bank-accounts.service';
export { getStatementLine, listStatementLines } from './statement-lines/service';
