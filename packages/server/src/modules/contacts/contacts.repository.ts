import type { Contact, ListContactsQuery } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  isDuplicateEntryError,
  isStillReferencedError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { ConflictError, InternalError, PreconditionFailedError } from '../../errors';

/**
 * Data access for contacts.
 *
 * Everything here goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate (OB-013). That is what makes A7 a
 * property of the queries rather than of the service's care: a cross-org id
 * matches nothing, and the service's `assertFound` turns that into the one error a
 * miss is allowed to produce.
 *
 * The other job of this file is that no driver error escapes it. MySQL answers a
 * duplicate code with errno 1062 and a delete of a referenced row with errno 1451;
 * both are the client's situation rather than a fault, and both would otherwise
 * reach `toWireError` unrecognised and become an opaque 500.
 */

/** The resource token every miss in this module reports (A7). */
export const CONTACT_RESOURCE = 'contact';

/** The columns every read in this module selects, so one mapper covers them all. */
const CONTACT_COLUMNS = [
  'id',
  'code',
  'display_name',
  'legal_name',
  'email',
  'phone',
  'is_customer',
  'is_vendor',
  'notes',
  'is_active',
  'created_at',
  'updated_at',
] as const;

interface ContactRow {
  readonly id: Buffer;
  readonly code: string | null;
  readonly display_name: string;
  readonly legal_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly is_customer: number;
  readonly is_vendor: number;
  readonly notes: string | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewContactRow {
  readonly code: string | null;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isCustomer: boolean;
  readonly isVendor: boolean;
  readonly notes: string | null;
}

/**
 * `code` is present, unlike `AccountPatch`, and the divergence from D-27 is argued
 * on `updateContactRequestSchema`. `null` gives the code up rather than leaving it
 * alone; absent leaves it alone.
 */
export interface ContactPatch {
  readonly code?: string | null;
  readonly displayName?: string;
  readonly legalName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly isCustomer?: boolean;
  readonly isVendor?: boolean;
  readonly notes?: string | null;
  readonly isActive?: boolean;
}

/**
 * The org-scoped handle for the current operation.
 *
 * The shape the rest of this module wants — a `TenantDatabase` from a context — so
 * that no function below takes an org as a parameter (spec §4).
 */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied contact id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A `400` here would be
 * a distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function contactIdBytes(contactId: string): Buffer | undefined {
  return tryUuidToBuffer(contactId);
}

export async function insertContact(db: TenantDatabase, input: NewContactRow): Promise<ContactRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('contacts')
      .values({
        id,
        code: input.code,
        display_name: input.displayName,
        legal_name: input.legalName,
        email: input.email,
        phone: input.phone,
        is_customer: input.isCustomer ? 1 : 0,
        is_vendor: input.isVendor ? 1 : 0,
        notes: input.notes,
      })
      .execute();
  } catch (error) {
    throw translateDuplicateCode(error, input.code);
  }

  const row = await selectContactById(db, id);
  if (row === undefined) {
    throw new InternalError('The contact inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectContactById(
  db: TenantDatabase,
  id: Buffer,
): Promise<ContactRow | undefined> {
  return db.selectFrom('contacts').select(CONTACT_COLUMNS).where('id', '=', id).executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * Used by the delete path, and it is doing more work there than it looks: InnoDB
 * needs a shared lock on this row to validate a `journal_lines` or
 * `journal_draft_lines` insert that names the contact, so holding an exclusive one
 * means no new reference can appear between the checks and the delete. `contacts`
 * is in `0999_app_grants`'s mutable allowlist, so the app user may take a locking
 * read on it — the journal tables are not, which is why nothing in this codebase
 * locks a journal row.
 */
export async function selectContactByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<ContactRow | undefined> {
  return db
    .selectFrom('contacts')
    .select(CONTACT_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Which of `codes` this org already uses (Phase 3, the QuickBooks CSV import).
 *
 * Mirrors `accounts.repository.ts`'s `selectExistingCodes`: the comparison is the
 * column's own `utf8mb4_0900_ai_ci` collation via `IN`, matching what
 * `uq_contacts_org_code` enforces, so this finds exactly the codes a bulk create
 * would collide on — the same pre-check `applyChartTemplate` runs for accounts,
 * for the same all-or-nothing commit. A `null` code never matches — MySQL treats
 * NULLs as distinct in a unique index — so the caller filters null codes out
 * before calling this; the `flatMap` below is defensive against the same fact on
 * the read side, since nothing in `codes` should be able to select a null row.
 */
export async function selectExistingCodes(
  db: TenantDatabase,
  codes: readonly string[],
): Promise<readonly string[]> {
  if (codes.length === 0) return [];

  const rows = await db.selectFrom('contacts').select('code').where('code', 'in', codes).execute();
  return rows.flatMap((row) => (row.code === null ? [] : [row.code]));
}

/**
 * `(created_at, id)` — the general ordering D-21 names, and the one this list has
 * to use rather than merely may.
 *
 * Both columns are written once. `display_name` and `code` are not, and a keyset
 * over either would drop a renamed contact from every page — the failure D-27
 * removed from the chart of accounts by making the sort column immutable, avoided
 * here by not sorting on a mutable column at all. The full argument, including
 * what it costs the alphabetical screen, is on `contactPageSchema`.
 *
 * `idx_contacts_org_created` is `(org_id, created_at, id)`, which is exactly the
 * tuple the predicate compares, so a page is a range scan rather than a sort.
 */
const CONTACT_KEYSET: KeysetOrdering<ContactRow> = [
  instantKey('contacts.created_at', (row) => row.created_at),
  uuidKey('contacts.id', (row) => row.id),
];

export async function selectContactsPage(
  db: TenantDatabase,
  filters: ListContactsQuery,
  limit: number,
): Promise<KeysetPage<ContactRow>> {
  let query = db.selectFrom('contacts').select(CONTACT_COLUMNS);

  if (filters.isCustomer !== undefined) {
    query = query.where('is_customer', '=', filters.isCustomer ? 1 : 0);
  }
  if (filters.isVendor !== undefined) {
    query = query.where('is_vendor', '=', filters.isVendor ? 1 : 0);
  }
  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  // The filters go on first so the keyset predicate composes with them rather than
  // with a different result set: a page of "customers only" has to end where the
  // next page of "customers only" begins, not where the unfiltered list did.
  const rows = await applyKeyset(query, CONTACT_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, CONTACT_KEYSET, limit);
}

/**
 * Error translation here, unlike `updateAccountRow`, and `code` is the whole
 * reason: it stays in the patch shape (see `updateContactRequestSchema`), so
 * `uq_contacts_org_code` is reachable from an update and `ER_DUP_ENTRY` has to
 * become the same `ConflictError` a create produces.
 */
export async function updateContactRow(
  db: TenantDatabase,
  id: Buffer,
  patch: ContactPatch,
): Promise<void> {
  try {
    await db
      .updateTable('contacts')
      .set({
        ...(patch.code === undefined ? {} : { code: patch.code }),
        ...(patch.displayName === undefined ? {} : { display_name: patch.displayName }),
        ...(patch.legalName === undefined ? {} : { legal_name: patch.legalName }),
        ...(patch.email === undefined ? {} : { email: patch.email }),
        ...(patch.phone === undefined ? {} : { phone: patch.phone }),
        ...(patch.isCustomer === undefined ? {} : { is_customer: patch.isCustomer ? 1 : 0 }),
        ...(patch.isVendor === undefined ? {} : { is_vendor: patch.isVendor ? 1 : 0 }),
        ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
      })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateDuplicateCode(error, patch.code ?? null);
  }

  /**
   * The affected-row count is deliberately not consulted, for the reason
   * `updateAccountRow` states: mysql2 does not set `CLIENT_FOUND_ROWS`, so an
   * `UPDATE` that matches a row and changes nothing reports zero affected rows,
   * exactly like one that matched nothing. Existence is established by the
   * caller's locking read instead, which it performs anyway.
   */
}

/**
 * Deletes the row, or refuses because something references it.
 *
 * The refusal is the database's, not this function's. `journal_lines.contact_id`
 * and `journal_draft_lines.contact_id` are both `ON DELETE RESTRICT`
 * (`0002_ledger`), so a referenced contact cannot be deleted no matter what any
 * caller believes about it — which is what makes the service's pre-checks a
 * *message* rather than a guarantee.
 *
 * The two constraints raise the same errno, so this cannot tell them apart and
 * answers with the posted-line message. That is the right one to collapse to: the
 * pre-checks under the row lock make this path unreachable except by a reference
 * that predates the lock, and a posting is the reference that cannot be undone.
 */
export async function deleteContactRow(db: TenantDatabase, id: Buffer): Promise<void> {
  try {
    await db.deleteFrom('contacts').where('id', '=', id).execute();
  } catch (error) {
    if (!isStillReferencedError(error)) throw error;
    throw contactReferencedError();
  }
}

/**
 * Whether any posted journal line names this contact.
 *
 * Existence, not a count: nothing needs the number, and `SELECT 1 … LIMIT 1` stops
 * at the first match on `idx_journal_lines_org_contact` instead of scanning every
 * line a contact has accumulated.
 */
export async function hasPostings(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('journal_lines')
    .select('id')
    .where('contact_id', '=', id)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * Whether any *unposted draft* line names this contact.
 *
 * A separate question from `hasPostings` with a separate answer, because the
 * remedies are opposite. A posted line is permanent and the contact can only be
 * deactivated; a draft is a form in progress (D-19), so the reference is removed
 * by editing or discarding the draft and the contact then deletes normally.
 * Collapsing the two would tell someone to deactivate a contact over a reference
 * they could have deleted in one click.
 *
 * Reads `idx_journal_draft_lines_org_contact` (`0002_ledger`).
 */
export async function hasDraftLines(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('journal_draft_lines')
    .select('id')
    .where('contact_id', '=', id)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * The one error a posted-to contact produces, from both the pre-check and the
 * `RESTRICT` backstop, so the two cannot drift into two messages for one
 * situation.
 *
 * `PreconditionFailedError` and not `ConflictError`: the request is well-formed
 * and permitted, and it is the *state* that forbids it. `precondition` is a stable
 * token, so a client branches on `contact_has_postings` rather than on prose.
 */
export function contactReferencedError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'contact_has_postings',
    'This contact is named by at least one posted journal line and cannot be deleted. Deleting ' +
      'it would remove a party the ledger still points at, changing what a posted entry says. ' +
      'Deactivate it instead: an inactive contact keeps its history and cannot be selected for ' +
      'new postings.',
  );
}

/**
 * The draft counterpart, and a different token because the remedy is different.
 *
 * A client branching on `contact_on_draft` learns the reference is removable,
 * which `contact_has_postings` would have told them it was not.
 */
export function contactOnDraftError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'contact_on_draft',
    'This contact is named by at least one unposted draft journal and cannot be deleted while ' +
      'that reference exists. Unlike a posted entry a draft is editable: remove the contact ' +
      'from the draft line, or discard the draft, and the contact deletes normally.',
  );
}

export function toContact(row: ContactRow): Contact {
  return {
    id: bufferToUuid(row.id),
    code: row.code,
    displayName: row.display_name,
    legalName: row.legal_name,
    email: row.email,
    phone: row.phone,
    isCustomer: row.is_customer !== 0,
    isVendor: row.is_vendor !== 0,
    notes: row.notes,
    isActive: row.is_active !== 0,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants and this is a lossless
    // rendering of one.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `uq_contacts_org_code` as a `ConflictError`.
 *
 * Free text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, code)`, so the row this collides with is inside the caller's own org
 * and naming the code discloses nothing they cannot already read.
 *
 * Any other driver error is rethrown untouched and becomes an opaque 500, which is
 * correct — this function knows about exactly one constraint and must not guess
 * about the rest. A `null` code cannot collide at all (MySQL treats NULLs as
 * distinct in a unique index), so an errno 1062 alongside one would be a
 * constraint this function does not know about and is passed through.
 */
function translateDuplicateCode(error: unknown, code: string | null): unknown {
  if (!isDuplicateEntryError(error) || code === null) return error;

  return new ConflictError(
    `A contact with code ${JSON.stringify(code)} already exists in this organization. Codes are ` +
      'compared case-insensitively, so a code differing only in case is the same code. Any ' +
      'number of contacts may have no code at all.',
    { code },
  );
}
