import type { Ten99FilingStatus, Ten99FormData } from '@openbooks/plugin-api';
import type {
  EfileTen99RunRequest,
  GenerateTen99RunRequest,
  Ten99Form,
  Ten99Run,
  Ten99RunList,
  Ten99RunStatus,
  Ten99Worksheet,
  Ten99WorksheetRow,
  UpsertVendorTaxProfileRequest,
  VendorTaxProfile,
} from '@openbooks/shared-types';
import {
  efileTen99RunRequestSchema,
  fromMinorString,
  fromMinorUnits,
  generateTen99RunRequestSchema,
  toMinorString,
  toMinorUnits,
  upsertVendorTaxProfileRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import {
  bufferToUuid,
  newUuid,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import type { TenantDatabase } from '../../db';
import { decryptField, encryptField } from '../../crypto/field-encryption';
import { InternalError, ValidationError, assertFound, parseInput } from '../../errors';
import { storageProvider } from '../../providers';
import { form1099ProviderFor } from '../../providers/efile';
import { selectBranding, selectOrgIdentity } from '../branding/branding.repository';
import type { BrandingRow, OrgIdentityRow } from '../branding/branding.repository';
import {
  CONTACT_RESOURCE,
  contactIdBytes,
  selectContactById,
} from '../contacts/contacts.repository';
import { requirePermission } from '../permissions';

import { createTen99Renderer } from './renderer';
import type { Ten99FormBranding } from './renderer/types';
import type {
  ContactSnapshotRow,
  NewTen99FormRow,
  Ten99FormRow,
  Ten99RunRow,
  VendorTaxProfilePatch,
  VendorTaxProfileRow,
} from './ten99.repository';
import {
  TEN99_FORM_RESOURCE,
  TEN99_RUN_RESOURCE,
  VENDOR_TAX_PROFILE_RESOURCE,
  insertTen99Forms,
  insertTen99Run,
  selectAllTen99Runs,
  selectAllVendorTaxProfiles,
  selectContactsByIds,
  selectEligibleVendorTaxProfiles,
  selectPaidRollup,
  selectTen99FormById,
  selectTen99FormsByRun,
  selectTen99FormsByRuns,
  selectTen99RunById,
  selectVendorTaxProfileByContactId,
  selectVendorTaxProfileSecretByContactId,
  updateTen99RunStatus,
  upsertVendorTaxProfile as upsertVendorTaxProfileRow,
} from './ten99.repository';

/**
 * 1099 contractor tax reporting (OB-228; ROADMAP D-228-1…D-228-7). Read
 * `ten99.repository.ts`'s header for the schema and the rollup's SQL; this file is the
 * public API and everything money/permission/decrypt-shaped that surrounds it.
 *
 * ## Surface
 *
 * | Operation                        | Permission     |
 * | --------------------------------- | -------------- |
 * | `upsertVendorTaxProfile`          | `ten99.write`  |
 * | `getVendorTaxProfile`             | `ten99.read`   |
 * | `listVendorTaxProfiles`           | `ten99.read`   |
 * | `computeTen99Worksheet`           | `ten99.read`   |
 * | `generateTen99Run`                | `ten99.write`  |
 * | `getTen99Run` / `listTen99Runs`   | `ten99.read`   |
 * | `renderTen99FormPdf`              | `ten99.read`   |
 * | `efileTen99Run`                   | `ten99.write`  |
 * | `getTen99FilingStatus`            | `ten99.read`   |
 *
 * `ten99.write` covers both generating a run and submitting it for e-file — there is no
 * separate transmit-only permission in v1 (D-228-6 notes an owner-only `ten99.file` as the
 * offered alternative; not built).
 *
 * ## Money
 *
 * Every amount is a cents-only string on the wire and a `bigint` in the database (D-13,
 * CLAUDE.md). `fromMinorString`/`toMinorString` are the string↔`Money` boundary;
 * `fromMinorUnits`/`toMinorUnits` are the `bigint`↔`Money` boundary — a `SUM()` rollup off
 * `ten99.repository.ts` already arrives as a plain `bigint`, so it goes through
 * `fromMinorUnits`, never `fromMinorString` (that parser is for wire input only).
 *
 * ## Three assumptions this module makes, flagged for the orchestrator's integration
 *
 * 1. **`renderTen99FormPdf` never writes `pdf_storage_key`.** `ten99_forms` is append-only
 *    (`openbooks_app` holds no `UPDATE` on it, `0999_app_grants`), so the column the schema
 *    reserved for this is permanently unwritable from here. Instead the rendered PDF is
 *    stored under a **deterministic** key derived from the form id
 *    (`ten99FormStorageKey`), so a re-render overwrites the same object rather than
 *    accumulating copies, and `downloadUrl` on the wire is always a freshly signed URL to
 *    that same deterministic key — present even before the form has ever been rendered
 *    once. Fetching it before a first render 404s at the storage layer; nothing in this
 *    module tracks "has this been rendered" as a boolean, because the append-only table has
 *    nowhere to put one.
 * 2. **`efileTen99Run` decrypts the full TIN only for the duration of the call**, to build
 *    `Ten99FormData.recipientTin` for the provider boundary (`Form1099Provider` takes
 *    the plaintext, `plugin-api/providers.ts`'s own doc comment: "the full TIN lives
 *    encrypted … and is decrypted only at the boundary that hands it to a real e-file
 *    vendor"). It is never logged, never persisted a second time, and never reaches the
 *    wire — `Ten99Form.recipientTinLast4` is the only TIN fragment any response carries.
 * 3. **`getTen99FilingStatus` re-reads the persisted run row; it does not poll the
 *    provider.** `Form1099Provider.getStatus` exists for a real transmitter to implement,
 *    but nothing in this module has a live `Form1099Provider` handle to call it with
 *    outside of `efileTen99Run` itself (this module holds no per-run provider
 *    configuration to reconstruct one from). Re-reading the row is what "re-reads status"
 *    in this function's spec means here; wiring an active poll is a follow-up once a real
 *    (`iris`) adapter exists to poll.
 */

const DEFAULT_THRESHOLD_MINOR = '60000';
const DOWNLOAD_URL_TTL_SECONDS = 3600;

function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

// ── Vendor tax profiles ──────────────────────────────────────────────────────

export async function upsertVendorTaxProfile(
  input: { readonly contactId: string } & UpsertVendorTaxProfileRequest,
  ctx: RequestContext = getContext('upsertVendorTaxProfile()'),
): Promise<VendorTaxProfile> {
  await requirePermission(ctx, 'ten99.write');
  const { contactId, ...body } = input;
  const request = parseInput(upsertVendorTaxProfileRequestSchema, body);
  const author = requireActingUser(ctx);

  const db = orgScope(ctx);
  const contactBytes = assertFound(contactIdBytes(contactId), CONTACT_RESOURCE);
  const contact = assertFound(await selectContactById(db, contactBytes), CONTACT_RESOURCE);

  // `taxId` is write-only and three-state (`upsertVendorTaxProfileRequestSchema`'s doc
  // comment): present sets/replaces the encrypted TIN, `null` clears it, absent leaves it.
  // Separators are stripped before encrypting so `12-3456789` and `123456789` store
  // identically and `last4` is always exactly four digits.
  let taxIdCiphertext: Buffer | null | undefined;
  let taxIdLast4: string | null | undefined;
  if (request.taxId !== undefined) {
    if (request.taxId === null) {
      taxIdCiphertext = null;
      taxIdLast4 = null;
    } else {
      const digits = request.taxId.replaceAll('-', '');
      taxIdCiphertext = encryptField(digits);
      taxIdLast4 = digits.slice(-4);
    }
  }

  const patch: VendorTaxProfilePatch = {
    isEligible: request.isEligible,
    defaultForm: request.defaultForm,
    defaultBox: request.defaultBox,
    ...(request.taxIdType === undefined ? {} : { taxIdType: request.taxIdType }),
    ...(request.taxClassification === undefined
      ? {}
      : { taxClassification: request.taxClassification }),
    ...(request.legalNameOverride === undefined
      ? {}
      : { legalNameOverride: request.legalNameOverride }),
    ...(request.w9ReceivedOn === undefined ? {} : { w9ReceivedOn: request.w9ReceivedOn }),
    ...(taxIdCiphertext === undefined ? {} : { taxIdCiphertext }),
    ...(taxIdLast4 === undefined ? {} : { taxIdLast4 }),
  };

  await upsertVendorTaxProfileRow(db, contactBytes, patch, author);

  const row = assertFound(
    await selectVendorTaxProfileByContactId(db, contactBytes),
    VENDOR_TAX_PROFILE_RESOURCE,
  );
  return toWireVendorTaxProfile(row, toContactNamePair(contact));
}

export async function getVendorTaxProfile(
  contactId: string,
  ctx: RequestContext = getContext('getVendorTaxProfile()'),
): Promise<VendorTaxProfile> {
  await requirePermission(ctx, 'ten99.read');

  const db = orgScope(ctx);
  const contactBytes = assertFound(contactIdBytes(contactId), CONTACT_RESOURCE);
  const [row, contact] = await Promise.all([
    selectVendorTaxProfileByContactId(db, contactBytes),
    selectContactById(db, contactBytes),
  ]);

  return toWireVendorTaxProfile(
    assertFound(row, VENDOR_TAX_PROFILE_RESOURCE),
    toContactNamePair(assertFound(contact, CONTACT_RESOURCE)),
  );
}

export async function listVendorTaxProfiles(
  ctx: RequestContext = getContext('listVendorTaxProfiles()'),
): Promise<{ readonly profiles: readonly VendorTaxProfile[] }> {
  await requirePermission(ctx, 'ten99.read');

  const db = orgScope(ctx);
  const rows = await selectAllVendorTaxProfiles(db);
  if (rows.length === 0) return { profiles: [] };

  const contacts = await selectContactsByIds(
    db,
    rows.map((row) => row.contactId),
  );

  const profiles = rows.map((row) =>
    toWireVendorTaxProfile(row, requireContact(row.contactId, contacts)),
  );
  return { profiles };
}

// ── Worksheet ─────────────────────────────────────────────────────────────────

export async function computeTen99Worksheet(
  input: { readonly taxYear: number; readonly thresholdMinor?: string },
  ctx: RequestContext = getContext('computeTen99Worksheet()'),
): Promise<Ten99Worksheet> {
  await requirePermission(ctx, 'ten99.read');

  const thresholdMoney = fromMinorString(input.thresholdMinor ?? DEFAULT_THRESHOLD_MINOR);
  const thresholdMinorValue = toMinorUnits(thresholdMoney);

  const db = orgScope(ctx);
  const [rollup, profiles] = await Promise.all([
    selectPaidRollup(db, input.taxYear),
    selectEligibleVendorTaxProfiles(db),
  ]);

  if (profiles.length === 0) {
    return { taxYear: input.taxYear, thresholdMinor: toMinorString(thresholdMoney), rows: [] };
  }

  const paidByContact = new Map(
    rollup.map((row) => [row.contactId.toString('hex'), row.paidMinor] as const),
  );
  const contacts = await selectContactsByIds(
    db,
    profiles.map((profile) => profile.contactId),
  );

  const rows: Ten99WorksheetRow[] = profiles.map((profile) =>
    toWorksheetRow(
      profile,
      requireContact(profile.contactId, contacts),
      paidByContact,
      thresholdMinorValue,
    ),
  );

  return { taxYear: input.taxYear, thresholdMinor: toMinorString(thresholdMoney), rows };
}

function toWorksheetRow(
  profile: VendorTaxProfileRow,
  contact: ContactSnapshotRow,
  paidByContact: ReadonlyMap<string, bigint>,
  thresholdMinorValue: bigint,
): Ten99WorksheetRow {
  const paidMinorValue = paidByContact.get(profile.contactId.toString('hex')) ?? 0n;
  const legalName = profile.legalNameOverride ?? contact.legalName ?? contact.displayName;

  return {
    contactId: bufferToUuid(profile.contactId),
    contactName: contact.displayName,
    legalName,
    taxIdLast4: profile.taxIdLast4,
    taxClassification: profile.taxClassification,
    defaultForm: profile.defaultForm,
    defaultBox: profile.defaultBox,
    paidMinor: toMinorString(fromMinorUnits(paidMinorValue)),
    meetsThreshold: paidMinorValue >= thresholdMinorValue,
    hasTaxId: profile.taxIdLast4 !== null,
    likelyExempt: profile.taxClassification === 'c_corp' || profile.taxClassification === 's_corp',
  };
}

// ── Filing runs ───────────────────────────────────────────────────────────────

export async function generateTen99Run(
  input: GenerateTen99RunRequest,
  ctx: RequestContext = getContext('generateTen99Run()'),
): Promise<Ten99Run> {
  await requirePermission(ctx, 'ten99.write');
  const request = parseInput(generateTen99RunRequestSchema, input);
  const author = requireActingUser(ctx);

  const thresholdOverride =
    request.thresholdMinor === undefined ? {} : { thresholdMinor: request.thresholdMinor };
  const worksheet = await computeTen99Worksheet(
    { taxYear: request.taxYear, ...thresholdOverride },
    ctx,
  );

  const contactFilter = request.contactIds === undefined ? undefined : new Set(request.contactIds);
  const eligibleRows = worksheet.rows.filter(
    (row) =>
      row.meetsThreshold && (contactFilter === undefined || contactFilter.has(row.contactId)),
  );

  const db = orgScope(ctx);
  const contactBytesByWireId = new Map(
    eligibleRows.map((row) => {
      const bytes = assertFound(contactIdBytes(row.contactId), CONTACT_RESOURCE);
      return [row.contactId, bytes] as const;
    }),
  );
  const contacts = await selectContactsByIds(db, [...contactBytesByWireId.values()]);

  const runId = newUuid();
  const runIdBytes = uuidToBuffer(runId);
  const thresholdMoney = fromMinorString(worksheet.thresholdMinor);

  const formRows: NewTen99FormRow[] = eligibleRows.map((row) => {
    const contactBytes = assertFound(contactBytesByWireId.get(row.contactId), CONTACT_RESOURCE);
    const contact = requireContact(contactBytes, contacts);
    return {
      id: newUuidBuffer(),
      runId: runIdBytes,
      contactId: contactBytes,
      taxYear: request.taxYear,
      formType: row.defaultForm,
      boxCode: row.defaultBox,
      amountMinor: toMinorUnits(fromMinorString(row.paidMinor)),
      recipientLegalName: row.legalName,
      recipientTinLast4: row.taxIdLast4,
      recipientAddressSnapshot: formatAddressSnapshot(contact),
    };
  });

  // One transaction for the run header and every snapshot form (`account-statement.service.ts`'s
  // own reasoning): the run and its forms are one filing event, so a failure partway through
  // must leave neither behind — a run with no forms because the insert died is not "generated".
  await db.transaction(async (trx) => {
    await insertTen99Run(trx, {
      id: runIdBytes,
      taxYear: request.taxYear,
      status: 'generated',
      thresholdMinor: toMinorUnits(thresholdMoney),
      generatedByUserId: author,
    });
    await insertTen99Forms(trx, formRows);
  });

  const run = assertFound(await selectTen99RunById(db, runIdBytes), TEN99_RUN_RESOURCE);
  const forms = await selectTen99FormsByRun(db, runIdBytes);
  return toWireRun(ctx, run, forms, contacts);
}

export async function getTen99Run(
  runId: string,
  ctx: RequestContext = getContext('getTen99Run()'),
): Promise<Ten99Run> {
  await requirePermission(ctx, 'ten99.read');

  const db = orgScope(ctx);
  const id = assertFound(tryUuidToBuffer(runId), TEN99_RUN_RESOURCE);
  const run = assertFound(await selectTen99RunById(db, id), TEN99_RUN_RESOURCE);
  const forms = await selectTen99FormsByRun(db, id);
  const contacts = await selectContactsByIds(
    db,
    forms.map((form) => form.contactId),
  );

  return toWireRun(ctx, run, forms, contacts);
}

export async function listTen99Runs(
  ctx: RequestContext = getContext('listTen99Runs()'),
): Promise<Ten99RunList> {
  await requirePermission(ctx, 'ten99.read');

  const db = orgScope(ctx);
  const runs = await selectAllTen99Runs(db);
  if (runs.length === 0) return { runs: [] };

  const forms = await selectTen99FormsByRuns(
    db,
    runs.map((run) => run.id),
  );
  const contacts = await selectContactsByIds(
    db,
    forms.map((form) => form.contactId),
  );

  const formsByRun = new Map<string, Ten99FormRow[]>();
  for (const form of forms) {
    const key = form.runId.toString('hex');
    const bucket = formsByRun.get(key);
    if (bucket === undefined) {
      formsByRun.set(key, [form]);
    } else {
      bucket.push(form);
    }
  }

  const wireRuns = await Promise.all(
    runs.map((run) => toWireRun(ctx, run, formsByRun.get(run.id.toString('hex')) ?? [], contacts)),
  );
  return { runs: wireRuns };
}

export async function getTen99FilingStatus(
  runId: string,
  ctx: RequestContext = getContext('getTen99FilingStatus()'),
): Promise<Ten99Run> {
  // See this file's header, assumption 3: this re-reads the persisted row rather than
  // polling a live `Form1099Provider`.
  await requirePermission(ctx, 'ten99.read');
  return getTen99Run(runId, ctx);
}

// ── PDF rendering ─────────────────────────────────────────────────────────────

export async function renderTen99FormPdf(
  formId: string,
  ctx: RequestContext = getContext('renderTen99FormPdf()'),
): Promise<Uint8Array> {
  await requirePermission(ctx, 'ten99.read');

  const db = orgScope(ctx);
  const id = assertFound(tryUuidToBuffer(formId), TEN99_FORM_RESOURCE);
  const form = assertFound(await selectTen99FormById(db, id), TEN99_FORM_RESOURCE);
  const run = assertFound(await selectTen99RunById(db, form.runId), TEN99_RUN_RESOURCE);

  const branding = await resolveBranding(db, ctx);
  const logo =
    branding.logoStorageKey === null
      ? undefined
      : await storageProvider().get(branding.logoStorageKey);

  const pdf = await createTen99Renderer().render({
    branding: toRenderBranding(branding),
    ...(logo === undefined ? {} : { logo }),
    taxYear: run.taxYear,
    formType: form.formType,
    boxCode: form.boxCode,
    amountMinor: toMinorString(fromMinorUnits(form.amountMinor)),
    recipientLegalName: form.recipientLegalName,
    recipientTinLast4: form.recipientTinLast4,
    recipientAddress: form.recipientAddressSnapshot,
  });

  // See this file's header, assumption 1: `ten99_forms` is append-only, so
  // `pdf_storage_key` is never written back. The artifact lives at a deterministic key
  // instead, and a re-render simply overwrites the same object.
  await storageProvider().put(ten99FormStorageKey(ctx.orgId, formId), pdf, 'application/pdf');

  return pdf;
}

// ── E-file ────────────────────────────────────────────────────────────────────

export async function efileTen99Run(
  input: { readonly runId: string } & EfileTen99RunRequest,
  ctx: RequestContext = getContext('efileTen99Run()'),
): Promise<Ten99Run> {
  await requirePermission(ctx, 'ten99.write');
  const { runId, ...body } = input;
  const request = parseInput(efileTen99RunRequestSchema, body);

  const db = orgScope(ctx);
  const id = assertFound(tryUuidToBuffer(runId), TEN99_RUN_RESOURCE);
  const run = assertFound(await selectTen99RunById(db, id), TEN99_RUN_RESOURCE);
  const forms = await selectTen99FormsByRun(db, id);

  // See this file's header, assumption 2: the TIN is decrypted only for this call, to
  // build the transmitter's own `Ten99FormData` shape, and never persisted or logged.
  const formData: Ten99FormData[] = await Promise.all(
    forms.map(async (form) => {
      const secret = await selectVendorTaxProfileSecretByContactId(db, form.contactId);
      const recipientTin =
        secret === undefined || secret.taxIdCiphertext === null
          ? null
          : decryptField(secret.taxIdCiphertext);

      return {
        formType: form.formType,
        boxCode: form.boxCode,
        amountMinor: toMinorString(fromMinorUnits(form.amountMinor)),
        recipientLegalName: form.recipientLegalName,
        recipientTin,
        recipientAddress: form.recipientAddressSnapshot,
      };
    }),
  );

  const provider = form1099ProviderFor(request.provider, { apiKey: null, environment: 'sandbox' });
  const transmission = await provider.buildTransmission({ taxYear: run.taxYear, forms: formData });
  const result = await provider.submit(transmission);

  await updateTen99RunStatus(db, id, {
    status: toRunStatus(result.status),
    efileProvider: request.provider,
    efileRef: result.providerRef,
  });

  return getTen99Run(runId, ctx);
}

/**
 * `Form1099Provider.submit`'s `Ten99FilingStatus` (`'ready_to_file' | 'submitted' |
 * 'accepted' | 'rejected'`, `plugin-api/providers.ts`) has no `'ready_to_file'` member on
 * `Ten99RunStatus` (`'draft' | 'generated' | 'submitted' | 'accepted' | 'rejected'`,
 * `@openbooks/shared-types`) — `ready_to_file` is the `manual` adapter's terminal state
 * (its own doc comment: "transmits nothing"), which is exactly what `'generated'` already
 * means for a run on this side, so it maps back rather than growing a sixth run status for
 * one adapter's vocabulary.
 */
function toRunStatus(filing: Ten99FilingStatus): Ten99RunStatus {
  switch (filing) {
    case 'ready_to_file':
      return 'generated';
    case 'submitted':
    case 'accepted':
    case 'rejected':
      return filing;
  }
}

// ---------------------------------------------------------------------------
// Small resolutions
// ---------------------------------------------------------------------------

/** The deterministic PDF storage key. See this file's header, assumption 1. */
function ten99FormStorageKey(orgId: string, formId: string): string {
  return `org/${orgId}/ten99/forms/${formId}.pdf`;
}

function requireContact(
  contactId: Buffer,
  contacts: ReadonlyMap<string, ContactSnapshotRow>,
): ContactSnapshotRow {
  const contact = contacts.get(contactId.toString('hex'));
  if (contact === undefined) {
    // `fk_vendor_tax_profiles_contact` / `fk_ten99_forms_contact` are `ON DELETE
    // CASCADE`/`RESTRICT` respectively — either way a row here names a contact this org
    // still has, so a miss means the batched lookup itself is wrong, not the data.
    throw new InternalError(
      'A 1099 row names a contact that could not be read; the foreign key to `contacts` ' +
        'should make that impossible.',
    );
  }
  return contact;
}

/** The address block a filed form snapshots at generate time — one line per non-empty part. */
function formatAddressSnapshot(contact: ContactSnapshotRow): string | null {
  const cityRegion = [contact.city, contact.region]
    .filter((part): part is string => part !== null)
    .join(', ');

  const lines = [
    contact.addressLine1,
    contact.addressLine2,
    cityRegion === '' ? null : cityRegion,
    contact.postalCode,
    contact.country,
  ].filter((line): line is string => line !== null);

  return lines.length === 0 ? null : lines.join('\n');
}

/**
 * `contact` takes the narrow camelCase shape `ContactSnapshotRow` already carries, so
 * `listVendorTaxProfiles`/the worksheet path can hand this function a batched-lookup row
 * directly. `upsertVendorTaxProfile`/`getVendorTaxProfile` instead hold a single
 * `contacts.repository.ts#ContactRow` (snake_case, that module's own convention) and adapt
 * it at the call site — see `toContactNamePair` just below.
 */
function toWireVendorTaxProfile(
  row: VendorTaxProfileRow,
  contact: { readonly displayName: string; readonly legalName: string | null },
): VendorTaxProfile {
  return {
    contactId: bufferToUuid(row.contactId),
    contactName: contact.displayName,
    isEligible: row.isEligible,
    taxIdLast4: row.taxIdLast4,
    taxIdType: row.taxIdType,
    taxClassification: row.taxClassification,
    defaultForm: row.defaultForm,
    defaultBox: row.defaultBox,
    legalName: row.legalNameOverride ?? contact.legalName ?? contact.displayName,
    w9ReceivedOn: row.w9ReceivedOn,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Adapts a `contacts.repository.ts#ContactRow` (snake_case) to `toWireVendorTaxProfile`'s shape.
 */
function toContactNamePair(contact: {
  readonly display_name: string;
  readonly legal_name: string | null;
}): { readonly displayName: string; readonly legalName: string | null } {
  return { displayName: contact.display_name, legalName: contact.legal_name };
}

async function toWireRun(
  ctx: RequestContext,
  run: Ten99RunRow,
  forms: readonly Ten99FormRow[],
  contacts: ReadonlyMap<string, ContactSnapshotRow>,
): Promise<Ten99Run> {
  return {
    id: bufferToUuid(run.id),
    taxYear: run.taxYear,
    status: run.status,
    efileProvider: run.efileProvider,
    efileRef: run.efileRef,
    thresholdMinor: toMinorString(fromMinorUnits(run.thresholdMinor)),
    generatedByUserId: bufferToUuid(run.generatedByUserId),
    createdAt: run.createdAt.toISOString(),
    forms: await Promise.all(forms.map((form) => toWireForm(ctx, form, contacts))),
  };
}

/**
 * `downloadUrl` is a signed URL to the deterministic key (this file's header, assumption
 * 1), minted whether or not the PDF has ever been rendered — the same "always present, a
 * miss is a storage 404 rather than a wire null" shape `account-statement.service.ts#toWire`
 * gives its own `downloadUrl` for an artifact that, there, is always rendered eagerly.
 */
async function toWireForm(
  ctx: RequestContext,
  form: Ten99FormRow,
  contacts: ReadonlyMap<string, ContactSnapshotRow>,
): Promise<Ten99Form> {
  const formIdWire = bufferToUuid(form.id);
  const contact = contacts.get(form.contactId.toString('hex'));

  return {
    id: formIdWire,
    runId: bufferToUuid(form.runId),
    contactId: bufferToUuid(form.contactId),
    contactName: contact?.displayName ?? form.recipientLegalName,
    formType: form.formType,
    boxCode: form.boxCode,
    amountMinor: toMinorString(fromMinorUnits(form.amountMinor)),
    recipientLegalName: form.recipientLegalName,
    recipientTinLast4: form.recipientTinLast4,
    correctsFormId: form.correctsFormId === null ? null : bufferToUuid(form.correctsFormId),
    downloadUrl: await resolveDownloadUrl(ctx, formIdWire),
    createdAt: form.createdAt.toISOString(),
  };
}

function resolveDownloadUrl(ctx: RequestContext, formId: string): Promise<string> {
  return storageProvider().signedUrl(
    ten99FormStorageKey(ctx.orgId, formId),
    DOWNLOAD_URL_TTL_SECONDS,
  );
}

async function resolveBranding(db: TenantDatabase, ctx: RequestContext): Promise<BrandingRow> {
  const row = await selectBranding(db);
  if (row !== undefined) return row;

  const identity = await requireOrgIdentity(ctx);
  return {
    displayName: identity.name,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    email: null,
    phone: null,
    website: null,
    taxNumber: null,
    logoStorageKey: null,
    brandColor: null,
    invoiceFooter: null,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
  };
}

async function requireOrgIdentity(ctx: RequestContext): Promise<OrgIdentityRow> {
  const identity = await selectOrgIdentity(ctx);
  if (identity === undefined) {
    throw new InternalError(
      `Context named an org (${ctx.orgId}) with no row in \`orgs\`. This context's orgId ` +
        'originates from a resolved session, so a miss here is a server-side wiring fault ' +
        'rather than client input.',
    );
  }
  return identity;
}

function toRenderBranding(row: BrandingRow): Ten99FormBranding {
  return {
    displayName: row.displayName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    brandColor: row.brandColor,
  };
}

/**
 * `vendor_tax_profiles.created_by_user_id` is `NOT NULL` — a profile write is made by a
 * human, the same invariant `requireConnectingUser` enforces for
 * `bank_feed_connections.created_by_user_id`. `ten99_form_runs.generated_by_user_id` shares
 * the reason.
 */
function requireActingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('This 1099 action is taken by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot be recorded as the human ' +
          'accountable for this write.',
      },
    ]);
  }
  return userId;
}
