import { z } from 'zod';

/**
 * Org branding — the letterhead an invoice is printed under (OB-123, Phase 1).
 *
 * This is the sender's side of invoice delivery: the display name, address, contact
 * details and marks that turn a bare document into something a customer recognises.
 * `delivery.ts` holds the delivery act itself and the customer-safe view the hosted
 * page renders; this file holds the one editable record that view is dressed with.
 *
 * ## No `.meta({ id })` here yet
 *
 * The routes arrive in a later stream, and an `id` with no route publishes a
 * `components.schemas` entry nothing can reach — the sequence `documents.ts` and
 * `contacts.ts` both describe. The ids will land in the same diff as the routes;
 * until then these carry descriptions and no id.
 *
 * ## Column widths are declared here first
 *
 * The F2 schema stream provisions the `org_branding` columns to match these, so the
 * bounds live in one place the way `contacts.ts` restates them from `0002_ledger`.
 * The inequality runs the safe way for that file's reason: MySQL's `VARCHAR(n)`
 * counts characters and `String.length` counts UTF-16 code units, so a value these
 * schemas accept cannot be truncated by the column that stores it.
 */
export const ORG_BRANDING_DISPLAY_NAME_MAX_LENGTH = 255;
export const ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH = 255;
export const ORG_BRANDING_CITY_MAX_LENGTH = 128;
export const ORG_BRANDING_REGION_MAX_LENGTH = 128;
export const ORG_BRANDING_POSTAL_CODE_MAX_LENGTH = 32;
export const ORG_BRANDING_COUNTRY_MAX_LENGTH = 128;
export const ORG_BRANDING_EMAIL_MAX_LENGTH = 320;
export const ORG_BRANDING_PHONE_MAX_LENGTH = 64;
export const ORG_BRANDING_WEBSITE_MAX_LENGTH = 512;
export const ORG_BRANDING_TAX_NUMBER_MAX_LENGTH = 64;
export const ORG_BRANDING_LOGO_STORAGE_KEY_MAX_LENGTH = 512;
export const ORG_BRANDING_FOOTER_MAX_LENGTH = 1024;

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORG_BRANDING_DISPLAY_NAME_MAX_LENGTH)
  .meta({
    description:
      'What the org calls itself on the invoices it sends — the name at the top of the letterhead, ' +
      'e.g. `Acme Supplies Limited`. Required: an invoice printed under no name is not one anyone ' +
      'can act on.',
  });

const addressLine1Schema = z.string().trim().min(1).max(ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH);
const addressLine2Schema = z.string().trim().min(1).max(ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH);
const citySchema = z.string().trim().min(1).max(ORG_BRANDING_CITY_MAX_LENGTH);
const regionSchema = z.string().trim().min(1).max(ORG_BRANDING_REGION_MAX_LENGTH);
const postalCodeSchema = z.string().trim().min(1).max(ORG_BRANDING_POSTAL_CODE_MAX_LENGTH);
const countrySchema = z.string().trim().min(1).max(ORG_BRANDING_COUNTRY_MAX_LENGTH);

/**
 * Trimmed before the format check, not after — `emailSchema` in `contacts.ts`
 * argues why the pipe order matters: `z.email().trim()` registers the format check
 * first and refuses a pasted `' billing@acme.com '` rather than cleaning it.
 */
const emailSchema = z
  .string()
  .trim()
  .pipe(z.email().max(ORG_BRANDING_EMAIL_MAX_LENGTH))
  .meta({
    description:
      'The org’s own billing email, printed on the invoice so a customer can reply. Send `null` ' +
      'to clear it. This is not the delivery recipient — that is the customer’s address.',
  });

/**
 * Length-bounded and deliberately not format-checked, for the reason `phoneSchema`
 * in `contacts.ts` gives: no pattern accepts every phone number a real business
 * holds, and nothing computes on this field — it is printed and dialled by a human.
 */
const phoneSchema = z.string().trim().min(1).max(ORG_BRANDING_PHONE_MAX_LENGTH).meta({
  description: 'The org’s phone number, printed as-is on the invoice. Send `null` to clear it.',
});

/**
 * A trimmed string and not `z.url()`, on the same argument `phoneSchema` makes: an
 * org enters `acme.com`, `www.acme.com` or a full URL, and a strict parser refuses
 * the first two while nothing here dereferences the value — it is a line of text on
 * a printed invoice.
 */
const websiteSchema = z.string().trim().min(1).max(ORG_BRANDING_WEBSITE_MAX_LENGTH).meta({
  description: 'The org’s website, printed as entered. Send `null` to clear it.',
});

const taxNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORG_BRANDING_TAX_NUMBER_MAX_LENGTH)
  .meta({
    description:
      'The org’s tax registration number — the VAT/GST/ABN a filing requires on an invoice. Free ' +
      'text, not validated against any jurisdiction’s check digit. Send `null` to clear it.',
  });

/**
 * The object-store key of the uploaded logo, not a URL.
 *
 * Set by the logo-upload path rather than typed into this form, and stored as the
 * key so the hosted page and the PDF renderer can mint their own signed or public
 * URL from it. The customer-safe view in `delivery.ts` never exposes this key — it
 * exposes a `logoUrl` derived from it.
 */
const logoStorageKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(ORG_BRANDING_LOGO_STORAGE_KEY_MAX_LENGTH)
  .meta({
    description:
      'The object-store key of the org’s logo, written after a logo upload rather than typed here. ' +
      'The public invoice view renders a `logoUrl` derived from this, never the key. Send `null` ' +
      'to remove the logo.',
  });

/**
 * A six-digit hex colour, `#1a1a1a`.
 *
 * A regex is used where `contacts.ts` refuses one, and the difference is that a hex
 * colour is a closed, well-defined format — unlike a phone number or an address —
 * so a pattern here rejects exactly the malformed values and no real ones. The
 * three-digit shorthand (`#abc`) is deliberately not accepted: one canonical form
 * means the value a stylesheet reads and the value stored are the same string.
 */
const brandColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/u)
  .meta({
    description:
      'The org’s accent colour as a six-digit hex string, e.g. `#1a1a1a`. Used to tint the hosted ' +
      'invoice page and the PDF. Send `null` to fall back to the default.',
    examples: ['#1a1a1a', '#0b5cff'],
  });

const invoiceFooterSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORG_BRANDING_FOOTER_MAX_LENGTH)
  .meta({
    description:
      'Free text printed at the foot of every invoice — payment instructions, a thank-you, the ' +
      'bank details a customer pays into. Send `null` to clear it.',
  });

/**
 * The org's branding as the API returns it.
 *
 * Nullable-and-required rather than optional, matching every other response schema
 * here (`contactSchema`'s reason): a persisted row holds either a value or NULL, and
 * under `exactOptionalPropertyTypes` an absent key is a different type from a null
 * one. `displayName` is the one field that is never null — there is always a name to
 * print under, even before the rest of the letterhead is filled in.
 */
export const orgBrandingSchema = z
  .strictObject({
    displayName: displayNameSchema,
    addressLine1: addressLine1Schema.nullable(),
    addressLine2: addressLine2Schema.nullable(),
    city: citySchema.nullable(),
    region: regionSchema.nullable(),
    postalCode: postalCodeSchema.nullable(),
    country: countrySchema.nullable(),
    email: emailSchema.nullable(),
    phone: phoneSchema.nullable(),
    website: websiteSchema.nullable(),
    taxNumber: taxNumberSchema.nullable(),
    logoStorageKey: logoStorageKeySchema.nullable(),
    brandColor: brandColorSchema.nullable(),
    invoiceFooter: invoiceFooterSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    description:
      'The letterhead an org’s invoices are printed under: its name, address, contact details, ' +
      'logo and accent colour. One row per org.',
  });

export type OrgBranding = z.infer<typeof orgBrandingSchema>;

/**
 * Partial update of the branding record.
 *
 * Every field optional; an absent field is left alone and an explicit `null` clears
 * a nullable one — the shape `updateContactRequestSchema` and
 * `updatePaymentRequestSchema` both use. `displayName` is `.optional()` and not
 * nullish, because it is the one field that has no null state: it can be changed but
 * never cleared. `logoStorageKey` is accepted here so a client can clear the logo by
 * sending `null`; the key itself is normally written by the upload path.
 *
 * `createdAt`/`updatedAt` are absent — they are the server's to set.
 */
export const updateOrgBrandingRequestSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    addressLine1: addressLine1Schema.nullish(),
    addressLine2: addressLine2Schema.nullish(),
    city: citySchema.nullish(),
    region: regionSchema.nullish(),
    postalCode: postalCodeSchema.nullish(),
    country: countrySchema.nullish(),
    email: emailSchema.nullish(),
    phone: phoneSchema.nullish(),
    website: websiteSchema.nullish(),
    taxNumber: taxNumberSchema.nullish(),
    logoStorageKey: logoStorageKeySchema.nullish(),
    brandColor: brandColorSchema.nullish(),
    invoiceFooter: invoiceFooterSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    description:
      'Partial update of the org’s branding. An absent field is unchanged and an explicit `null` ' +
      'clears a nullable one. `displayName` cannot be cleared, only changed.',
  });

export type UpdateOrgBrandingRequest = z.infer<typeof updateOrgBrandingRequestSchema>;
