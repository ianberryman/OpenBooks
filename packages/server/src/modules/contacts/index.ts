/**
 * Contacts — customers and vendors, as one table (OB-036; spec §2.1).
 *
 * The CRUD the ledger needs in order to say who an amount was with. Invoices,
 * bills, and the AR/AP subledgers the `isCustomer` / `isVendor` flags anticipate
 * are M3; this ticket ends at the service, and transport is OB-045.
 *
 * ## Surface
 *
 * | Operation                          | Permission        |
 * | ---------------------------------- | ----------------- |
 * | `createContact(input, ctx)`        | `contacts.write`  |
 * | `getContact(id, ctx)`              | `contacts.read`   |
 * | `listContacts(query, ctx)`         | `contacts.read`   |
 * | `updateContact(id, input, ctx)`    | `contacts.write`  |
 * | `deactivateContact(id, ctx)`       | `contacts.write`  |
 * | `reactivateContact(id, ctx)`       | `contacts.write`  |
 * | `deleteContact(id, ctx)`           | `contacts.write`  |
 *
 * `listContacts` returns one bounded page and an opaque cursor, not the whole
 * list. It is keyset-paginated (D-21) over `(created_at, id)` — see
 * `CONTACT_KEYSET` in `contacts.repository.ts` and the block on
 * `contactPageSchema` for why it is that pair and not `display_name`.
 *
 * `(input, ctx)` follows `modules/accounts`, and `ctx` is where the org comes
 * from — spec §4 forbids it as a loose parameter, so there is no signature here
 * into which another org's id could be passed. Nothing takes a transaction:
 * `src/db/transaction-scope.ts` propagates one ambiently, so
 * `withIdempotency(spec, () => createContact(input, ctx))` joins the claim's
 * transaction without this module knowing a transaction exists.
 *
 * ## One table, two flags, and neither required
 *
 * Migration `0002_ledger` states the modelling decision at length: the same legal
 * entity is routinely both a customer and a vendor, and two tables force an org to
 * hold it twice. There is deliberately no `CHECK (is_customer OR is_vendor)` — a
 * journal line naming a contact says who the amount is with, which is independent
 * of whether that party is ever invoiced or billed, an employee expense
 * reimbursement being the ordinary case. This module adds no constraint of its
 * own, and creates both flags false when neither is given.
 *
 * ## Two decisions worth reading before changing anything here
 *
 * **A contact's `code` is mutable, and an account's is not (against D-27).** Both
 * of D-27's arguments turn out to be arguments about accounts. Mechanically, a
 * keyset over a mutable sort column drops rows — but the contact list is ordered
 * by `(created_at, id)`, so no cursor here names an editable column. On the
 * accounting side, an account code is the reference other things cite, while a
 * posted line names a contact by *row*: `journal_lines` references
 * `contacts (org_id, id)`, so renumbering a customer restates nothing. Two things
 * then make immutability actively wrong rather than merely unnecessary — contact
 * codes usually arrive from the system the org migrated off, and D-27's escape
 * hatch is missing, since a contact the ledger names can never be deleted and its
 * code would be permanent from the first posting. The full argument is on
 * `updateContactRequestSchema`.
 *
 * **Hard deletion is allowed, for a contact nothing in the ledger names.** The
 * argument is on `deleteContact`: a contact is a directory row rather than a
 * record of what happened, so deleting an unreferenced one restates nothing, and
 * refusing would leave every mistyped and double-entered row in the picker
 * forever. Safety rests on `ON DELETE RESTRICT`, not on the service's checks.
 * Journal lines and draft lines are checked separately and answer with different
 * precondition tokens, because a posting is permanent and a draft is a form in
 * progress — `deleteContactRow`'s errno 1451 backstop cannot tell them apart,
 * which is why the checks are taken under a row lock that makes it unreachable.
 *
 * The question this file left open — whether an inactive contact may be posted
 * to — is **settled by OB-059, and the answer is no.** `postJournal`'s line input
 * now carries a `contactId`, so the thing the rule governs exists, and
 * `assertContactsPostable` refuses a deactivated contact with `contact_inactive`
 * exactly as an inactive account is refused. Deactivation takes a contact out of
 * circulation while keeping its history, and naming it on a new entry would put it
 * back. A *reversal* is not subject to the check, for the reason given where the
 * copy is made: correcting an old entry must not depend on the contact list having
 * stayed still.
 */

export type {
  Contact,
  ContactPage,
  CreateContactRequest,
  ListContactsQuery,
  UpdateContactRequest,
} from '@openbooks/shared-types';

export {
  createContact,
  deactivateContact,
  deleteContact,
  getContact,
  listContacts,
  reactivateContact,
  updateContact,
} from './contacts.service';
