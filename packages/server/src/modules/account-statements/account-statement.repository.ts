import type { TenantDatabase } from '../../db';
import { systemDb } from '../../db';

/**
 * Data access for `customer_statements` (OB-220; migration `0022_account_statements`).
 *
 * Append-only, the same shape as `statement_packages`
 * (`modules/statements/statement-package.repository.ts`) and `invoice_deliveries`
 * (`modules/delivery/delivery.repository.ts`): a re-render is a new row, and the
 * artifact it names — and, when the statement was sent, the token it names — was
 * frozen at render time. There is no update path here — only an insert and reads.
 *
 * `selectStatementCredentialByKeyPrefix` (the read a bare capability token needs,
 * with no org known yet) lives in `src/db/statement-credential-lookup.ts` instead
 * of here, for `delivery.repository.ts`'s exact reason: everything in *this* file
 * goes through `tenantDb`, which injects `org_id`.
 */

export interface CustomerStatementRow {
  readonly id: Buffer;
  readonly contactId: Buffer;
  readonly asOf: string;
  readonly status: 'generated' | 'sent' | 'failed';
  readonly recipientEmail: string | null;
  readonly artifactStorageKey: string;
  readonly keyPrefix: string | null;
  readonly tokenHash: Buffer | null;
  readonly providerMessageId: string | null;
  readonly generatedByUserId: Buffer;
  readonly createdAt: Date;
}

export interface NewCustomerStatementRow {
  readonly id: Buffer;
  readonly contactId: Buffer;
  readonly asOf: string;
  readonly status: 'generated' | 'sent' | 'failed';
  readonly recipientEmail: string | null;
  readonly artifactStorageKey: string;
  readonly keyPrefix: string | null;
  readonly tokenHash: Buffer | null;
  readonly providerMessageId: string | null;
  readonly generatedByUserId: Buffer;
}

/**
 * Writes the row and reads `created_at` back — MySQL has no `RETURNING`, and the
 * wire contract needs the server-set default's exact value, not the app's guess at
 * what it resolved to (`statement-package.repository.ts#insertStatementPackage`'s
 * own reason).
 */
export async function insertCustomerStatement(
  db: TenantDatabase,
  row: NewCustomerStatementRow,
): Promise<CustomerStatementRow> {
  await db
    .insertInto('customer_statements')
    .values({
      // `org_id` is injected by `tenantDb`.
      id: row.id,
      contact_id: row.contactId,
      as_of: row.asOf,
      status: row.status,
      recipient_email: row.recipientEmail,
      artifact_storage_key: row.artifactStorageKey,
      key_prefix: row.keyPrefix,
      token_hash: row.tokenHash,
      provider_message_id: row.providerMessageId,
      generated_by_user_id: row.generatedByUserId,
    })
    .execute();

  const persisted = await db
    .selectFrom('customer_statements')
    .select('created_at')
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();

  return { ...row, createdAt: persisted.created_at };
}

/**
 * Every statement this org has rendered, newest first, optionally narrowed to one
 * contact. Unpaginated, the same convention `statementPackageListSchema` documents
 * (`statement-package.repository.ts#listStatementPackages`) — a v1 org renders a
 * handful of these per customer, not enough to justify a keyset.
 *
 * Ordered by `created_at` then `id`, both descending, for the identical reason
 * `listStatementPackages` orders that way: two statements rendered inside the same
 * millisecond are not ruled out by `DATETIME(3)`'s precision and would otherwise
 * have no defined order between them.
 */
export async function listCustomerStatements(
  db: TenantDatabase,
  contactId?: Buffer,
): Promise<CustomerStatementRow[]> {
  let query = db.selectFrom('customer_statements').selectAll();
  if (contactId !== undefined) {
    query = query.where('contact_id', '=', contactId);
  }

  const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();

  return rows.map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    asOf: row.as_of,
    status: row.status as 'generated' | 'sent' | 'failed',
    recipientEmail: row.recipient_email,
    artifactStorageKey: row.artifact_storage_key,
    keyPrefix: row.key_prefix,
    tokenHash: row.token_hash,
    providerMessageId: row.provider_message_id,
    generatedByUserId: row.generated_by_user_id,
    createdAt: row.created_at,
  }));
}

/**
 * Every contact name a batch of statements names, keyed by their `BINARY(16)` id.
 *
 * Batched for `statement-package.repository.ts#selectUserDisplayNames`'s exact
 * reason: a statement list can name several distinct contacts and one `IN` query
 * beats one round trip per row. A contact id with no match — structurally
 * impossible while `fk_customer_statements_contact` holds `ON DELETE RESTRICT` —
 * resolves to `undefined`, and the service treats that as the data-integrity fault
 * it would be rather than a wire-contract null.
 */
export async function selectContactNames(
  db: TenantDatabase,
  contactIds: readonly Buffer[],
): Promise<ReadonlyMap<string, string>> {
  if (contactIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('contacts')
    .select(['id', 'display_name'])
    .where('id', 'in', [...contactIds])
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.display_name]));
}

/**
 * Display names for a batch of authors, keyed by their `BINARY(16)` user id.
 *
 * Copied from `statement-package.repository.ts#selectUserDisplayNames` verbatim —
 * `users` is not a tenant table (a user exists across orgs), so this reaches it
 * through `systemDb` rather than `tenantDb`, batched for the same reason
 * `selectContactNames` above is.
 */
export async function selectUserDisplayNames(
  userIds: readonly Buffer[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map();

  const rows = await systemDb()
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', 'in', [...userIds])
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.display_name]));
}
