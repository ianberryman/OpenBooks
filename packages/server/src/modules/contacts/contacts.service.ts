import type {
  Contact,
  ContactPage,
  CreateContactRequest,
  ListContactsQuery,
  UpdateContactRequest,
} from '@openbooks/shared-types';
import {
  createContactRequestSchema,
  listContactsQuerySchema,
  updateContactRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { resolvePageLimit } from '../../db';
import { assertFound, parseInput } from '../../errors';
import { requirePermission } from '../permissions';
import type { ContactPatch } from './contacts.repository';
import {
  CONTACT_RESOURCE as RESOURCE,
  contactIdBytes,
  contactOnDraftError,
  contactReferencedError,
  deleteContactRow,
  hasDraftLines,
  hasPostings,
  insertContact,
  orgScope,
  selectContactById,
  selectContactByIdForUpdate,
  selectContactsPage,
  toContact,
  updateContactRow,
} from './contacts.repository';

/**
 * Customers and vendors, as one table (OB-036; spec §2.1).
 *
 * Read `index.ts` for the two decisions this module exists to record — a mutable
 * `code` against D-27's precedent, and what deletion is allowed to mean for a
 * party the ledger names — and
 * `packages/shared-types/src/contacts/contacts.ts` for the wire contract and the
 * argument behind each.
 *
 * Three things are uniform across every operation below and stated once here
 * rather than at each:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else; validating first would tell
 *    them which fields the operation accepts and how long each may be, which is a
 *    description of an API surface they are not entitled to. Enforcement is
 *    service-layer only (spec §2.4, §5) — no route may repeat or replace it.
 *
 * 2. **Every payload is parsed with a shared zod schema**, because the HTTP route
 *    is not the only caller (spec §12; see `input.ts`). Contacts have no route at
 *    all until OB-045, so at the moment the service parse is the *only* parse.
 *
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined the read to the context's org, so a cross-org id returns no
 *    row and reaches the same line a nonexistent id reaches (A7). There is no
 *    branch here that can tell the two apart, which is why there is no branch here
 *    that could leak the difference.
 */

/**
 * Creates one contact, active.
 *
 * `contacts.write` alone, not `contacts.write` plus `contacts.read`, even though
 * this returns the created row. Reading back what you just wrote is part of the
 * write — a caller who could create a contact but not see the result would have to
 * guess its id — and requiring both would make every write role a read role for no
 * gain. The same reasoning covers `update`, `deactivate`, and `reactivate`.
 *
 * No transaction, unlike `createAccount`. That one opens one because it resolves a
 * parent account and has to hold a lock on it across the insert; a contact
 * references nothing, so there is a single statement here and nothing for a
 * transaction to tie together. An ambient one is joined regardless
 * (`transaction-scope.ts`), so `withIdempotency` still composes.
 */
export async function createContact(
  input: CreateContactRequest,
  ctx: RequestContext,
): Promise<Contact> {
  await requirePermission(ctx, 'contacts.write');
  const request = parseInput(createContactRequestSchema, input);

  const row = await insertContact(orgScope(ctx), {
    code: request.code ?? null,
    displayName: request.displayName,
    legalName: request.legalName ?? null,
    email: request.email ?? null,
    phone: request.phone ?? null,
    // Defaulted here rather than in the schema, matching the column defaults in
    // `0002_ledger`. A `.default()` in zod would put the two fields in
    // `CreateContactRequest`'s output type and oblige every caller to state them.
    isCustomer: request.isCustomer ?? false,
    isVendor: request.isVendor ?? false,
    isEmployee: request.isEmployee ?? false,
    notes: request.notes ?? null,
    addressLine1: request.addressLine1 ?? null,
    addressLine2: request.addressLine2 ?? null,
    city: request.city ?? null,
    region: request.region ?? null,
    postalCode: request.postalCode ?? null,
    country: request.country ?? null,
  });

  return toContact(row);
}

export async function getContact(contactId: string, ctx: RequestContext): Promise<Contact> {
  await requirePermission(ctx, 'contacts.read');

  const db = orgScope(ctx);
  const id = assertFound(contactIdBytes(contactId), RESOURCE);

  return toContact(assertFound(await selectContactById(db, id), RESOURCE));
}

/**
 * One page of the org's contacts, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`, even though the schema declares
 * the same bounds. The schema is a restatement for `openapi.json`'s benefit; the
 * function is the authority, and it has to be, because spec §12 puts an MCP tool
 * and the workflow engine on the same service with no schema in front of them.
 */
export async function listContacts(
  query: ListContactsQuery,
  ctx: RequestContext,
): Promise<ContactPage> {
  await requirePermission(ctx, 'contacts.read');
  const filters = parseInput(listContactsQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectContactsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toContact), nextCursor: page.nextCursor };
}

/**
 * Updates the mutable fields of one contact — which is all of them.
 *
 * ## Why there is no equivalent of `updateAccount`'s has-postings refusal
 *
 * `updateAccount` refuses `type` and `normalBalance` once an account carries
 * postings, because those two decide what every report *means*: change one and
 * last quarter's profit changes with no journal row having moved. No field on a
 * contact does that. `isCustomer` and `isVendor` say which subledgers the party
 * takes part in from now on; the names and the contact details are labels. Every
 * amount stays on the account it was posted to and every report reproduces, so
 * there is nothing here to freeze and the softer rule would be friction without a
 * guarantee behind it.
 *
 * `code` is included, which is the deliberate departure from D-27. The argument is
 * on `updateContactRequestSchema` and the short form is that D-27's two reasons
 * are both reasons about accounts: the contact list does not sort on `code`, and
 * nothing cites a contact's code — a posted line names the row.
 *
 * ## Why the read is a locking one
 *
 * Not for a check that has to survive a writer — there is no such check here — but
 * because `code` is unique and mutable, so two concurrent updates moving the same
 * code onto two contacts would otherwise race to `uq_contacts_org_code` and one
 * would surface as whichever error the driver produced first. Serializing on the
 * row makes the loser a plain `ConflictError` naming the code, which is the answer
 * a client can act on. `updateContactRow` translates errno 1062 either way, so the
 * lock buys determinism rather than safety.
 */
export async function updateContact(
  contactId: string,
  input: UpdateContactRequest,
  ctx: RequestContext,
): Promise<Contact> {
  await requirePermission(ctx, 'contacts.write');
  const request = parseInput(updateContactRequestSchema, input);

  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const id = assertFound(contactIdBytes(contactId), RESOURCE);
    assertFound(await selectContactByIdForUpdate(trx, id), RESOURCE);

    const patch: ContactPatch = {
      // `null` clears, absent leaves alone. `.nullish()` makes both expressible and
      // only `undefined` means "absent" — JSON has no way to send `undefined`, so a
      // client wanting to clear a field sends `null` and gets exactly that.
      ...(request.code === undefined ? {} : { code: request.code }),
      ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
      ...(request.legalName === undefined ? {} : { legalName: request.legalName }),
      ...(request.email === undefined ? {} : { email: request.email }),
      ...(request.phone === undefined ? {} : { phone: request.phone }),
      ...(request.isCustomer === undefined ? {} : { isCustomer: request.isCustomer }),
      ...(request.isVendor === undefined ? {} : { isVendor: request.isVendor }),
      ...(request.isEmployee === undefined ? {} : { isEmployee: request.isEmployee }),
      ...(request.notes === undefined ? {} : { notes: request.notes }),
      ...(request.addressLine1 === undefined ? {} : { addressLine1: request.addressLine1 }),
      ...(request.addressLine2 === undefined ? {} : { addressLine2: request.addressLine2 }),
      ...(request.city === undefined ? {} : { city: request.city }),
      ...(request.region === undefined ? {} : { region: request.region }),
      ...(request.postalCode === undefined ? {} : { postalCode: request.postalCode }),
      ...(request.country === undefined ? {} : { country: request.country }),
    };

    await updateContactRow(trx, id, patch);
    return toContact(assertFound(await selectContactById(trx, id), RESOURCE));
  });
}

/**
 * Removes a contact from circulation without removing it from the books.
 *
 * This is the only form of removal available to a contact a journal line names,
 * and it is the operation the delete path's error points at. Idempotent: an
 * already-inactive contact is returned unchanged rather than refused, because a
 * retry of a deactivation is a retry, not a conflict.
 */
export async function deactivateContact(contactId: string, ctx: RequestContext): Promise<Contact> {
  return setActive(contactId, false, ctx);
}

/**
 * The counterpart to `deactivateContact`, and not an optional convenience.
 *
 * Without it, deactivation is a one-way door for exactly the contacts that cannot
 * take the other exit: a contact with postings can never be deleted, so an org
 * that deactivated the wrong customer would be left with a row it can neither use
 * nor remove — and, because `uq_contacts_org_code` does not exclude inactive rows,
 * could not recreate it under the same code either. Reactivation costs one
 * operation and removes a trap.
 */
export async function reactivateContact(contactId: string, ctx: RequestContext): Promise<Contact> {
  return setActive(contactId, true, ctx);
}

/**
 * Deletes a contact that nothing in the ledger names.
 *
 * ## Why hard deletion is permitted at all
 *
 * ROADMAP D-16 settles that ledger entries are never deleted, and a contact is not
 * a ledger entry. It is a directory row that postings *refer* to. A contact no
 * journal line names has never appeared in the books, so deleting it removes
 * nothing an auditor could ask about and no report changes — there is no past date
 * whose figures stop reproducing, which is the property D-16 exists to protect.
 * This is `deleteAccount`'s argument, and it transfers because the structure is
 * the same: configuration that entries cite, with a `RESTRICT` foreign key
 * standing between deletion and anything that cites it.
 *
 * Refusing outright had a real cost here too. A contact list accumulates typos,
 * duplicates of the same company entered twice, and rows imported from a system
 * the org has left. None of those has ever been posted to, and deactivating them
 * leaves them in every picker under a "show inactive" toggle forever.
 *
 * ## Why the pre-checks are not what makes this safe
 *
 * They run so the caller gets an actionable message naming *which* reference, and
 * `fk_journal_lines_contact` / `fk_journal_draft_lines_contact` are what actually
 * hold: both are `ON DELETE RESTRICT`, so a referenced contact cannot be deleted
 * regardless of what this service concluded. `deleteContactRow` translates the
 * resulting errno 1451 into the same error the postings pre-check raises, so a
 * lost race is invisible to the caller rather than a different failure.
 *
 * ## Why the checks are taken under a row lock, unlike `deleteAccount`'s
 *
 * `deleteAccount` needs no lock for its postings check, because journals are
 * append-only and the app user holds no `DELETE` on `journal_lines`: a reference,
 * once made, is permanent, and one arriving mid-flight is answered by the foreign
 * key with the message the pre-check would have given. Draft lines are not like
 * that. They are inserted and deleted freely (`0999_app_grants`, D-19), so a draft
 * reference can appear between the check and the delete — and if it did, errno
 * 1451 would answer with the *postings* message, telling someone their contact is
 * on a posted entry when it is on a draft they could edit.
 *
 * The lock removes that. InnoDB takes a shared lock on this `contacts` row to
 * validate an insert into either child table, and `selectContactByIdForUpdate`
 * holds an exclusive one, so no new reference of either kind can appear between
 * the checks and the delete. The two pre-checks are therefore exact, and errno
 * 1451 is left meaning a reference that predates the lock.
 *
 * Deliberately no cascade and no "delete and reassign its lines": both are ways
 * for a ledger to lose who an amount was with, quietly.
 */
export async function deleteContact(contactId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'contacts.write');

  const db = orgScope(ctx);

  await db.transaction(async (trx) => {
    const id = assertFound(contactIdBytes(contactId), RESOURCE);

    // Establishes existence, so deleting a contact that never existed — or one
    // belonging to another org — is a 404 rather than a silent success.
    assertFound(await selectContactByIdForUpdate(trx, id), RESOURCE);

    // Postings first: it is the reference that cannot be undone, so when a contact
    // carries both it is the one whose remedy is the true one.
    if (await hasPostings(trx, id)) throw contactReferencedError();
    if (await hasDraftLines(trx, id)) throw contactOnDraftError();

    await deleteContactRow(trx, id);
  });
}

async function setActive(
  contactId: string,
  isActive: boolean,
  ctx: RequestContext,
): Promise<Contact> {
  await requirePermission(ctx, 'contacts.write');

  const db = orgScope(ctx);
  const id = assertFound(contactIdBytes(contactId), RESOURCE);
  assertFound(await selectContactById(db, id), RESOURCE);

  await updateContactRow(db, id, { isActive });
  return toContact(assertFound(await selectContactById(db, id), RESOURCE));
}
