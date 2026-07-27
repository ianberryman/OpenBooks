import { z } from 'zod';

import { ACCOUNT_TYPES, NORMAL_BALANCES } from '../accounts';
import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { calendarDateSchema, minorUnitsSchema, pageQueryShape } from '../wire';

import { reportDimensionFilterSchema, reportRangeShape } from './balances';

/**
 * The general ledger wire contract (OB-044; acceptance B4, B6; D-13, D-14, D-21).
 *
 * One account, one date range: the balance it was carrying, the individual lines
 * that moved it in order, and the balance it ended on. `balances.ts` next door
 * carries the query every M2 report shares; this file carries the half of the
 * general ledger that is unlike the other two reports — a *list*, and therefore a
 * page and a cursor.
 *
 * ## Why the header rides on every page
 *
 * `opening`, `movement` and `closing` come from the report core and are the same
 * three numbers on page one and page nine, so repeating them looks wasteful. They
 * are repeated anyway, and the reason is the one thing paging a ledger cannot be
 * made to hide: the ledger changes while a client pages it. A back-dated entry
 * posted between two fetches moves `closing`, and a page that carried no header
 * would let a client hold page one's totals against page nine's lines with nothing
 * in either response saying they no longer belong together. Recomputed per page,
 * the totals are a true statement about the ledger at the moment that page was
 * read, and a client comparing two pages' headers can *see* that it moved.
 *
 * ## Why nothing here carries `.meta({ id })`
 *
 * The same reason `balances.ts` gives: the transform lifts every schema carrying
 * an `id` into `components.schemas` whether a route references it or not, and A10
 * makes drift in `openapi.json` a build failure. OB-044 ends at the service.
 * Transport is OB-045, and the ids belong to it.
 */

/**
 * The most counterparty accounts one entry lists before it stops naming them.
 *
 * A journal has no bound on its line count, so the other side of a line has no
 * bound either, and an allocation across forty departments would otherwise put
 * forty account names on one row of a ledger. Eight is above every ordinary split
 * — a payment run, a payroll journal, a rent allocation — and `accountCount`
 * carries the truth when the list is short of it, so a client never has to guess
 * whether it is looking at all of them.
 */
export const GL_COUNTERPARTY_ACCOUNTS_MAX = 8;

const glAmountsSchema = z.strictObject({
  debits: minorUnitsSchema,
  credits: minorUnitsSchema,
  balance: minorUnitsSchema.meta({
    description: '`debits - credits`. Negative means the account is net credit.',
  }),
});

const glAccountRefSchema = z.strictObject({
  accountId: z.uuid(),
  code: z.string(),
  name: z.string(),
});

/**
 * The accounts on the **opposite side** of this line's journal.
 *
 * "The other side" is a choice, and on a journal with more than two lines it is
 * the choice that decides whether a general ledger is readable or useless. Three
 * readings were available: every other line of the journal, every other line
 * touching a different account, or the lines on the opposite debit/credit side.
 * This is the third.
 *
 * The reason is what double entry actually asserts. A rent journal that debits
 * three departments and credits one bank account is one economic event: each
 * department's debit is explained by the bank credit, and it is explained by
 * nothing at all by the other two departments' debits. Under "every other line",
 * a reader of the Rent — Sales account would see Rent — Support and Rent —
 * Operations named as the contra, which is precisely backwards, and would see it
 * on exactly the entries a split makes hardest to follow.
 *
 * What is deliberately *not* here is an amount per counterparty. A journal records
 * that its debits equal its credits; it does not record which debit paid for which
 * credit, and on a three-against-one split there is no such fact to report.
 * Apportioning one would be inventing it. So the strongest true statement is the
 * set of accounts, and `accountCount > 1` is the classic "— Split —".
 *
 * Filters do not narrow this. The other side of a line is a fact about the journal
 * it belongs to, not about the slice being reported, and a contact-filtered ledger
 * whose entries showed no counterparty would be reporting the filter rather than
 * the books.
 */
export const generalLedgerCounterpartySchema = z.strictObject({
  accounts: z
    .array(glAccountRefSchema)
    .max(GL_COUNTERPARTY_ACCOUNTS_MAX)
    .meta({
      description:
        'Distinct accounts on the opposite side of the journal, in account-code order, truncated ' +
        'to at most `GL_COUNTERPARTY_ACCOUNTS_MAX`. Compare against `accountCount` to tell a ' +
        'complete list from a truncated one.',
    }),
  accountCount: z
    .int()
    .nonnegative()
    .meta({
      description:
        'How many distinct accounts are on the opposite side in total. More than one is the ' +
        'classic split entry.',
    }),
});

export const generalLedgerTagSchema = z.strictObject({
  dimensionId: z.uuid(),
  dimensionCode: z.string(),
  dimensionValueId: z.uuid(),
  code: z.string(),
  name: z.string(),
});

/**
 * One journal line against the account, and the balance it left behind.
 *
 * `runningBalance` is `opening.balance` plus every entry up to and including this
 * one, in `(date, sequenceNumber, lineId)` order — always `debits - credits`, and
 * never flipped to the account's normal side. The core states the same convention
 * for the same reason: which direction reads as "positive" is a presentation
 * decision, and a number whose sign depends on the account it is attached to
 * cannot be summed by a caller that did not also fetch the account.
 *
 * The last entry of the last page therefore satisfies `runningBalance ===
 * closing.balance`, which is acceptance B4 restated at the level a reader checks
 * it: the bottom of the column equals the figure at the bottom of the page.
 *
 * `lineId` and `sequenceNumber` are strings because both are `BIGINT` — D-13's
 * argument about a JSON parser's silent 2^53 ceiling, applied to an identifier.
 */
export const generalLedgerEntrySchema = z.strictObject({
  lineId: z.string(),
  journalId: z.uuid(),
  sequenceNumber: z.string().meta({
    description:
      'The org’s own gapless entry number (D-14), and the second column of this list’s ' +
      'ordering — `date` alone does not order two entries made on the same day.',
  }),
  lineNumber: z.int().positive(),
  date: calendarDateSchema,
  journalMemo: z.string().nullable(),
  lineMemo: z.string().nullable(),
  contact: z
    .strictObject({ contactId: z.uuid(), displayName: z.string() })
    .nullable()
    .meta({
      description:
        'Who the amount is with, when the line names anyone. Not a statement that the amount is ' +
        'receivable or payable — that is the subledger’s, and the subledger is M3.',
    }),
  debit: minorUnitsSchema,
  credit: minorUnitsSchema,
  runningBalance: minorUnitsSchema.meta({
    description:
      '`opening.balance` plus every entry through this one, as `debits - credits`. See the ' +
      'note on the page: a running balance is a statement about the ledger at the moment the ' +
      'page was read.',
  }),
  counterparty: generalLedgerCounterpartySchema,
  tags: z.array(generalLedgerTagSchema).meta({
    description:
      'Every dimension value this line carries, in dimension-code then value-code order.',
  }),
});

export type GeneralLedgerEntry = z.infer<typeof generalLedgerEntrySchema>;

/**
 * One page of a general ledger: the account, the three totals, and the entries.
 *
 * The envelope is written out rather than built with `pageSchema`, because that
 * factory requires the `.meta({ id })` this file must not carry. `items` is
 * `entries` for the same reason it is `items` everywhere else — this response is
 * not only a list, and a page whose sole key was `items` would have nowhere to put
 * the balances the list exists to explain.
 */
export const generalLedgerSchema = z.strictObject({
  accountId: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  normalBalance: z.enum(NORMAL_BALANCES),
  from: calendarDateSchema.nullable().meta({
    description:
      'The inclusive lower bound applied, or null when the range starts at the ledger’s beginning.',
  }),
  to: calendarDateSchema.nullable().meta({
    description: 'The inclusive upper bound applied, or null when every posting to date is in.',
  }),
  opening: glAmountsSchema.meta({
    description:
      'Postings strictly before `from`, under the same filters. All zero when `from` is absent.',
  }),
  movement: glAmountsSchema.meta({
    description:
      'Postings inside the range, both bounds inclusive — the entries this page is a window on.',
  }),
  closing: glAmountsSchema.meta({ description: '`opening + movement` (B4).' }),
  entries: z.array(generalLedgerEntrySchema),
  nextCursor: z
    .string()
    .nullable()
    .meta({
      description:
        'The cursor for the next page, or null when this is the last one. Opaque: send it back ' +
        'verbatim. A full page does not imply another exists.',
    }),
});

export type GeneralLedger = z.infer<typeof generalLedgerSchema>;

/**
 * The query: one account, the shared report range, the shared filters that mean
 * something for a single account, and a page.
 *
 * `types` and `groupBy` are the two parts of `reportSliceShape` that are left out,
 * and both for the same reason — this report has already named the one account it
 * is about. An account-type filter can only either agree with that account or
 * empty the report, and a `groupBy` axis would divide a list of individual lines
 * into columns, which is a cross-tabulation and not a ledger. The dimension and
 * contact filters are restated from `reportSliceShape` rather than spread, because
 * spreading and then omitting two keys is a `strictObject` that silently accepts
 * whatever a later ticket adds to the shared shape.
 *
 * B6 lands here as it lands on the core: this ledger run once per value of an axis
 * plus once with `includeUnassigned` covers every entry exactly once, so the runs'
 * movements sum to the unfiltered movement. That is why `includeUnassigned` is on
 * the filter at all — it is the drill-through from the unassigned bucket D-18
 * requires every grouped report to show, and no list of value ids can express it.
 */
export const generalLedgerQuerySchema = z
  .strictObject({
    accountId: z.uuid(),
    ...reportRangeShape,
    contactId: z.uuid().optional(),
    dimensions: z.array(reportDimensionFilterSchema).max(MAX_DIMENSIONS_PER_ORG).optional(),
    ...pageQueryShape,
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    error: 'The range ends before it starts.',
    path: ['to'],
  })
  .refine(
    (query) =>
      query.dimensions === undefined ||
      new Set(query.dimensions.map((filter) => filter.dimensionId)).size ===
        query.dimensions.length,
    {
      error:
        'Two filters name the same dimension. A line carries at most one value per axis, so ' +
        'filtering the same axis twice matches nothing — send one filter listing every value ' +
        'that should be included.',
      path: ['dimensions'],
    },
  )
  .meta({
    description:
      'One account over an inclusive date range, oldest first by entry date and then by the ' +
      'org’s entry number. Omitting `from` starts at the ledger’s beginning, so there is no ' +
      'opening balance; omitting `to` includes every posting to date.',
  });

export type GeneralLedgerQueryParams = z.infer<typeof generalLedgerQuerySchema>;
export type GeneralLedgerQueryInput = z.input<typeof generalLedgerQuerySchema>;
