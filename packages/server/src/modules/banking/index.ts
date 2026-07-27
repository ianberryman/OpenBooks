/**
 * Banking (M4): statement import, matching, reconciliation.
 *
 * Wave 1 builds the statement import: the parser seam (`parser.ts`), the two format
 * parsers (OB-076 CSV, OB-077 OFX), and this ticket's dedupe/idempotency/queue
 * (OB-078). This barrel is where the format dispatch lives — the one file that names
 * both concrete parsers — and where the statement service is re-exported for the
 * transport (OB-084) and the worker to reach.
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
import { csvStatementParser } from './csv';
import { ofxStatementParser } from './ofx';
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

export {
  createStatementImportHandler,
  previewImport,
  processStatementImport,
  registerStatementImportJob,
  startImport,
} from './statements/service';
export type { StartedImport, StatementImportDeps, StatementParseFn } from './statements/service';
export { STATEMENT_IMPORT_QUEUE } from './statements/job';
export type { StatementImportJob, StatementImportJobContext } from './statements/job';
