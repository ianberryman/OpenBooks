import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';

import type {
  Ten99BoxCode,
  Ten99EfileProvider,
  Ten99FormType,
  Ten99RunStatus,
  TaxClassification,
  TaxIdType,
} from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import { newUuidBuffer } from '../../db';

/**
 * Data access for the three 1099 tenant tables (OB-228; migration `0023_ten99`) plus the
 * calendar-year cash-paid rollup over `payments`.
 *
 * `vendor_tax_profiles` and `ten99_form_runs` are mutable (`0999_app_grants`); `ten99_forms`
 * is append-only — a correction is a new row carrying `corrects_form_id`, never a mutation
 * (D-02 house style), and there is no `updateTen99Form*` function here for that reason.
 *
 * Every `*_id` column this file selects is `BINARY(16)`; every public row type keeps it as
 * `Buffer` and leaves the `Buffer → UUID string` conversion to the service layer
 * (`account-statement.repository.ts`'s own split, not `connections.repository.ts`'s, which
 * folds the wire mapper in here — this module follows the exemplar named in its spec).
 *
 * `VendorTaxProfileRow` never carries `tax_id_ciphertext` — only `taxIdLast4` — so a service
 * function that reads the ordinary projection cannot leak the encrypted TIN by forgetting to
 * drop a field (D-228-2). `selectVendorTaxProfileSecretByContactId` is the one exception,
 * for `ten99.service.ts#efileTen99Run`'s own reason: decrypting a TIN to hand to a real
 * e-file transmitter is the one place this codebase needs the plaintext back.
 */

export const VENDOR_TAX_PROFILE_RESOURCE = 'vendor_tax_profile';
export const TEN99_RUN_RESOURCE = 'ten99_form_run';
export const TEN99_FORM_RESOURCE = 'ten99_form';

// ── Vendor tax profiles ──────────────────────────────────────────────────────

const VENDOR_TAX_PROFILE_COLUMNS = [
  'id',
  'contact_id',
  'is_1099_eligible',
  'tax_id_last4',
  'tax_id_type',
  'tax_classification',
  'default_form',
  'default_box',
  'legal_name_override',
  'w9_received_on',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

export interface VendorTaxProfileRow {
  readonly id: Buffer;
  readonly contactId: Buffer;
  readonly isEligible: boolean;
  readonly taxIdLast4: string | null;
  readonly taxIdType: TaxIdType | null;
  readonly taxClassification: TaxClassification | null;
  readonly defaultForm: Ten99FormType;
  readonly defaultBox: Ten99BoxCode;
  readonly legalNameOverride: string | null;
  readonly w9ReceivedOn: string | null;
  readonly createdByUserId: Buffer;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The one row shape that carries the encrypted TIN. See this file's header. */
export interface VendorTaxProfileSecretRow extends VendorTaxProfileRow {
  readonly taxIdCiphertext: Buffer | null;
}

interface RawVendorTaxProfileRow {
  readonly id: Buffer;
  readonly contact_id: Buffer;
  readonly is_1099_eligible: number;
  readonly tax_id_last4: string | null;
  readonly tax_id_type: string | null;
  readonly tax_classification: string | null;
  readonly default_form: string;
  readonly default_box: string;
  readonly legal_name_override: string | null;
  readonly w9_received_on: string | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * `default_form`/`default_box`/`tax_classification`/`tax_id_type` are `VARCHAR + CHECK`
 * (this file's migration header: "the app reads them as a union"), so they arrive typed as
 * plain `string` off `generated.ts` and are narrowed here — `customer_statements.status`'s
 * own cast, `account-statement.repository.ts#listCustomerStatements`.
 */
function toVendorTaxProfileRow(row: RawVendorTaxProfileRow): VendorTaxProfileRow {
  return {
    id: row.id,
    contactId: row.contact_id,
    isEligible: row.is_1099_eligible !== 0,
    taxIdLast4: row.tax_id_last4,
    taxIdType: row.tax_id_type as TaxIdType | null,
    taxClassification: row.tax_classification as TaxClassification | null,
    defaultForm: row.default_form as Ten99FormType,
    defaultBox: row.default_box as Ten99BoxCode,
    legalNameOverride: row.legal_name_override,
    w9ReceivedOn: row.w9_received_on,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function selectVendorTaxProfileByContactId(
  db: TenantDatabase,
  contactId: Buffer,
): Promise<VendorTaxProfileRow | undefined> {
  const row = await db
    .selectFrom('vendor_tax_profiles')
    .select(VENDOR_TAX_PROFILE_COLUMNS)
    .where('contact_id', '=', contactId)
    .executeTakeFirst();
  return row === undefined ? undefined : toVendorTaxProfileRow(row);
}

/**
 * The one read that carries the encrypted TIN, keyed by the vendor it names rather than by
 * profile id — `efileTen99Run` walks a run's forms, which name a `contact_id`, not a
 * `vendor_tax_profiles.id`.
 */
export async function selectVendorTaxProfileSecretByContactId(
  db: TenantDatabase,
  contactId: Buffer,
): Promise<VendorTaxProfileSecretRow | undefined> {
  const row = await db
    .selectFrom('vendor_tax_profiles')
    .select([...VENDOR_TAX_PROFILE_COLUMNS, 'tax_id_ciphertext'])
    .where('contact_id', '=', contactId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { ...toVendorTaxProfileRow(row), taxIdCiphertext: row.tax_id_ciphertext };
}

export async function selectAllVendorTaxProfiles(
  db: TenantDatabase,
): Promise<readonly VendorTaxProfileRow[]> {
  const rows = await db
    .selectFrom('vendor_tax_profiles')
    .select(VENDOR_TAX_PROFILE_COLUMNS)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toVendorTaxProfileRow);
}

/** The worksheet's own input: eligible vendors only (`is_1099_eligible = 1`). */
export async function selectEligibleVendorTaxProfiles(
  db: TenantDatabase,
): Promise<readonly VendorTaxProfileRow[]> {
  const rows = await db
    .selectFrom('vendor_tax_profiles')
    .select(VENDOR_TAX_PROFILE_COLUMNS)
    .where('is_1099_eligible', '=', 1)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toVendorTaxProfileRow);
}

/**
 * The three-state patch `upsertVendorTaxProfileRequestSchema` describes: a key present sets
 * the column, `null` clears it, and a key **absent from this object** leaves the stored value
 * alone. `isEligible`/`defaultForm`/`defaultBox` are not part of that three-state set — the
 * wire schema makes all three always-required-with-a-default, so they are plain (non-optional)
 * fields here and are written on every upsert, insert or update alike.
 */
export interface VendorTaxProfilePatch {
  readonly isEligible: boolean;
  readonly defaultForm: Ten99FormType;
  readonly defaultBox: Ten99BoxCode;
  readonly taxIdType?: TaxIdType | null;
  readonly taxClassification?: TaxClassification | null;
  readonly legalNameOverride?: string | null;
  readonly w9ReceivedOn?: string | null;
  readonly taxIdCiphertext?: Buffer | null;
  readonly taxIdLast4?: string | null;
}

/**
 * `INSERT … ON DUPLICATE KEY UPDATE` against `uq_vendor_tax_profiles_contact (org_id,
 * contact_id)` — `upsertBranding`'s exact shape and exact reason
 * (`branding.repository.ts#upsertBranding`): a read-then-branch loses a race with itself,
 * and the unique key makes the conflict target unambiguous. `rest` is spread into both the
 * insert and the update side, so a field this call omits is omitted from the `INSERT` column
 * list too — for a nullable column with no explicit `DEFAULT`, MySQL still fills it with
 * `NULL`, which is exactly the "absent leaves it alone" contract's first-write case (there is
 * nothing yet *to* leave alone, so absent and "set to null" coincide only on the insert side).
 */
export async function upsertVendorTaxProfile(
  db: TenantDatabase,
  contactId: Buffer,
  patch: VendorTaxProfilePatch,
  createdByUserId: Buffer,
): Promise<void> {
  const rest = {
    ...(patch.taxIdType === undefined ? {} : { tax_id_type: patch.taxIdType }),
    ...(patch.taxClassification === undefined
      ? {}
      : { tax_classification: patch.taxClassification }),
    ...(patch.legalNameOverride === undefined
      ? {}
      : { legal_name_override: patch.legalNameOverride }),
    ...(patch.w9ReceivedOn === undefined ? {} : { w9_received_on: patch.w9ReceivedOn }),
    ...(patch.taxIdCiphertext === undefined ? {} : { tax_id_ciphertext: patch.taxIdCiphertext }),
    ...(patch.taxIdLast4 === undefined ? {} : { tax_id_last4: patch.taxIdLast4 }),
  };

  // `id` is only ever consumed on the insert branch — `ON DUPLICATE KEY UPDATE` never
  // touches it, so an existing profile keeps the id it was created with no matter how many
  // times this runs.
  await db
    .insertInto('vendor_tax_profiles')
    .values({
      id: newUuidBuffer(),
      contact_id: contactId,
      is_1099_eligible: patch.isEligible ? 1 : 0,
      default_form: patch.defaultForm,
      default_box: patch.defaultBox,
      created_by_user_id: createdByUserId,
      ...rest,
    })
    .onDuplicateKeyUpdate({
      is_1099_eligible: patch.isEligible ? 1 : 0,
      default_form: patch.defaultForm,
      default_box: patch.defaultBox,
      ...rest,
    })
    .execute();
}

// ── Contact snapshots (name + address, for the worksheet and a filed form) ──────────────────

export interface ContactSnapshotRow {
  readonly id: Buffer;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
}

/**
 * Batched the way `account-statement.repository.ts#selectContactNames` batches its own
 * narrower read: a worksheet or a run can name several vendors, and one `IN` query beats one
 * round trip per row. Keyed by the `BINARY(16)` id's hex string, the same key shape every
 * other batched lookup in this codebase uses.
 */
export async function selectContactsByIds(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, ContactSnapshotRow>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .selectFrom('contacts')
    .select([
      'id',
      'display_name',
      'legal_name',
      'address_line1',
      'address_line2',
      'city',
      'region',
      'postal_code',
      'country',
    ])
    .where('id', 'in', [...ids])
    .execute();

  return new Map(
    rows.map((row) => [
      row.id.toString('hex'),
      {
        id: row.id,
        displayName: row.display_name,
        legalName: row.legal_name,
        addressLine1: row.address_line1,
        addressLine2: row.address_line2,
        city: row.city,
        region: row.region,
        postalCode: row.postal_code,
        country: row.country,
      },
    ]),
  );
}

// ── The payments rollup (the correctness core) ───────────────────────────────

export interface PaidRollupRow {
  readonly contactId: Buffer;
  readonly paidMinor: bigint;
}

/**
 * Cash actually paid to each contact in the calendar year, card/third-party payments
 * excluded (D-228-3/4) — the worksheet's whole arithmetic.
 *
 * Modeled on `aging.repository.ts#selectPayments`'s join shape, simplified because this is a
 * flat rollup rather than a per-payment detail read: one join, one `GROUP BY`, no correlated
 * subqueries, because there is no per-document allocation state to net against here — a
 * `payments` row already *is* cash that moved.
 *
 * Four predicates, each load-bearing:
 *  - `direction = 'paid'` — money this org sent, the only direction a 1099 reports.
 *  - `void_journal_id IS NULL` — a voided payment moved no cash in the end; the aging report
 *    (`selectPayments`) filters the identical way, via its `void_journal.id IS NULL` join.
 *  - `payment_date BETWEEN {taxYear}-01-01 AND {taxYear}-12-31` — the calendar year, not the
 *    fiscal year; 1099 reporting is calendar-year by IRS rule regardless of the org's own
 *    fiscal-year start month.
 *  - `accounts.excluded_from_1099 = 0` on the **funding** bank account — a card or third-party
 *    processor payout is excluded because the processor (not this org) is the one with a 1099-K
 *    reporting obligation for it (D-228-3); an org marks the funding account, not the payment.
 *
 * `accounts` is joined rather than read as a correlated subquery because this is a flat
 * equi-join with no row-multiplication risk (`payments.bank_account_id → accounts.id` is
 * many-to-one), unlike the document/allocation sums in `aging.repository.ts` where a join
 * would multiply rows.
 */
export async function selectPaidRollup(
  db: TenantDatabase,
  taxYear: number,
): Promise<readonly PaidRollupRow[]> {
  const yearStart = `${String(taxYear)}-01-01`;
  const yearEnd = `${String(taxYear)}-12-31`;

  const rows = await db
    .selectFrom('payments')
    .innerJoin('accounts', (join) =>
      join
        .onRef('accounts.id', '=', 'payments.bank_account_id')
        .onRef('accounts.org_id', '=', 'payments.org_id'),
    )
    .where('payments.direction', '=', 'paid')
    .where('payments.void_journal_id', 'is', null)
    .where('payments.payment_date', '>=', yearStart)
    .where('payments.payment_date', '<=', yearEnd)
    .where('accounts.excluded_from_1099', '=', 0)
    .groupBy('payments.contact_id')
    // Two `select` calls, not one array mixing a plain column reference with a `sql`
    // fragment — `aging.repository.ts`'s own note: combining them collapses the row type to
    // an index signature, so `contact_id` keeps its inferred `Buffer` type only if it is
    // selected on its own.
    .select(['payments.contact_id as contact_id'])
    .select([paidSum().as('paid_minor')])
    .execute();

  return rows.map((row) => ({
    contactId: row.contact_id,
    paidMinor: toBigInt(row.paid_minor),
  }));
}

/** `SUM` over a grouped `BIGINT` column arrives as a DECIMAL string on the mysql2 driver. */
function paidSum(): RawBuilder<string> {
  return sql<string>`COALESCE(SUM(${sql.ref('payments.amount_minor')}), 0)`;
}

/** `aging.repository.ts#toBigInt`'s identical helper: DECIMAL string, or a number over zero rows. */
function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

// ── Filing runs ───────────────────────────────────────────────────────────────

const RUN_COLUMNS = [
  'id',
  'tax_year',
  'status',
  'efile_provider',
  'efile_ref',
  'threshold_minor',
  'generated_by_user_id',
  'created_at',
] as const;

export interface Ten99RunRow {
  readonly id: Buffer;
  readonly taxYear: number;
  readonly status: Ten99RunStatus;
  readonly efileProvider: Ten99EfileProvider | null;
  readonly efileRef: string | null;
  readonly thresholdMinor: bigint;
  readonly generatedByUserId: Buffer;
  readonly createdAt: Date;
}

interface RawRunRow {
  readonly id: Buffer;
  readonly tax_year: number;
  readonly status: string;
  readonly efile_provider: string | null;
  readonly efile_ref: string | null;
  readonly threshold_minor: bigint;
  readonly generated_by_user_id: Buffer;
  readonly created_at: Date;
}

function toRunRow(row: RawRunRow): Ten99RunRow {
  return {
    id: row.id,
    taxYear: row.tax_year,
    status: row.status as Ten99RunStatus,
    efileProvider: row.efile_provider as Ten99EfileProvider | null,
    efileRef: row.efile_ref,
    thresholdMinor: row.threshold_minor,
    generatedByUserId: row.generated_by_user_id,
    createdAt: row.created_at,
  };
}

export interface NewTen99RunRow {
  readonly id: Buffer;
  readonly taxYear: number;
  readonly status: Ten99RunStatus;
  readonly thresholdMinor: bigint;
  readonly generatedByUserId: Buffer;
}

/** A fresh run has no e-file provider or ref yet — both are set only by `updateTen99RunStatus`. */
export async function insertTen99Run(db: TenantDatabase, row: NewTen99RunRow): Promise<void> {
  await db
    .insertInto('ten99_form_runs')
    .values({
      id: row.id,
      tax_year: row.taxYear,
      status: row.status,
      efile_provider: null,
      efile_ref: null,
      threshold_minor: row.thresholdMinor,
      generated_by_user_id: row.generatedByUserId,
    })
    .execute();
}

export async function selectTen99RunById(
  db: TenantDatabase,
  id: Buffer,
): Promise<Ten99RunRow | undefined> {
  const row = await db
    .selectFrom('ten99_form_runs')
    .select(RUN_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : toRunRow(row);
}

/**
 * Every run this org has generated, newest first — unpaginated, the same convention
 * `listCustomerStatements`/`listStatementPackages` document: a v1 org runs 1099 filing once a
 * year, not enough runs to justify a keyset.
 */
export async function selectAllTen99Runs(db: TenantDatabase): Promise<readonly Ten99RunRow[]> {
  const rows = await db
    .selectFrom('ten99_form_runs')
    .select(RUN_COLUMNS)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map(toRunRow);
}

export interface Ten99RunStatusPatch {
  readonly status: Ten99RunStatus;
  readonly efileProvider: Ten99EfileProvider;
  readonly efileRef: string;
}

/**
 * `ten99_form_runs` is mutable (`0999_app_grants`): status legitimately moves as e-file
 * progresses (`draft→generated→submitted→accepted|rejected`), the same working-state shape a
 * reconciliation session takes.
 */
export async function updateTen99RunStatus(
  db: TenantDatabase,
  id: Buffer,
  patch: Ten99RunStatusPatch,
): Promise<void> {
  await db
    .updateTable('ten99_form_runs')
    .set({
      status: patch.status,
      efile_provider: patch.efileProvider,
      efile_ref: patch.efileRef,
    })
    .where('id', '=', id)
    .execute();
}

// ── Filed forms (append-only) ────────────────────────────────────────────────

const FORM_COLUMNS = [
  'id',
  'run_id',
  'contact_id',
  'tax_year',
  'form_type',
  'box_code',
  'amount_minor',
  'recipient_legal_name',
  'recipient_tin_last4',
  'recipient_address_snapshot',
  'corrects_form_id',
  'pdf_storage_key',
  'created_at',
] as const;

export interface Ten99FormRow {
  readonly id: Buffer;
  readonly runId: Buffer;
  readonly contactId: Buffer;
  readonly taxYear: number;
  readonly formType: Ten99FormType;
  readonly boxCode: Ten99BoxCode;
  readonly amountMinor: bigint;
  readonly recipientLegalName: string;
  readonly recipientTinLast4: string | null;
  readonly recipientAddressSnapshot: string | null;
  readonly correctsFormId: Buffer | null;
  /**
   * Always `null` off this repository — the column is never written after the row's insert
   * (`ten99_forms` is append-only; `openbooks_app` holds no `UPDATE` on it). See
   * `ten99.service.ts#renderTen99FormPdf`'s header for where the rendered artifact actually
   * lives instead.
   */
  readonly pdfStorageKey: string | null;
  readonly createdAt: Date;
}

interface RawFormRow {
  readonly id: Buffer;
  readonly run_id: Buffer;
  readonly contact_id: Buffer;
  readonly tax_year: number;
  readonly form_type: string;
  readonly box_code: string;
  readonly amount_minor: bigint;
  readonly recipient_legal_name: string;
  readonly recipient_tin_last4: string | null;
  readonly recipient_address_snapshot: string | null;
  readonly corrects_form_id: Buffer | null;
  readonly pdf_storage_key: string | null;
  readonly created_at: Date;
}

function toFormRow(row: RawFormRow): Ten99FormRow {
  return {
    id: row.id,
    runId: row.run_id,
    contactId: row.contact_id,
    taxYear: row.tax_year,
    formType: row.form_type as Ten99FormType,
    boxCode: row.box_code as Ten99BoxCode,
    amountMinor: row.amount_minor,
    recipientLegalName: row.recipient_legal_name,
    recipientTinLast4: row.recipient_tin_last4,
    recipientAddressSnapshot: row.recipient_address_snapshot,
    correctsFormId: row.corrects_form_id,
    pdfStorageKey: row.pdf_storage_key,
    createdAt: row.created_at,
  };
}

export interface NewTen99FormRow {
  readonly id: Buffer;
  readonly runId: Buffer;
  readonly contactId: Buffer;
  readonly taxYear: number;
  readonly formType: Ten99FormType;
  readonly boxCode: Ten99BoxCode;
  readonly amountMinor: bigint;
  readonly recipientLegalName: string;
  readonly recipientTinLast4: string | null;
  readonly recipientAddressSnapshot: string | null;
}

/**
 * Every form is a fresh row — `ten99_forms` is append-only, so there is no update path here,
 * only this insert (D-02: a correction is a new row naming `corrects_form_id`, which
 * `generateTen99Run` does not yet set — v1 has no correction flow, only first-time generation).
 */
export async function insertTen99Forms(
  db: TenantDatabase,
  rows: readonly NewTen99FormRow[],
): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insertInto('ten99_forms')
    .values(
      rows.map((row) => ({
        id: row.id,
        run_id: row.runId,
        contact_id: row.contactId,
        tax_year: row.taxYear,
        form_type: row.formType,
        box_code: row.boxCode,
        amount_minor: row.amountMinor,
        recipient_legal_name: row.recipientLegalName,
        recipient_tin_last4: row.recipientTinLast4,
        recipient_address_snapshot: row.recipientAddressSnapshot,
        corrects_form_id: null,
        pdf_storage_key: null,
      })),
    )
    .execute();
}

export async function selectTen99FormById(
  db: TenantDatabase,
  id: Buffer,
): Promise<Ten99FormRow | undefined> {
  const row = await db
    .selectFrom('ten99_forms')
    .select(FORM_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : toFormRow(row);
}

export async function selectTen99FormsByRun(
  db: TenantDatabase,
  runId: Buffer,
): Promise<readonly Ten99FormRow[]> {
  const rows = await db
    .selectFrom('ten99_forms')
    .select(FORM_COLUMNS)
    .where('run_id', '=', runId)
    .orderBy('recipient_legal_name', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toFormRow);
}

/** The batched form of `selectTen99FormsByRun`, for `listTen99Runs`'s one round trip. */
export async function selectTen99FormsByRuns(
  db: TenantDatabase,
  runIds: readonly Buffer[],
): Promise<readonly Ten99FormRow[]> {
  if (runIds.length === 0) return [];

  const rows = await db
    .selectFrom('ten99_forms')
    .select(FORM_COLUMNS)
    .where('run_id', 'in', [...runIds])
    .orderBy('run_id', 'asc')
    .orderBy('recipient_legal_name', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(toFormRow);
}
