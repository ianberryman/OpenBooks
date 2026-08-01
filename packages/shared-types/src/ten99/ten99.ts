import { z } from 'zod';

import { calendarDateSchema } from '../wire';

/**
 * The 1099 contractor-tax-reporting wire contract (OB-228).
 *
 * A reporting/compliance overlay that posts no journals. Three shapes carry it: a
 * per-vendor **tax profile** (W-9 data; the TIN is write-only — only `taxIdLast4` is
 * ever read back, D-228-2), the calendar-year **worksheet** (cash actually paid to each
 * 1099 vendor, card/third-party payments excluded, D-228-3/4), and a **filing run** whose
 * immutable per-vendor **forms** are snapshotted on generate (D-228-5). Money is a
 * cents-only string everywhere (D-13).
 */

export const TAX_ID_TYPES = ['ein', 'ssn', 'itin'] as const;
export const taxIdTypeSchema = z.enum(TAX_ID_TYPES).meta({
  description: 'Which taxpayer id the recipient filed on their W-9.',
});
export type TaxIdType = (typeof TAX_ID_TYPES)[number];

export const TAX_CLASSIFICATIONS = [
  'individual',
  'c_corp',
  's_corp',
  'partnership',
  'llc',
  'other',
] as const;
export const taxClassificationSchema = z.enum(TAX_CLASSIFICATIONS).meta({
  description: 'W-9 federal tax classification. C/S-corps are generally 1099-exempt.',
});
export type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number];

export const TEN99_FORM_TYPES = ['1099_nec', '1099_misc'] as const;
export const ten99FormTypeSchema = z.enum(TEN99_FORM_TYPES).meta({
  description: '1099-NEC (nonemployee compensation) or 1099-MISC (rent/other income).',
});
export type Ten99FormType = (typeof TEN99_FORM_TYPES)[number];

/** The reportable box. v1: NEC box 1, MISC box 1 (rents), MISC box 3 (other income). */
export const TEN99_BOX_CODES = ['nec_1', 'misc_1', 'misc_3'] as const;
export const ten99BoxCodeSchema = z.enum(TEN99_BOX_CODES);
export type Ten99BoxCode = (typeof TEN99_BOX_CODES)[number];

export const TEN99_RUN_STATUSES = [
  'draft',
  'generated',
  'submitted',
  'accepted',
  'rejected',
] as const;
export const ten99RunStatusSchema = z.enum(TEN99_RUN_STATUSES);
export type Ten99RunStatus = (typeof TEN99_RUN_STATUSES)[number];

export const TEN99_EFILE_PROVIDERS = ['manual', 'iris'] as const;
export const ten99EfileProviderSchema = z.enum(TEN99_EFILE_PROVIDERS);
export type Ten99EfileProvider = (typeof TEN99_EFILE_PROVIDERS)[number];

// ── Vendor tax profile ───────────────────────────────────────────────────────

/**
 * A vendor's 1099 profile as read back. The full TIN is never returned — only
 * `taxIdLast4` — so a leaked list response cannot reconstruct a taxpayer id (D-228-2).
 */
export const vendorTaxProfileSchema = z
  .strictObject({
    contactId: z.uuid(),
    contactName: z.string(),
    isEligible: z.boolean().meta({ description: 'Whether this vendor should receive a 1099.' }),
    taxIdLast4: z.string().nullable().meta({
      description: 'The last four of the TIN, all that is read back; null when none is stored.',
    }),
    taxIdType: taxIdTypeSchema.nullable(),
    taxClassification: taxClassificationSchema.nullable(),
    defaultForm: ten99FormTypeSchema,
    defaultBox: ten99BoxCodeSchema,
    legalName: z.string().meta({
      description: 'The 1099 payee legal name — the override if set, else the contact legal name.',
    }),
    w9ReceivedOn: calendarDateSchema.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'VendorTaxProfile', description: "A vendor's 1099/W-9 profile." });

export type VendorTaxProfile = z.infer<typeof vendorTaxProfileSchema>;

/**
 * Upsert a vendor's profile. `taxId` is write-only: present sets/replaces the encrypted
 * TIN, `null` clears it, absent leaves it untouched. It is validated as 9 digits
 * (EIN/SSN/ITIN are all nine) with optional separators the server strips.
 */
export const upsertVendorTaxProfileRequestSchema = z
  .strictObject({
    isEligible: z.boolean(),
    taxId: z
      .string()
      .regex(/^\d{2}-?\d{7}$|^\d{3}-?\d{2}-?\d{4}$/, 'must be a 9-digit EIN or SSN')
      .nullable()
      .optional()
      .meta({ description: 'Write-only. Present sets the TIN, null clears it, absent keeps it.' }),
    taxIdType: taxIdTypeSchema.nullable().optional(),
    taxClassification: taxClassificationSchema.nullable().optional(),
    defaultForm: ten99FormTypeSchema.default('1099_nec'),
    defaultBox: ten99BoxCodeSchema.default('nec_1'),
    legalNameOverride: z.string().max(255).nullable().optional(),
    w9ReceivedOn: calendarDateSchema.nullable().optional(),
  })
  .meta({
    id: 'UpsertVendorTaxProfileRequest',
    description: "Create or update a vendor's 1099 profile.",
  });

export type UpsertVendorTaxProfileRequest = z.infer<typeof upsertVendorTaxProfileRequestSchema>;

// ── Worksheet (the live calendar-year rollup) ────────────────────────────────

/**
 * One vendor's line on the worksheet: cash actually paid in the tax year (excluding
 * payments funded from `excluded_from_1099` accounts), and the review flags a human
 * needs before generating — over threshold, has a TIN, is a likely-exempt corporation.
 */
export const ten99WorksheetRowSchema = z
  .strictObject({
    contactId: z.uuid(),
    contactName: z.string(),
    legalName: z.string(),
    taxIdLast4: z.string().nullable(),
    taxClassification: taxClassificationSchema.nullable(),
    defaultForm: ten99FormTypeSchema,
    defaultBox: ten99BoxCodeSchema,
    paidMinor: z.string().meta({
      description: 'Cash paid to this vendor in the tax year, cents-only (D-13), card excluded.',
    }),
    meetsThreshold: z.boolean(),
    hasTaxId: z.boolean(),
    likelyExempt: z.boolean().meta({ description: 'True for a C/S-corp classification.' }),
  })
  .meta({ id: 'Ten99WorksheetRow', description: 'One vendor on the 1099 worksheet.' });

export type Ten99WorksheetRow = z.infer<typeof ten99WorksheetRowSchema>;

export const ten99WorksheetSchema = z
  .strictObject({
    taxYear: z.number().int(),
    thresholdMinor: z
      .string()
      .meta({ description: 'The reporting threshold applied, cents-only.' }),
    rows: z.array(ten99WorksheetRowSchema),
  })
  .meta({
    id: 'Ten99Worksheet',
    description: 'The calendar-year cash-paid rollup for 1099 vendors, for human review.',
  });

export type Ten99Worksheet = z.infer<typeof ten99WorksheetSchema>;

// ── Filing runs and forms ────────────────────────────────────────────────────

/**
 * Generate a filing run for a tax year: snapshots one immutable `Ten99Form` per eligible
 * vendor at or over the threshold. `contactIds` narrows to a subset; absent takes every
 * over-threshold eligible vendor.
 */
export const generateTen99RunRequestSchema = z
  .strictObject({
    taxYear: z.number().int().min(2000).max(2100),
    thresholdMinor: z.string().optional().meta({
      description: 'Override the reporting threshold (cents). Absent uses the NEC default ($600).',
    }),
    contactIds: z.array(z.uuid()).optional(),
  })
  .meta({ id: 'GenerateTen99RunRequest', description: 'Generate a 1099 filing run for a year.' });

export type GenerateTen99RunRequest = z.infer<typeof generateTen99RunRequestSchema>;

export const ten99FormSchema = z
  .strictObject({
    id: z.uuid(),
    runId: z.uuid(),
    contactId: z.uuid(),
    contactName: z.string(),
    formType: ten99FormTypeSchema,
    boxCode: ten99BoxCodeSchema,
    amountMinor: z.string().meta({ description: 'The reported amount, cents-only (D-13).' }),
    recipientLegalName: z.string(),
    recipientTinLast4: z.string().nullable(),
    correctsFormId: z.uuid().nullable().meta({
      description: 'The form this corrects, when this is a correction (D-02 house style).',
    }),
    downloadUrl: z.string().nullable().meta({
      description: 'A short-lived signed URL to the recipient Copy B PDF, minted on read.',
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Ten99Form', description: 'One immutable filed 1099 form.' });

export type Ten99Form = z.infer<typeof ten99FormSchema>;

export const ten99RunSchema = z
  .strictObject({
    id: z.uuid(),
    taxYear: z.number().int(),
    status: ten99RunStatusSchema,
    efileProvider: ten99EfileProviderSchema.nullable(),
    efileRef: z.string().nullable(),
    thresholdMinor: z.string(),
    generatedByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
    forms: z.array(ten99FormSchema),
  })
  .meta({ id: 'Ten99Run', description: 'A 1099 filing run and its immutable forms.' });

export type Ten99Run = z.infer<typeof ten99RunSchema>;

export const ten99RunListSchema = z
  .strictObject({ runs: z.array(ten99RunSchema) })
  .meta({ id: 'Ten99RunList', description: 'The org’s 1099 filing runs, newest first.' });

export type Ten99RunList = z.infer<typeof ten99RunListSchema>;

/** Submit a generated run to an e-file provider. `manual` returns the IRIS file to download. */
export const efileTen99RunRequestSchema = z
  .strictObject({ provider: ten99EfileProviderSchema.default('manual') })
  .meta({ id: 'EfileTen99RunRequest', description: 'Submit a 1099 filing run for e-file.' });

export type EfileTen99RunRequest = z.infer<typeof efileTen99RunRequestSchema>;
