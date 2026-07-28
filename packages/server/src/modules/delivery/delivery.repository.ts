import type { TenantDatabase } from '../../db';

/**
 * The write side of `invoice_deliveries` (OB-126, Phase 1). The read side —
 * `selectDeliveryCredentialByKeyPrefix` — lives in `src/db/delivery-lookup.ts`
 * because it is reached with no org context; every write here goes through
 * `tenantDb`, which injects `org_id` the way `insertDocument` relies on it to.
 *
 * `invoice_deliveries` is append-only (`0999_app_grants`): a delivery attests that
 * an artifact went to an address at a time, so the app holds INSERT and no
 * UPDATE/DELETE on it. There is deliberately no update path in this file — a re-send
 * and a retried failure are each a new row, never an edit of an old one
 * (`0007_invoice_delivery`'s header).
 */

export interface NewDeliveryRow {
  readonly id: Buffer;
  readonly invoiceId: Buffer;
  readonly recipientEmail: string;
  readonly artifactStorageKey: string;
  readonly keyPrefix: string;
  readonly tokenHash: Buffer;
  /** The provider's message id when it accepted one; `null` on a failed send. */
  readonly providerMessageId: string | null;
  readonly status: 'sent' | 'failed';
}

/**
 * The two server-set instants the row carries. `sent_at` and `created_at` both
 * default to `CURRENT_TIMESTAMP(3)` (`0007_invoice_delivery`) rather than being set
 * by the app, so they are read back after the insert — MySQL has no `RETURNING`, and
 * the wire contract needs their exact values, not the app's guess at what the
 * default resolved to.
 */
export interface DeliveryTimestamps {
  readonly sentAt: Date;
  readonly createdAt: Date;
}

export async function insertDelivery(
  db: TenantDatabase,
  row: NewDeliveryRow,
): Promise<DeliveryTimestamps> {
  await db
    .insertInto('invoice_deliveries')
    .values({
      // `org_id` is injected by `tenantDb`, the same way `insertDocument` omits it.
      id: row.id,
      invoice_id: row.invoiceId,
      recipient_email: row.recipientEmail,
      artifact_storage_key: row.artifactStorageKey,
      key_prefix: row.keyPrefix,
      token_hash: row.tokenHash,
      provider_message_id: row.providerMessageId,
      status: row.status,
    })
    .execute();

  const persisted = await db
    .selectFrom('invoice_deliveries')
    .select(['sent_at', 'created_at'])
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();

  return { sentAt: persisted.sent_at, createdAt: persisted.created_at };
}
