import { z } from 'zod';

import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { JOURNAL_SIDES } from '../journals';
import { calendarDateSchema, minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

/**
 * The journal-draft wire contract (OB-038; ROADMAP D-16, D-19).
 *
 * ## Everything is nullable, and that is the design
 *
 * A draft is not a weaker journal, it is a different kind of thing: it is in no
 * report, in no trial balance, and no invariant test applies to it, because it
 * has not happened yet (D-19). So every field a journal requires is optional
 * here — no date, no account, no amount, no balance, not even a line. A form that
 * cannot be saved until it is already correct is not a draft, and the friction it
 * removes is the one D-16 identifies: a typo noticed ten seconds after posting
 * should not produce three journal entries.
 *
 * Validation happens once, at post, where its failure is a message to the person
 * posting rather than a constraint violation while they type. The one rule
 * enforced *here* is non-negativity, and it is here because a negative amount is
 * not incompleteness — it encodes a sign convention this system does not have
 * (D-13), and `chk_journal_draft_lines_non_negative` would refuse it anyway.
 *
 * ## The `id`s
 *
 * `jsonSchemaTransformObject` copies *every* schema carrying an `id` out of zod's
 * global registry into `components.schemas`, whether or not a route references
 * it, and A10 makes drift in `openapi.json` a build failure. OB-038 ended at the
 * service and left them off; OB-045 built `/v1/journal-drafts` and added them,
 * exactly as OB-018 left them off and OB-023 added them. `JournalDraftPage` is a
 * `pageSchema` call now for the same reason — the helper requires an `id`, because
 * the only reason to have a response *schema* rather than a response *type* is to
 * publish it — and the keys did not change, because they were the shared
 * envelope's already (D-21).
 *
 * `listDraftsQuerySchema` carries no `id`: a querystring is emitted as individual
 * `parameters`, so a component for it would be referenced by nothing.
 */

/**
 * Column widths, restated from the `journal_drafts` / `journal_draft_lines`
 * blocks in `0002_ledger`.
 *
 * The inequality runs the safe way for the reason `accounts.ts` gives: MySQL's
 * `VARCHAR(n)` counts characters and `String.length` counts UTF-16 code units, so
 * a value this schema accepts cannot be silently truncated by the column.
 */
export const DRAFT_MEMO_MAX_LENGTH = 512;
export const DRAFT_REFERENCE_MAX_LENGTH = 120;
export const DRAFT_LINE_MEMO_MAX_LENGTH = 512;

/**
 * The upper bound on lines in one draft, from `journal_draft_lines.line_number`'s
 * `SMALLINT UNSIGNED`.
 *
 * The schema's own limit rather than a smaller "reasonable" number, following the
 * argument at `MAX_LINES` in `posting.service.ts`: the column bound is a
 * correctness constraint, and a lower business limit would be product policy that
 * a draft — an unfinished thing — is the wrong place to invent.
 */
export const DRAFT_MAX_LINES = 65_535;

const draftMemoSchema = z.string().trim().max(DRAFT_MEMO_MAX_LENGTH).meta({
  description: 'What the entry is for. Send `null` to clear it.',
});

const draftReferenceSchema = z
  .string()
  .trim()
  .max(DRAFT_REFERENCE_MAX_LENGTH)
  .meta({
    description:
      'The org’s own reference for the entry — an invoice number, a bank statement line. Send ' +
      '`null` to clear it.',
  });

const draftLineMemoSchema = z.string().trim().max(DRAFT_LINE_MEMO_MAX_LENGTH);

const draftSideSchema = z.enum(JOURNAL_SIDES).meta({
  description:
    'Which side of the ledger this line will move. Null while the line is unfinished. The side ' +
    'carries the sign, so `amount` is never negative.',
});

/**
 * A draft amount: minor units, and never negative.
 *
 * `minorUnitsSchema` accepts a leading `-` because a signed amount is meaningful
 * elsewhere in the API; on a draft line it is not. The refusal is a restatement of
 * `chk_journal_draft_lines_non_negative`, and the reason the check exists at all is
 * in `0002_ledger`: a draft holding `-500` in `debit_minor` encodes a sign
 * convention the ledger does not have, and the only thing between it and the ledger
 * would be the post-time validator remembering to look.
 *
 * Zero is accepted — it is what an unfinished line holds.
 */
const draftAmountSchema = minorUnitsSchema
  .refine((value) => !value.startsWith('-'), {
    message:
      'A draft amount must not be negative; the side carries the sign. Set `side` to `credit` ' +
      'rather than negating a debit.',
  })
  .meta({
    description:
      'The amount on `side`, in minor units. `"0"` while the line is unfinished — an amount of ' +
      'zero carries no side, so a line saved with a side and no amount reads back with neither.',
  });

/**
 * The tags a draft line carries, named by value and never by axis.
 *
 * The same shape `setJournalLineDimensionsRequestSchema` uses for a posted line,
 * and for the same reason: a value belongs to exactly one dimension, so naming
 * the pair makes a mismatched `(axis, value)` expressible, and deriving the axis
 * from the value makes it unrepresentable. Two values on one axis is refused by
 * the service — `PRIMARY KEY (org_id, draft_line_id, dimension_id)` would refuse
 * it anyway, as an opaque duplicate-key error.
 *
 * Bounded by `MAX_DIMENSIONS_PER_ORG` because a line cannot carry more tags than
 * the org has axes; over that, at least two of them are duplicates on one axis.
 */
const draftLineDimensionValueIdsSchema = z
  .array(z.uuid())
  .max(MAX_DIMENSIONS_PER_ORG)
  .meta({
    description:
      'Every dimension value this line carries, after the call. A value names its own axis. An ' +
      'omitted axis is untagged and an empty list clears every tag.',
  });

/**
 * One line of a draft. Every field is optional, including the account.
 *
 * Unlike `journalLineRequestSchema`, this carries a `contactId` and dimension
 * tags: a draft has to be able to hold everything the journal-entry form collects
 * (OB-051), and a draft that dropped them at save would be a worse record of the
 * user's intent than no draft at all.
 */
export const draftLineInputSchema = z
  .strictObject({
    accountId: z.uuid().nullish(),
    contactId: z.uuid().nullish(),
    side: draftSideSchema.nullish(),
    amount: draftAmountSchema.nullish(),
    memo: draftLineMemoSchema.nullish(),
    dimensionValueIds: draftLineDimensionValueIdsSchema.optional(),
  })
  .meta({
    /**
     * `JournalDraftLineRequest` and not `DraftLineInput`, which reads better here and
     * publishes worse: `fastify-type-provider-zod` emits one component per io
     * direction and suffixes the request side with `Input`, so that id becomes a
     * `DraftLineInputInput` in the artifact. The name chosen is the one
     * `JournalLineRequest` already set for the posting body.
     */
    id: 'JournalDraftLineRequest',
    description:
      'One line in progress. An unknown or another organization’s `accountId`, `contactId`, or ' +
      'dimension value is a `not_found`, not a validation failure.',
  });

export type DraftLineInput = z.infer<typeof draftLineInputSchema>;

/**
 * A draft line as stored, read back rather than echoed.
 *
 * `lineId` is a string for the reason `postedJournalLineSchema` gives: the column
 * is a `BIGINT` and a JSON number cannot carry one past 2^53 (D-13's argument
 * applied to an identifier). `side` is derived from which amount column is
 * non-zero, so a line whose amount is `"0"` reads back with `side: null` whatever
 * was sent — the table has no column for a side without an amount, and inventing
 * one would be a second place a line's meaning is recorded.
 */
export const journalDraftLineSchema = z
  .strictObject({
    lineId: z.string(),
    lineNumber: z.int(),
    accountId: z.uuid().nullable(),
    contactId: z.uuid().nullable(),
    side: draftSideSchema.nullable(),
    amount: draftAmountSchema,
    memo: z.string().nullable(),
    dimensionValueIds: z.array(z.uuid()),
  })
  .meta({
    id: 'JournalDraftLine',
    description: 'One stored draft line, read back rather than echoed.',
  });

export type JournalDraftLine = z.infer<typeof journalDraftLineSchema>;

/**
 * A draft as the API returns it.
 *
 * Two absences are the decisions worth reading (both argued in `0002_ledger`):
 *
 *  - **No sequence number.** Numbers come from the counter row at post time
 *    (D-14), and a draft that reserved one and was then discarded would leave a
 *    gap — which is indistinguishable from a deleted entry, the exact ambiguity
 *    the append-only design exists to remove.
 *  - **No period.** The period is resolved from `entryDate` at post, so a draft
 *    written in an open period and posted after it closed cannot carry a stale
 *    answer.
 *
 * `createdByUserId` records who *drafted*. Who *posted* is the journal's actor
 * triple, set from the caller at post — the fact an auditor asks about.
 */
export const journalDraftSchema = z
  .strictObject({
    id: z.uuid(),
    entryDate: calendarDateSchema.nullable(),
    memo: z.string().nullable(),
    reference: z.string().nullable(),
    createdByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lines: z.array(journalDraftLineSchema),
  })
  .meta({
    id: 'JournalDraft',
    description:
      'An entry that has not reached the ledger. It is in no report and no trial balance, carries ' +
      'no sequence number and no period, and may be edited or discarded freely (D-19).',
  });

export type JournalDraft = z.infer<typeof journalDraftSchema>;

/**
 * A draft in a list: the header, and no lines.
 *
 * The argument is `journalSummarySchema`'s. Embedding lines would make the size
 * of one page depend on how many lines an org's drafts happen to carry, which is
 * the property the page-size bound exists to remove.
 */
export const journalDraftSummarySchema = z
  .strictObject({
    id: z.uuid(),
    entryDate: calendarDateSchema.nullable(),
    memo: z.string().nullable(),
    reference: z.string().nullable(),
    createdByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'JournalDraftSummary',
    description: 'A draft in a list: the header, and no lines.',
  });

export type JournalDraftSummary = z.infer<typeof journalDraftSummarySchema>;

/**
 * Creates a draft. Every field is optional, including `lines`.
 *
 * An empty draft is a legitimate thing to create — it is what a "New entry"
 * button produces, before the user has typed anything — so there is no
 * `.refine()` demanding a field here. The refusals a draft can earn are refusals
 * about *references*: an account or contact that does not exist in this org.
 */
export const createDraftRequestSchema = z
  .strictObject({
    entryDate: calendarDateSchema.nullish(),
    memo: draftMemoSchema.nullish(),
    reference: draftReferenceSchema.nullish(),
    lines: z.array(draftLineInputSchema).max(DRAFT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateDraftRequest',
    description:
      'Creates one draft. Nothing is required: a draft holds whatever has been entered so far, ' +
      'and everything is checked when it is posted.',
  });

export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;

/**
 * Partial update of the header; `lines`, when present, **replaces the whole set**.
 *
 * Replacement rather than per-line patching, because the client is a form: it
 * holds the current state of every line and sends it. Patching would need stable
 * line identities across an edit that inserts a line in the middle, and the
 * renumbering that follows would make `lineNumber` — the only thing ordering the
 * lines — mean something different before and after the call.
 *
 * `lines: []` therefore clears every line, and an absent `lines` leaves them
 * alone. That asymmetry is the same one `null`-clears-versus-absent-leaves gives
 * the nullable header fields.
 */
export const updateDraftRequestSchema = z
  .strictObject({
    entryDate: calendarDateSchema.nullish(),
    memo: draftMemoSchema.nullish(),
    reference: draftReferenceSchema.nullish(),
    lines: z.array(draftLineInputSchema).max(DRAFT_MAX_LINES).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateDraftRequest',
    description:
      'Partial update. An absent field is unchanged, `null` clears a header field, and `lines` ' +
      'replaces the whole set — send every line the draft should have, including the unchanged ' +
      'ones.',
  });

export type UpdateDraftRequest = z.infer<typeof updateDraftRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 *
 * `createdByUserId` reads `idx_journal_drafts_org_author` and answers the one
 * question a drafts screen actually asks — "what have I got in progress" — which
 * would otherwise be a client-side filter over a paged list, and therefore wrong
 * at every page boundary.
 */
export const listDraftsQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    createdByUserId: z.uuid().optional(),
  })
  .meta({
    description:
      'Omitting `createdByUserId` lists every draft in the org. Drafts are visible to anyone ' +
      'who can read journals; they are not private to their author.',
  });

/**
 * The *input* type, not `z.infer`: `limit` carries a `.default()`, so the parsed
 * output has it and a caller does not — two different types under
 * `exactOptionalPropertyTypes`.
 */
export type ListDraftsQuery = z.input<typeof listDraftsQuerySchema>;

/**
 * Ordered by `(created_at, id)` — `idx_journal_drafts_org_created`. Neither of the
 * journal list's columns is available: a draft has no sequence number by
 * construction, and its `entry_date` is nullable, so neither is total.
 */
export const journalDraftPageSchema = pageSchema(journalDraftSummarySchema, {
  id: 'JournalDraftPage',
  description:
    'One page of the org’s drafts, oldest first by creation. Drafts are visible to anyone who ' +
    'can read journals; they are not private to their author.',
});

export type JournalDraftPage = z.infer<typeof journalDraftPageSchema>;
