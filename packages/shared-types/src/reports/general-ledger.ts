import { z } from 'zod';

import { ACCOUNT_TYPES, NORMAL_BALANCES } from '../accounts';
import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { calendarDateSchema, minorUnitsSchema, pageCursorSchema, pageQueryShape } from '../wire';

import { reportDimensionFilterSchema, reportRangeShape } from './balances';
import { reportGroupKeyShape } from './groups';

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
 * ## The `id`s
 *
 * `GET /v1/reports/general-ledger` is OB-045's, so the response schemas below now
 * carry the ids OB-044 deliberately withheld. `generalLedgerQuerySchema` carries
 * none and must not: a querystring is emitted as individual `parameters`, so a
 * component for it would be referenced by nothing.
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

const glAmountsSchema = z
  .strictObject({
    debits: minorUnitsSchema,
    credits: minorUnitsSchema,
    balance: minorUnitsSchema.meta({
      description: '`debits - credits`. Negative means the account is net credit.',
    }),
  })
  .meta({
    id: 'GeneralLedgerAmounts',
    description:
      'Debits, credits, and their difference over one window. The three windows a ledger page ' +
      'reports — opening, movement, closing — are the same shape, so they are one component.',
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
export const generalLedgerCounterpartySchema = z
  .strictObject({
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
  })
  .meta({ id: 'GeneralLedgerCounterparty' });

/**
 * One dimension value a line carries, qualified by the axis it sits on.
 *
 * `reportGroupKeyShape` spread rather than referenced: a tag names both halves of
 * the pair, where a grouped report's key is already qualified by the report's own
 * `groupBy`. Composing this as an `allOf` over `ReportGroupKey` would publish a
 * two-part schema that says nothing a reader of one entry needs, so the shared
 * fields are spread and this stays one flat component. See `groups.ts`.
 */
export const generalLedgerTagSchema = z
  .strictObject({
    dimensionId: z.uuid(),
    dimensionCode: z.string(),
    ...reportGroupKeyShape,
  })
  .meta({
    id: 'GeneralLedgerTag',
    description: 'A dimension value carried by this line, with the axis it belongs to.',
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
export const generalLedgerEntrySchema = z
  .strictObject({
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
  })
  .meta({ id: 'GeneralLedgerEntry' });

export type GeneralLedgerEntry = z.infer<typeof generalLedgerEntrySchema>;

/**
 * One page of a general ledger: the account, the three totals, and the entries.
 *
 * ## Why this is not the `{ items, nextCursor }` envelope (OB-045)
 *
 * D-21 gives every *list* one envelope, and six endpoints use it. This one
 * deliberately does not, and the reason is that a general ledger page is not a
 * list — it is a report that contains one. The account it is about, the range that
 * was applied, and the three balances are the subject; the entries are the working
 * that explains them, and the header is recomputed per page precisely so a client
 * can see the ledger move underneath it. A page whose sole key was `items` would
 * have nowhere to put any of that.
 *
 * Forcing the envelope was the alternative and it produces something worse in both
 * available forms: the header inside every item repeats a report per row, and the
 * header beside `items` is this shape with the entries renamed — the same object,
 * naming the one part of it that is a list after the whole. So the *protocol* is
 * shared and the *shape* is not: `nextCursor` is the same opaque `PageCursor`,
 * with the same meaning and the same rule about a full page not implying another,
 * so a client that has learned to page any other collection pages this one
 * unchanged. What it must not do is assume `items`.
 */
export const generalLedgerSchema = z
  .strictObject({
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
    nextCursor: pageCursorSchema.nullable().meta({
      description:
        'The cursor for the next page, or null when this is the last one. Opaque: send it back ' +
        'verbatim. A full page does not imply another exists. The same token every other list ' +
        'endpoint returns — only the key it sits beside differs.',
    }),
  })
  .meta({
    id: 'GeneralLedger',
    description:
      'One account over a date range: the balance it was carrying, one page of the lines that ' +
      'moved it, and the balance it ended on. The three balances are recomputed on every page, ' +
      'so a client can tell that the ledger moved between two fetches.',
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
