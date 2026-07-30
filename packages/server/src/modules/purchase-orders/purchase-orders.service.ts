import type {
  Bill,
  CreateBillRequest,
  CreatePurchaseOrderRequest,
  DocumentLine,
  ListPurchaseOrdersQuery,
  PurchaseOrder,
  PurchaseOrderPage,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  UpdatePurchaseOrderRequest,
} from '@openbooks/shared-types';
import {
  createPurchaseOrderRequestSchema,
  listPurchaseOrdersQuerySchema,
  updatePurchaseOrderRequestSchema,
} from '@openbooks/shared-types';
import { add, fromMinorUnits, toMinorString } from '@openbooks/shared-types/money';
import type { Quantity, TaxMode } from '@openbooks/shared-types/tax';
import {
  quantityFromUnits,
  quantityToString,
  taxRateFromUnits,
  taxRateToPercentString,
} from '@openbooks/shared-types/tax';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, resolvePageLimit, tryUuidToBuffer, uuidToBuffer } from '../../db';
import {
  assertFound,
  InternalError,
  parseInput,
  PreconditionFailedError,
  ValidationError,
} from '../../errors';
import { createBill } from '../bills';
import type { TaxRateRow } from '../bills/ap-documents.repository';
import { selectTaxRates } from '../bills/ap-documents.repository';
import {
  distinctRateIds,
  documentTotals,
  linesAsInput,
  requireAuthor,
  requireVendor,
  resolveLines,
} from '../bills/ap-documents.service';
import { requirePermission } from '../permissions';

import type {
  NewPurchaseOrderLineRow,
  PurchaseOrderLineRow,
  PurchaseOrderRow,
} from './purchase-orders.repository';
import {
  PURCHASE_ORDER_RESOURCE as RESOURCE,
  approvePurchaseOrderRow,
  claimPurchaseOrderNumber,
  deletePurchaseOrder,
  insertPurchaseOrder,
  markPurchaseOrderConverted,
  newPurchaseOrderId,
  orgScope,
  purchaseOrderIdBytes,
  replacePurchaseOrderLines,
  selectLinesForPurchaseOrders,
  selectPurchaseOrderById,
  selectPurchaseOrderByIdForUpdate,
  selectPurchaseOrderLines,
  selectPurchaseOrdersPage,
  updatePurchaseOrderRow,
} from './purchase-orders.repository';
import type { PurchaseOrderFilters } from './purchase-orders.repository';

/**
 * Purchase orders (initiative M, OB-170…173; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * A purchase order is a **non-posting pre-document** (D-92, D-M3): create, edit
 * and discard behave exactly as a bill's do while it is a draft, but nothing
 * here ever calls `postJournal`. `approvePurchaseOrder` allocates the gapless
 * number and stamps `approved_at` — nothing else — and
 * `convertPurchaseOrderToBill` is the one financial event a purchase order ever
 * causes: it builds a `CreateBillRequest` from the header and stored lines and
 * calls `createBill` (D-M4), which is the ordinary bill-creation path and
 * therefore requires `bills.write` on its own — the intended downstream
 * separation-of-duties gate, not a permission this module re-checks.
 *
 * Three things follow the rest of the service layer, `ap-documents.service.ts`'s
 * own list restated for this module:
 *
 * 1. `requirePermission` runs first, before the payload is parsed.
 * 2. Every payload is parsed with the shared zod schema — the HTTP route is not
 *    the only caller (spec §12).
 * 3. A miss is always `assertFound`; `tenantDb` has already confined every read
 *    to the caller's org, so a cross-org id reaches the same 404 a nonexistent
 *    one does (A7).
 *
 * ## What is reused from AP, and why it is safe to reuse
 *
 * `resolveLines`, `requireVendor`, `requireAuthor`, `documentTotals` and
 * `linesAsInput` (`bills/ap-documents.service.ts`) are the pricing and
 * reference-resolution machinery bills and vendor credits already share, and a
 * purchase-order line is priced identically — same quantity/unit-amount/
 * account/tax-rate shape, same two roundings (D-35). `PurchaseOrderLineRow`
 * carries the same field names as `ApDocumentLineRow` on purpose, which is what
 * lets `documentTotals` and `linesAsInput` take it directly rather than through
 * a second mapping. The one thing this module does not reuse is the dimension
 * tagging: `resolveLines` still resolves whatever `dimensionValueIds` a caller
 * sends (it is shared with bills, which do carry them), but
 * `predocumentLineInputSchema` never lets a purchase-order request supply any
 * (D-M7), and the priced rows are stored with the `dimensions` field dropped —
 * see `resolvePurchaseOrderLines`.
 */

/**
 * `quantity_micros` is scaled by 1,000,000 and `Quantity` is scaled by 10,000.
 * `ap-documents.service.ts`'s own constant, restated: 1,000,000 / 10,000 is
 * exactly 100, so no rounding is introduced converting between them.
 */
const MICROS_PER_QUANTITY_UNIT = 100n;

/** No purchase-order line carries a tag (D-M7), so every `linesAsInput` call sees an empty map. */
const NO_LINE_TAGS: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * Priced lines, with the dimensions `resolveLines` resolved dropped.
 *
 * `resolveLines` is shared with bills and vendor credits and always resolves
 * `dimensionValueIds`, but `predocumentLineInputSchema` (D-M7) never carries
 * any on a purchase-order request, so the array it returns is always empty —
 * dropping it here rather than widening `NewPurchaseOrderLineRow` to carry a
 * field that could only ever be `[]`.
 */
async function resolvePurchaseOrderLines(
  db: TenantDatabase,
  lines: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitAmount: string;
    readonly accountId: string;
    readonly taxRateId?: string | null | undefined;
  }[],
  taxMode: TaxMode,
): Promise<readonly NewPurchaseOrderLineRow[]> {
  const priced = await resolveLines(db, lines, taxMode);

  return priced.map((line) => ({
    lineNumber: line.lineNumber,
    description: line.description,
    quantityMicros: line.quantityMicros,
    unitAmountMinor: line.unitAmountMinor,
    accountId: line.accountId,
    taxRateId: line.taxRateId,
    lineAmountMinor: line.lineAmountMinor,
    taxAmountMinor: line.taxAmountMinor,
  }));
}

/** Re-prices every stored line under a new tax mode — `repriceLines`'s own shape, PO-side. */
async function repricePurchaseOrderLines(
  db: TenantDatabase,
  purchaseOrderId: Buffer,
  taxMode: TaxMode,
): Promise<void> {
  const lines = await selectPurchaseOrderLines(db, purchaseOrderId);
  if (lines.length === 0) return;

  await replacePurchaseOrderLines(
    db,
    purchaseOrderId,
    await resolvePurchaseOrderLines(db, linesAsInput(lines, NO_LINE_TAGS), taxMode),
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(
  input: CreatePurchaseOrderRequest,
  ctx: RequestContext = getContext('createPurchaseOrder()'),
): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'purchase_orders.write');
  const request = parseInput(createPurchaseOrderRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const contactId = assertFound(tryUuidToBuffer(request.contactId), 'contact');
    await requireVendor(trx, contactId);

    const id = newPurchaseOrderId();
    await insertPurchaseOrder(trx, id, {
      createdByUserId: author,
      contactId,
      issueDate: request.issueDate,
      expectedDate: request.expectedDate ?? null,
      taxMode: request.taxMode,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
    });

    if (request.lines !== undefined) {
      await replacePurchaseOrderLines(
        trx,
        id,
        await resolvePurchaseOrderLines(trx, request.lines, request.taxMode),
      );
    }

    return readPurchaseOrder(trx, id);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getPurchaseOrder(
  purchaseOrderId: string,
  ctx: RequestContext = getContext('getPurchaseOrder()'),
): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'purchase_orders.read');
  const db = orgScope(ctx);
  return readPurchaseOrder(db, assertFound(purchaseOrderIdBytes(purchaseOrderId), RESOURCE));
}

/** One page of the org's purchase orders, oldest first (D-21). */
export async function listPurchaseOrders(
  query: ListPurchaseOrdersQuery,
  ctx: RequestContext = getContext('listPurchaseOrders()'),
): Promise<PurchaseOrderPage> {
  await requirePermission(ctx, 'purchase_orders.read');
  const request = parseInput(listPurchaseOrdersQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const filters: PurchaseOrderFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.status === undefined ? {} : { status: request.status }),
  };

  const db = orgScope(ctx);
  const page = await selectPurchaseOrdersPage(db, filters, limit);
  const linesByPurchaseOrder = await selectLinesForPurchaseOrders(
    db,
    page.rows.map((row) => row.id),
  );

  const items = page.rows.map((row) =>
    toPurchaseOrderSummary(row, linesByPurchaseOrder.get(row.id.toString('hex')) ?? []),
  );

  return { items, nextCursor: page.nextCursor };
}

// ---------------------------------------------------------------------------
// Update / discard — drafts only
// ---------------------------------------------------------------------------

/**
 * Updates a draft's header, and — when `lines` is present — replaces the whole
 * line set. `updateBill`'s own reasoning applies unchanged, including the
 * `FOR UPDATE` read before any write and the re-pricing when `taxMode` changes
 * with no `lines` in the same request.
 */
export async function updatePurchaseOrder(
  purchaseOrderId: string,
  input: UpdatePurchaseOrderRequest,
  ctx: RequestContext = getContext('updatePurchaseOrder()'),
): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'purchase_orders.write');
  const request = parseInput(updatePurchaseOrderRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(purchaseOrderIdBytes(purchaseOrderId), RESOURCE);
    const row = assertFound(await selectPurchaseOrderByIdForUpdate(trx, id), RESOURCE);
    assertDraft(row);

    const contactId =
      request.contactId === undefined
        ? undefined
        : assertFound(tryUuidToBuffer(request.contactId), 'contact');
    if (contactId !== undefined) await requireVendor(trx, contactId);

    await updatePurchaseOrderRow(
      trx,
      id,
      {
        ...(contactId === undefined ? {} : { contactId }),
        ...(request.issueDate === undefined ? {} : { issueDate: request.issueDate }),
        ...(request.expectedDate === undefined ? {} : { expectedDate: request.expectedDate }),
        ...(request.taxMode === undefined ? {} : { taxMode: request.taxMode }),
        ...(request.reference === undefined ? {} : { reference: request.reference }),
        ...(request.memo === undefined ? {} : { memo: request.memo }),
      },
      new Date(),
    );

    const taxMode = request.taxMode ?? row.tax_mode;
    if (request.lines !== undefined) {
      await replacePurchaseOrderLines(
        trx,
        id,
        await resolvePurchaseOrderLines(trx, request.lines, taxMode),
      );
    } else if (taxMode !== row.tax_mode) {
      await repricePurchaseOrderLines(trx, id, taxMode);
    }

    return readPurchaseOrder(trx, id);
  });
}

/**
 * Discards a draft purchase order and everything on it — `discardBill`'s own
 * shape: the row is locked first so "deleted nothing" can be told apart from
 * "was not there" versus "is approved", which a bare 404 could not distinguish
 * for a purchase order the caller can plainly read.
 */
export async function discardPurchaseOrder(
  purchaseOrderId: string,
  ctx: RequestContext = getContext('discardPurchaseOrder()'),
): Promise<void> {
  await requirePermission(ctx, 'purchase_orders.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(purchaseOrderIdBytes(purchaseOrderId), RESOURCE);
    const row = assertFound(await selectPurchaseOrderByIdForUpdate(trx, id), RESOURCE);
    assertDraft(row);

    if ((await deletePurchaseOrder(trx, id)) !== 1) {
      throw new InternalError(
        'Discarding a purchase order deleted no rows while holding its row lock. The purchase ' +
          'order was read FOR UPDATE in this transaction, so it cannot have been removed by ' +
          'another one.',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Approve (D-36, D-M6) — allocates the number; posts no journal
// ---------------------------------------------------------------------------

/**
 * Approves a purchase order: allocates its gapless number and stamps
 * `approved_at`, in one transaction. Unlike `approveBill`, nothing here calls
 * `postJournal` (D-M3) — a purchase order's only financial event is the
 * conversion that follows, not the approval.
 */
export async function approvePurchaseOrder(
  purchaseOrderId: string,
  ctx: RequestContext = getContext('approvePurchaseOrder()'),
): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'purchase_orders.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(purchaseOrderIdBytes(purchaseOrderId), RESOURCE);

    // The counter before the row, `approveDocument`'s own lock order and the same
    // reason: an approval waiting on the counter holds nothing, so it cannot be
    // part of a deadlock cycle with another approval holding this row.
    const sequenceNumber = await claimPurchaseOrderNumber(trx);

    const row = assertFound(await selectPurchaseOrderByIdForUpdate(trx, id), RESOURCE);
    assertApprovable(row);

    const lines = await selectPurchaseOrderLines(trx, id);
    assertHasValue(lines);

    const now = new Date();
    const updated = await approvePurchaseOrderRow(trx, id, sequenceNumber, now);
    if (updated !== 1) {
      throw new InternalError(
        `Approving a purchase order updated ${String(updated)} rows while holding its row lock. ` +
          'The purchase order was read FOR UPDATE in this transaction, so it cannot have been ' +
          'approved by another one.',
      );
    }

    return readPurchaseOrder(trx, id);
  });
}

// ---------------------------------------------------------------------------
// Convert (D-M4) — the one financial event a purchase order ever causes
// ---------------------------------------------------------------------------

/**
 * Converts an approved purchase order into a draft bill, once (D-M4).
 *
 * Builds a `CreateBillRequest` from the purchase order's own header and stored
 * lines — `linesAsInput` round-trips them exactly, since they were stored
 * priced by the same `resolveLines` a bill's own creation uses — and calls
 * `createBill`, which requires `bills.write` on its own. That is deliberate:
 * the permission this operation checks is `purchase_orders.write`, and the bill
 * it produces is gated by AP's own permission, so converting a purchase order
 * and being trusted to enter a bill are two separate grants (the intended
 * separation-of-duties point, restated from the M-contract).
 *
 * Everything runs in **one transaction**: `createBill` opens its own through
 * `orgScope`, which joins this one ambiently (`transaction-scope.ts`), so the
 * bill and the `converted_bill_id`/`converted_at` write are one unit of work —
 * a rollback of either leaves the purchase order exactly as it was, still
 * approved and still unconverted.
 */
export async function convertPurchaseOrderToBill(
  purchaseOrderId: string,
  ctx: RequestContext = getContext('convertPurchaseOrderToBill()'),
): Promise<Bill> {
  await requirePermission(ctx, 'purchase_orders.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(purchaseOrderIdBytes(purchaseOrderId), RESOURCE);
    const row = assertFound(await selectPurchaseOrderByIdForUpdate(trx, id), RESOURCE);

    if (row.approved_at === null || row.sequence_number === null) {
      throw new PreconditionFailedError(
        'purchase_order_not_approved',
        'Only an approved purchase order can be converted. Approve it first, which allocates ' +
          'its gapless number (D-M6).',
      );
    }
    if (row.converted_bill_id !== null) {
      throw new PreconditionFailedError(
        'purchase_order_already_converted',
        `This purchase order has already produced bill ${bufferToUuid(row.converted_bill_id)}. ` +
          'A purchase order converts at most once (D-M4); edit the bill it produced instead.',
      );
    }

    const lines = await selectPurchaseOrderLines(trx, id);
    const request: CreateBillRequest = {
      contactId: bufferToUuid(row.contact_id),
      issueDate: row.issue_date,
      taxMode: row.tax_mode,
      ...(row.reference === null ? {} : { reference: row.reference }),
      ...(row.memo === null ? {} : { memo: row.memo }),
      lines: [...linesAsInput(lines, NO_LINE_TAGS)],
    };

    const bill = await createBill(request, ctx);

    const updated = await markPurchaseOrderConverted(trx, id, uuidToBuffer(bill.id), new Date());
    if (updated !== 1) {
      throw new InternalError(
        `Converting a purchase order updated ${String(updated)} rows while holding its row ` +
          'lock. The purchase order was read FOR UPDATE in this transaction, so it cannot have ' +
          'been converted by another one.',
      );
    }

    return bill;
  });
}

// ---------------------------------------------------------------------------
// Reading a purchase order back
// ---------------------------------------------------------------------------

async function readPurchaseOrder(db: TenantDatabase, id: Buffer): Promise<PurchaseOrder> {
  const row = assertFound(await selectPurchaseOrderById(db, id), RESOURCE);
  return hydrate(db, row);
}

async function hydrate(db: TenantDatabase, row: PurchaseOrderRow): Promise<PurchaseOrder> {
  const lines = await selectPurchaseOrderLines(db, row.id);
  const rates = await selectTaxRates(db, distinctRateIds(lines));
  return toPurchaseOrder(row, lines, rates);
}

function toPurchaseOrder(
  row: PurchaseOrderRow,
  lines: readonly PurchaseOrderLineRow[],
  rates: ReadonlyMap<string, TaxRateRow>,
): PurchaseOrder {
  return {
    ...toPurchaseOrderSummary(row, lines),
    lines: lines.map((line) => toPurchaseOrderLine(line, rates)),
  };
}

function toPurchaseOrderSummary(
  row: PurchaseOrderRow,
  lines: readonly PurchaseOrderLineRow[],
): PurchaseOrderSummary {
  return {
    id: bufferToUuid(row.id),
    documentNumber: row.sequence_number === null ? null : row.sequence_number.toString(),
    reference: row.reference,
    contactId: bufferToUuid(row.contact_id),
    issueDate: row.issue_date,
    expectedDate: row.expected_date,
    taxMode: row.tax_mode,
    status: statusOf(row),
    memo: row.memo,
    totals: documentTotals(lines),
    convertedBillId: row.converted_bill_id === null ? null : bufferToUuid(row.converted_bill_id),
    approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Stored, not computed (D-M6, unlike `statusOf` in `ap-documents.service.ts`):
 * a purchase order posts no journal and has no allocations for a derivation to
 * read, so the three states are read straight off the two columns the lifecycle
 * writes.
 */
function statusOf(row: PurchaseOrderRow): PurchaseOrderStatus {
  if (row.converted_bill_id !== null) return 'converted';
  if (row.approved_at !== null) return 'approved';
  return 'draft';
}

function toPurchaseOrderLine(
  row: PurchaseOrderLineRow,
  rates: ReadonlyMap<string, TaxRateRow>,
): DocumentLine {
  const rate = row.tax_rate_id === null ? undefined : rates.get(row.tax_rate_id.toString('hex'));
  const net = fromMinorUnits(row.line_amount_minor);
  const tax = fromMinorUnits(row.tax_amount_minor);

  return {
    lineId: row.id.toString(),
    lineNumber: row.line_number,
    description: row.description ?? '',
    quantity: quantityToString(toQuantity(row.quantity_micros)),
    unitAmount: toMinorString(fromMinorUnits(row.unit_amount_minor)),
    accountId: bufferToUuid(row.account_id),
    taxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
    taxRatePercentage: rate === undefined ? null : percentOf(rate),
    netAmount: toMinorString(net),
    taxAmount: toMinorString(tax),
    grossAmount: toMinorString(add(net, tax)),
    // No purchase-order line carries a tag in v1 (D-M7).
    dimensionValueIds: [],
  };
}

function toQuantity(micros: bigint): Quantity {
  return quantityFromUnits(micros / MICROS_PER_QUANTITY_UNIT);
}

function percentOf(rate: TaxRateRow): string {
  return taxRateToPercentString(taxRateFromUnits(BigInt(rate.rate_ppm)));
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** `assertDraft`'s own message, PO-side (`ap-documents.service.ts`). */
function assertDraft(row: PurchaseOrderRow): void {
  if (row.approved_at === null) return;

  throw new PreconditionFailedError(
    'purchase_order_approved',
    'An approved purchase order cannot be edited or discarded. Its number is fixed and it may ' +
      'have already converted; issue a new purchase order for anything further (D-M6).',
  );
}

/** `assertApprovable`'s own message, PO-side. */
function assertApprovable(row: PurchaseOrderRow): void {
  if (row.approved_at === null) return;

  throw new PreconditionFailedError(
    'purchase_order_already_approved',
    `This purchase order is already approved as number ${row.sequence_number?.toString() ?? '?'}. ` +
      'Approval happens once (D-M6); convert it to a bill instead.',
  );
}

/** `assertHasValue`'s own message, PO-side. */
function assertHasValue(lines: readonly PurchaseOrderLineRow[]): void {
  const gross = lines.reduce(
    (total, line) => total + line.line_amount_minor + line.tax_amount_minor,
    0n,
  );
  if (gross > 0n) return;

  throw new ValidationError('This purchase order is not ready to approve.', [
    {
      path: 'lines',
      message:
        'A purchase order with no value has nothing for a vendor to fulfil. Add a line, or ' +
        'discard it — approving it anyway would consume a number in a series that has to stay ' +
        'gapless (D-36).',
    },
  ]);
}
