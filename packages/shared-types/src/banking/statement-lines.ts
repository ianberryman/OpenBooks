import { z } from 'zod';

import { isOrderedRange } from '../subledger';
import { calendarDateSchema, pageQueryShape } from '../wire';

import {
  bankDateRangeShape,
  bankLineAmountSchema,
  bankLineDirectionSchema,
  unpublishedPageSchema,
} from './banking';
import { bankLineClearingSchema } from './clearing';

/**
 * Statement lines (OB-075, for OB-078; ROADMAP D-42, acceptance E1, E2).
 *
 * ## There is no update shape in this file, and that is the file's whole argument
 *
 * D-42: a statement line is what the bank said, and is never modified. Append-only
 * in the grants allowlist sense — the app may insert and read, not update — which is
 * spec §2.2's argument about journals applied to a different record: "a statement
 * line that could be edited stops being evidence. The reason to keep it is that it
 * independently corroborates the ledger, and a corroborating record you can rewrite
 * corroborates nothing."
 *
 * So there is no `updateBankStatementLineRequestSchema` here, and there is no
 * `updatedAt` on the line either. The absence is deliberate and legible: everything
 * the matching pipeline decides lives in rows that *reference* a line — a proposal,
 * a clearing — and never in the line itself. `contracts.test.ts` asserts that this
 * module exports no update shape for a line, because the way this decision gets
 * lost is somebody adding a `memo` field in wave 2 and nobody noticing what it
 * costs.
 *
 * A user who thinks a line is wrong is right about the ledger and wrong about the
 * line: the correction is an entry, or a clearing with a recorded difference (E4),
 * not an edit to the evidence.
 *
 * ## The fingerprint, and the two identical coffees
 *
 * Re-import is idempotent (E1), so lines are deduped on a fingerprint over the
 * fields the bank actually supplies. D-42 states the hard case rather than leaving
 * it to be rediscovered: two genuinely distinct transactions can be identical in
 * every supplied field — two £4.50 coffees at the same shop on the same day, from a
 * bank that provides no transaction id. The fingerprint therefore includes an
 * occurrence index *within the file*, so the second coffee survives, and
 * re-importing the same file still collapses to two rather than four.
 *
 * ## No `.meta({ id })`, and no route yet — see `banking.ts`.
 */

export const BANK_LINE_DESCRIPTION_MAX_LENGTH = 512;
export const BANK_LINE_COUNTERPARTY_MAX_LENGTH = 255;
export const BANK_LINE_REFERENCE_MAX_LENGTH = 255;

/**
 * What the dedupe fingerprint is computed over (D-42, E1).
 *
 * Declared as data rather than as prose in a service, because E1 says re-import
 * produces no duplicates "whatever the file's ordering" and that property is only
 * checkable against a stated list of inputs. Two things about it are load-bearing:
 *
 * - `bankReference` is the bank's own transaction id where one exists. It is the
 *   strongest field here and it is *not* sufficient on its own, because most CSV
 *   exports have none.
 * - `occurrenceIndex` is the count of earlier lines in the same file with the same
 *   values for everything above it — not the row number. The row number would make
 *   the fingerprint depend on the file's ordering, which is exactly what E1 says it
 *   must not do.
 */
export const BANK_LINE_FINGERPRINT_FIELDS = [
  'postedDate',
  'amount',
  'description',
  'bankReference',
  'occurrenceIndex',
] as const;

export type BankLineFingerprintField = (typeof BANK_LINE_FINGERPRINT_FIELDS)[number];

/**
 * The fingerprint on the wire: opaque, like a page cursor and for the same reason.
 *
 * A client that parsed it would make the field list above part of the public
 * contract, and the field list is the one thing about dedupe a later ticket may
 * need to change — a bank that starts supplying transaction ids should improve the
 * fingerprint, not break every consumer. It is returned rather than hidden because
 * "why was this line treated as a duplicate" is a question a support conversation
 * actually asks, and two equal opaque strings answer it.
 */
export const bankLineFingerprintSchema = z.string().meta({
  description:
    'An opaque dedupe key over what the bank supplied (D-42). Two lines with the same ' +
    'fingerprint are the same transaction. Do not parse it or construct it: what goes into it is ' +
    'free to change.',
});

const lineDescriptionSchema = z.string().max(BANK_LINE_DESCRIPTION_MAX_LENGTH);

/**
 * The fields that come from the bank, shared by a parsed row and a stored line.
 *
 * One shape rather than two, so that what a preview showed and what an import
 * created cannot drift: a preview that displayed a field the import then dropped
 * would be a screen that lies about what the button does.
 */
const bankLineFactsShape = {
  postedDate: calendarDateSchema.meta({
    description:
      'The date the bank posted it, which is the date its own balance moved on — and therefore ' +
      'the date a reconciliation counts it under (D-45).',
  }),
  valueDate: calendarDateSchema.nullable().meta({
    description:
      'The date the money became available, where the bank supplies both dates. Null when it ' +
      'supplies one. Never used for reconciliation; kept because it is what the bank said.',
  }),
  amount: bankLineAmountSchema,
  description: lineDescriptionSchema.meta({
    description: 'The narrative, verbatim. Not normalised, not trimmed of the bank’s own noise.',
  }),
  counterparty: z.string().max(BANK_LINE_COUNTERPARTY_MAX_LENGTH).nullable().meta({
    description: 'The payee or payer, where the format separates it from the narrative.',
  }),
  bankReference: z.string().max(BANK_LINE_REFERENCE_MAX_LENGTH).nullable().meta({
    description:
      'The bank’s own identifier for the transaction — OFX’s `FITID`. Null for most CSVs.',
  }),
  occurrenceIndex: z
    .int()
    .min(0)
    .meta({
      description:
        'How many earlier lines in the same file were identical in every other supplied field. ' +
        'Zero for almost every line; it exists so that two identical transactions on the same day ' +
        'both survive, and so that re-importing the file still collapses them to two (D-42).',
    }),
  fingerprint: bankLineFingerprintSchema,
};

/**
 * A row as the parser read it, before anything has been written.
 *
 * Only a preview returns these (`bankStatementImportPreviewSchema`). It has no `id`
 * because it is not a thing yet, and it carries `isDuplicate` because that is the
 * one fact a preview can tell a user that the file itself cannot.
 */
export const bankStatementLineDraftSchema = z.strictObject({
  ...bankLineFactsShape,
  isDuplicate: z.boolean().meta({
    description: 'Whether a line with this fingerprint is already present on the bank account.',
  }),
});

export type BankStatementLineDraft = z.infer<typeof bankStatementLineDraftSchema>;

/**
 * A statement line as the API returns it.
 *
 * There is no `updatedAt` and no `status`. The first is D-42 made visible in the
 * shape: nothing about this row ever changes, so a timestamp for the last change
 * would be a field that is always equal to `createdAt` and an invitation to make it
 * not be. The second follows M3's rule for computed state (D-38): whether a line is
 * reconciled is whether `clearing` is present, and a label beside it would be a
 * second encoding that drifts the first time a clearing is removed.
 */
export const bankStatementLineSchema = z.strictObject({
  id: z.uuid(),
  bankAccountId: z.uuid(),
  importId: z.uuid().meta({
    description:
      'The import that first created this line. A re-import that recognised it as a duplicate ' +
      'does not become its import — the line records where it came from, and that is the upload ' +
      'that introduced it.',
  }),
  ...bankLineFactsShape,
  clearing: bankLineClearingSchema.nullable().meta({
    description:
      'What cleared this line, or null. Presence *is* the reconciled state — there is no status ' +
      'field, because a label beside this would be a second encoding of the same fact.',
  }),
  createdAt: z.iso.datetime(),
});

export type BankStatementLine = z.infer<typeof bankStatementLineSchema>;

/**
 * `cleared` is the matching screen's whole filter: the lines with nothing against
 * them yet are the work.
 *
 * A real boolean and not a query-string flag, following `listAccountsQuerySchema` —
 * the route coerces, because `'false'` is truthy in every language an integrator
 * might use.
 */
export const listBankStatementLinesQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...bankDateRangeShape,
    bankAccountId: z.uuid().optional(),
    importId: z.uuid().optional(),
    direction: bankLineDirectionSchema.optional(),
    cleared: z.boolean().optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListBankStatementLinesQuery = z.input<typeof listBankStatementLinesQuerySchema>;

/**
 * Ordered by `(posted_date, id)`, and this is the one list in the module that does
 * not use `(created_at, id)`.
 *
 * D-21 chose keyset ordering over a column that cannot move under a cursor, and
 * `posted_date` qualifies precisely because of D-42: a statement line is never
 * modified, so its date cannot change beneath a paging client. The usual objection —
 * that a back-dated row lands behind a cursor that has already passed it — applies
 * to rows that are *edited* into the past, not to rows that arrive from a re-import;
 * a re-import creates only lines that were not there, and a client paging a
 * statement while uploading another one is reading a moving list either way.
 *
 * Reconciliation reads a statement in date order, so any other ordering would make
 * the milestone's central screen sort a whole account client-side.
 */
export const bankStatementLinePageSchema = unpublishedPageSchema(bankStatementLineSchema);

export type BankStatementLinePage = z.infer<typeof bankStatementLinePageSchema>;
