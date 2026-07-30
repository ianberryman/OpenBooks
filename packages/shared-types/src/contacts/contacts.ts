import { z } from 'zod';

import { pageQueryShape, pageSchema } from '../wire';

/**
 * Request and response schemas for contacts (OB-036; spec §3).
 *
 * The split is the one `accounts/accounts.ts` states: a schema is the single
 * source of truth for shape, and everything needing authority or state —
 * `requirePermission`, the duplicate-code conflict, the delete restriction —
 * stays on the server, because a schema knows nothing about the caller.
 *
 * ## The `id`s
 *
 * `jsonSchemaTransformObject` copies *every* schema carrying an `id` out of zod's
 * global registry into `components.schemas`, whether or not a route references
 * it, and A10 makes drift in `openapi.json` a build failure. So the rule at the top
 * of `accounts/accounts.ts` holds: an `id` goes on a body or response schema a
 * route references and on nothing else. OB-036 left them off because contacts had
 * no routes; OB-045 built `/v1/contacts` and added them, which is the sequence
 * OB-018 and OB-023 established.
 *
 * `listContactsQuerySchema` has none and must not gain one — a querystring is
 * emitted as individual `parameters`, so a component for it would be referenced by
 * nothing.
 */

/**
 * Column widths, restated from the `contacts` block in `0002_ledger`.
 *
 * The inequality runs the safe way for the reason `accounts.ts` gives: MySQL's
 * `VARCHAR(n)` counts characters and `String.length` counts UTF-16 code units, so
 * a value this schema accepts cannot be truncated by the column.
 */
export const CONTACT_CODE_MAX_LENGTH = 32;
export const CONTACT_NAME_MAX_LENGTH = 255;
export const CONTACT_EMAIL_MAX_LENGTH = 320;
export const CONTACT_PHONE_MAX_LENGTH = 64;
export const CONTACT_NOTES_MAX_LENGTH = 512;

/**
 * `.trim()` before the length checks, so `uq_contacts_org_code` sees the value the
 * user sees — the argument `accountCodeSchema` makes, and it applies here in the
 * one direction that matters even though the column is nullable: `'ACME '` and
 * `'ACME'` are distinct rows to the unique key and the same customer number to
 * everyone reading the list.
 */
const contactCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTACT_CODE_MAX_LENGTH)
  .meta({
    description:
      'Optional short reference unique within the org, e.g. a customer number carried over ' +
      "from another system. Compared under the column's `utf8mb4_0900_ai_ci` collation, so it " +
      'is case- and accent-insensitive. Send `null` to clear it.',
  });

const displayNameSchema = z.string().trim().min(1).max(CONTACT_NAME_MAX_LENGTH).meta({
  description: 'What this contact is called in lists and on documents, e.g. `Acme Supplies`.',
});

const legalNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTACT_NAME_MAX_LENGTH)
  .meta({
    description:
      'The registered name, when it differs from `displayName` — `Acme Supplies Limited` against ' +
      '`Acme Supplies`. Send `null` to clear it.',
  });

/**
 * Trimmed before the format check, not after.
 *
 * `z.email().trim()` registers the format check first, so a pasted `' bob@acme.com '`
 * is refused rather than cleaned — measured against zod 4.4, which runs checks in
 * declaration order. The pipe puts the trim ahead of the check, which is the order
 * a human pasting an address out of a signature block needs.
 */
const emailSchema = z
  .string()
  .trim()
  .pipe(z.email().max(CONTACT_EMAIL_MAX_LENGTH))
  .meta({
    description:
      'Contact email. Not unique and not verified — two divisions of one customer legitimately ' +
      'share an address. Send `null` to clear it.',
  });

/**
 * Length-bounded and deliberately not format-checked.
 *
 * There is no pattern that accepts every phone number a small business actually
 * holds — extensions, national trunk prefixes, the `+44 (0)` form British
 * stationery still prints — and a regex here would refuse real numbers while
 * catching nothing an accounting system depends on. Nothing computes on this
 * field; it is printed and dialled by a human.
 */
const phoneSchema = z.string().trim().min(1).max(CONTACT_PHONE_MAX_LENGTH).meta({
  description: 'Contact phone number, in whatever form the org keeps it. Send `null` to clear it.',
});

const notesSchema = z.string().trim().max(CONTACT_NOTES_MAX_LENGTH).meta({
  description: 'Optional free text. Send `null` to clear it.',
});

const isCustomerSchema = z.boolean().meta({
  description:
    'Whether this contact is invoiced. Independent of `isVendor`: a supplier who also buys from ' +
    'you is one contact with both flags set, which is why there is one table and not two.',
});

const isVendorSchema = z.boolean().meta({
  description:
    'Whether this contact is billed by. Neither flag is required — a party named on a journal ' +
    'line need take part in no subledger at all, an employee reimbursement being the ordinary ' +
    'case. See the `contacts` commentary in migration 0002_ledger.',
});

const isEmployeeSchema = z.boolean().meta({
  description:
    'Whether this contact is an employee who can be reimbursed. A third independent flag, not a ' +
    'third table (D-M1): an expense is a bill whose contact carries this flag, so the same ' +
    'directory row that is billed by a vendor may also be an employee, and one contact may hold ' +
    'any combination of `isCustomer`, `isVendor` and `isEmployee`.',
});

/**
 * A contact as the API returns it.
 *
 * Nullable-and-required rather than optional, matching every other response
 * schema here: a persisted row either holds a value or holds NULL, and under
 * `exactOptionalPropertyTypes` an absent key is a different type from a null one.
 *
 * `orgId` is absent for the reason `accountSchema` states — every contact the
 * caller can reach belongs to the context's org, so the field would carry no
 * information and would be one more place a cross-org id could appear.
 */
export const contactSchema = z
  .strictObject({
    id: z.uuid(),
    code: contactCodeSchema.nullable(),
    displayName: displayNameSchema,
    legalName: legalNameSchema.nullable(),
    email: emailSchema.nullable(),
    phone: phoneSchema.nullable(),
    isCustomer: isCustomerSchema,
    isVendor: isVendorSchema,
    isEmployee: isEmployeeSchema,
    notes: notesSchema.nullable(),
    isActive: z.boolean().meta({
      description:
        'Inactive contacts keep every journal line that names them and cannot be selected for new ' +
        'ones. This is the only form of removal available to a contact the ledger references.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'Contact',
    description:
      'A customer, a vendor, or both — one directory row the ledger can name on a journal line.',
  });

export type Contact = z.infer<typeof contactSchema>;

/**
 * `isCustomer` and `isVendor` are optional and default to false at the service,
 * matching the column defaults in `0002_ledger`.
 *
 * Optional rather than required, which is the opposite of what
 * `createAccountRequestSchema` does with `normalBalance`, and the difference is
 * the cost of guessing wrong. A contra account created with the wrong normal
 * balance reports with an inverted sign and reads as a data problem; a contact
 * created with neither flag is simply a contact that appears in no subledger
 * filter, which is visible the first time someone looks for it and is corrected
 * by one update. There is nothing to restate.
 */
export const createContactRequestSchema = z
  .strictObject({
    code: contactCodeSchema.nullish(),
    displayName: displayNameSchema,
    legalName: legalNameSchema.nullish(),
    email: emailSchema.nullish(),
    phone: phoneSchema.nullish(),
    isCustomer: isCustomerSchema.optional(),
    isVendor: isVendorSchema.optional(),
    isEmployee: isEmployeeSchema.optional(),
    notes: notesSchema.nullish(),
  })
  .meta({
    id: 'CreateContactRequest',
    description:
      'Creates one contact. Only `displayName` is required; all three subledger flags default to ' +
      'false, because a party named on a journal line need take part in no subledger at all.',
  });

export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

/**
 * Every field optional; an absent field is left alone and an explicit `null`
 * clears it.
 *
 * `isActive` is deliberately absent, as it is on `updateAccountRequestSchema`:
 * deactivation is the sanctioned alternative to deleting a referenced contact and
 * is what the delete path's error names, so it is its own operation rather than a
 * flag buried in a patch body.
 *
 * ## `code` **is** here, and that is a decision against D-27's precedent
 *
 * An account's code is immutable. A contact's is not, and the divergence is
 * deliberate rather than an omission, because both of D-27's arguments turn out
 * to be arguments about accounts specifically.
 *
 * The mechanical one first, since it is what forced D-27: the chart of accounts is
 * ordered by `code`, keyset pagination orders by the column it sorts on, and a
 * keyset over a mutable column silently drops rows. The contact list is ordered by
 * `(created_at, id)` — see `contactPageSchema` and `idx_contacts_org_created`,
 * which `0002_ledger` added for exactly this — so no cursor into this list names a
 * column a caller can edit. Making the code immutable would buy nothing here; the
 * failure it prevents is already absent by construction.
 *
 * The accounting one is the argument that would still have to hold on its own, and
 * it does not. An account code is the reference other things cite: a journal, an
 * export, a filed schedule. A contact's code is cited by nothing — `journal_lines`
 * references `contacts (org_id, id)`, so a posted line names the *row*, and
 * renumbering a customer changes no entry's meaning and restates no report. It is
 * a directory label, in the same class as `name` and `description`, which D-27
 * left mutable for precisely this reason.
 *
 * Two things then make immutability actively wrong here rather than merely
 * unnecessary. Codes on contacts are usually not ours: they arrive from the system
 * the org migrated off, and renumbering after an import is ordinary bookkeeping.
 * And the escape hatch D-27 relied on does not exist — an account with a mistyped
 * code deletes outright and is recreated, while a contact the ledger already names
 * can *never* be deleted (`fk_journal_lines_contact` is `ON DELETE RESTRICT`), so
 * an immutable code would be permanent from the first posting rather than
 * correctable by delete-and-recreate.
 *
 * `null` clears the code, which the account schema has no equivalent for because
 * `accounts.code` is `NOT NULL`. A contact that had a number and no longer needs
 * one gives the number up, and `uq_contacts_org_code` treats NULLs as distinct, so
 * any number of contacts may hold none.
 */
export const updateContactRequestSchema = z
  .strictObject({
    code: contactCodeSchema.nullish(),
    displayName: displayNameSchema.optional(),
    legalName: legalNameSchema.nullish(),
    email: emailSchema.nullish(),
    phone: phoneSchema.nullish(),
    isCustomer: isCustomerSchema.optional(),
    isVendor: isVendorSchema.optional(),
    isEmployee: isEmployeeSchema.optional(),
    notes: notesSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateContactRequest',
    description:
      'Partial update. An absent field is unchanged and an explicit `null` clears it. ' +
      '`isActive` is not here — deactivation is its own operation.',
  });

export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 *
 * The filters are real booleans and not query-string flags, for the reason
 * `listAccountsQuerySchema` gives: a shared schema that accepted `'false'` would
 * accept it from a JSON body too, and `'false'` is truthy in every language an
 * integrator might use. Coercing a querystring is the route's job (OB-045).
 *
 * `isCustomer`, `isVendor` and `isEmployee` are independent filters rather than
 * one `role` enum, because the flags are independent — an entity flagged more
 * than one of them must appear under either filter, and an enum would force it
 * to pick.
 */
export const listContactsQuerySchema = z.strictObject({
  ...pageQueryShape,
  isCustomer: z.boolean().optional(),
  isVendor: z.boolean().optional(),
  isEmployee: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

/**
 * The *input* type, not `z.infer`. `limit` carries a `.default()`, so the parsed
 * output has it and a caller does not — and under `exactOptionalPropertyTypes`
 * those are two different types.
 */
export type ListContactsQuery = z.input<typeof listContactsQuerySchema>;

/**
 * ## Why the contact list is ordered by `(created_at, id)` and not by name
 *
 * Alphabetical is what a contact list looks like on screen, and it is the one
 * ordering a cursor into this list must not use. `display_name` is mutable — it is
 * the field most likely to be edited, since it is how a business records that a
 * customer rebranded — and a keyset over a mutable column silently drops rows: a
 * contact renamed from `Zenith` to `Acme` while someone is paging moves behind a
 * cursor that has already passed it, so it appears on no page at all. That is
 * exactly the failure D-21 chose keyset to eliminate, reached through a mutable
 * sort key instead of through `OFFSET`.
 *
 * D-27 answered the same problem for the chart of accounts by removing the
 * mutability, and that answer is not available here: `displayName` is a label, and
 * an accounting system that refused to rename a customer would be wrong in a way
 * no pagination scheme is worth. So the ordering avoids the mutable column
 * instead, which is what `0002_ledger`'s `idx_contacts_org_created` was added for
 * and what its comment says.
 *
 * What this costs is real and belongs to OB-045's screen rather than to this
 * contract: a paged alphabetical list needs either a sort the server can page
 * safely or a client that sorts what it holds. `idx_contacts_org_name` exists for
 * whichever answer that ticket picks.
 *
 * `id` is carried as a second column because `created_at` alone is not a total
 * order — two contacts created in the same millisecond share it — and a
 * non-total ordering skips or repeats rows at the page boundary.
 */
export const contactPageSchema = pageSchema(contactSchema, {
  id: 'ContactPage',
  description:
    'One page of the org’s contacts, oldest first by creation. Not alphabetical, and the ' +
    'paragraph above says why: a cursor into a list ordered by an editable column silently ' +
    'drops the rows that moved behind it.',
});

export type ContactPage = z.infer<typeof contactPageSchema>;
