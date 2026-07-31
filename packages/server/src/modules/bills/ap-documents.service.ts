import type { JournalLineInput, PostJournalInput, PostedJournal } from '@openbooks/plugin-api';
import type {
  Allocation,
  DocumentLine,
  DocumentLineInput,
  DocumentSettlement,
  DocumentStatus,
  DocumentTaxSummaryRow,
  DocumentTotalsResponse,
  VoidDocumentRequest,
} from '@openbooks/shared-types';
import type { Money } from '@openbooks/shared-types/money';
import {
  ZERO,
  add,
  fromMinorString,
  fromMinorUnits,
  subtract,
  sum,
  toMinorString,
  toMinorUnits,
} from '@openbooks/shared-types/money';
import type { Quantity, TaxMode, TaxRate } from '@openbooks/shared-types/tax';
import {
  ZERO_TAX_RATE,
  computeLine,
  quantityFromString,
  quantityFromUnits,
  quantityToString,
  quantityUnits,
  taxRateFromUnits,
  taxRateToPercentString,
} from '@openbooks/shared-types/tax';

import type { RequestContext } from '../../context';
import { bufferToUuid, type TenantDatabase, tryUuidToBuffer } from '../../db';
import type { ValidationIssue } from '../../errors';
import {
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
} from '../../errors';
import { assertCatalogItemsUsable } from '../catalog';
import { resolveTagsForNewLine } from '../dimensions';
import { postJournal, reverseJournal } from '../ledger';
import { resolveControlAccount } from '../settings';

import type {
  AllocationRow,
  ApDocumentLineRow,
  ApDocumentRow,
  ApDocumentType,
  NewApDocumentLineRow,
  TaxRateRow,
} from './ap-documents.repository';
import {
  AP_DOCUMENT_RESOURCE,
  approveDocumentRow,
  claimDocumentNumber,
  replaceDocumentLines,
  selectAccounts,
  selectAllocatedTotals,
  selectAllocationsFor,
  selectApprovedWithReference,
  selectContact,
  selectDocumentByIdForUpdate,
  selectDocumentLines,
  selectDocumentNumbers,
  selectLineDimensions,
  selectLinesForDocuments,
  selectTaxRates,
  voidDocumentRow,
} from './ap-documents.repository';

/**
 * The machinery bills and vendor credits share (OB-063).
 *
 * `bills.service.ts` and `vendor-credits.service.ts` hold the two public surfaces
 * and everything that is genuinely different about them; this file holds the parts
 * where "bill" and "vendor credit" are the same operation pointed in opposite
 * directions. The split is `documents.ts`'s in `shared-types` applied one layer
 * down, and it is drawn where the migration draws it: `ap_documents` is one table
 * because a document holds no financial state, and `document_type` carries the
 * direction.
 *
 * ## The one asymmetry that is not cosmetic: which way the journal runs
 *
 * A **bill** debits what was bought and credits accounts payable. A **vendor
 * credit** does the exact reverse. Getting that backwards is invisible in a total —
 * a balanced journal is balanced either way, and the trial balance still sums to
 * zero — and obvious on a balance sheet, where the payables control account would
 * carry a debit balance and the business would appear to be owed money by every
 * supplier it owes. `journalSides` below is the single place the direction is
 * decided, and `test/bills/direction.test.ts` asserts the *signed* control-account
 * balance rather than the journal's balance, because only the former can fail.
 */

/**
 * `quantity_micros` is scaled by 1,000,000 and `Quantity` is scaled by 10,000.
 *
 * The column was specified as six decimals (`0005_subledger`: "2.5 hours is
 * 2500000") and the shared primitive settled on four (`compute.ts`: "rather than
 * more, because a quantity with more precision than the price it multiplies is
 * precision nobody entered"). The two were written in parallel and disagree.
 *
 * Converting at the storage boundary is the only move available here that does not
 * reimplement the arithmetic: 1,000,000 / 10,000 is exactly 100, so every quantity
 * this service writes round-trips to the unit it came from with no rounding
 * anywhere. The service is the narrower of the two, which is the safe direction —
 * it can never write a value the column cannot hold.
 */
const MICROS_PER_QUANTITY_UNIT = 100n;

// ---------------------------------------------------------------------------
// The view a document reads back as
// ---------------------------------------------------------------------------

/**
 * Everything a bill and a vendor credit have in common on the wire.
 *
 * `billSchema` and `vendorCreditSchema` are this plus or minus `dueDate`, so the
 * two services narrow this rather than assembling their own — one assembly means
 * one answer to "what is outstanding", which is the whole of D-34.
 */
export interface ApDocumentView {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly reference: string | null;
  readonly contactId: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly taxMode: TaxMode;
  readonly status: DocumentStatus;
  readonly memo: string | null;
  readonly lines: readonly DocumentLine[];
  readonly totals: DocumentTotalsResponse;
  readonly taxSummary: readonly DocumentTaxSummaryRow[];
  readonly settlement: DocumentSettlement;
  readonly allocations: readonly Allocation[];
  readonly journalId: string | null;
  readonly voidJournalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The summary form: the header and the numbers, no lines, no allocation detail. */
export interface ApDocumentSummaryView {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly reference: string | null;
  readonly contactId: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly status: DocumentStatus;
  readonly totals: DocumentTotalsResponse;
  readonly settlement: DocumentSettlement;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pricing (D-35)
// ---------------------------------------------------------------------------

/**
 * Turns wire lines into rows, resolving every reference and applying the two
 * roundings D-35 permits.
 *
 * The arithmetic is `shared-types/src/tax/compute.ts` and is not restated here.
 * That module owns both rounding points — the extension and the tax — and owns the
 * reason there are exactly two; a second implementation would be the divergence C5
 * exists to catch, and it would diverge on the inclusive path first, where a cent
 * can be lost silently.
 *
 * References are checked by *reading* them rather than by letting the foreign keys
 * refuse the insert. Both would refuse, and only this one produces the right error:
 * another org's account id arrives at the database as errno 1452 and becomes a 500,
 * where A7 requires the same 404 a nonexistent id gets.
 */
export async function resolveLines(
  db: TenantDatabase,
  lines: readonly DocumentLineInput[],
  taxMode: TaxMode,
): Promise<readonly NewApDocumentLineRow[]> {
  const accountIds = collectIds(lines, (line) => line.accountId);
  const rateIds = collectIds(lines, (line) => line.taxRateId);

  const [accounts, rates] = await Promise.all([
    selectAccounts(db, accountIds),
    selectTaxRates(db, rateIds),
  ]);

  if (accountIds.some((id) => !accounts.has(id.toString('hex')))) {
    throw new NotFoundError('account');
  }
  if (rateIds.some((id) => !rates.has(id.toString('hex')))) {
    throw new NotFoundError('tax_rate');
  }

  // A catalog item on a line is checked here, where the line first cites it: it must
  // exist in this org (a cross-org id is A7's 404, B11) and be a `'purchase'` item —
  // a bill, a vendor credit, a purchase order and an expense all spend rather than
  // earn (D-CAT-1). Its `is_active` is not re-validated (D-CAT-2), so a repriced or
  // converted document does not begin to fail because the catalog was tidied.
  await assertCatalogItemsUsable(
    db,
    lines.flatMap((line) =>
      line.catalogItemId == null
        ? []
        : [{ catalogItemId: line.catalogItemId, expected: 'purchase' as const }],
    ),
  );

  const issues: ValidationIssue[] = [];
  const rows: NewApDocumentLineRow[] = [];

  for (const [index, line] of lines.entries()) {
    const path = `lines.${String(index)}`;
    const accountId = idBytes(line.accountId, 'account');
    const rateId =
      line.taxRateId === undefined || line.taxRateId === null
        ? null
        : idBytes(line.taxRateId, 'tax_rate');

    const quantity = quantityFromString(line.quantity);
    const unitAmount = fromMinorString(line.unitAmount);

    // The wire schema accepts both of these and the table's CHECK constraints
    // refuse them (`chk_ap_document_lines_quantity`, `..._amounts`). Refused here
    // so the answer is a `validation_failed` naming the field rather than errno
    // 3819 surfacing as a 500 — the same shape D-13 fixed for an over-large money
    // string. The mismatch between the two is reported with the ticket.
    if (quantityUnits(quantity) <= 0n) {
      issues.push({
        path: `${path}.quantity`,
        message:
          'Quantity must be greater than zero. A returned item or a discount on a bill is a ' +
          'vendor credit, which is a document in its own right (D-39) — not a negative line.',
      });
    }
    if (toMinorUnits(unitAmount) < 0n) {
      issues.push({
        path: `${path}.unitAmount`,
        message:
          'A unit amount is not negative. The document type carries the direction, so reducing ' +
          'what is owed is a vendor credit rather than a negative bill (D-39).',
      });
    }

    const rateRow = rateId === null ? undefined : rates.get(rateId.toString('hex'));

    // The mirror of the AR check: a rate restricted to sales may not price a
    // purchase (D-35, `applies_to` in `0005_subledger`). Checked where the line
    // first cites the rate and not again at approval, for the reason the archived
    // check below is not repeated either.
    //
    // A `validation_failed` naming the line rather than the `precondition_failed`
    // the archived case uses, and the difference is real: an archived rate is a
    // fact about the org's rate list that changed under a document, while a
    // sales-only rate on a bill is a wrong field in this request, and the caller
    // needs to know which line to change.
    if (rateRow !== undefined && rateRow.applies_to === 'sales') {
      issues.push({
        path: `${path}.taxRateId`,
        message:
          'This tax rate applies to sales only, so it cannot price a line on a bill or a vendor ' +
          'credit. A rate posts to one account, and an org that reclaims input tax holds a ' +
          'separate rate for purchases — using this one would post reclaimable input tax to the ' +
          'output-tax account and the return would stop reconciling.',
      });
    }

    if (rateRow !== undefined && rateRow.is_active !== 1) {
      // Archived rather than deleted is how a rate leaves circulation
      // (`0005_subledger`, `fk_ap_document_lines_tax_rate` RESTRICT). An archived
      // rate stays readable on documents that already cite it and may not be
      // chosen anew, exactly as an archived dimension value may not.
      throw new PreconditionFailedError(
        'tax_rate_archived',
        `Cannot price a line at an archived tax rate (${bufferToUuid(rateRow.id)}).`,
      );
    }

    const split = computeLine({ quantity, unitAmount, rate: toTaxRate(rateRow) }, taxMode);

    rows.push({
      lineNumber: index + 1,
      description: line.description,
      quantityMicros: quantityUnits(quantity) * MICROS_PER_QUANTITY_UNIT,
      unitAmountMinor: toMinorUnits(unitAmount),
      accountId,
      taxRateId: rateId,
      // Existence and direction were checked above; a malformed id is A7's 404 here
      // too, the same shape `accountId` and `taxRateId` take (D-CAT-2: provenance).
      catalogItemId:
        line.catalogItemId === undefined || line.catalogItemId === null
          ? null
          : idBytes(line.catalogItemId, 'catalog_item'),
      lineAmountMinor: toMinorUnits(split.net),
      taxAmountMinor: toMinorUnits(split.tax),
      // Resolved through the module that owns them, so the refusals a tag can
      // earn — unknown, cross-org, archived, two values on one axis — are the
      // dimensions module's rules and not a second copy of them (D-18).
      dimensions: (await resolveTagsForNewLine(line.dimensionValueIds ?? [], db)).map((tag) => ({
        dimensionId: tag.dimensionId,
        valueId: tag.dimensionValueId,
      })),
    });
  }

  if (issues.length > 0) throw new ValidationError('Document line is not storable.', issues);

  return rows;
}

function toTaxRate(rate: TaxRateRow | undefined): TaxRate {
  // An absent rate is *no tax*, not a zero-rated one, and the two are different on
  // a return (`linePercentageSchema`). They compute identically — hence
  // `ZERO_TAX_RATE` here — and are told apart by `tax_rate_id` being NULL, which
  // is what `chk_ap_document_lines_tax_needs_rate` keeps honest.
  return rate === undefined ? ZERO_TAX_RATE : taxRateFromUnits(BigInt(rate.rate_ppm));
}

// ---------------------------------------------------------------------------
// Reading a document back
// ---------------------------------------------------------------------------

export async function readDocumentView(
  db: TenantDatabase,
  row: ApDocumentRow,
): Promise<ApDocumentView> {
  const lines = await selectDocumentLines(db, row.id);
  const [tags, rates, allocations] = await Promise.all([
    selectLineDimensions(
      db,
      lines.map((line) => line.id),
    ),
    selectTaxRates(db, distinctRateIds(lines)),
    selectAllocationsFor(db, row.id, row.document_type),
  ]);

  const counterparts = await selectDocumentNumbers(db, counterpartIds(allocations, row));
  const totals = documentTotals(lines);
  const allocated = sum(allocations.map((allocation) => fromMinorUnits(allocation.amount_minor)));

  return {
    ...toSummaryView(row, totals, allocated),
    taxMode: row.tax_mode,
    memo: row.memo,
    lines: lines.map((line) => toDocumentLine(line, rates, tags)),
    taxSummary: taxSummaryOf(lines, rates),
    allocations: allocations.map((allocation) => toAllocation(allocation, row, counterparts)),
    journalId: row.journal_id === null ? null : bufferToUuid(row.journal_id),
    voidJournalId: row.void_journal_id === null ? null : bufferToUuid(row.void_journal_id),
  };
}

/**
 * Stored lines as the input shape that priced them.
 *
 * Needed because changing a document's `taxMode` re-prices every line it already
 * holds: `unitAmount` means "including tax" or "excluding tax" depending on that
 * one flag (`taxModeSchema`), so leaving the stored amounts alone after a mode
 * change would leave a document whose own three columns do not add up. The
 * round-trip is exact — quantity, unit amount, account, rate and tags are all
 * stored as entered, and only the two computed columns are re-derived.
 */
export function linesAsInput(
  lines: readonly ApDocumentLineRow[],
  tags: ReadonlyMap<string, readonly string[]>,
): readonly DocumentLineInput[] {
  return lines.map((line) => ({
    description: line.description ?? '',
    quantity: quantityToString(toQuantity(line.quantity_micros)),
    unitAmount: toMinorString(fromMinorUnits(line.unit_amount_minor)),
    accountId: bufferToUuid(line.account_id),
    taxRateId: line.tax_rate_id === null ? null : bufferToUuid(line.tax_rate_id),
    // Carried through the round-trip so a mode-change reprice and a purchase-order
    // conversion keep the line's provenance (D-CAT-2).
    catalogItemId: line.catalog_item_id === null ? null : bufferToUuid(line.catalog_item_id),
    dimensionValueIds: [...(tags.get(line.id.toString()) ?? [])],
  }));
}

export function toSummaryView(
  row: ApDocumentRow,
  totals: DocumentTotalsResponse,
  allocated: Money,
): ApDocumentSummaryView {
  return {
    id: bufferToUuid(row.id),
    documentNumber: row.sequence_number === null ? null : row.sequence_number.toString(),
    reference: row.reference,
    contactId: bufferToUuid(row.contact_id),
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: statusOf(row, fromMinorString(totals.gross), allocated),
    totals,
    settlement: settlementOf(row, fromMinorString(totals.gross), allocated),
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The status, derived and never stored (D-38).
 *
 * The four facts it is read from are the two journal columns and the arithmetic:
 * `void_journal_id` set is `void`, `journal_id` null is `draft`, and the rest is
 * how much of the document has been applied. A stored column would be a third copy
 * of a fact the journal columns already carry and the first thing to drift when an
 * allocation is removed.
 */
function statusOf(row: ApDocumentRow, gross: Money, allocated: Money): DocumentStatus {
  if (row.void_journal_id !== null) return 'void';
  if (row.journal_id === null) return 'draft';
  if (toMinorUnits(allocated) <= 0n) return 'approved';
  return toMinorUnits(allocated) >= toMinorUnits(gross) ? 'paid' : 'part_paid';
}

/**
 * What is left, computed on read (D-34).
 *
 * A draft and a void both report **zero** outstanding, and that is the line C2
 * turns on rather than a presentational nicety. Outstanding across the AP
 * subledger has to equal the payables control account at every date; a draft has
 * told the ledger nothing and a void has been reversed out of it, so either one
 * carrying its total would put the subledger above the control account by exactly
 * the documents that are not in it.
 *
 * `allocated` is still reported as it stands, because an allocation against a
 * voided document is a real row consuming a payment's credit — reporting it as
 * zero would hide it, and the AP service refuses the void that would create the
 * situation in the first place (see `voidDocument`).
 */
function settlementOf(row: ApDocumentRow, gross: Money, allocated: Money): DocumentSettlement {
  const settled = row.journal_id === null || row.void_journal_id !== null;

  return {
    allocated: toMinorString(allocated),
    outstanding: toMinorString(settled ? ZERO : subtract(gross, allocated)),
  };
}

export function documentTotals(lines: readonly ApDocumentLineRow[]): DocumentTotalsResponse {
  // The sums of the rounded lines, never the rate applied to a sum (D-35). Taken
  // independently and `net + tax === gross` survives, because summation is exact.
  const net = sum(lines.map((line) => fromMinorUnits(line.line_amount_minor)));
  const tax = sum(lines.map((line) => fromMinorUnits(line.tax_amount_minor)));

  return { net: toMinorString(net), tax: toMinorString(tax), gross: toMinorString(add(net, tax)) };
}

function toDocumentLine(
  row: ApDocumentLineRow,
  rates: ReadonlyMap<string, TaxRateRow>,
  tags: ReadonlyMap<string, readonly string[]>,
): DocumentLine {
  const rate = row.tax_rate_id === null ? undefined : rates.get(row.tax_rate_id.toString('hex'));
  const net = fromMinorUnits(row.line_amount_minor);
  const tax = fromMinorUnits(row.tax_amount_minor);

  return {
    // A `BIGINT`, stringified so it cannot lose precision on the wire — the same
    // reason money is a string (D-13).
    lineId: row.id.toString(),
    lineNumber: row.line_number,
    description: row.description ?? '',
    quantity: quantityToString(toQuantity(row.quantity_micros)),
    unitAmount: toMinorString(fromMinorUnits(row.unit_amount_minor)),
    accountId: bufferToUuid(row.account_id),
    taxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
    catalogItemId: row.catalog_item_id === null ? null : bufferToUuid(row.catalog_item_id),
    // Read from the rate rather than stored on the line, which is only safe
    // because a rate's percentage is immutable — `updateTaxRateRequestSchema`
    // makes a new percentage a new rate precisely so a document stays printable
    // as it stood.
    taxRatePercentage: rate === undefined ? null : percentOf(rate),
    netAmount: toMinorString(net),
    taxAmount: toMinorString(tax),
    grossAmount: toMinorString(add(net, tax)),
    dimensionValueIds: [...(tags.get(row.id.toString()) ?? [])],
  };
}

/**
 * One row per rate, plus the untaxed group, which is what a return is filed from.
 *
 * Grouped by rate *id* and not by percentage because two rates can share a
 * percentage and post to different accounts (`documentTaxSummaryRowSchema`).
 */
function taxSummaryOf(
  lines: readonly ApDocumentLineRow[],
  rates: ReadonlyMap<string, TaxRateRow>,
): readonly DocumentTaxSummaryRow[] {
  const groups = new Map<string, { rate: TaxRateRow | undefined; net: Money; tax: Money }>();

  for (const line of lines) {
    const key = line.tax_rate_id === null ? '' : line.tax_rate_id.toString('hex');
    const existing = groups.get(key) ?? {
      rate: line.tax_rate_id === null ? undefined : rates.get(key),
      net: ZERO,
      tax: ZERO,
    };

    groups.set(key, {
      rate: existing.rate,
      net: add(existing.net, fromMinorUnits(line.line_amount_minor)),
      tax: add(existing.tax, fromMinorUnits(line.tax_amount_minor)),
    });
  }

  return [...groups.values()].map((group) => ({
    taxRateId: group.rate === undefined ? null : bufferToUuid(group.rate.id),
    taxRateName: group.rate?.name ?? null,
    percentage: group.rate === undefined ? null : percentOf(group.rate),
    net: toMinorString(group.net),
    tax: toMinorString(group.tax),
  }));
}

function toAllocation(
  row: AllocationRow,
  document: ApDocumentRow,
  numbers: ReadonlyMap<string, bigint | null>,
): Allocation {
  /**
   * The document *being viewed* is not in `numbers` — `counterpartIds` excludes it
   * deliberately, since its number is already in hand. Falling through to the map
   * for it returned null, which read as "a vendor credit has no number" on the one
   * view where the credit is the source. Caught by
   * `vendor-credits.service.test.ts`.
   */
  const number = (id: Buffer): string | null =>
    id.equals(document.id)
      ? (document.sequence_number?.toString() ?? null)
      : (numbers.get(id.toString('hex'))?.toString() ?? null);

  // `chk_ap_allocations_one_source` makes exactly one of the three present (D-106
  // added the discount journal as the third). The impossible fourth case throws
  // rather than defaulting, because the only available default would name the wrong
  // document.
  const source =
    row.payment_id !== null
      ? {
          // Null for a payment, per `allocationSchema`: D-36 numbers the four
          // document types and nothing else.
          sourceType: 'payment' as const,
          sourceId: bufferToUuid(row.payment_id),
          sourceNumber: null,
        }
      : row.discount_journal_id !== null
        ? {
            // A settlement discount's source is its own posted journal, not a
            // numbered document, so `sourceNumber` is null — the same mapping
            // `allocations.repository.ts` uses for the `discount` kind (D-106).
            sourceType: 'discount' as const,
            sourceId: bufferToUuid(row.discount_journal_id),
            sourceNumber: null,
          }
        : {
            sourceType: 'vendor_credit' as const,
            sourceId: bufferToUuid(requireSource(row)),
            sourceNumber: number(requireSource(row)),
          };

  return {
    id: bufferToUuid(row.id),
    ...source,
    targetType: 'bill',
    targetId: bufferToUuid(row.bill_id),
    targetNumber: number(row.bill_id),
    amount: toMinorString(fromMinorUnits(row.amount_minor)),
    date: row.allocated_on,
    createdAt: row.created_at.toISOString(),
  };
}

function requireSource(row: AllocationRow): Buffer {
  if (row.vendor_credit_id === null) {
    throw new InternalError(
      'An ap_allocations row named none of a payment, a discount journal, or a vendor ' +
        'credit, which chk_ap_allocations_one_source forbids.',
    );
  }
  return row.vendor_credit_id;
}

/**
 * One page of documents as summaries, with the computed statuses filled in.
 *
 * The two aggregations D-34 promised would be needed live here: the totals come
 * from the page's lines and the settlement from the page's allocations, both in
 * one round trip for the whole page rather than one per row.
 *
 * `part_paid` and `paid` are filtered **after** the page is assembled, because
 * they are computed and there is no column to put in a `WHERE` clause (see
 * `selectDocumentsPage`). Paging stays correct: `nextCursor` is minted from the
 * last row of the *underlying* page, so following it reaches everything, and a
 * short page still means "there may be more" exactly when `nextCursor` is set —
 * which `pagination.ts` states is the only signal a client may read.
 */
export async function toSummaryPage(
  db: TenantDatabase,
  documentType: ApDocumentType,
  rows: readonly ApDocumentRow[],
  status: DocumentStatus | undefined,
): Promise<readonly ApDocumentSummaryView[]> {
  const ids = rows.map((row) => row.id);
  const [linesByDocument, allocatedByDocument] = await Promise.all([
    selectLinesForDocuments(db, ids),
    selectAllocatedTotals(db, ids, documentType),
  ]);

  const summaries = rows.map((row) => {
    const hex = row.id.toString('hex');
    return toSummaryView(
      row,
      documentTotals(linesByDocument.get(hex) ?? []),
      fromMinorUnits(allocatedByDocument.get(hex) ?? 0n),
    );
  });

  return status === undefined ? summaries : summaries.filter((row) => row.status === status);
}

/** The three lifecycle states a `WHERE` clause can express; the rest are computed. */
export function lifecycleFor(
  status: DocumentStatus | undefined,
): 'draft' | 'approved' | 'void' | undefined {
  if (status === undefined) return undefined;
  if (status === 'draft' || status === 'void') return status;
  return 'approved';
}

// ---------------------------------------------------------------------------
// Approval (D-38) — the irreversible step
// ---------------------------------------------------------------------------

export interface ApprovalOutcome {
  readonly sequenceNumber: bigint;
  readonly journal: PostedJournal;
}

/**
 * Whatever is true of one document type and not the other, run once the row is
 * locked and its lines are read. Throwing from it aborts the approval and rolls
 * the claimed number back.
 */
export type ApprovalCheck = (
  row: ApDocumentRow,
  lines: readonly ApDocumentLineRow[],
) => void | Promise<void>;

/**
 * Numbers the document and posts its journal, in **one transaction**.
 *
 * ## The lock order, and why the counter is first
 *
 *   1. `document_sequences` counter row, `FOR UPDATE` (`claimDocumentNumber`)
 *   2. `ap_documents` row, `FOR UPDATE` — the document being approved
 *   3. approved bills for this vendor and reference, `FOR UPDATE`
 *      (`selectApprovedWithReference`, bills only)
 *   4. `dimension_values` rows, `FOR UPDATE` (inside `postJournal`)
 *   5. period row, `FOR UPDATE` (inside `postJournal`)
 *   6. `journal_sequences` counter row, `FOR UPDATE` (inside `postJournal`)
 *
 * `postJournal` always takes 4, 5, 6 in that order and nothing anywhere reaches
 * back for a document counter after taking a period or a journal sequence, so the
 * global order is total.
 *
 * **The counter comes before the document row, and the ordering was measured
 * rather than reasoned to.** The obvious order is the one `postDraft` uses — lock
 * the thing you were asked about first — and it deadlocks here. The counter row is
 * per org and per document type, so every approval of this type contends on it;
 * with the document locked first, one approval holds document A and waits for the
 * counter while another holds the counter and, at step 3, reaches for document A.
 * That cycle needs nothing exotic: two bills for the same vendor, approved at
 * once. With the counter outermost, an approval that is waiting for it holds
 * nothing, so there is no cycle to close. The operations that lock a document
 * without a number — edit, discard, void — never want the counter, so they cannot
 * close one either.
 *
 * The cost of that order, stated because it is real: an approval that is going to
 * fail — a bad id, a closed period — still claims the counter first and holds it
 * until it rolls back, so every approval of one type in one org serializes. For a
 * document type a small business issues tens of times a day, that is not a cost
 * worth trading a deadlock for.
 *
 * ## Exactly once
 *
 * The mechanism is the row lock, not a status column and not a check-then-act. The
 * loser blocks at step 1 until the winner commits, then reads the document at step
 * 2 and finds `journal_id` set, and reports a `precondition_failed`. One journal,
 * one number, no window in which both callers believe they hold an unapproved
 * document — and `uq_ap_documents_journal` is the backstop underneath that,
 * exactly as `uq_journals_org_reverses` is for a reversal.
 *
 * A failed approval leaves the document **intact and still a draft**: the
 * transaction rolls back, the number is never consumed (which is what gapless
 * means — see D-14 on why `AUTO_INCREMENT` cannot do this), and the user sees the
 * document they were editing plus the reason it was refused.
 */
export async function approveDocument(
  db: TenantDatabase,
  documentId: Buffer,
  documentType: ApDocumentType,
  ctx: RequestContext,
  check: ApprovalCheck,
): Promise<ApprovalOutcome> {
  const sequenceNumber = await claimDocumentNumber(db, documentType);

  const row = assertFound(
    await selectDocumentByIdForUpdate(db, documentId, documentType),
    documentResource(documentType),
  );
  assertApprovable(row);

  const lines = await selectDocumentLines(db, documentId);
  await check(row, lines);
  await assertNoDuplicateReference(db, row);

  const controlAccountId = await resolveControlAccount(db, 'payable');
  const rates = await selectTaxRates(db, distinctRateIds(lines));
  const tags = await selectLineDimensions(
    db,
    lines.map((line) => line.id),
  );

  // `postJournal` joins this transaction ambiently (`transaction-scope.ts`), so
  // the posting, both sequence allocations, and the update below are one unit of
  // work on one connection. It is called, never re-implemented: balance
  // validation, the period lock, the account and contact checks, and actor
  // provenance all live in it, and it is the only path to the journal tables
  // (`openbooks/no-journal-writes`).
  const journal = await postJournal(
    toPostJournalInput(row, lines, rates, tags, controlAccountId, sequenceNumber, ctx),
    ctx,
  );

  const updated = await approveDocumentRow(
    db,
    row.id,
    sequenceNumber,
    tryUuidToBuffer(journal.journalId) ??
      raise('postJournal returned a journal id that is not a UUID.'),
    new Date(),
  );

  if (updated !== 1) {
    throw new InternalError(
      `Approving an AP document updated ${String(updated)} rows while holding its row lock. The ` +
        'document was read FOR UPDATE in this transaction, so it cannot have been approved by ' +
        'another one — the journal is posted and the document may not point at it (D-38).',
    );
  }

  return { sequenceNumber, journal };
}

/**
 * Refuses a second approved bill carrying one vendor's invoice number (D-36).
 *
 * ## The decision, and the argument for it
 *
 * D-36 says the AP `reference` holds "the vendor's own invoice number… the number
 * that matters on an AP document — we did not issue it". Two approved bills from
 * one vendor quoting one number is the classic duplicate-entry mistake and the one
 * that costs money: it is how a supplier gets paid twice, and neither the totals
 * nor the trial balance shows anything wrong, because both bills are individually
 * correct.
 *
 * Three answers were available — refuse, warn, allow — and the middle one is
 * **not expressible**: `billSchema` carries no warnings channel, and OB-063 may not
 * add one to a contract four other services are being written against. Between the
 * remaining two, refusing is chosen, and the scope of the refusal is what makes it
 * safe rather than obstructive:
 *
 *  - It is keyed on **(vendor, reference)**, never on reference alone. Two vendors
 *    both numbering their invoices `1001` is ordinary and unremarkable.
 *  - A bill with **no reference never collides**. Plenty of vendors do not number
 *    anything, and a NULL is not a claim about a number.
 *  - It ignores **drafts**. Entry is never blocked, which is the D-38 line: before
 *    approval a document is editable and discardable, and a check that fired while
 *    someone typed would be a check they learn to work around.
 *  - It ignores **voided** bills, so re-entering a bill after voiding it — the
 *    single most common legitimate reuse of a vendor number — passes.
 *
 * What that leaves refused is the unambiguous case: this vendor, this number,
 * already approved and still live. The escape hatch is real and it is the right
 * one — look at the other bill. If the vendor genuinely issued two documents under
 * one number, that is the vendor's error and an AP clerk should be calling them
 * rather than filing it silently.
 *
 * The message names the colliding bill's number, which `ConflictError` permits
 * where `NotFoundError` does not: the colliding row is inside the caller's own org
 * by construction (`tenantDb`), so there is no cross-org existence to disclose.
 *
 * ## Why this cannot be a unique index
 *
 * The condition is "approved and not void", and MySQL has no partial index. A
 * plain `UNIQUE (org_id, contact_id, reference)` would forbid two *drafts* and
 * forbid re-entry after a void, which are exactly the two cases that must pass. So
 * it is a service check, and it is race-free for two reasons together: it runs
 * while the document-sequence counter is held, so no other approval of this type
 * can be between its counter claim and its commit, and it is a **current** read
 * rather than a consistent one — see `selectApprovedWithReference` for why the
 * second half was not optional and how the test found it missing.
 */
async function assertNoDuplicateReference(db: TenantDatabase, row: ApDocumentRow): Promise<void> {
  // Vendor credits are excluded on purpose. `reference` on one holds the vendor's
  // own credit-note number where they issued one, and a vendor who reuses a number
  // across a credit and an invoice, or issues none at all, is common — there is no
  // double-payment risk on this side to weigh against the false refusals.
  if (row.document_type !== 'bill' || row.reference === null) return;

  const existing = await selectApprovedWithReference(
    db,
    'bill',
    row.contact_id,
    row.reference,
    row.id,
  );
  if (existing === undefined) return;

  const number = existing.sequence_number?.toString() ?? bufferToUuid(existing.id);
  throw new PreconditionFailedError(
    'duplicate_vendor_reference',
    `This vendor's invoice number is already on approved bill ${number}. Entering the same ` +
      'vendor invoice twice is how a supplier gets paid twice, and neither total would look ' +
      'wrong. Check that bill; if the vendor really issued two documents under one number, ask ' +
      'them to correct it (D-36).',
  );
}

/**
 * The document as `postJournal` takes it — and the one place the direction is
 * decided.
 *
 * A **bill** debits every line's expense or asset account, debits the tax the
 * rates nominate, and credits accounts payable for the gross. A **vendor credit**
 * is the exact mirror. `journalSides` is one expression rather than two branches
 * spread through the builder, so "which way does an AP document run" has a single
 * answer that a test can mutate.
 *
 * Tax lines are grouped by **account** rather than by rate: a journal line names
 * an account and two rates sharing one liability account would otherwise post two
 * lines to it. The per-rate detail is not lost — it is on the document, which is
 * where a return is filed from (`documentTaxSummaryRowSchema`).
 *
 * The contact rides on **every** line, not only the control line.
 * `journal_lines.contact_id` means "who the amount is with" (`0002_ledger`), and
 * every line of a bill is with that vendor — the expense as much as the payable.
 * The control line carrying it is what C2 sums; the expense lines carrying it is
 * what makes "what did we buy from this vendor" answerable from the ledger.
 *
 * Dimension tags travel on the line they were entered on and on nothing else. The
 * tax and control lines are aggregates across lines that may be tagged
 * differently, and tagging them with any one line's axes would put money in a
 * slice nobody assigned it to — B6's "slices plus unassigned equals the whole"
 * would still hold, and the slice would be wrong.
 */
function toPostJournalInput(
  row: ApDocumentRow,
  lines: readonly ApDocumentLineRow[],
  rates: ReadonlyMap<string, TaxRateRow>,
  tags: ReadonlyMap<string, readonly string[]>,
  controlAccountId: Buffer,
  sequenceNumber: bigint,
  ctx: RequestContext,
): PostJournalInput {
  const { lineSide, controlSide } = journalSides(row.document_type);
  const contactId = bufferToUuid(row.contact_id);
  const postingLines: JournalLineInput[] = [];

  for (const line of lines) {
    if (line.line_amount_minor > 0n) {
      const lineTags = tags.get(line.id.toString()) ?? [];
      postingLines.push({
        accountId: bufferToUuid(line.account_id),
        side: lineSide,
        amount: line.line_amount_minor,
        contactId,
        ...(line.description === null ? {} : { memo: line.description }),
        ...(lineTags.length === 0 ? {} : { dimensionValueIds: lineTags }),
      });
    }
  }

  for (const [accountHex, amount] of taxByAccount(lines, rates)) {
    postingLines.push({
      accountId: bufferToUuid(Buffer.from(accountHex, 'hex')),
      side: lineSide,
      amount,
      contactId,
      memo: 'Tax',
    });
  }

  const gross = lines.reduce(
    (total, line) => total + line.line_amount_minor + line.tax_amount_minor,
    0n,
  );

  postingLines.push({
    accountId: bufferToUuid(controlAccountId),
    side: controlSide,
    amount: gross,
    contactId,
  });

  return {
    // The document's own issue date, never a date on the request. An approval that
    // could name its own entry date would let a client post a bill into a period
    // other than the one it is printed for — `invoices.ts` argues the same for the
    // absent approve-request schema.
    date: row.issue_date,
    memo: row.memo ?? defaultMemo(row.document_type, sequenceNumber, row.reference),
    // `bill` or `vendor_credit` — the origin `0005_subledger` documents and, before
    // OB-091, never set (every subledger journal landed as `manual`).
    source: row.document_type,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    lines: postingLines,
  };
}

/**
 * Which way the money runs. The one line in this module that a balanced journal
 * cannot tell you is wrong.
 *
 * A bill is an obligation incurred: what was bought is a debit, and accounts
 * payable — a liability, normal balance credit — is credited. A vendor credit
 * reduces that obligation, so both sides invert. Swap these and every journal
 * still balances, the trial balance still sums to zero, and the payables control
 * account carries a debit balance: the business appears to be *owed* money by
 * every supplier it owes. `test/bills/direction.test.ts` asserts the signed
 * control balance for exactly this reason.
 */
function journalSides(documentType: ApDocumentType): {
  readonly lineSide: 'debit' | 'credit';
  readonly controlSide: 'debit' | 'credit';
} {
  return documentType === 'bill'
    ? { lineSide: 'debit', controlSide: 'credit' }
    : { lineSide: 'credit', controlSide: 'debit' };
}

function taxByAccount(
  lines: readonly ApDocumentLineRow[],
  rates: ReadonlyMap<string, TaxRateRow>,
): ReadonlyMap<string, bigint> {
  const byAccount = new Map<string, bigint>();

  for (const line of lines) {
    if (line.tax_amount_minor <= 0n || line.tax_rate_id === null) continue;

    const rate = rates.get(line.tax_rate_id.toString('hex'));
    if (rate === undefined) {
      // Unreachable: `fk_ap_document_lines_tax_rate` guarantees the row and this
      // map was built from these lines' own rate ids. Stated as a fault rather
      // than skipped, because skipping would post an unbalanced journal.
      throw new InternalError('A document line cites a tax rate that could not be read back.');
    }

    const key = rate.tax_account_id.toString('hex');
    byAccount.set(key, (byAccount.get(key) ?? 0n) + line.tax_amount_minor);
  }

  return byAccount;
}

function defaultMemo(
  documentType: ApDocumentType,
  sequenceNumber: bigint,
  reference: string | null,
): string {
  const name = documentType === 'bill' ? 'Bill' : 'Vendor credit';
  const suffix = reference === null ? '' : ` (vendor ref ${reference})`;
  return `${name} ${sequenceNumber.toString()}${suffix}`;
}

// ---------------------------------------------------------------------------
// Void (D-16, D-38)
// ---------------------------------------------------------------------------

/**
 * Voids an approved document by reversing its journal, never by deleting it.
 *
 * The document, its number and its original journal all remain visible (C7). A
 * voided document that vanished would make the gapless sequence a lie — a gap is
 * indistinguishable from a deletion, which is the whole reason the sequence is
 * gapless (D-14, D-36).
 *
 * The reversal takes **its own date**, for `reverseJournal`'s reason: the
 * document's period is usually closed by the time someone voids it, and correcting
 * a closed period by reopening it restates figures already reported.
 *
 * ## An allocated document may not be voided
 *
 * Refused rather than cascaded, and it is a real decision. An allocation consumes
 * a payment's or a credit's available balance (D-37); voiding the document it
 * points at would leave that balance consumed by something that no longer owes
 * anything, so a payment would show less credit available than it has. Removing
 * the allocation is OB-064's operation and is an ordinary delete that restates no
 * financial statement — so the fix is one step the user can take, and doing it for
 * them would be this module writing another module's table.
 */
export async function voidDocument(
  db: TenantDatabase,
  row: ApDocumentRow,
  request: VoidDocumentRequest,
  ctx: RequestContext,
): Promise<PostedJournal> {
  if (row.journal_id === null) {
    throw new PreconditionFailedError(
      'document_not_approved',
      'Only an approved document can be voided. A draft is discarded, which removes it outright ' +
        'because it never reached the ledger (D-16).',
    );
  }
  if (row.void_journal_id !== null) {
    throw new PreconditionFailedError(
      'document_already_void',
      'This document is already void. Its reversal is a posted journal and reversing that would ' +
        're-instate the document rather than undo it.',
    );
  }

  const allocations = await selectAllocationsFor(db, row.id, row.document_type);
  if (allocations.length > 0) {
    throw new PreconditionFailedError(
      'document_has_allocations',
      `This document has ${String(allocations.length)} allocation(s) against it. Remove them ` +
        'first: voiding while they stand would leave a payment or a credit showing less ' +
        'available than it has, because the allocation would still consume it (D-37).',
    );
  }

  const reversal = await reverseJournal(
    {
      journalId: bufferToUuid(row.journal_id),
      date: request.date,
      ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    },
    ctx,
  );

  const updated = await voidDocumentRow(
    db,
    row.id,
    tryUuidToBuffer(reversal.journalId) ??
      raise('reverseJournal returned a journal id that is not a UUID.'),
    new Date(),
  );

  if (updated !== 1) {
    throw new InternalError(
      `Voiding an AP document updated ${String(updated)} rows while holding its row lock. The ` +
        'reversal is posted and the document may not point at it (D-38).',
    );
  }

  return reversal;
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/**
 * The vendor this document is with.
 *
 * `is_vendor` is checked because the flag says which subledgers a contact takes
 * part in (`0002_ledger`), and a bill raised against a customer-only contact would
 * put a payable on a party the AP screens never show. Checked at entry *and* at
 * approval: at entry so the mistake is caught while it is still a draft, at
 * approval because the flag is editable in between.
 *
 * `is_active` is deliberately **not** checked here. `postJournal` refuses a line
 * naming a deactivated contact and says why, and a second copy of that rule here
 * would be a second answer to the same question — one that could drift, and one
 * that would refuse a draft the ledger would have accepted.
 */
export async function requireVendor(db: TenantDatabase, contactId: Buffer): Promise<void> {
  const contact = assertFound(await selectContact(db, contactId), 'contact');

  if (contact.is_vendor !== 1) {
    throw new PreconditionFailedError(
      'contact_is_not_a_vendor',
      'This contact is not marked as a vendor. A payable belongs to a party the AP subledger ' +
        'knows about; mark the contact as a vendor first.',
    );
  }
}

/**
 * The employee an expense is with (initiative M, D-M2).
 *
 * The mirror of `requireVendor` for the one AP document whose counterparty is an
 * employee rather than a supplier. An employee expense reuses the whole bill posting
 * path — it *is* an `ap_documents` bill (`document_type='bill'`) — and the only thing
 * that differs is which flag the contact must carry: a reimbursement belongs to
 * someone the org employs, not a vendor. `is_employee` and `is_vendor` are
 * independent flags (`0002_ledger`), so this is a separate guard, not a widening of
 * the vendor one. Checked at entry *and* at approval for `requireVendor`'s reason —
 * the flag is editable in between.
 */
export async function requireEmployee(db: TenantDatabase, contactId: Buffer): Promise<void> {
  const contact = assertFound(await selectContact(db, contactId), 'contact');

  if (contact.is_employee !== 1) {
    throw new PreconditionFailedError(
      'contact_is_not_an_employee',
      'This contact is not marked as an employee. An expense reimbursement is owed to someone the ' +
        'org employs; mark the contact as an employee first.',
    );
  }
}

export function assertDraft(row: ApDocumentRow): void {
  if (row.journal_id === null) return;

  throw new PreconditionFailedError(
    'document_approved',
    'An approved document cannot be edited or discarded. Approval is the irreversible step — ' +
      'the ledger has been told (D-38). The correction is a vendor credit, or a void.',
  );
}

/**
 * Refuses a second approval.
 *
 * This is the *message*, not the guarantee. The guarantee is the row lock the
 * caller already holds plus `uq_ap_documents_journal`, exactly as the pre-check in
 * `reverseJournal` is a message in front of `uq_journals_org_reverses`. The loser
 * of a concurrent approval reaches this line having blocked on the lock and read
 * the winner's committed row, so under contention this is what it sees.
 */
export function assertApprovable(row: ApDocumentRow): void {
  if (row.journal_id === null) return;

  throw new PreconditionFailedError(
    'document_already_approved',
    `This document is already approved as number ${row.sequence_number?.toString() ?? '?'} and ` +
      'has posted its journal. Approval happens once (D-38); the corrections are a credit or a ' +
      'void.',
  );
}

/**
 * A document that would post nothing is refused before `postJournal` sees it.
 *
 * `postJournal` refuses it too — as "too few lines" or "a journal must move a
 * non-zero amount" — and neither reads as an answer about the document the caller
 * sent. Refusing here is also what keeps the number gapless in the case that
 * actually happens: the counter is claimed inside the transaction, so a rejected
 * approval rolls it back, but an approval rejected *after* the journal attempt has
 * done work for nothing.
 */
export function assertHasValue(
  lines: readonly ApDocumentLineRow[],
  documentType: ApDocumentType,
): void {
  const gross = lines.reduce(
    (total, line) => total + line.line_amount_minor + line.tax_amount_minor,
    0n,
  );
  if (gross > 0n) return;

  const name = documentType === 'bill' ? 'bill' : 'vendor credit';
  throw new ValidationError(`This ${name} is not ready to approve.`, [
    {
      path: 'lines',
      message:
        `A ${name} with no value posts nothing. Add a line, or discard it — a document that ` +
        'moved no money would consume a number in a series that has to stay gapless (D-36).',
    },
  ]);
}

/** Re-prices every stored line under a new tax mode. See `linesAsInput`. */
export async function repriceLines(
  db: TenantDatabase,
  documentId: Buffer,
  taxMode: TaxMode,
): Promise<void> {
  const lines = await selectDocumentLines(db, documentId);
  if (lines.length === 0) return;

  const tags = await selectLineDimensions(
    db,
    lines.map((line) => line.id),
  );

  await replaceDocumentLines(
    db,
    documentId,
    await resolveLines(db, linesAsInput(lines, tags), taxMode),
  );
}

export function requireAuthor(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    // `ap_documents.created_by_user_id` is NOT NULL and references `users` with
    // RESTRICT rather than the CASCADE `journal_drafts` uses: an approved document
    // is a fact, and who raised it is part of the record (`0005_subledger`). A
    // context with no user has nothing to author one.
    throw new ValidationError('An AP document is authored by a user.', [
      {
        path: 'actor',
        message: 'This caller has no user identity, so it cannot raise a bill or a vendor credit.',
      },
    ]);
  }
  return userId;
}

export function documentResource(documentType: ApDocumentType): string {
  return AP_DOCUMENT_RESOURCE[documentType];
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

export function distinctRateIds(lines: readonly ApDocumentLineRow[]): readonly Buffer[] {
  return [
    ...new Map(
      lines
        .map((line) => line.tax_rate_id)
        .filter((id): id is Buffer => id !== null)
        .map((id) => [id.toString('hex'), id]),
    ).values(),
  ];
}

function counterpartIds(
  allocations: readonly AllocationRow[],
  document: ApDocumentRow,
): readonly Buffer[] {
  const ids = new Map<string, Buffer>();

  for (const allocation of allocations) {
    for (const id of [allocation.bill_id, allocation.vendor_credit_id]) {
      if (id === null || id.equals(document.id)) continue;
      ids.set(id.toString('hex'), id);
    }
  }

  return [...ids.values()];
}

function toQuantity(micros: bigint): Quantity {
  return quantityFromUnits(micros / MICROS_PER_QUANTITY_UNIT);
}

function percentOf(rate: TaxRateRow): string {
  return taxRateToPercentString(taxRateFromUnits(BigInt(rate.rate_ppm)));
}

function collectIds(
  lines: readonly DocumentLineInput[],
  of: (line: DocumentLineInput) => string | null | undefined,
): readonly Buffer[] {
  const ids = new Map<string, Buffer>();

  for (const line of lines) {
    const value = of(line);
    if (value === null || value === undefined) continue;
    const bytes = tryUuidToBuffer(value);
    if (bytes !== undefined) ids.set(bytes.toString('hex'), bytes);
  }

  return [...ids.values()];
}

/**
 * A reference id as bytes.
 *
 * A malformed id is a miss rather than a validation failure, for the reason
 * `tryUuidToBuffer` gives: 400 for a malformed id and 404 for an unknown one is a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
function idBytes(value: string, resource: string): Buffer {
  return assertFound(tryUuidToBuffer(value), resource);
}

function raise(message: string): never {
  throw new InternalError(message);
}
