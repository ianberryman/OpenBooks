import type { BankImportMappingDefinition } from '@openbooks/shared-types';

/**
 * What the CSV `StatementParser` needs to read one bank's file (OB-076; the seam in
 * `../parser.ts`).
 *
 * It is exactly a saved mapping's `definition` — `hasHeaderRow`, the `delimiter`,
 * the stated `dateOrder`, the `amountConvention`, and the zero-based column indices
 * (`bankImportMappingDefinitionSchema`). There is no second shape to keep in step:
 * a CSV import arrives with either a saved mapping (which the mapping service turns
 * into this) or an inline one (which is already this), so the parser reads whatever
 * OB-078 hands it without a conversion in between — and a conversion is where a
 * column index or a date order gets rewritten.
 *
 * Defined here rather than in `../parser.ts` because the seam is format-agnostic on
 * purpose (`StatementParser<Opts>`): an OFX file is self-describing and its `Opts`
 * is `void`, so the CSV-only shape belongs beside the CSV parser.
 */
export type CsvOptions = BankImportMappingDefinition;
