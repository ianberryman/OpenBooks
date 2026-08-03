import type { PermissionKey as PluginApiPermissionKey } from '@openbooks/plugin-api';

/**
 * The fixed permission catalog (spec §5: "Permissions: fixed catalog + roles as
 * bundles").
 *
 * ## Why this is a hand-written list and not derived from the schema
 *
 * `permissions.code` is `VARCHAR(64)`, so `src/db/generated.ts` types it as
 * `string`. There is no enum to derive from and deliberately so — a MySQL `ENUM`
 * would make adding a permission an `ALTER TABLE` on a table that
 * `role_permissions` has foreign keys into. So the union has to be stated, which
 * means it can drift from what migration `0001_tenancy` seeds.
 *
 * Drift is not defended against by care. `test/permissions/catalog.test.ts` reads
 * `permissions` out of the migrated database and asserts set equality in *both*
 * directions: a code seeded but not listed here fails, and a code listed here but
 * not seeded fails too. The two directions fail differently and both matter — the
 * first is a permission no service can ever check, the second is a
 * `requirePermission` call that compiles and can never be satisfied because no
 * role can hold a code the catalog table does not contain.
 *
 * ## Why this file is separate from the enforcement
 *
 * `RouteDefinition.permission` and `McpToolDefinition.permission` are declarative
 * (plugin-api `routes.ts`), so the transport layer legitimately handles permission
 * *keys* — it emits them into the OpenAPI artifact. It must never hold the
 * enforcement (spec §2.4, §5). Keeping the type in its own module means a boundary
 * rule can allow transport to reach this file while forbidding
 * `permissions.service.ts`, rather than having to choose between banning both and
 * banning neither. See the OB-016 report note on `.dependency-cruiser.cjs`.
 *
 * Order follows the seed statement in `0001_tenancy.ts` so the two can be diffed
 * by eye; the test is what actually holds them together.
 */
export const PERMISSION_KEYS = [
  // Enforced from M1.
  'orgs.read',
  'orgs.write',
  'members.read',
  'members.write',
  'roles.read',
  'roles.write',
  'accounts.read',
  'accounts.write',
  'periods.read',
  'periods.write',
  'periods.close',
  'periods.reopen',
  'journals.read',
  'journals.post',
  'journals.reverse',
  'reports.read',
  'api_keys.read',
  'api_keys.write',
  // Catalog only in M1; the enforcement point arrives with the named milestone.
  // Seeded now because the six system roles are defined in terms of the whole
  // catalog — see the `seedPermissions` commentary in `0001_tenancy.ts`.
  'contacts.read',
  'contacts.write',
  'dimensions.read',
  'dimensions.write',
  'invoices.read',
  'invoices.write',
  'invoices.void',
  'invoices.send',
  'credit_notes.read',
  'credit_notes.write',
  'payments_received.read',
  'payments_received.write',
  'bills.read',
  'bills.write',
  'bills.void',
  'vendor_credits.read',
  'vendor_credits.write',
  'payments_made.read',
  'payments_made.write',
  'tax_rates.read',
  'tax_rates.write',
  // Invoice delivery — the org letterhead an invoice is sent under (Phase 1, INV).
  'branding.read',
  'branding.write',
  'banking.read',
  'banking.import',
  'banking.match',
  'banking.reconcile',
  'banking.reopen',
  // Live bank feeds (OB-227, D-131). Connecting a feed stores a per-org restricted
  // credential and stands up a standing automated pull job — an org-administration
  // act, not a clerk's file import — so it is its own key seeded owner-only, and the
  // bookkeeper is excluded from it exactly as from `processing.write`. Syncing runs
  // on `banking.import` and reads on `banking.read`.
  'banking.connect',
  'integrations.read',
  'integrations.write',
  'agents.review',
  // Payment-processor integration (initiative J, OB-143…153) — connecting the
  // org's own Stripe/Square and reading its connections and event log.
  'processing.read',
  'processing.write',
  'workflows.read',
  'workflows.write',
  'workflows.activate',
  // Pay Bills (initiative G, OB-109…118). The queue/issue split is a real
  // separation of duties (D-109): `pending_payments.*` build the queue and post no
  // journal, while `disbursements.issue` releases it — seeded to owner only, so a
  // clerk who can queue cannot also pay.
  'pending_payments.read',
  'pending_payments.write',
  'disbursements.issue',
  // Fixed assets & recurring journals (initiative L, OB-162…169). Two independent
  // config surfaces, each a plain read/write pair with no separation-of-duties split
  // (D-117): unlike Pay Bills there is no release gate to withhold, because the
  // automated posts run through `postJournal` under the automation's own Owner role.
  'recurring_journals.read',
  'recurring_journals.write',
  'fixed_assets.read',
  'fixed_assets.write',
  // Procure-to-pay & pre-sale (initiative M, OB-170…179). Purchase orders and
  // estimates are non-posting pre-documents (D-92) with their own read/write pairs;
  // an employee expense is an ap_documents bill against an employee contact, so it
  // reuses the bill posting path but is gated by its own keys — and `expenses.approve`
  // is the separation-of-duties gate (like `disbursements.issue`): the clerk who
  // enters an expense is not necessarily the one who approves it into a payable.
  'purchase_orders.read',
  'purchase_orders.write',
  'estimates.read',
  'estimates.write',
  'expenses.read',
  'expenses.write',
  'expenses.approve',
  // Budgets (initiative N, OB-180…184). A budget posts no journal (D-94), so there
  // is no separation-of-duties release gate to withhold — just a plain read/write
  // pair (D-N6). The budget-vs-actual report gates on `reports.read` like every
  // other report; these two govern only entering and importing the figures.
  'budgets.read',
  'budgets.write',
  // Accountant access & period close (initiative P, OB-192…199). The audit-trail
  // report surfaces the actor provenance every journal already carries plus the
  // period close/reopen history (D-98) — a distinct read from `reports.read`
  // because it exposes who-changed-what across the org, a controller/accountant
  // capability rather than a figure any report reader needs. The other P
  // capabilities reuse keys that already exist: `periods.close`/`periods.reopen`
  // gate the close workflow, `journals.post` posts an adjusting entry (flagged by
  // `journals.source`, not a permission), and `reports.read` gates the statement
  // package (it renders reports the holder can already run).
  'audit.read',
  // Item catalog (initiative CAT, OB-220…). A reusable list of priced items a
  // document line can be selected from (D-CAT-1). A plain read/write pair with no
  // separation-of-duties gate: the item only seeds a line's defaults and posts no
  // journal (D-CAT-2). `catalog.write` is held by the AR/AP clerks too, so inline
  // "add item" works while entering an invoice or a bill.
  'catalog.read',
  'catalog.write',
  // 1099 contractor tax reporting (initiative 1099, OB-228). A read/write pair.
  // `ten99.read` gates the worksheet and filed forms (masked TIN only) and auto-grants
  // to every `%.read` holder. `ten99.write` gates managing a vendor's W-9 / TIN, generating
  // a filing run, and e-filing — held by owner, accountant and bookkeeper (1099 prep is
  // clerk work, so it is NOT on the bookkeeper administration-exclusion list). No dedicated
  // transmit SoD key in v1 (D-228-6); an owner-only `ten99.file` is the offered alternative.
  'ten99.read',
  'ten99.write',
  // Tracked inventory & COGS (initiative INVENTORY, OB-224). A read/write pair
  // distinct from `catalog.write` (D-INV-8): `inventory.read` gates the valuation
  // report, on-hand views and reorder alerts and auto-grants to every `%.read`
  // holder; `inventory.write` gates the stock-adjustment document — a distinct
  // authority from editing an item's costing fields, which ride `catalog.write`.
  // Held by owner and bookkeeper; the AR/AP clerks do not adjust stock.
  'inventory.read',
  'inventory.write',
] as const;

/**
 * The catalog as a closed union.
 *
 * This is the narrowing plugin-api's own `PermissionKey` comment defers to OB-016.
 * It carries the same name on purpose: adopting it is an import-path change at a
 * call site and nothing else, and `@openbooks/plugin-api` stays unedited (it is
 * owned elsewhere, and per spec §8 the contract package cannot depend on the host
 * that assembles the catalog anyway).
 *
 * The practical consequence is that `requirePermission(ctx, 'invoice.write')` — a
 * typo for `invoices.write` — is a compile error rather than a check that silently
 * never passes, which under the loose `` `${string}.${string}` `` it was.
 */
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Every catalog entry is still `resource.action`, so the narrow type remains
 * assignable wherever plugin-api's loose one is expected. Fails to compile if an
 * entry is added without a dot, which would silently make this union *not* a
 * subtype and break every `RouteDefinition.permission` assignment.
 */
type AssertShapedLikePluginApiKey<_T extends PluginApiPermissionKey> = true;
export type _CatalogKeysAreResourceAction = AssertShapedLikePluginApiKey<PermissionKey>;

/**
 * The catalog size, pinned in the type system.
 *
 * Migration `0001` seeds these codes and the seven system roles are set operations
 * over that number (Owner is the whole catalog). An entry deleted here by an errant
 * edit would otherwise only surface as a database test failure; this makes it a
 * compile failure in the file that caused it.
 */
type AssertCatalogSize<_N extends 78> = true;
export type _CatalogSize = AssertCatalogSize<(typeof PERMISSION_KEYS)['length']>;

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

/**
 * Narrows a string read from the database or the wire.
 *
 * The repository uses it to drop codes it does not recognise. That is the
 * fail-closed direction and it is safe: a code absent from this union cannot be
 * passed to `requirePermission` in the first place, so a role holding it holds
 * something no service can ask about. The drift test is what turns that from a
 * silent no-op into a failure.
 */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}
