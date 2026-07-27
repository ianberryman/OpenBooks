/**
 * CSV statement import (OB-076; ROADMAP D-41, D-42, acceptance E1).
 *
 * Two things live here and share one thing. The `StatementParser` (`parse.ts`)
 * turns a file plus a saved mapping's `definition` into bank facts; the mapping
 * service (`mappings.service.ts`) is where those definitions are saved, read and
 * listed. What they share is `CsvOptions` — the parser's options *are* a mapping's
 * definition, so a saved mapping reads a file with no shape in between.
 *
 * Dedupe, occurrence index, fingerprint and import persistence are OB-078's and are
 * not here; routes are OB-084's; the mapping UI is OB-085's.
 */

export type { CsvOptions } from './options';
export { csvStatementParser, parseCsvStatement } from './parse';
export {
  getBankImportMapping,
  listBankImportMappings,
  mostRecentlyUsedMapping,
  saveBankImportMapping,
} from './mappings.service';
