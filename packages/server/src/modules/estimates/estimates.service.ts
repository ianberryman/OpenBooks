import type {
  CreateEstimateRequest,
  CreateInvoiceRequest,
  DocumentLineInput,
  Estimate,
  EstimatePage,
  EstimateSummary,
  Invoice,
  ListEstimatesQuery,
  PredocumentLineInput,
  TaxMode,
  UpdateEstimateRequest,
} from '@openbooks/shared-types';
import {
  createEstimateRequestSchema,
  listEstimatesQuerySchema,
  quantityFromString,
  quantityToString,
  quantityUnits,
  taxRateToPercentString,
  updateEstimateRequestSchema,
} from '@openbooks/shared-types';
import { fromMinorString, toMinorUnits } from '@openbooks/shared-types/money';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, resolvePageLimit, tryUuidToBuffer, uuidToBuffer } from '../../db';
import type { TenantDatabase } from '../../db';
import type { ValidationIssue } from '../../errors';
import {
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
  parseInput,
} from '../../errors';
import { createInvoice } from '../invoices';
import type { TaxRateRow } from '../invoices/ar-documents.repository';
import {
  selectContact,
  selectExistingAccountIds,
  selectTaxRates,
} from '../invoices/ar-documents.repository';
import {
  NO_TAX_RATE,
  minor,
  money,
  priceDocument,
  quantityFromMicros,
  quantityToMicros,
  toTaxRate,
} from '../invoices/pricing';
import type { PriceableLine } from '../invoices/pricing';
import { toTotals } from '../invoices/projection';
import { requirePermission } from '../permissions';

import type {
  EstimateFilters,
  EstimateLineRow,
  EstimatePageRow,
  EstimatePatch,
  EstimateRow,
  NewEstimateLineRow,
} from './estimates.repository';
import {
  approveEstimateRow,
  claimEstimateNumber,
  deleteEstimate,
  estimateIdBytes,
  insertEstimate,
  markEstimateConverted,
  newEstimateId,
  orgScope,
  replaceEstimateLines,
  selectEstimateById,
  selectEstimateByIdForUpdate,
  selectEstimateLines,
  selectEstimatesPage,
  updateEstimateRow,
} from './estimates.repository';

/**
 * Estimates: the AR mirror of a purchase order (initiative M, OB-175…176; ROADMAP
 * D-M3, D-M4, D-M6, D-M7).
 *
 * An estimate is a **non-posting pre-document**: it carries lines and its own
 * gapless number, but never a journal (D-M3, D-92). Its lifecycle is
 * `draft` → `approved` → `converted`, told the same way an AR document's is —
 * `chk_estimates_approved` ties `sequence_number` to `approved_at` and
 * `chk_estimates_converted` ties `converted_invoice_id` to `converted_at`, so
 * neither pair is representable half-written — except that *approving* here
 * allocates a number and stamps a timestamp and nothing else, because there is no
 * journal to post (contrast `approveArDocument`, which does both in one
 * transaction).
 *
 * ## No `requireCustomer` guard
 *
 * Unlike AP's `requireVendor` (bills refuse a contact that is not a vendor), the
 * AR side of this codebase does not gate on `is_customer` — `createInvoice`
 * only checks the contact exists, and `createEstimate` follows it exactly. This
 * is a deliberate asymmetry already in the codebase, not an omission here.
 *
 * ## What resolveLines et al. are, having no separate module to import from
 *
 * `ar-documents.service.ts`'s `resolveLines` prices AR document lines and is not
 * exported (it is `ar_documents`/`ar_document_lines`-specific and private to that
 * file). `resolveEstimateLines` below is the same algorithm restated over
 * `estimate_lines` — same tax-rate-existence, archived-rate and
 * `applies_to !== 'purchases'` checks, same `priceDocument` call — with the one
 * simplification D-M7 buys: no `dimensionValueIds`, so there is no tags module to
 * consult and no second table to write. Everything reusable *is* reused: the
 * account/tax-rate existence reads, the tax-rate row shape, the contact existence
 * check and the pricing primitives all come from `ar-documents.repository.ts` and
 * `invoices/pricing.ts` — imported, never re-implemented.
 *
 * ## Convert calls `createInvoice`, never writes an invoice row itself
 *
 * `convertEstimateToInvoice` builds a `CreateInvoiceRequest` from the estimate's
 * header and priced lines and calls the ordinary `createInvoice` (D-M4). Because
 * `TenantDatabase.transaction` joins an already-open ambient transaction rather
 * than starting a nested one (`transaction-scope.ts`), the estimate's row lock,
 * `createInvoice`'s insert, and the `converted_invoice_id` write that follows are
 * one unit of work on one connection — a rollback of any part rolls back all of
 * it. Convert-once is the `FOR UPDATE` read of the estimate plus the
 * `converted_invoice_id IS NULL` check, exactly as an AR document's approve
 * guards against a second journal.
 *
 * The invoice's `issueDate` is the day of conversion, not the estimate's own —
 * an estimate can sit approved for months, and the invoice it produces should
 * date from when it was actually raised, not from when the quote was drawn up.
 * Its `dueDate` then follows the ordinary `createInvoice` default (the contact's
 * payment term, or due-on-receipt) rather than anything carried over.
 *
 * There are no routes here; transport is `transport/routes/estimates.ts`.
 */

export async function createEstimate(
  input: CreateEstimateRequest,
  ctx: RequestContext = getContext('createEstimate()'),
): Promise<Estimate> {
  await requireWrite(ctx);
  const request = parseInput(createEstimateRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = newEstimateId();
    const contactId = await resolveContact(trx, request.contactId);

    await insertEstimate(trx, id, {
      createdByUserId: author,
      contactId,
      issueDate: request.issueDate,
      expiryDate: request.expiryDate ?? null,
      taxMode: request.taxMode,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
    });

    if (request.lines !== undefined) {
      await replaceEstimateLines(
        trx,
        id,
        await resolveEstimateLines(trx, request.lines, request.taxMode),
      );
    }

    return toEstimate(await readEstimate(trx, id));
  });
}

export async function getEstimate(
  estimateId: string,
  ctx: RequestContext = getContext('getEstimate()'),
): Promise<Estimate> {
  await requirePermission(ctx, 'estimates.read');

  const db = orgScope(ctx);
  return toEstimate(await readEstimate(db, assertFound(estimateIdBytes(estimateId), 'estimate')));
}

/**
 * One page of the org's estimates, oldest first (D-21) — `listInvoices`'s
 * reasoning applies unchanged: the document number is null until approval and
 * `issueDate` stays editable while a draft, so `(created_at, id)` is the only
 * keyset available.
 */
export async function listEstimates(
  query: ListEstimatesQuery,
  ctx: RequestContext = getContext('listEstimates()'),
): Promise<EstimatePage> {
  await requirePermission(ctx, 'estimates.read');
  const request = parseInput(listEstimatesQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const filters: EstimateFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.status === undefined ? {} : { status: request.status }),
  };

  const page = await selectEstimatesPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toEstimateSummary), nextCursor: page.nextCursor };
}

/**
 * Updates the header, and — when `lines` is present — replaces the whole line
 * set. Draft only: `updateArDocument`'s reasoning applies, minus the ledger —
 * there is no journal here to protect, but a line added mid-approve would still
 * be a line the (about-to-be-allocated) number never accounted for.
 */
export async function updateEstimate(
  estimateId: string,
  input: UpdateEstimateRequest,
  ctx: RequestContext = getContext('updateEstimate()'),
): Promise<Estimate> {
  await requireWrite(ctx);
  const request = parseInput(updateEstimateRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(estimateIdBytes(estimateId), 'estimate');
    const row = assertFound(await selectEstimateByIdForUpdate(trx, id), 'estimate');
    assertDraft(row);

    const contactId =
      request.contactId === undefined ? undefined : await resolveContact(trx, request.contactId);

    const patch: EstimatePatch = {
      ...(contactId === undefined ? {} : { contactId }),
      ...(request.issueDate === undefined ? {} : { issueDate: request.issueDate }),
      ...(request.expiryDate === undefined ? {} : { expiryDate: request.expiryDate }),
      ...(request.taxMode === undefined ? {} : { taxMode: request.taxMode }),
      ...(request.reference === undefined ? {} : { reference: request.reference }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
    };
    await updateEstimateRow(trx, id, patch, new Date());

    const taxMode = request.taxMode ?? row.tax_mode;

    if (request.lines !== undefined) {
      await replaceEstimateLines(trx, id, await resolveEstimateLines(trx, request.lines, taxMode));
    } else if (taxMode !== row.tax_mode) {
      // `updateArDocument`'s repricing branch, restated: the inputs (quantity,
      // unit amount, rate) did not change, only what `unitAmount` means, so
      // every line is repriced under the new mode. See `repriceLines` for why
      // this goes through a replace rather than the narrower in-place update
      // the AR original uses.
      await repriceLines(trx, id, taxMode);
    }

    return toEstimate(await readEstimate(trx, id));
  });
}

/**
 * Discards a draft and its lines outright. Draft only, and it holds no number —
 * `discardArDocument`'s reasoning, minus the ledger: nothing about this estimate
 * has been shown to anyone but the person composing it.
 */
export async function discardEstimate(
  estimateId: string,
  ctx: RequestContext = getContext('discardEstimate()'),
): Promise<void> {
  await requireWrite(ctx);

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(estimateIdBytes(estimateId), 'estimate');
    const row = assertFound(await selectEstimateByIdForUpdate(trx, id), 'estimate');
    assertDraft(row);

    if ((await deleteEstimate(trx, id)) !== 1) {
      throw new InternalError(
        'Discarding an estimate removed no row while holding its row lock. The estimate was ' +
          'read FOR UPDATE in this transaction, so it cannot have been removed by another one.',
      );
    }
  });
}

/**
 * Approves a draft: allocates its gapless number and stamps `approved_at`.
 * No journal — an estimate never posts one (D-M3) — so this is strictly
 * narrower than `approveArDocument`: there is no control account to resolve and
 * no balance to check, only that the estimate is still a draft and carries at
 * least one line to carry forward at convert.
 */
export async function approveEstimate(
  estimateId: string,
  ctx: RequestContext = getContext('approveEstimate()'),
): Promise<Estimate> {
  await requireWrite(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(estimateIdBytes(estimateId), 'estimate');
    const row = assertFound(await selectEstimateByIdForUpdate(trx, id), 'estimate');

    if (row.sequence_number !== null) {
      throw new PreconditionFailedError(
        'estimate_already_approved',
        'This estimate has already been approved. Approval allocates its gapless number once ' +
          '(D-36); an estimate that must change after that is edited by discarding and re-quoting.',
      );
    }

    const lines = await selectEstimateLines(trx, id);
    if (lines.length === 0) {
      throw new ValidationError('This estimate is not ready to approve.', [
        {
          path: 'lines',
          message: 'An estimate needs at least one line before it can be approved.',
        },
      ]);
    }

    const sequenceNumber = await claimEstimateNumber(trx);
    const approvedAt = new Date();

    const updated = await approveEstimateRow(trx, id, sequenceNumber, approvedAt);
    if (updated !== 1) {
      throw new InternalError(
        `Approving an estimate updated ${String(updated)} rows while holding its row lock. The ` +
          'estimate was read FOR UPDATE in this transaction, so it cannot have been approved by ' +
          'another one.',
      );
    }

    return toEstimate(await readEstimate(trx, id));
  });
}

/**
 * Converts an approved estimate into a draft invoice, carrying every line
 * across (D-M4). See the file header for the transaction argument and for why
 * the invoice's `issueDate` is the day of conversion.
 *
 * `createInvoice` checks its own `invoices.write` permission — this function
 * checks only `estimates.write` before it. That composition is deliberate, the
 * same shape `approveArDocument` takes with `postJournal`'s `journals.post`: the
 * creator of the ledger-adjacent row is the one authority on what it takes to
 * create it.
 */
export async function convertEstimateToInvoice(
  estimateId: string,
  ctx: RequestContext = getContext('convertEstimateToInvoice()'),
): Promise<Invoice> {
  await requireWrite(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(estimateIdBytes(estimateId), 'estimate');
    const row = assertFound(await selectEstimateByIdForUpdate(trx, id), 'estimate');

    if (row.sequence_number === null) {
      throw new PreconditionFailedError(
        'estimate_not_approved',
        'This estimate has not been approved, so it has no number to stand behind an invoice. ' +
          'Approve it first.',
      );
    }
    if (row.converted_invoice_id !== null) {
      throw new PreconditionFailedError(
        'estimate_already_converted',
        'This estimate has already been converted to an invoice. Converting happens at most ' +
          'once (D-M4) — find the invoice it produced instead of converting it again.',
      );
    }

    const lines = await selectEstimateLines(trx, id);

    const request: CreateInvoiceRequest = {
      contactId: bufferToUuid(row.contact_id),
      // The day of conversion, not the estimate's own `issueDate` — see the file
      // header.
      issueDate: new Date().toISOString().slice(0, 10),
      taxMode: row.tax_mode,
      ...(row.reference === null ? {} : { reference: row.reference }),
      ...(row.memo === null ? {} : { memo: row.memo }),
      lines: lines.map((line) => toDocumentLineInput(line)),
    };

    // Joins this same transaction (`TenantDatabase.transaction`'s ambient-scope
    // check) rather than opening a second one, so the invoice's insert and the
    // `converted_invoice_id` write below cannot land on different connections.
    const invoice = await createInvoice(request, ctx);

    const updated = await markEstimateConverted(trx, id, uuidToBuffer(invoice.id), new Date());
    if (updated !== 1) {
      throw new InternalError(
        `Converting an estimate updated ${String(updated)} rows while holding its row lock. The ` +
          'invoice is already created and the estimate may not record the conversion.',
      );
    }

    return invoice;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface EstimateView {
  readonly row: EstimateRow;
  readonly lines: readonly EstimateLineRow[];
  readonly rates: ReadonlyMap<string, TaxRateRow>;
  readonly net: bigint;
  readonly tax: bigint;
}

async function readEstimate(db: TenantDatabase, id: Buffer): Promise<EstimateView> {
  const row = assertFound(await selectEstimateById(db, id), 'estimate');
  const lines = await selectEstimateLines(db, id);
  const rates = await selectTaxRates(db, rateIds(lines));

  return {
    row,
    lines,
    rates,
    net: sumOf(lines, (line) => line.line_amount_minor),
    tax: sumOf(lines, (line) => line.tax_amount_minor),
  };
}

function estimateStatus(row: EstimateRow): 'approved' | 'converted' | 'draft' {
  if (row.converted_invoice_id !== null) return 'converted';
  if (row.sequence_number !== null) return 'approved';
  return 'draft';
}

function toEstimate(view: EstimateView): Estimate {
  return {
    id: bufferToUuid(view.row.id),
    documentNumber: view.row.sequence_number === null ? null : view.row.sequence_number.toString(),
    reference: view.row.reference,
    contactId: bufferToUuid(view.row.contact_id),
    issueDate: view.row.issue_date,
    expiryDate: view.row.expiry_date,
    taxMode: view.row.tax_mode,
    status: estimateStatus(view.row),
    memo: view.row.memo,
    lines: view.lines.map((line) => toDocumentLine(line, view.rates)),
    totals: toTotals(view.net, view.tax),
    convertedInvoiceId:
      view.row.converted_invoice_id === null ? null : bufferToUuid(view.row.converted_invoice_id),
    approvedAt: view.row.approved_at === null ? null : view.row.approved_at.toISOString(),
    createdAt: view.row.created_at.toISOString(),
    updatedAt: view.row.updated_at.toISOString(),
  };
}

function toEstimateSummary(row: EstimatePageRow): EstimateSummary {
  const net = toBigInt(row.net);
  const tax = toBigInt(row.tax);

  return {
    id: bufferToUuid(row.id),
    documentNumber: row.sequence_number === null ? null : row.sequence_number.toString(),
    reference: row.reference,
    contactId: bufferToUuid(row.contact_id),
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    taxMode: row.tax_mode,
    status: estimateStatus(row),
    memo: row.memo,
    totals: toTotals(net, tax),
    convertedInvoiceId:
      row.converted_invoice_id === null ? null : bufferToUuid(row.converted_invoice_id),
    approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toDocumentLine(
  row: EstimateLineRow,
  rates: ReadonlyMap<string, TaxRateRow>,
): Estimate['lines'][number] {
  const rate = row.tax_rate_id === null ? undefined : rates.get(row.tax_rate_id.toString('hex'));

  return {
    lineId: row.id.toString(),
    lineNumber: row.line_number,
    description: row.description ?? '',
    quantity: quantityToString(quantityFromMicros(row.quantity_micros)),
    unitAmount: row.unit_amount_minor.toString(),
    accountId: bufferToUuid(row.account_id),
    taxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
    taxRatePercentage: rate === undefined ? null : taxRateToPercentString(toTaxRate(rate.rate_ppm)),
    netAmount: row.line_amount_minor.toString(),
    taxAmount: row.tax_amount_minor.toString(),
    grossAmount: (row.line_amount_minor + row.tax_amount_minor).toString(),
    // No dimension tags on a predocument line (D-M7) — always empty, never
    // read from a table that does not exist for this document.
    dimensionValueIds: [],
  };
}

/**
 * One converted line, as `createInvoice`'s own request schema takes it.
 *
 * No `dimensionValueIds` — the estimate line carries none to translate (D-M7) —
 * and no rate lookup: `createInvoice` re-resolves `taxRateId` itself (through its
 * own `resolveLines`), so nothing here needs the rate row, only its id.
 */
function toDocumentLineInput(row: EstimateLineRow): DocumentLineInput {
  return {
    description: row.description ?? '',
    quantity: quantityToString(quantityFromMicros(row.quantity_micros)),
    unitAmount: row.unit_amount_minor.toString(),
    accountId: bufferToUuid(row.account_id),
    taxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
  };
}

// ---------------------------------------------------------------------------
// Writing lines
// ---------------------------------------------------------------------------

/**
 * Turns wire lines into priced rows, resolving and checking every reference.
 *
 * The AR-side `resolveLines` (`ar-documents.service.ts`), restated over
 * `estimate_lines` with no dimension step (D-M7): same existence checks (an
 * unknown or cross-org account/tax-rate id is a 404, not the 500 a foreign-key
 * violation would produce — A7), same archived-rate and
 * `applies_to !== 'purchases'` refusals, same one-call-at-the-end
 * `priceDocument` so a line is priced by the shared implementation exactly as a
 * client previewing it would be (D-35).
 */
async function resolveEstimateLines(
  db: TenantDatabase,
  lines: readonly PredocumentLineInput[],
  mode: TaxMode,
): Promise<readonly NewEstimateLineRow[]> {
  const accountIds = dedupe(
    lines.map((line) => idBytes(line.accountId, 'account')).filter(isPresent),
  );
  const requestedRateIds = dedupe(
    lines
      .map((line) => (line.taxRateId == null ? undefined : idBytes(line.taxRateId, 'tax_rate')))
      .filter(isPresent),
  );

  const [accounts, rates] = await Promise.all([
    selectExistingAccountIds(db, accountIds),
    selectTaxRates(db, requestedRateIds),
  ]);

  if (accountIds.some((id) => !accounts.has(id.toString('hex')))) {
    throw new NotFoundError('account');
  }
  if (requestedRateIds.some((id) => !rates.has(id.toString('hex')))) {
    throw new NotFoundError('tax_rate');
  }

  const issues: ValidationIssue[] = [];
  const priceable: PriceableLine[] = [];
  const resolved: Omit<NewEstimateLineRow, 'lineAmountMinor' | 'taxAmountMinor'>[] = [];

  for (const [index, line] of lines.entries()) {
    const path = `lines.${String(index)}`;
    const quantity = quantityFromString(line.quantity);
    const unitAmount = fromMinorString(line.unitAmount);

    if (quantityUnits(quantity) <= 0n) {
      issues.push({
        path: `${path}.quantity`,
        message:
          'A quantity must be greater than zero. An estimate carries no negative lines — there ' +
          'is no credit-note equivalent for a quote.',
      });
    }

    if (toMinorUnits(unitAmount) < 0n) {
      issues.push({
        path: `${path}.unitAmount`,
        message: 'A unit amount must not be negative.',
      });
    }

    const rateRow = line.taxRateId == null ? undefined : rates.get(hexOf(line.taxRateId));

    if (rateRow !== undefined && rateRow.is_active !== 1) {
      issues.push({
        path: `${path}.taxRateId`,
        message:
          'This tax rate is archived and cannot be put on a new line. An archived rate stays on ' +
          'the documents that already used it.',
      });
    }

    if (rateRow !== undefined && rateRow.applies_to === 'purchases') {
      issues.push({
        path: `${path}.taxRateId`,
        message:
          'This tax rate applies to purchases only, so it cannot price a line on an estimate. A ' +
          'rate posts to one account, and an org that reclaims input tax holds a separate rate ' +
          'for sales — using this one would post output tax to the input-tax account.',
      });
    }

    priceable.push({
      quantity,
      unitAmount,
      rate: rateRow === undefined ? NO_TAX_RATE : toTaxRate(rateRow.rate_ppm),
    });

    resolved.push({
      lineNumber: index + 1,
      description: line.description,
      quantityMicros: quantityToMicros(quantity),
      unitAmountMinor: toMinorUnits(unitAmount),
      accountId: idBytes(line.accountId, 'account'),
      taxRateId: line.taxRateId == null ? null : idBytes(line.taxRateId, 'tax_rate'),
    });
  }

  if (issues.length > 0) throw new ValidationError('Estimate line is not storable.', issues);

  const priced = priceDocument(priceable, mode);

  return resolved.map((line, index) => {
    const split = priced.lines[index];
    if (split === undefined) {
      throw new InternalError('The pricing returned fewer lines than it was given.');
    }
    return { ...line, lineAmountMinor: minor(split.net), taxAmountMinor: minor(split.tax) };
  });
}

/**
 * Recomputes both stored amounts on every line, under a new tax mode.
 *
 * Through `replaceEstimateLines` rather than a narrower in-place update (unlike
 * `ar-documents.service.ts`'s `repriceLines`, which has `updateLineAmounts` for
 * exactly this): an estimate line carries no tags to preserve (D-M7), so
 * reissuing the row's id costs nothing a replace would otherwise lose.
 */
async function repriceLines(db: TenantDatabase, id: Buffer, mode: TaxMode): Promise<void> {
  const lines = await selectEstimateLines(db, id);
  if (lines.length === 0) return;

  const rates = await selectTaxRates(db, rateIds(lines));
  const priced = priceDocument(
    lines.map((line) => toPriceableLine(line, rates)),
    mode,
  );

  await replaceEstimateLines(
    db,
    id,
    lines.map((line, index) => {
      const split = priced.lines[index];
      if (split === undefined) {
        throw new InternalError('The pricing returned fewer lines than it was given.');
      }
      return {
        lineNumber: line.line_number,
        description: line.description ?? '',
        quantityMicros: line.quantity_micros,
        unitAmountMinor: line.unit_amount_minor,
        accountId: line.account_id,
        taxRateId: line.tax_rate_id,
        lineAmountMinor: minor(split.net),
        taxAmountMinor: minor(split.tax),
      };
    }),
  );
}

function toPriceableLine(
  row: EstimateLineRow,
  rates: ReadonlyMap<string, TaxRateRow>,
): PriceableLine {
  const rate = row.tax_rate_id === null ? undefined : rates.get(row.tax_rate_id.toString('hex'));

  return {
    quantity: quantityFromMicros(row.quantity_micros),
    unitAmount: money(row.unit_amount_minor),
    rate: rate === undefined ? NO_TAX_RATE : toTaxRate(rate.rate_ppm),
  };
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

function assertDraft(row: EstimateRow): void {
  if (row.sequence_number === null) return;

  throw new PreconditionFailedError(
    'estimate_approved',
    'This estimate has been approved, so it can no longer be edited or discarded. Approve, send ' +
      'and convert are the only operations left to it.',
  );
}

function idBytes(value: string, resource: string): Buffer {
  return assertFound(tryUuidToBuffer(value), resource);
}

function hexOf(value: string): string {
  return idBytes(value, 'tax_rate').toString('hex');
}

/**
 * The contact, which must exist in this org. Existence only — there is no
 * `requireCustomer`-style guard on the AR side of this codebase (see the file
 * header), so a contact not flagged `is_customer` is accepted exactly as
 * `createInvoice` accepts one.
 */
async function resolveContact(db: TenantDatabase, contactId: string): Promise<Buffer> {
  const id = idBytes(contactId, 'contact');
  assertFound(await selectContact(db, id), 'contact');
  return id;
}

function rateIds(lines: readonly EstimateLineRow[]): readonly Buffer[] {
  return dedupe(lines.map((line) => line.tax_rate_id).filter(isPresent));
}

function dedupe(ids: readonly Buffer[]): readonly Buffer[] {
  return [...new Map(ids.map((id) => [id.toString('hex'), id])).values()];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function sumOf<T>(rows: readonly T[], of: (row: T) => bigint): bigint {
  return rows.reduce((total, row) => total + of(row), 0n);
}

function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function requireAuthor(ctx: RequestContext): Buffer {
  const userId =
    ctx.userId === null || ctx.userId === undefined ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('An estimate is raised by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot raise an estimate. Who raised one is ' +
          'part of the record it becomes.',
      },
    ]);
  }
  return userId;
}

async function requireWrite(ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'estimates.write');
}
