import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';

/**
 * Data access for `purchase_orders` and `purchase_order_lines` (initiative M,
 * OB-170…173; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * The mirror of `bills/ap-documents.repository.ts`, cut down to what a
 * non-posting pre-document needs: there is no `journal_id`/`void_journal_id`
 * pair, no allocations, and no duplicate-reference check — a purchase order
 * that has not converted has caused no financial fact for any of those three to
 * be about. What is identical is the shape that matters most: `org_id` is on
 * every statement before this file adds a predicate (`tenantDb`), so a
 * cross-org id matches nothing and the service's `assertFound` turns that into
 * A7's one sanctioned miss, and `selectPurchaseOrderByIdForUpdate` /
 * `claimPurchaseOrderNumber` both take a locking read only because
 * `purchase_orders` and `document_sequences` are in `0999_app_grants`'s
 * mutable allowlist (D-14).
 *
 * `purchase_order_lines` carries no dimension tags (D-M7, deferred) — one fewer
 * table than `ap_document_lines`' own tag join, and one fewer thing this file
 * has to replace on an edit.
 */

export const PURCHASE_ORDER_RESOURCE = 'purchase_order';

const PURCHASE_ORDER_COLUMNS = [
  'id',
  'sequence_number',
  'contact_id',
  'issue_date',
  'expected_date',
  'tax_mode',
  'reference',
  'memo',
  'approved_at',
  'converted_bill_id',
  'converted_at',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

const LINE_COLUMNS = [
  'id',
  'line_number',
  'description',
  'quantity_micros',
  'unit_amount_minor',
  'account_id',
  'tax_rate_id',
  'catalog_item_id',
  'line_amount_minor',
  'tax_amount_minor',
] as const;

export interface PurchaseOrderRow {
  readonly id: Buffer;
  readonly sequence_number: bigint | null;
  readonly contact_id: Buffer;
  readonly issue_date: string;
  readonly expected_date: string | null;
  readonly tax_mode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
  readonly approved_at: Date | null;
  readonly converted_bill_id: Buffer | null;
  readonly converted_at: Date | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Same field names as `ApDocumentLineRow` on purpose (`bills/ap-documents.repository.ts`):
 * it is what lets the service pass a `PurchaseOrderLineRow[]` straight into
 * `documentTotals` and `linesAsInput` (`bills/ap-documents.service.ts`) rather
 * than mapping to a shape those functions never asked to be widened for.
 */
export interface PurchaseOrderLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly description: string | null;
  readonly quantity_micros: bigint;
  readonly unit_amount_minor: bigint;
  readonly account_id: Buffer;
  readonly tax_rate_id: Buffer | null;
  /** The catalog item this line was selected from, provenance only (D-CAT-2). */
  readonly catalog_item_id: Buffer | null;
  readonly line_amount_minor: bigint;
  readonly tax_amount_minor: bigint;
}

export interface NewPurchaseOrderRow {
  readonly createdByUserId: Buffer;
  readonly contactId: Buffer;
  readonly issueDate: string;
  readonly expectedDate: string | null;
  readonly taxMode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
}

export interface PurchaseOrderPatch {
  readonly contactId?: Buffer;
  readonly issueDate?: string;
  readonly expectedDate?: string | null;
  readonly taxMode?: 'exclusive' | 'inclusive';
  readonly reference?: string | null;
  readonly memo?: string | null;
}

/** A line as the service priced it (`resolveLines`), minus the dimensions AP documents carry (D-M7). */
export interface NewPurchaseOrderLineRow {
  readonly lineNumber: number;
  readonly description: string | null;
  readonly quantityMicros: bigint;
  readonly unitAmountMinor: bigint;
  readonly accountId: Buffer;
  readonly taxRateId: Buffer | null;
  /** The catalog item this line was selected from, or null for a free-form line (D-CAT-2). */
  readonly catalogItemId: Buffer | null;
  readonly lineAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied purchase-order id as bytes, or `undefined` when it is not a
 * UUID — routed through `assertFound` to the same 404 a nonexistent one
 * produces (A7), `documentIdBytes`'s own shape.
 */
export function purchaseOrderIdBytes(purchaseOrderId: string): Buffer | undefined {
  return tryUuidToBuffer(purchaseOrderId);
}

export function newPurchaseOrderId(): Buffer {
  return newUuidBuffer();
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

export async function insertPurchaseOrder(
  db: TenantDatabase,
  id: Buffer,
  input: NewPurchaseOrderRow,
): Promise<void> {
  await db
    .insertInto('purchase_orders')
    .values({
      id,
      sequence_number: null,
      created_by_user_id: input.createdByUserId,
      contact_id: input.contactId,
      issue_date: input.issueDate,
      expected_date: input.expectedDate,
      tax_mode: input.taxMode,
      reference: input.reference,
      memo: input.memo,
      approved_at: null,
      converted_bill_id: null,
      converted_at: null,
    })
    .execute();
}

export async function selectPurchaseOrderById(
  db: TenantDatabase,
  id: Buffer,
): Promise<PurchaseOrderRow | undefined> {
  return db
    .selectFrom('purchase_orders')
    .select(PURCHASE_ORDER_COLUMNS)
    .where('purchase_orders.id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the serialization point for
 * every write to a purchase order (edit, discard, approve, convert). Possible
 * only because `purchase_orders` is in `0999_app_grants`'s mutable allowlist
 * (D-14 explains why the AP/AR document tables can do this and the ledger
 * tables cannot).
 */
export async function selectPurchaseOrderByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<PurchaseOrderRow | undefined> {
  return db
    .selectFrom('purchase_orders')
    .select(PURCHASE_ORDER_COLUMNS)
    .where('purchase_orders.id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Applies the header patch, and always writes `updated_at` — `updateDocumentRow`'s
 * own reason: `ON UPDATE CURRENT_TIMESTAMP(3)` only fires when some column's
 * value actually changes, so an edit that replaced only the lines would leave
 * the header's `updated_at` stale otherwise.
 */
export async function updatePurchaseOrderRow(
  db: TenantDatabase,
  id: Buffer,
  patch: PurchaseOrderPatch,
  now: Date,
): Promise<void> {
  await db
    .updateTable('purchase_orders')
    .set({
      ...(patch.contactId === undefined ? {} : { contact_id: patch.contactId }),
      ...(patch.issueDate === undefined ? {} : { issue_date: patch.issueDate }),
      ...(patch.expectedDate === undefined ? {} : { expected_date: patch.expectedDate }),
      ...(patch.taxMode === undefined ? {} : { tax_mode: patch.taxMode }),
      ...(patch.reference === undefined ? {} : { reference: patch.reference }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      updated_at: now,
    })
    .where('purchase_orders.id', '=', id)
    .execute();
}

/**
 * Records the approval: the number and the timestamp, together, in one
 * statement — `chk_purchase_orders_approved` ties `(sequence_number IS NULL) =
 * (approved_at IS NULL)`, so writing them separately would be inexpressible
 * rather than merely untidy, exactly as `approveDocumentRow`'s own comment
 * argues for the journal-numbering pair.
 *
 * The `approved_at IS NULL` predicate is belt to the row lock's braces: the
 * caller holds the row `FOR UPDATE` and has already read it as unapproved, so a
 * zero here means a concurrent approval slipped past the lock somehow, which the
 * caller reports as a fault rather than silently double-approving.
 */
export async function approvePurchaseOrderRow(
  db: TenantDatabase,
  id: Buffer,
  sequenceNumber: bigint,
  approvedAt: Date,
): Promise<number> {
  const result = await db
    .updateTable('purchase_orders')
    .set({ sequence_number: sequenceNumber, approved_at: approvedAt, updated_at: approvedAt })
    .where('purchase_orders.id', '=', id)
    .where('purchase_orders.approved_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Records the conversion: the bill it produced, and when. `chk_purchase_orders_converted`
 * is the schema's half of convert-once; the `converted_bill_id IS NULL`
 * predicate here is the service's, taken while holding the row `FOR UPDATE`
 * (D-M4) — the same shape `approvePurchaseOrderRow` takes for approval.
 */
export async function markPurchaseOrderConverted(
  db: TenantDatabase,
  id: Buffer,
  billId: Buffer,
  convertedAt: Date,
): Promise<number> {
  const result = await db
    .updateTable('purchase_orders')
    .set({ converted_bill_id: billId, converted_at: convertedAt, updated_at: convertedAt })
    .where('purchase_orders.id', '=', id)
    .where('purchase_orders.converted_bill_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Discards a draft, and with it its lines (`ON DELETE CASCADE`).
 *
 * The `approved_at IS NULL` predicate is what makes discarding an approved
 * purchase order impossible from this path — `chk_purchase_orders_convert_needs_approval`
 * means a converted row is always an approved one too, so this one predicate
 * covers both `deleteDraftDocument`'s guards at once.
 */
export async function deletePurchaseOrder(db: TenantDatabase, id: Buffer): Promise<number> {
  const result = await db
    .deleteFrom('purchase_orders')
    .where('purchase_orders.id', '=', id)
    .where('purchase_orders.approved_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export async function selectPurchaseOrderLines(
  db: TenantDatabase,
  purchaseOrderId: Buffer,
): Promise<readonly PurchaseOrderLineRow[]> {
  return db
    .selectFrom('purchase_order_lines')
    .select(LINE_COLUMNS)
    .where('purchase_order_lines.purchase_order_id', '=', purchaseOrderId)
    .orderBy('purchase_order_lines.line_number')
    .execute();
}

/** The lines of several purchase orders at once, keyed by hex id — `selectLinesForDocuments`'s own shape. */
export async function selectLinesForPurchaseOrders(
  db: TenantDatabase,
  purchaseOrderIds: readonly Buffer[],
): Promise<ReadonlyMap<string, readonly PurchaseOrderLineRow[]>> {
  const byPurchaseOrder = new Map<string, PurchaseOrderLineRow[]>();
  if (purchaseOrderIds.length === 0) return byPurchaseOrder;

  const rows = await db
    .selectFrom('purchase_order_lines')
    .select(LINE_COLUMNS)
    .select('purchase_order_id')
    .where('purchase_order_lines.purchase_order_id', 'in', purchaseOrderIds)
    .orderBy('purchase_order_lines.line_number')
    .execute();

  for (const row of rows) {
    const key = row.purchase_order_id.toString('hex');
    const existing = byPurchaseOrder.get(key);
    if (existing === undefined) byPurchaseOrder.set(key, [row]);
    else existing.push(row);
  }

  return byPurchaseOrder;
}

/**
 * Replaces a purchase order's lines wholesale — `replaceDocumentLines`'s own
 * delete-then-insert shape, minus the tag-reattachment step that file needs and
 * this table has no column for (D-M7).
 */
export async function replacePurchaseOrderLines(
  db: TenantDatabase,
  purchaseOrderId: Buffer,
  lines: readonly NewPurchaseOrderLineRow[],
): Promise<void> {
  await db
    .deleteFrom('purchase_order_lines')
    .where('purchase_order_lines.purchase_order_id', '=', purchaseOrderId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('purchase_order_lines')
    .values(
      lines.map((line) => ({
        purchase_order_id: purchaseOrderId,
        line_number: line.lineNumber,
        description: line.description,
        quantity_micros: line.quantityMicros,
        unit_amount_minor: line.unitAmountMinor,
        account_id: line.accountId,
        tax_rate_id: line.taxRateId,
        catalog_item_id: line.catalogItemId,
        line_amount_minor: line.lineAmountMinor,
        tax_amount_minor: line.taxAmountMinor,
      })),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// The number (D-36, D-M6)
// ---------------------------------------------------------------------------

/**
 * Claims the next number for this org's purchase-order series, gaplessly
 * (D-36) — `claimDocumentNumber`'s own insert-then-lock shape, against the
 * `'purchase_order'` `document_sequences` row rather than a bill's or an
 * invoice's. `(org_id, document_type)` is the primary key, so this lock is
 * per series: approving a purchase order never serializes against approving a
 * bill, an invoice, or an estimate.
 */
export async function claimPurchaseOrderNumber(db: TenantDatabase): Promise<bigint> {
  await db
    .insertInto('document_sequences')
    .values({ document_type: 'purchase_order', next_value: 1n })
    .onDuplicateKeyUpdate({ org_id: db.orgId })
    .execute();

  const counter = await db
    .selectFrom('document_sequences')
    .select('next_value')
    .where('document_sequences.document_type', '=', 'purchase_order')
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('document_sequences')
    .set({ next_value: counter.next_value + 1n })
    .where('document_sequences.document_type', '=', 'purchase_order')
    .execute();

  return counter.next_value;
}

// ---------------------------------------------------------------------------
// Listing (D-21)
// ---------------------------------------------------------------------------

/**
 * `(created_at, id)` — `DOCUMENT_KEYSET`'s own reasoning: `sequence_number` is
 * NULL on every draft and `issue_date` is editable while one still is, so
 * neither is total or stable enough to page on.
 */
const PURCHASE_ORDER_KEYSET: KeysetOrdering<PurchaseOrderRow> = [
  instantKey('purchase_orders.created_at', (row) => row.created_at),
  uuidKey('purchase_orders.id', (row) => row.id),
];

export interface PurchaseOrderFilters {
  readonly contactId?: Buffer | undefined;
  readonly status?: 'draft' | 'approved' | 'converted' | undefined;
  readonly cursor?: string | undefined;
}

/**
 * One page of this org's purchase orders.
 *
 * Unlike `ap_documents`' `part_paid`/`paid`, every status a purchase order can
 * hold is a plain predicate over its own two nullable columns — there is no
 * allocation to aggregate — so the whole filter runs in SQL and nothing is
 * filtered again after the page is assembled.
 */
export async function selectPurchaseOrdersPage(
  db: TenantDatabase,
  filters: PurchaseOrderFilters,
  limit: number,
): Promise<KeysetPage<PurchaseOrderRow>> {
  let query = db.selectFrom('purchase_orders').select(PURCHASE_ORDER_COLUMNS);

  if (filters.contactId !== undefined) {
    query = query.where('purchase_orders.contact_id', '=', filters.contactId);
  }
  if (filters.status === 'draft') {
    query = query.where('purchase_orders.approved_at', 'is', null);
  }
  if (filters.status === 'approved') {
    query = query
      .where('purchase_orders.approved_at', 'is not', null)
      .where('purchase_orders.converted_bill_id', 'is', null);
  }
  if (filters.status === 'converted') {
    query = query.where('purchase_orders.converted_bill_id', 'is not', null);
  }

  const rows = await applyKeyset(query, PURCHASE_ORDER_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, PURCHASE_ORDER_KEYSET, limit);
}
