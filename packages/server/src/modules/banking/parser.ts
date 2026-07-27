/**
 * The seam between a file format and the statement pipeline (OB-076, OB-077,
 * OB-078; ROADMAP D-41, D-42, acceptance E1).
 *
 * A parser turns bytes into bank facts and nothing else. It does not dedupe, does
 * not assign an occurrence index, does not compute a fingerprint, and never touches
 * the database — all of that is OB-078's dedupe stage, because every one of those
 * decisions depends on lines the parser cannot see: the ones already stored, and
 * the other rows in the same file. A parser that knew about duplicates would be a
 * parser that had to be handed the account's history to read a file, which is the
 * coupling this interface exists to refuse.
 *
 * So a `ParsedStatementRow` is exactly `bankLineFactsShape` (shared-types) minus
 * `occurrenceIndex` and `fingerprint` — the fields that come from the bank, in the
 * system's own representation (a calendar date is an ISO `YYYY-MM-DD` string, an
 * amount is signed `bigint` minor units per D-13). The two computed fields are
 * added by the stage that has the context to compute them.
 *
 * This file is the fixed point wave 1 fans out around: OB-076 and OB-077 each
 * implement `StatementParser`, OB-078 consumes `ParsedStatement`, and none of the
 * three has to wait on another to typecheck. It carries no logic on purpose.
 */

/**
 * One transaction as the bank stated it, before anything has been decided about it.
 *
 * The amount is signed minor units, positive money-in / negative money-out, already
 * resolved from whatever convention the file used (`bankAmountConventionSchema`) —
 * the sign trap is the parser's to get right, so that everything downstream reads
 * one convention (E4: `cleared + difference = line.amount` is an equation, not one
 * with a sign lookup in it). `bankReference` is the bank's own id (OFX's `FITID`)
 * where the format supplies one, and null where it does not, which is most CSVs.
 */
export interface ParsedStatementRow {
  readonly postedDate: string;
  readonly valueDate: string | null;
  readonly amount: bigint;
  readonly description: string;
  readonly counterparty: string | null;
  readonly bankReference: string | null;
}

/**
 * A file, read.
 *
 * `closingBalance` and `externalAccountId` are the two facts a statement carries
 * that are not derivable from its lines (D-46): the balance is the outside claim a
 * reconciliation tests against, and the account id is what catches a March current
 * account uploaded into savings. OFX supplies both; a bare CSV supplies neither, so
 * both are nullable rather than optional — a format that cannot state one says so.
 */
export interface ParsedStatement {
  readonly rows: readonly ParsedStatementRow[];
  readonly closingBalance: bigint | null;
  readonly externalAccountId: string | null;
}

/**
 * Bytes in, bank facts out. `Opts` is the format's own configuration — a CSV needs
 * the saved column mapping and its conventions, an OFX file is self-describing and
 * needs nothing — so the registry that dispatches by format supplies the shape the
 * chosen parser requires.
 *
 * Synchronous: parsing is pure and CPU-bound, and a parser that returned a promise
 * would invite one that awaited a network call, which is the line D-41 draws
 * between a file import and a feed. A malformed file is a thrown `ValidationError`
 * naming the row (there is no partial parse — see `imports.ts`), not a rejected
 * promise and not a `ParsedStatement` with a rejects array.
 */
export interface StatementParser<Opts = void> {
  parse(raw: Uint8Array, opts: Opts): ParsedStatement;
}
