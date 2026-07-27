/**
 * The contacts wire contract (OB-036).
 *
 * Read `contacts.ts` for the one place this contract diverges from the chart of
 * accounts on purpose — a contact's `code` is mutable and an account's is not
 * (against D-27, and for reasons that turn out to be about accounts) — and for why
 * the list is ordered by `(created_at, id)` rather than by name.
 *
 * The bodies and responses carry `.meta({ id })` and the list query deliberately
 * does not — `contacts.ts` states the rule and why a querystring is the exception.
 */

export type {
  Contact,
  ContactPage,
  CreateContactRequest,
  ListContactsQuery,
  UpdateContactRequest,
} from './contacts';
export {
  CONTACT_CODE_MAX_LENGTH,
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_NOTES_MAX_LENGTH,
  CONTACT_PHONE_MAX_LENGTH,
  contactPageSchema,
  contactSchema,
  createContactRequestSchema,
  listContactsQuerySchema,
  updateContactRequestSchema,
} from './contacts';
