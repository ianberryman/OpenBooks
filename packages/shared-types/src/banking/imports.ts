import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

import { bankStatementLineDraftSchema } from './statement-lines';

/**
 * Statement imports and the column mappings that drive them (OB-075, for OB-076,
 * OB-077 and OB-078; ROADMAP D-41, D-42, acceptance E1).
 *
 * ## File import, and the interface that has no hosted implementation
 *
 * D-41: CSV and OFX/QFX, uploaded by the user. `BankFeedProvider` ships with a real
 * file-based implementation and no hosted aggregator adapter, because a live feed
 * is "a different milestone wearing M4's clothes" — OAuth to a third party, custody
 * of credentials that read a customer's bank, webhook replay, per-institution
 * quirks. None of that is banking logic and all of it would be built before a
 * single statement line had been matched.
 *
 * So there is no `sync` request here, no cursor into a provider, and no webhook
 * payload. What a hosted feed would eventually produce is *statement lines*, which
 * is the shape everything downstream already reads.
 *
 * ## Re-import is idempotent, and it is the point (E1)
 *
 * An import is a request that either produces lines or fails whole. It never
 * imports part of a file: a partial import is what makes people afraid to re-upload,
 * and being unafraid to re-upload is the entire user-visible value of E1. So there
 * is no `linesRejected` count — a row this parser cannot read is a
 * `validation_failed` naming the row, before anything is written.
 *
 * What re-import *does* produce is duplicates, and duplicates are the ordinary case
 * rather than the error case: statements overlap at their edges as a matter of
 * course (D-42). `bankStatementImportResultSchema` therefore reports how many lines
 * were new and how many were already present, and both numbers are expected to be
 * non-zero on a second upload.
 *
 * ## The component ids arrived with OB-084's routes — see `banking.ts`.
 *
 * Preview, start-import, and the import-poll reads (`getBankStatementImport`,
 * `listBankStatementImports`) are all routed, so the shapes they carry are components.
 * `updateBankImportMappingRequestSchema` alone carries no id: OB-084 routed no
 * mapping-update surface, and a component no operation reaches is the
 * unreachable-component A10 refuses (see the wave-4 note in `banking.ts`).
 */

/**
 * The two file formats (D-41).
 *
 * `ofx` covers QFX: QFX is Quicken's OFX with a couple of proprietary tags, and
 * OB-077 is one parser for both. A separate `qfx` member would be a second token
 * for one format, and every consumer would have to remember to accept both.
 */
export const BANK_STATEMENT_FORMATS = ['csv', 'ofx'] as const;

export type BankStatementFormat = (typeof BANK_STATEMENT_FORMATS)[number];

export const bankStatementFormatSchema = z.enum(BANK_STATEMENT_FORMATS).meta({
  description:
    'The uploaded file’s format. `ofx` covers QFX — QFX is OFX with proprietary tags and one ' +
    'parser reads both, so a second token would be a second name for one format.',
});

/**
 * How the file's date column is written.
 *
 * Stated by the mapping and never inferred, and this is the one field in the module
 * worth an argument. `01/02/2026` is a valid date under two of these orders and
 * means two different months; a detector that guesses from the first rows is right
 * until a statement happens to contain no day above twelve, at which point it
 * silently mis-dates the whole file — and a mis-dated statement line lands in the
 * wrong reconciliation period, where it is discovered a month later by a
 * reconciliation that will not balance.
 *
 * A user picking the order once, on the mapping they then reuse, is a question
 * asked once per bank rather than a guess made once per upload.
 */
export const BANK_DATE_ORDERS = ['ymd', 'dmy', 'mdy'] as const;

export type BankDateOrder = (typeof BANK_DATE_ORDERS)[number];

export const bankDateOrderSchema = z.enum(BANK_DATE_ORDERS).meta({
  description:
    'The order of the parts in the file’s date column, whatever separator it uses. Stated rather ' +
    'than detected: `01/02/2026` is a valid date under both `dmy` and `mdy` and means different ' +
    'months, and a detector that guesses is wrong on exactly the files where no day exceeds 12.',
});

/**
 * How the file expresses which way the money went.
 *
 * `signed` — one column, positive in, negative out; the convention this system
 * stores (`bankLineAmountSchema`).
 *
 * `signed_reversed` — one column with the opposite sign, which is what a credit-card
 * export usually gives: a purchase is positive because it increases what you owe.
 * Modelled rather than left to the user to work around, because the workaround is a
 * spreadsheet with a `-1` multiplier in it, and that spreadsheet is not in the audit
 * trail.
 *
 * `debit_credit_columns` — two columns, at most one of them filled per row. The sign
 * trap here is worth writing down: the labels are the *bank's* accounting, not
 * yours. Your account is the bank's liability, so a deposit is a **credit** on their
 * statement and a **debit** in your books. The credit column is therefore money in
 * and maps to a positive amount.
 */
export const BANK_AMOUNT_CONVENTIONS = [
  'signed',
  'signed_reversed',
  'debit_credit_columns',
] as const;

export type BankAmountConvention = (typeof BANK_AMOUNT_CONVENTIONS)[number];

export const bankAmountConventionSchema = z.enum(BANK_AMOUNT_CONVENTIONS).meta({
  description:
    'How the file signs its amounts. `signed` is positive-in/negative-out; `signed_reversed` is ' +
    'the credit-card convention, where a purchase is positive; `debit_credit_columns` is two ' +
    'columns, of which the *credit* one is money in — the labels are the bank’s accounting, ' +
    'where your account is their liability.',
});

export const BANK_IMPORT_MAPPING_NAME_MAX_LENGTH = 120;
export const BANK_IMPORT_FILENAME_MAX_LENGTH = 255;

/**
 * The largest statement this API accepts, in characters of file text.
 *
 * E10 sets the target at 5,000 lines. A wide CSV row is a few hundred characters,
 * so four mebicharacters is roughly an order of magnitude of headroom over the
 * criterion — chosen against the criterion rather than as a round number, and
 * generous in that direction because the cost of being wrong here is a statement a
 * business cannot upload at all.
 *
 * A bound exists at all for `PAGE_SIZE_MAX`'s reason: without one, the cost of a
 * request is set by the caller's file rather than by the caller.
 */
export const BANK_STATEMENT_CONTENT_MAX_LENGTH = 4_194_304;

/** How many mapped rows a preview returns. Enough to see a mistake, not a page of data. */
export const BANK_IMPORT_PREVIEW_ROWS = 20;

/**
 * Which column holds what, by **zero-based index**.
 *
 * Index and not header name, for two reasons that both come from real exports.
 * Banks ship headerless CSVs, which have no names to refer to; and banks ship files
 * with two columns both called `Amount`, which makes a name ambiguous exactly where
 * it matters most. An index is unambiguous in both cases, and the header row — when
 * there is one — is what the preview shows the user so they can pick the right
 * index without counting commas.
 *
 * `amount` and the `debit`/`credit` pair are mutually exclusive, enforced by the
 * refinement on the definition below rather than by a union, so that an invalid
 * mapping produces a message naming the field the user must fix.
 */
const columnIndexSchema = z.int().min(0);

export const bankImportColumnsSchema = z
  .strictObject({
    postedDate: columnIndexSchema,
    description: columnIndexSchema,
    amount: columnIndexSchema.nullable().meta({
      description: 'Null exactly when the convention is `debit_credit_columns`.',
    }),
    debit: columnIndexSchema.nullable(),
    credit: columnIndexSchema.nullable(),
    valueDate: columnIndexSchema.nullable().meta({
      description:
        'The date the money was available, where the bank supplies both. Null when it does not — ' +
        'and reconciliation uses `postedDate`, because that is the date the bank’s own balance ' +
        'moved on.',
    }),
    counterparty: columnIndexSchema.nullable(),
    bankReference: columnIndexSchema.nullable().meta({
      description:
        'The bank’s own identifier for the transaction, where it supplies one. Worth mapping ' +
        'whenever it exists: it is the strongest field in the dedupe fingerprint (D-42).',
    }),
  })
  .meta({
    id: 'BankImportColumns',
    description:
      'Which column holds what, by zero-based index. `amount` and the `debit`/`credit` pair are ' +
      'mutually exclusive, decided by the definition’s `amountConvention`.',
  });

export type BankImportColumns = z.infer<typeof bankImportColumnsSchema>;

/**
 * Everything needed to read one bank's CSV, minus the name it is saved under.
 *
 * A mapping is a **CSV artefact by construction** — it names columns, and OFX has
 * none — so there is no `format` field to get wrong. Sending a mapping with an OFX
 * upload is `import_mapping_format_mismatch`.
 */
export const bankImportMappingDefinitionSchema = z
  .strictObject({
    hasHeaderRow: z.boolean(),
    delimiter: z
      .string()
      .length(1)
      .meta({
        description:
          'One character. A tab is a tab, not the two characters `\\t` — this is data, not an ' +
          'escape sequence.',
      }),
    dateOrder: bankDateOrderSchema,
    amountConvention: bankAmountConventionSchema,
    columns: bankImportColumnsSchema,
  })
  .refine(
    (definition) =>
      definition.amountConvention === 'debit_credit_columns'
        ? definition.columns.amount === null &&
          definition.columns.debit !== null &&
          definition.columns.credit !== null
        : definition.columns.amount !== null &&
          definition.columns.debit === null &&
          definition.columns.credit === null,
    {
      error:
        'Map either a single `amount` column or both `debit` and `credit`, matching ' +
        '`amountConvention`.',
      path: ['columns'],
    },
  )
  .meta({
    id: 'BankImportMappingDefinition',
    description:
      'Everything needed to read one bank’s CSV, minus the name it is saved under. A CSV artefact ' +
      'by construction — it names columns, and OFX has none.',
  });

export type BankImportMappingDefinition = z.infer<typeof bankImportMappingDefinitionSchema>;

/**
 * A saved mapping (D-41, OB-076).
 *
 * Saved and reused rather than re-entered per upload, because a business uploads
 * from the same bank every month and the column layout is a property of the bank,
 * not of the file. It is also what makes a mis-mapping *correctable*: the mapping is
 * a named row someone can look at, rather than a set of choices made in a wizard
 * and forgotten.
 */
export const bankImportMappingSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    definition: bankImportMappingDefinitionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'BankImportMapping',
    description: 'A saved column mapping, reused across a bank’s monthly uploads (D-41).',
  });

export type BankImportMapping = z.infer<typeof bankImportMappingSchema>;

const mappingNameSchema = z.string().trim().min(1).max(BANK_IMPORT_MAPPING_NAME_MAX_LENGTH);

export const createBankImportMappingRequestSchema = z
  .strictObject({
    name: mappingNameSchema,
    definition: bankImportMappingDefinitionSchema,
  })
  .meta({
    id: 'CreateBankImportMappingRequest',
    description: 'Saves a named column mapping against a bank account.',
  });

export type CreateBankImportMappingRequest = z.infer<typeof createBankImportMappingRequestSchema>;

/**
 * `definition` is replaced whole rather than patched.
 *
 * The fields inside it are interdependent — the convention decides which columns
 * may be present — so a patch would let a caller reach a definition that never
 * validates as a whole, one field at a time. `updateInvoiceRequestSchema` replaces
 * `lines` for the same reason.
 *
 * Editing a mapping does not touch a line already imported through it. A statement
 * line is what the bank said (D-42) and is never modified; a file read under the
 * wrong mapping is re-imported under the right one, and the dedupe decides what is
 * genuinely new.
 */
export const updateBankImportMappingRequestSchema = z
  .strictObject({
    name: mappingNameSchema.optional(),
    definition: bankImportMappingDefinitionSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  });

export type UpdateBankImportMappingRequest = z.infer<typeof updateBankImportMappingRequestSchema>;

export const listBankImportMappingsQuerySchema = z.strictObject({ ...pageQueryShape });

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListBankImportMappingsQuery = z.input<typeof listBankImportMappingsQuerySchema>;

export const bankImportMappingPageSchema = pageSchema(bankImportMappingSchema, {
  id: 'BankImportMappingPage',
  description: 'One page of a bank account’s saved mappings, oldest first.',
});

export type BankImportMappingPage = z.infer<typeof bankImportMappingPageSchema>;

/**
 * The file itself, as text.
 *
 * Text rather than multipart or a storage handle, because both formats M4 accepts
 * *are* text and a JSON body keeps the whole surface one content type — an MCP tool
 * reaching the same service (spec §12, M5) has no multipart to send. It also keeps
 * the request idempotent in the ordinary way: the same body under the same key is
 * the same import.
 */
const statementContentSchema = z
  .string()
  .min(1)
  .max(BANK_STATEMENT_CONTENT_MAX_LENGTH)
  .meta({
    description:
      'The statement file’s contents, as text. CSV or OFX/QFX — both are text, so there is no ' +
      'multipart and no binary here.',
  });

const importSourceShape = {
  bankAccountId: z.uuid(),
  format: bankStatementFormatSchema,
  filename: z
    .string()
    .trim()
    .min(1)
    .max(BANK_IMPORT_FILENAME_MAX_LENGTH)
    .meta({
      description:
        'What the file was called. Recorded, never parsed — a filename is how a person finds the ' +
        'artifact D-41 says file import exists to give them, and nothing derives meaning from it.',
    }),
  content: statementContentSchema,
  mappingId: z.uuid().nullish().meta({
    description: 'A saved mapping to read the file with. CSV only, and exclusive with `mapping`.',
  }),
  mapping: bankImportMappingDefinitionSchema.nullish().meta({
    description:
      'An ad-hoc mapping for this upload. CSV only, and exclusive with `mappingId` — send one or ' +
      'the other, never both.',
  }),
};

/**
 * Exactly one way of reading a CSV, and no way of reading an OFX.
 *
 * Both halves matter. A CSV with neither a `mappingId` nor a `mapping` cannot be
 * read at all, and a CSV with both leaves the server choosing which the caller
 * meant. An OFX carries its own field names, so a mapping sent with one is either a
 * mistake or a misunderstanding — refusing it here is cheaper than importing a
 * statement that ignored half the request.
 */
function hasExactlyOneReading(input: {
  format: BankStatementFormat;
  mappingId?: string | null | undefined;
  mapping?: unknown;
}): boolean {
  const named = input.mappingId !== undefined && input.mappingId !== null;
  const inline = input.mapping !== undefined && input.mapping !== null;
  return input.format === 'csv' ? named !== inline : !named && !inline;
}

const READING_ERROR = {
  error:
    'A CSV import takes exactly one of `mappingId` or `mapping`; an OFX import takes neither, ' +
    'because the format names its own fields.',
  path: ['mapping'],
};

/**
 * Imports a statement.
 *
 * `saveMappingAs` is what makes OB-076's "saved column mappings" a single call: the
 * first upload from a new bank arrives with an inline `mapping` and a name to keep
 * it under, and every upload after it sends `mappingId`. Splitting that into
 * "create a mapping, then import" would make the common first-time path two
 * requests, the second of which can fail after the user has already answered every
 * question.
 */
export const createBankStatementImportRequestSchema = z
  .strictObject({
    ...importSourceShape,
    saveMappingAs: mappingNameSchema.nullish().meta({
      description:
        'Save the inline `mapping` under this name and use it for this import. Only meaningful ' +
        'alongside `mapping`.',
    }),
  })
  .refine(hasExactlyOneReading, READING_ERROR)
  .meta({
    id: 'CreateBankStatementImportRequest',
    description:
      'Imports a statement. Enqueues the parse and returns a queued handle — a 5,000-line file ' +
      'does not block the request (D-47, E10). A CSV takes exactly one of `mappingId`/`mapping`; ' +
      'an OFX takes neither.',
  });

export type CreateBankStatementImportRequest = z.infer<
  typeof createBankStatementImportRequestSchema
>;

/**
 * The handle `startImport` returns: a queued import to poll, not a finished one (E10,
 * D-47).
 *
 * A separate, smaller shape from `bankStatementImportSchema` on purpose. A queued import
 * has parsed nothing yet — no `result`, no statement dates — so it cannot satisfy the
 * completed shape, and the honest 202 body is these three fields. The parse happens on
 * the worker (`processStatementImport`); this is what the request ends with.
 */
export const bankStatementImportQueuedSchema = z
  .strictObject({
    id: z.uuid(),
    bankAccountId: z.uuid(),
    status: z.literal('queued').meta({
      description:
        'Always `queued`: the import has been accepted and enqueued, and the parse has not run yet.',
    }),
  })
  .meta({
    id: 'BankStatementImportQueued',
    description:
      'A queued statement import, returned `202` by start-import. The file has been accepted and ' +
      'the parse enqueued; nothing has been read yet.',
  });

export type BankStatementImportQueued = z.infer<typeof bankStatementImportQueuedSchema>;

/**
 * E1, as three numbers: `linesRead === linesImported + linesDuplicate`, exactly.
 *
 * Reported rather than implied, because "no duplicates were created" is invisible
 * from the outside — a second upload that silently did nothing and a second upload
 * that silently doubled the month look identical to a client that is only told
 * "created". These are what a screen says after a re-import, and what OB-088 asserts.
 */
export const bankStatementImportResultSchema = z
  .strictObject({
    linesRead: z.int().min(0).meta({
      description: 'How many transaction rows the file contained.',
    }),
    linesImported: z.int().min(0).meta({
      description: 'How many of them were new — the ones this import created.',
    }),
    linesDuplicate: z
      .int()
      .min(0)
      .meta({
        description:
          'How many were already present, matched on the dedupe fingerprint (D-42). Non-zero is the ' +
          'ordinary case on a re-upload: statements overlap at their edges, and re-importing last ' +
          'month’s file to catch a straggler must not double the month (E1).',
      }),
  })
  .meta({
    id: 'BankStatementImportResult',
    description:
      'E1 as three numbers: `linesRead === linesImported + linesDuplicate`, exactly. Non-zero ' +
      '`linesDuplicate` is the ordinary case on a re-upload.',
  });

export type BankStatementImportResult = z.infer<typeof bankStatementImportResultSchema>;

/**
 * The lifecycle of an import (D-47, D-49; OB-078's `bank_statement_imports.status`).
 *
 * `queued` → `processing` → `complete` | `failed`. Start-import writes `queued` and
 * returns (`bankStatementImportQueuedSchema`); the worker moves it to `processing`,
 * then to `complete` with counts or `failed` with a reason. A screen polls
 * `getBankStatementImport` and reads this to know which of the four it is looking at.
 */
export const BANK_STATEMENT_IMPORT_STATUSES = [
  'queued',
  'processing',
  'complete',
  'failed',
] as const;

export type BankStatementImportStatus = (typeof BANK_STATEMENT_IMPORT_STATUSES)[number];

export const bankStatementImportStatusSchema = z.enum(BANK_STATEMENT_IMPORT_STATUSES).meta({
  description:
    'Where the import is in its lifecycle. `queued`/`processing` carry neither `result` nor ' +
    '`failureReason`; `complete` carries `result`; `failed` carries `failureReason`.',
});

/**
 * One import, as the API returns it — the shape a screen polls (OB-085).
 *
 * ## It carries the whole lifecycle, not just a finished import
 *
 * A queued or processing import has parsed nothing, so `result` is null and there is no
 * `failureReason`; a completed import carries `result` and no reason; a failed one
 * carries the reason and no counts. That mapping is the `0006_banking` CHECK constraint
 * (`counts ↔ complete`, `reason ↔ failed`) restated on the wire as the refinement
 * below, so a client cannot construct — and the API cannot emit — an impossible
 * combination like a `failed` import with counts.
 *
 * ## There is no `statementStart`/`statementEnd` here
 *
 * The file's date range is a *parse-time* fact the preview reports
 * (`bankStatementImportPreviewSchema`); it is not persisted on the import row, so it is
 * not an import fact. `statementClosingBalance` is persisted (the bank printed it), and
 * it is a **claim from outside** (D-46) kept as evidence for a reconciliation to test —
 * never read as this account's balance, which is the ledger account's.
 */
export const bankStatementImportSchema = z
  .strictObject({
    id: z.uuid(),
    bankAccountId: z.uuid(),
    format: bankStatementFormatSchema,
    filename: z.string(),
    mappingId: z.uuid().nullable(),
    status: bankStatementImportStatusSchema,
    result: bankStatementImportResultSchema.nullable().meta({
      description: 'The counts, present exactly when `status` is `complete`; null otherwise.',
    }),
    failureReason: z
      .string()
      .nullable()
      .meta({
        description:
          'Why the import failed, present exactly when `status` is `failed`; null otherwise. A ' +
          'malformed file, an unreadable row — the parse never partially imports (E1).',
      }),
    statementClosingBalance: minorUnitsSchema.nullable().meta({
      description:
        'The closing balance the file states, where it states one. A claim from outside the system ' +
        '(D-46), kept as evidence for a reconciliation to test — never read as this account’s ' +
        'balance, which is the ledger account’s.',
    }),
    externalAccountId: z
      .string()
      .nullable()
      .meta({
        description:
          'The account identifier the file carried, where it carried one. Compared against the bank ' +
          'account’s own, so that uploading one account’s statement into another is noticed at ' +
          'import rather than by a reconciliation weeks later.',
      }),
    importedByUserId: z.uuid().meta({
      description: 'Who uploaded it. An import is the one point where data from outside enters.',
    }),
    createdAt: z.iso.datetime(),
  })
  .refine(
    (input) =>
      (input.result !== null) === (input.status === 'complete') &&
      (input.failureReason !== null) === (input.status === 'failed'),
    {
      error:
        'An import carries `result` exactly when `complete` and `failureReason` exactly when ' +
        '`failed` — the `0006_banking` CHECK, restated (counts ↔ complete, reason ↔ failed).',
      path: ['status'],
    },
  )
  .meta({
    id: 'BankStatementImport',
    description:
      'A statement import across its whole lifecycle — `queued`, `processing`, `complete` (with ' +
      '`result`), or `failed` (with `failureReason`). The shape OB-085 polls after starting one.',
  });

export type BankStatementImport = z.infer<typeof bankStatementImportSchema>;

export const listBankStatementImportsQuerySchema = z.strictObject({
  ...pageQueryShape,
  bankAccountId: z.uuid().optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListBankStatementImportsQuery = z.input<typeof listBankStatementImportsQuerySchema>;

/** Ordered by `(created_at, id)`, the default this API's lists use (D-21). */
export const bankStatementImportPageSchema = pageSchema(bankStatementImportSchema, {
  id: 'BankStatementImportPage',
  description: 'One page of a bank account’s statement imports, newest activity last by creation.',
});

export type BankStatementImportPage = z.infer<typeof bankStatementImportPageSchema>;

/** Reads the file and reports what would happen, writing nothing. */
export const previewBankStatementImportRequestSchema = z
  .strictObject(importSourceShape)
  .refine(hasExactlyOneReading, READING_ERROR)
  .meta({
    id: 'PreviewBankStatementImportRequest',
    description:
      'Reads the file and reports what importing it would do, writing nothing. Same reading rules ' +
      'as the real import: a CSV takes exactly one of `mappingId`/`mapping`, an OFX takes neither.',
  });

export type PreviewBankStatementImportRequest = z.infer<
  typeof previewBankStatementImportRequestSchema
>;

/**
 * What the import would do, without doing it.
 *
 * A column-mapping screen (OB-085) is unusable without this: choosing a date order
 * and six column indices from a raw file is guesswork until you can see the rows
 * those choices produce. It is also where the account-identifier check surfaces
 * early, at the point the user can still cancel.
 *
 * It writes nothing, so `linesDuplicate` here is a *prediction* — the answer can
 * change if another import lands in between. That is fine and is why the real
 * import reports its own counts rather than the client reusing these.
 */
export const bankStatementImportPreviewSchema = z
  .strictObject({
    format: bankStatementFormatSchema,
    headers: z
      .array(z.string())
      .nullable()
      .meta({
        description:
          'The header row, so a user can pick column indices without counting commas. Null for a ' +
          'headerless CSV and for OFX, which names its own fields.',
      }),
    result: bankStatementImportResultSchema.meta({
      description:
        'What importing this file would produce. A prediction, not a promise: another import ' +
        'landing in between changes what is already present.',
    }),
    sample: z.array(bankStatementLineDraftSchema).meta({
      description: `The first ${String(BANK_IMPORT_PREVIEW_ROWS)} rows as they would be read.`,
    }),
    statementStart: calendarDateSchema.nullable(),
    statementEnd: calendarDateSchema.nullable(),
    statementClosingBalance: minorUnitsSchema.nullable(),
    externalAccountId: z.string().nullable(),
    externalAccountMatches: z
      .boolean()
      .nullable()
      .meta({
        description:
          'Whether the file’s account identifier matches the bank account’s. Null when either side ' +
          'has none — a warning, never a refusal, because a bank that changes its identifier would ' +
          'otherwise lock a business out of its own statements.',
      }),
  })
  .meta({
    id: 'BankStatementImportPreview',
    description:
      'What importing this file would do, without doing it — the column-mapping screen’s input ' +
      '(OB-085). `result.linesDuplicate` is a prediction, not a promise.',
  });

export type BankStatementImportPreview = z.infer<typeof bankStatementImportPreviewSchema>;
