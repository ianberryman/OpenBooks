import type { TenantDatabase } from '../../db';

/**
 * Data access for `predocument_deliveries` (initiative M, OB-177; ROADMAP D-M5),
 * and the two minimal reads `sendPurchaseOrder`/`sendEstimate` need of their own
 * document.
 *
 * Deliberately self-contained: `purchase-orders`/`estimates` are separate modules
 * built in the same wave, so this file queries `purchase_orders`/`estimates`
 * directly through `tenantDb` rather than importing either — the two select
 * functions below are this module's *own* reads, mirroring `expenses.repository.ts`'s
 * one genuinely-own query rather than reusing another module's repository.
 *
 * `predocument_deliveries` is append-only (`0999_app_grants`), `invoice_deliveries`'
 * own reason (see `delivery/delivery.repository.ts`): a delivery attests that a
 * document went to an address at a time, so the app holds INSERT and no
 * UPDATE/DELETE on it, and there is no update path in this file.
 */

/** What `sendPurchaseOrder`/`sendEstimate` need to know before they can send. */
export interface PredocumentSendRow {
  readonly id: Buffer;
  /** Null on a draft; approving allocates one (`chk_*_approved` ties the two). */
  readonly sequenceNumber: bigint | null;
  readonly reference: string | null;
  readonly contactId: Buffer;
  readonly contactDisplayName: string;
  readonly contactEmail: string | null;
}

/**
 * A purchase order's send-relevant fields, joined to its vendor contact.
 *
 * The join condition ties `contacts.org_id` to `purchase_orders.org_id` rather
 * than to the context directly, because `TenantDatabase.selectFrom` only injects
 * the scope predicate on the table named in `selectFrom` — a joined table is
 * scoped by construction here, transitively, the same pattern
 * `expenses.repository.ts`'s `selectExpensesPage` uses for its own contacts join.
 * Without it, a cross-org contact could satisfy the join.
 */
export async function selectPurchaseOrderForSend(
  db: TenantDatabase,
  id: Buffer,
): Promise<PredocumentSendRow | undefined> {
  const row = await db
    .selectFrom('purchase_orders')
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.org_id', '=', 'purchase_orders.org_id')
        .onRef('contacts.id', '=', 'purchase_orders.contact_id'),
    )
    .select([
      'purchase_orders.id',
      'purchase_orders.sequence_number',
      'purchase_orders.reference',
      'purchase_orders.contact_id',
      'contacts.display_name as contact_display_name',
      'contacts.email as contact_email',
    ])
    .where('purchase_orders.id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toPredocumentSendRow(row);
}

/** The AR mirror of `selectPurchaseOrderForSend`, against `estimates`. */
export async function selectEstimateForSend(
  db: TenantDatabase,
  id: Buffer,
): Promise<PredocumentSendRow | undefined> {
  const row = await db
    .selectFrom('estimates')
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.org_id', '=', 'estimates.org_id')
        .onRef('contacts.id', '=', 'estimates.contact_id'),
    )
    .select([
      'estimates.id',
      'estimates.sequence_number',
      'estimates.reference',
      'estimates.contact_id',
      'contacts.display_name as contact_display_name',
      'contacts.email as contact_email',
    ])
    .where('estimates.id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toPredocumentSendRow(row);
}

interface SendJoinRow {
  readonly id: Buffer;
  readonly sequence_number: bigint | null;
  readonly reference: string | null;
  readonly contact_id: Buffer;
  readonly contact_display_name: string;
  readonly contact_email: string | null;
}

function toPredocumentSendRow(row: SendJoinRow): PredocumentSendRow {
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    reference: row.reference,
    contactId: row.contact_id,
    contactDisplayName: row.contact_display_name,
    contactEmail: row.contact_email,
  };
}

export type PredocumentKind = 'estimate' | 'purchase_order';
export type PredocumentDeliveryStatus = 'failed' | 'sent';

export interface NewPredocumentDeliveryRow {
  readonly id: Buffer;
  readonly documentKind: PredocumentKind;
  readonly documentId: Buffer;
  readonly recipientEmail: string;
  readonly status: PredocumentDeliveryStatus;
  /** The provider's message id when it accepted one; `null` on a failed send. */
  readonly providerMessageId: string | null;
  readonly createdByUserId: Buffer;
}

/**
 * `sent_at` defaults to `CURRENT_TIMESTAMP(3)` (`0015_procure_to_pay`) rather than
 * being set by the app, so it is read back after the insert — MySQL has no
 * `RETURNING`, and the wire contract needs its exact value, not the app's guess at
 * what the default resolved to. Mirrors `delivery.repository.ts`'s
 * `DeliveryTimestamps`.
 */
export interface PredocumentDeliveryTimestamp {
  readonly sentAt: Date;
}

export async function insertPredocumentDelivery(
  db: TenantDatabase,
  row: NewPredocumentDeliveryRow,
): Promise<PredocumentDeliveryTimestamp> {
  await db
    .insertInto('predocument_deliveries')
    .values({
      // `org_id` is injected by `tenantDb`, the same way `insertDocument` omits it.
      id: row.id,
      document_kind: row.documentKind,
      document_id: row.documentId,
      recipient_email: row.recipientEmail,
      status: row.status,
      provider_message_id: row.providerMessageId,
      created_by_user_id: row.createdByUserId,
    })
    .execute();

  const persisted = await db
    .selectFrom('predocument_deliveries')
    .select(['sent_at'])
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();

  return { sentAt: persisted.sent_at };
}
