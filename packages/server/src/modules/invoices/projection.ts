import type {
  Allocation,
  CreditNote,
  CreditNoteSummary,
  DocumentLine,
  DocumentSettlement,
  DocumentStatus,
  DocumentTaxSummaryRow,
  DocumentTotalsResponse,
  Invoice,
  InvoiceSummary,
} from '@openbooks/shared-types';
import { quantityToString, taxRateToPercentString } from '@openbooks/shared-types';

import { bufferToUuid } from '../../db';
import { InternalError } from '../../errors';

import type {
  AllocationRow,
  DocumentLineRow,
  DocumentPageRow,
  DocumentRow,
  TaxRateRow,
} from './ar-documents.repository';
import { toBigInt } from './ar-documents.repository';
import type { ArDocumentKind } from './kinds';
import { quantityFromMicros, toTaxRate } from './pricing';

/**
 * Rows to wire shapes (OB-062).
 *
 * Two rules govern everything here, and both are D-34 and D-38 restated as code:
 *
 *  - **Nothing in this file reads a balance or a status column, because there are
 *    none.** `status` is derived from `journal_id`, `void_journal_id` and the
 *    allocations; `settlement` is the total minus the allocations. They are computed
 *    on read for the same reason the trial balance is computed from journal lines
 *    rather than from a cache: two answers to "what does this customer owe" can
 *    disagree without anything looking broken, and spec §11 makes their agreement an
 *    invariant precisely because that divergence is unfalsifiable when the subledger
 *    is the thing being asked.
 *  - **Line amounts are read, never recomputed.** `line_amount_minor` and
 *    `tax_amount_minor` are where D-35's two roundings landed, recorded at the
 *    moment they were made. Recomputing them here would make an approved document's
 *    total depend on a `tax_rates` row that is still editable, so a rate corrected in
 *    March would silently restate January — and the ledger, posted once, would no
 *    longer agree.
 *
 * The one thing that *is* read live is a rate's percentage, and it is safe for a
 * stated reason: `updateTaxRateRequestSchema` makes `percentage` create-only, so the
 * value under a document cannot change. A rate is archived rather than deleted, so
 * the id always resolves.
 */

/**
 * The lifecycle, derived (D-38).
 *
 * The order of the branches is the order of the argument. `void` first because a
 * voided document is voided whatever has been applied to it; `draft` next because a
 * document with no journal has told the ledger nothing; and the remaining three are
 * a comparison of what has been applied against what the document is for.
 *
 * `allocated === 0` reads as `approved` rather than as `part_paid`, and a document
 * whose allocations reach its total reads as `paid` — on a credit note that means
 * "fully applied, nothing left to give", which is the same fact and the reason
 * `DOCUMENT_STATUSES` is one enum rather than two.
 */
export function documentStatus(
  row: Pick<DocumentRow, 'journal_id' | 'void_journal_id'>,
  gross: bigint,
  allocated: bigint,
): DocumentStatus {
  if (row.void_journal_id !== null) return 'void';
  if (row.journal_id === null) return 'draft';
  if (allocated <= 0n) return 'approved';
  return allocated >= gross ? 'paid' : 'part_paid';
}

export function toSettlement(gross: bigint, allocated: bigint): DocumentSettlement {
  return { allocated: allocated.toString(), outstanding: (gross - allocated).toString() };
}

export function toTotals(net: bigint, tax: bigint): DocumentTotalsResponse {
  // `net + tax`, added rather than re-derived: summation is exact, so the invariant
  // every line satisfies survives aggregation without anything re-rounding it.
  return { net: net.toString(), tax: tax.toString(), gross: (net + tax).toString() };
}

export function toDocumentLine(
  row: DocumentLineRow,
  tags: ReadonlyMap<string, readonly string[]>,
  rates: ReadonlyMap<string, TaxRateRow>,
): DocumentLine {
  const rate = row.tax_rate_id === null ? undefined : rates.get(row.tax_rate_id.toString('hex'));

  return {
    // A `BIGINT`, stringified so it cannot lose precision on the wire — the same
    // reason money is a string (D-13).
    lineId: row.id.toString(),
    lineNumber: row.line_number,
    // NOT NULL through this service: `documentLineInputSchema` requires a
    // description and the response type is non-nullable, so the column's nullability
    // is the schema being permissive about rows nothing here writes.
    description: row.description ?? '',
    quantity: quantityToString(quantityFromMicros(row.quantity_micros)),
    unitAmount: row.unit_amount_minor.toString(),
    accountId: bufferToUuid(row.account_id),
    taxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
    // Null when the line carries no rate, which is not the same as a zero-rated
    // one — a VAT return reports those separately.
    taxRatePercentage: rate === undefined ? null : taxRateToPercentString(toTaxRate(rate.rate_ppm)),
    netAmount: row.line_amount_minor.toString(),
    taxAmount: row.tax_amount_minor.toString(),
    grossAmount: (row.line_amount_minor + row.tax_amount_minor).toString(),
    dimensionValueIds: [...(tags.get(row.id.toString()) ?? [])],
  };
}

/**
 * One row per rate, which is what a tax return is filed from.
 *
 * Grouped by rate *id* rather than by percentage, because two rates can share a
 * percentage and post to different accounts — an org reclaiming input tax holds a
 * sales rate and a purchases rate, and a return reports them apart. The untaxed
 * group is `null` and is emitted only when something is in it.
 *
 * Ordered by line number of first appearance, so the summary reads in the order the
 * document does rather than in whatever order a `Map` happens to hold.
 */
export function toTaxSummary(
  lines: readonly DocumentLineRow[],
  rates: ReadonlyMap<string, TaxRateRow>,
): readonly DocumentTaxSummaryRow[] {
  const groups = new Map<string, { net: bigint; tax: bigint; rate: TaxRateRow | undefined }>();

  for (const line of lines) {
    const key = line.tax_rate_id === null ? '' : line.tax_rate_id.toString('hex');
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        net: line.line_amount_minor,
        tax: line.tax_amount_minor,
        rate: key === '' ? undefined : rates.get(key),
      });
    } else {
      existing.net += line.line_amount_minor;
      existing.tax += line.tax_amount_minor;
    }
  }

  return [...groups.entries()].map(([key, group]) => ({
    taxRateId: key === '' ? null : bufferToUuid(Buffer.from(key, 'hex')),
    taxRateName: group.rate?.name ?? null,
    percentage:
      group.rate === undefined ? null : taxRateToPercentString(toTaxRate(group.rate.rate_ppm)),
    net: group.net.toString(),
    tax: group.tax.toString(),
  }));
}

/**
 * The allocations against this document, naming both ends.
 *
 * Both ends rather than only the far one, because the same shape is embedded on a
 * payment (where the client knows the source) and on an invoice (where it knows the
 * target), and a shape that dropped the known end would be two shapes.
 *
 * `sourceNumber` is null for a payment deliberately: D-36 numbers the four document
 * types and nothing else, so a payment has no number to quote even though the table
 * carries a sequence of its own for the receipt.
 */
export function toAllocations(
  kind: ArDocumentKind,
  rows: readonly AllocationRow[],
  documentId: Buffer,
  documentNumber: bigint | null,
  counterpartNumbers: ReadonlyMap<string, bigint | null>,
): readonly Allocation[] {
  return rows.map((row) => {
    const shared = {
      id: bufferToUuid(row.id),
      amount: row.amount_minor.toString(),
      date: row.allocated_on,
      createdAt: row.created_at.toISOString(),
    };

    if (kind.allocationColumn === 'credit_note_id') {
      return {
        ...shared,
        sourceType: 'credit_note' as const,
        sourceId: bufferToUuid(documentId),
        sourceNumber: numberText(documentNumber),
        targetType: 'invoice' as const,
        targetId: bufferToUuid(row.invoice_id),
        targetNumber: numberText(counterpartNumbers.get(row.invoice_id.toString('hex')) ?? null),
      };
    }

    const source = row.payment_id ?? row.credit_note_id;
    if (source === null) {
      // `chk_ar_allocations_one_source` makes exactly one of the two non-null, so
      // reaching here means the constraint is gone. Stated as a fault rather than
      // defaulted, because every available default would attribute the credit to
      // something that did not give it.
      throw new InternalError(
        'An allocation names neither a payment nor a credit note; ' +
          'chk_ar_allocations_one_source should make that unrepresentable.',
      );
    }

    return {
      ...shared,
      sourceType: row.payment_id === null ? ('credit_note' as const) : ('payment' as const),
      sourceId: bufferToUuid(source),
      sourceNumber:
        row.payment_id === null
          ? numberText(counterpartNumbers.get(source.toString('hex')) ?? null)
          : null,
      targetType: 'invoice' as const,
      targetId: bufferToUuid(documentId),
      targetNumber: numberText(documentNumber),
    };
  });
}

/** Everything a detail response is assembled from, gathered by the service. */
export interface DocumentView {
  readonly row: DocumentRow;
  readonly lines: readonly DocumentLineRow[];
  readonly tags: ReadonlyMap<string, readonly string[]>;
  readonly rates: ReadonlyMap<string, TaxRateRow>;
  readonly allocations: readonly Allocation[];
  readonly net: bigint;
  readonly tax: bigint;
  readonly allocated: bigint;
}

export function toInvoice(view: DocumentView): Invoice {
  const gross = view.net + view.tax;

  return {
    id: bufferToUuid(view.row.id),
    documentNumber: numberText(view.row.sequence_number),
    reference: view.row.reference,
    contactId: bufferToUuid(view.row.contact_id),
    issueDate: view.row.issue_date,
    // Defaulted to the issue date at creation and never cleared, so the column's
    // nullability is for the credit notes that share this table. The fallback is
    // "due on receipt", which is what the default means.
    dueDate: view.row.due_date ?? view.row.issue_date,
    taxMode: view.row.tax_mode,
    status: documentStatus(view.row, gross, view.allocated),
    memo: view.row.memo,
    lines: view.lines.map((line) => toDocumentLine(line, view.tags, view.rates)),
    totals: toTotals(view.net, view.tax),
    taxSummary: [...toTaxSummary(view.lines, view.rates)],
    settlement: toSettlement(gross, view.allocated),
    allocations: [...view.allocations],
    journalId: view.row.journal_id === null ? null : bufferToUuid(view.row.journal_id),
    voidJournalId:
      view.row.void_journal_id === null ? null : bufferToUuid(view.row.void_journal_id),
    createdAt: view.row.created_at.toISOString(),
    updatedAt: view.row.updated_at.toISOString(),
  };
}

export function toCreditNote(view: DocumentView): CreditNote {
  const invoice = toInvoice(view);
  // A credit note has no due date: nothing about it falls due and aging never ages
  // one. Destructured off rather than built twice, so the two responses cannot drift
  // in any of the fourteen fields they share.
  const { dueDate: _dueDate, ...rest } = invoice;
  return rest;
}

export function toInvoiceSummary(row: DocumentPageRow): InvoiceSummary {
  const net = toBigInt(row.net);
  const tax = toBigInt(row.tax);
  const allocated = toBigInt(row.allocated);

  return {
    id: bufferToUuid(row.id),
    documentNumber: numberText(row.sequence_number),
    reference: row.reference,
    contactId: bufferToUuid(row.contact_id),
    issueDate: row.issue_date,
    dueDate: row.due_date ?? row.issue_date,
    status: documentStatus(row, net + tax, allocated),
    totals: toTotals(net, tax),
    settlement: toSettlement(net + tax, allocated),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toCreditNoteSummary(row: DocumentPageRow): CreditNoteSummary {
  const { dueDate: _dueDate, ...rest } = toInvoiceSummary(row);
  return rest;
}

/**
 * A `BIGINT` sequence number as the label it is.
 *
 * A string rather than a JSON number because a document number is a label — an org
 * that prefixes its invoices reads `INV-000124`, not 124 — and because the counter
 * is a `BIGINT` (D-13's argument applied to an identifier).
 */
function numberText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
