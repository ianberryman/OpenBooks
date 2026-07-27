import type {
  Aging,
  AgingAmounts,
  AgingBucket,
  AgingDetailType,
  AgingDocument,
  AgingQueryParams,
  AgingRow,
} from '@openbooks/shared-types';
import {
  AGING_BUCKETS,
  AGING_BUCKET_UPPER_BOUNDS,
  agingQuerySchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid } from '../../db';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { AgingDocumentRow, AgingPaymentRow } from './aging.repository';
import { selectApDocuments, selectArDocuments, selectPayments } from './aging.repository';
import { orgScope, resolveContact } from './balances.repository';

/**
 * Aging, and the per-contact statement (OB-065; ROADMAP D-34, D-37, D-39, D-40,
 * acceptance C8).
 *
 * What a business is owed and what it owes, split by how late it is, as at a date.
 * `aging.repository.ts` holds the as-at rule and why it is three date predicates
 * rather than one; this file holds the arithmetic and, in particular, the part of
 * it that C8 depends on and that is easy to leave out.
 *
 * ## What makes the buckets tie to the control account
 *
 * D-40 requires that the buckets sum to the control account's balance at the date,
 * and an aging report built only from unpaid invoices does not. Take the receivable
 * side and write the control account out:
 *
 * ```
 *   AR control (debits − credits)  =  Σ invoices − Σ credit notes − Σ payments received
 *   Σ invoice outstanding          =  Σ invoices − Σ allocations
 * ```
 *
 * The difference between them is `Σ credit notes + Σ payments − Σ allocations`,
 * which is precisely the credit that has been posted to the ledger and not yet
 * applied to anything: the unapplied credit note and the payment on account that
 * D-37 says is "a credit balance on the contact, applicable later". It is real
 * money already sitting in the control account, and an aging report that omits it
 * overstates what the business is owed by exactly that amount.
 *
 * So the report carries it, as a **negative amount in `current`** on the contact
 * holding it. `current` because a credit is not overdue — nobody is chasing it, and
 * `0005_subledger` makes `due_date` null on a credit note for that reason. Negative
 * because it reduces what is owed. With it in, the total is
 * `Σ invoices − Σ credit notes − Σ payments`, which is the control account exactly,
 * and C8 becomes a comparison of two numbers rather than a comparison with an
 * adjustment computed from the same subledger being tested.
 *
 * The payable side is the mirror: bills positive, unapplied vendor credits and
 * payments made negative, and the total is the AP control account's balance with
 * its sign flipped, because a payable is a credit-normal account.
 *
 * ## What the wire contract cannot say, and where that leaves the detail rows
 *
 * `agingDocumentSchema`'s `documentType` is `ALLOCATION_TARGET_TYPES` — invoice and
 * bill, "the two documents that carry an amount owed" — and its `dueDate` is not
 * nullable. So an unapplied credit has no representable detail row, and on a
 * contact holding one the `documents` array sums to *more* than that contact's
 * `amounts.total`. That is stated here rather than hidden by netting the credit
 * across the open invoices: netting would invent an allocation nobody made, change
 * which bucket money sits in, and make the report disagree with the invoice's own
 * outstanding amount everywhere else in the system (D-34 — outstanding has one
 * definition, total minus allocations). A gap a reader can see is better than an
 * arithmetic the data does not support. OB-067 should carry this into the response
 * documentation, and a later contract revision may add an explicit unapplied-credit
 * row rather than widen the enum.
 *
 * ## The statement
 *
 * There is no second report for "what does this customer owe and since when". It is
 * this one with `contactId` and `detail` set: the same buckets, the same as-at
 * rule, and the open documents behind them with their own dates and ages. A second
 * endpoint would be a second definition of outstanding, which is the divergence
 * D-34 exists to prevent.
 *
 * ## Permission
 *
 * `reports.read`, and only that — the same key every other report in this module
 * takes. Not `invoices.read` in addition for the receivable side, though the seeded
 * roles do draw an AR/AP line: `ap_only` holds `reports.read` and `journals.read`
 * already, so it can read the AR control account's general ledger, contact by
 * contact, with amounts and dates. The document number is the only thing this
 * report adds to what that role can already see, which is not a boundary worth
 * making the one report in the system that checks two permissions — and a second
 * check would leave `RouteDefinition.permission`, which names exactly one key,
 * describing half of the enforcement to OB-067's clients.
 */

export type AgingQuery = AgingQueryParams;

/**
 * The bucket list and the boundary list have to stay one apart: four upper bounds
 * name five buckets, and `bucketFor` indexes one by the other. Asserting it in the
 * type system makes an edit to `shared-types` that adds a boundary without adding a
 * bucket a compile error here rather than a silent `undefined` at the top bucket.
 */
type AssertBucketCount<_N extends 5> = true;
type AssertBoundCount<_N extends 4> = true;
export type _AgingBucketCount = AssertBucketCount<(typeof AGING_BUCKETS)['length']>;
export type _AgingBoundCount = AssertBoundCount<(typeof AGING_BUCKET_UPPER_BOUNDS)['length']>;

/**
 * Aging as at a date, for one ledger.
 *
 * Nothing takes a transaction — `src/db/transaction-scope.ts` propagates one
 * ambiently — and the org comes from the context, so there is no signature here
 * into which another org's id could be passed (spec §4).
 */
export async function getAging(
  query: AgingQuery,
  ctx: RequestContext = getContext('getAging()'),
): Promise<Aging> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(agingQuerySchema, query);

  const db = orgScope(ctx);
  // Resolved rather than passed through, for `balances.repository.ts`'s reason: an
  // id this org does not own would otherwise filter to nothing and report a
  // customer who owes zero, which is a number someone might act on. Through
  // `assertFound` it is one indistinguishable 404 (A7).
  const contactId =
    request.contactId === undefined ? null : await resolveContact(db, request.contactId);

  const sources =
    request.ledger === 'receivable'
      ? await readReceivable(db, request.asOf, contactId)
      : await readPayable(db, request.asOf, contactId);

  return assemble(sources, {
    asOf: request.asOf,
    ledger: request.ledger,
    detail: request.detail ?? false,
    includeZero: request.includeZero ?? false,
  });
}

/**
 * The three reads one side of the subledger is made of: what is owed, what has been
 * credited against it, and what has been paid on account.
 *
 * Concurrent because they share no state and neither refuses anything — every id a
 * caller can name was resolved before this point, so there is no first-refusal
 * ordering to preserve of the kind `resolveSpec` in `balances.service.ts` is
 * careful about.
 */
interface AgingSources {
  readonly targets: readonly AgingDocumentRow[];
  readonly credits: readonly AgingDocumentRow[];
  readonly payments: readonly AgingPaymentRow[];
}

async function readReceivable(
  db: TenantDatabase,
  asOf: string,
  contactId: Buffer | null,
): Promise<AgingSources> {
  const [targets, credits, payments] = await Promise.all([
    selectArDocuments(db, {
      asOf,
      documentType: 'invoice',
      allocationLink: 'invoice_id',
      contactId,
    }),
    selectArDocuments(db, {
      asOf,
      documentType: 'credit_note',
      allocationLink: 'credit_note_id',
      contactId,
    }),
    selectPayments(db, { asOf, direction: 'received', allocations: 'ar_allocations', contactId }),
  ]);

  return { targets, credits, payments };
}

async function readPayable(
  db: TenantDatabase,
  asOf: string,
  contactId: Buffer | null,
): Promise<AgingSources> {
  const [targets, credits, payments] = await Promise.all([
    selectApDocuments(db, { asOf, documentType: 'bill', allocationLink: 'bill_id', contactId }),
    selectApDocuments(db, {
      asOf,
      documentType: 'vendor_credit',
      allocationLink: 'vendor_credit_id',
      contactId,
    }),
    selectPayments(db, { asOf, direction: 'paid', allocations: 'ap_allocations', contactId }),
  ]);

  return { targets, credits, payments };
}

interface Assembly {
  readonly asOf: string;
  readonly ledger: Aging['ledger'];
  readonly detail: boolean;
  readonly includeZero: boolean;
}

type Buckets = Record<AgingBucket, bigint>;

const ZERO_BUCKETS: Buckets = {
  current: 0n,
  days1To30: 0n,
  days31To60: 0n,
  days61To90: 0n,
  days90Plus: 0n,
};

interface ContactAging {
  readonly contactId: string;
  readonly contactName: string;
  readonly buckets: Buckets;
  readonly documents: AgingDocument[];
}

function assemble(sources: AgingSources, into: Assembly): Aging {
  const contacts = new Map<string, ContactAging>();

  for (const row of sources.targets) {
    const outstanding = row.total - row.allocated;
    const contact = contactFor(contacts, row.contactId, row.contactName);
    const dueDate = requireDueDate(row);
    const daysPastDue = daysBetween(dueDate, into.asOf);
    const bucket = bucketFor(daysPastDue);

    contact.buckets[bucket] += outstanding;

    // A settled document is not aging. It is dropped from the detail whatever
    // `includeZero` says, because that flag is about contacts — a contact who has
    // paid is still a contact, an invoice that has been paid is not an open item.
    if (into.detail && outstanding !== 0n) {
      contact.documents.push({
        documentType: into.ledger === 'receivable' ? 'invoice' : 'bill',
        documentId: bufferToUuid(row.documentId),
        documentNumber: requireNumber(row).toString(),
        reference: row.reference,
        issueDate: row.issueDate,
        dueDate,
        total: row.total.toString(),
        outstanding: outstanding.toString(),
        daysPastDue,
        bucket,
      });
    }
  }

  // Credit notes, vendor credits and payments on account, as negatives in
  // `current`. See the file header: without them the total is not the control
  // account's balance, which is the whole of C8.
  const creditType = into.ledger === 'receivable' ? 'credit_note' : 'vendor_credit';

  for (const row of sources.credits) {
    const unapplied = row.total - row.allocated;
    const contact = contactFor(contacts, row.contactId, row.contactName);
    contact.buckets.current -= unapplied;

    if (into.detail && unapplied !== 0n) {
      contact.documents.push(
        creditRow({
          documentType: creditType,
          documentId: row.documentId,
          documentNumber: requireNumber(row).toString(),
          reference: row.reference,
          issueDate: row.issueDate,
          total: row.total,
          unapplied,
        }),
      );
    }
  }

  for (const row of sources.payments) {
    const unapplied = row.amount - row.allocated;
    const contact = contactFor(contacts, row.contactId, row.contactName);
    contact.buckets.current -= unapplied;

    if (into.detail && unapplied !== 0n) {
      contact.documents.push(
        creditRow({
          documentType: 'payment',
          documentId: row.paymentId,
          documentNumber: row.sequenceNumber.toString(),
          reference: row.reference,
          issueDate: row.paymentDate,
          total: row.amount,
          unapplied,
        }),
      );
    }
  }

  const rows = [...contacts.values()]
    .filter((contact) => into.includeZero || !isEmpty(contact.buckets))
    .sort(compareContacts)
    .map((contact) => toRow(contact, into));

  return {
    asOf: into.asOf,
    ledger: into.ledger,
    rows,
    totals: toAmounts(sumBuckets(rows)),
  };
}

function contactFor(
  contacts: Map<string, ContactAging>,
  contactId: Buffer,
  contactName: string,
): ContactAging {
  const key = contactId.toString('hex');
  const existing = contacts.get(key);
  if (existing !== undefined) return existing;

  const created: ContactAging = {
    contactId: bufferToUuid(contactId),
    contactName,
    buckets: { ...ZERO_BUCKETS },
    documents: [],
  };
  contacts.set(key, created);
  return created;
}

/**
 * Dropped when every bucket is zero, not when the total is.
 *
 * The distinction matters and it is the same one `bucketIsEmpty` draws in
 * `balances.service.ts`: a contact with an open invoice and an offsetting payment on
 * account nets to zero while holding two non-zero buckets, and dropping that row
 * would change the report's per-bucket totals — which is C8 being false one column
 * at a time while the grand total still ties. Dropping a row whose every bucket is
 * zero changes no sum at all.
 */
function isEmpty(buckets: Buckets): boolean {
  return AGING_BUCKETS.every((bucket) => buckets[bucket] === 0n);
}

/**
 * Contact name, then id.
 *
 * The id is not decoration: two contacts may legitimately share a display name
 * (`contacts` has no unique key on it), and an aging report whose row order depends
 * on which of them the database returned first is not reproducible in the sense
 * D-40 requires of the figures.
 */
function compareContacts(left: ContactAging, right: ContactAging): number {
  if (left.contactName !== right.contactName) {
    return left.contactName < right.contactName ? -1 : 1;
  }
  return left.contactId < right.contactId ? -1 : left.contactId > right.contactId ? 1 : 0;
}

function toRow(contact: ContactAging, into: Assembly): AgingRow {
  return {
    contactId: contact.contactId,
    contactName: contact.contactName,
    amounts: toAmounts(contact.buckets),
    // `null` rather than absent when detail was not asked for: a field that is
    // sometimes missing and sometimes present is two shapes, and under
    // `exactOptionalPropertyTypes` it is two types.
    documents: into.detail ? [...contact.documents].sort(compareDocuments) : null,
  };
}

/**
 * One unapplied credit, as a detail row.
 *
 * The two amounts are **negated**, matching the sign the credit contributes to
 * `current` two lines above. `agingDocumentSchema` argues why that is the right
 * shape: it makes the `documents` array sum to `amounts.total`, which is the
 * property the array did not have while a credit had no representable row — on a
 * contact holding one, the detail summed to more than the total printed above it.
 *
 * `dueDate` and `daysPastDue` are null, and `bucket` is `current`. A credit is
 * allocated rather than chased — `0005_subledger` makes `due_date` NULL on a credit
 * note for exactly that reason, and a payment has no due date to have. Zero would
 * read as "due today", which is a different and false statement.
 */
function creditRow(credit: {
  readonly documentType: AgingDetailType;
  readonly documentId: Buffer;
  readonly documentNumber: string;
  readonly reference: string | null;
  readonly issueDate: string;
  readonly total: bigint;
  readonly unapplied: bigint;
}): AgingDocument {
  return {
    documentType: credit.documentType,
    documentId: bufferToUuid(credit.documentId),
    documentNumber: credit.documentNumber,
    reference: credit.reference,
    issueDate: credit.issueDate,
    dueDate: null,
    total: (-credit.total).toString(),
    outstanding: (-credit.unapplied).toString(),
    daysPastDue: null,
    bucket: 'current',
  };
}

/**
 * Oldest first, which is the order the person chasing them works in — and the
 * credits last, because nobody chases them.
 *
 * A null `dueDate` sorts after every date rather than before every one, which is
 * the opposite of what a string comparison would do with a null coerced to the
 * empty string. Credits are what carry it, and a page opening with three unapplied
 * receipts before the overdue invoice it is about is the wrong first line.
 */
function compareDocuments(left: AgingDocument, right: AgingDocument): number {
  if (left.dueDate !== right.dueDate) {
    if (left.dueDate === null) return 1;
    if (right.dueDate === null) return -1;
    return left.dueDate < right.dueDate ? -1 : 1;
  }
  return left.documentNumber < right.documentNumber ? -1 : 1;
}

function sumBuckets(rows: readonly AgingRow[]): Buckets {
  const totals: Buckets = { ...ZERO_BUCKETS };

  for (const row of rows) {
    for (const bucket of AGING_BUCKETS) {
      totals[bucket] += BigInt(row.amounts[bucket]);
    }
  }

  return totals;
}

/** D-13's single conversion out: `bigint` minor units become cents-only strings here. */
function toAmounts(buckets: Buckets): AgingAmounts {
  let total = 0n;
  for (const bucket of AGING_BUCKETS) total += buckets[bucket];

  return {
    current: buckets.current.toString(),
    days1To30: buckets.days1To30.toString(),
    days31To60: buckets.days31To60.toString(),
    days61To90: buckets.days61To90.toString(),
    days90Plus: buckets.days90Plus.toString(),
    total: total.toString(),
  };
}

/**
 * Which bucket a number of days past due falls in.
 *
 * Driven by `AGING_BUCKET_UPPER_BOUNDS` rather than by five hand-written
 * comparisons, because `shared-types` publishes those bounds as data precisely so
 * that "31–60" cannot mean one thing in the report and another on the page that
 * prints the heading. Zero and below is `current`: due today is not yet overdue.
 */
function bucketFor(daysPastDue: number): AgingBucket {
  const index = AGING_BUCKET_UPPER_BOUNDS.findIndex((bound) => daysPastDue <= bound);
  const bucket = AGING_BUCKETS[index === -1 ? AGING_BUCKETS.length - 1 : index];

  if (bucket === undefined) {
    throw new InternalError(
      'The aging bucket list is shorter than its boundary list, so a document past due has no ' +
        'bucket to fall in.',
    );
  }

  return bucket;
}

/**
 * Whole days between two calendar dates, `to − from`.
 *
 * Built through `Date.UTC` from the parsed parts rather than by parsing the string
 * into a local `Date`. A calendar date has no timezone — which is why
 * `scripts/codegen.mjs` maps `DATE` to `string` rather than to `Date` — and a local
 * midnight subtraction spans 23 or 25 hours across a DST boundary, so the quotient
 * is 29.958 days where 30 is meant. `Math.round` rescues that particular case, and
 * that is the objection: the arithmetic would then be correct because of a rounding
 * step rather than because the subtraction means anything, on the boundary between
 * two buckets a business chases its money by. In UTC the quotient is the integer.
 */
const MILLISECONDS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / MILLISECONDS_PER_DAY);
}

function toUtcMillis(date: string): number {
  const [year, month, day] = date.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // `calendarDateSchema` has already parsed everything a caller can send, and the
    // stored side is a MySQL `DATE`. A malformed value here is a fault in this
    // process rather than input.
    throw new InternalError(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }

  return Date.UTC(year, month - 1, day);
}

function requireDueDate(row: AgingDocumentRow): string {
  if (row.dueDate === null) {
    // `chk_ar_documents_invoice_due` and `chk_ap_documents_bill_due` require a due
    // date on an approved invoice or bill, and this query inner-joins the posting
    // journal, so every row it returns is approved.
    throw new InternalError(
      'An approved invoice or bill has no due date, which chk_ar_documents_invoice_due makes ' +
        'unrepresentable.',
    );
  }

  return row.dueDate;
}

function requireNumber(row: AgingDocumentRow): bigint {
  if (row.sequenceNumber === null) {
    // `chk_ar_documents_approved` ties the number to the journal in both
    // directions, so an approved document without one is a schema violation.
    throw new InternalError(
      'An approved document carries no sequence number, which chk_ar_documents_approved makes ' +
        'unrepresentable.',
    );
  }

  return row.sequenceNumber;
}
