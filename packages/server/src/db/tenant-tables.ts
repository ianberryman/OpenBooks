import type { DB } from './generated';

/**
 * Tables whose `org_id` means "belongs to exactly one org, always".
 *
 * Derived from the generated schema rather than hand-listed: any table with a
 * non-nullable `org_id` is a tenant table by construction. A migration that adds
 * one gets scoping automatically, and a table without `org_id` cannot be reached
 * through the tenant wrapper at all. A hand-maintained list would drift, and the
 * direction it drifts in is a tenant table nobody remembered to scope.
 */
type TablesWithOrgId = {
  [K in keyof DB]: 'org_id' extends keyof DB[K] ? K : never;
}[keyof DB];

/**
 * Tables where `org_id` is nullable and NULL means "shared by every org".
 *
 * `roles` is the only one: spec §5 seeds six system roles shared across all orgs
 * (`org_id IS NULL`) and reserves non-null `org_id` for the custom roles that
 * arrive in v2. Scoping it with a plain `org_id = ?` would silently hide every
 * system role, which would leave every user with no permissions at all.
 *
 * This is a subtraction from the derived set, not an addition to it, so the unsafe
 * direction requires an explicit edit here with a reason. Access goes through
 * `systemDb` plus the deliberate `org_id = ? OR org_id IS NULL` predicate in the
 * permissions service.
 */
type SharedScopeTable = 'roles';

/** Table names the tenant wrapper accepts. */
export type TenantTableName = Exclude<TablesWithOrgId, SharedScopeTable>;

/**
 * Runtime counterpart, needed because types are erased and the wrapper has to
 * qualify `org_id` against an actual string at query-build time.
 *
 * `satisfies` ties it to the derived type both ways: a tenant table missing from
 * this array, or a non-tenant table wrongly present, is a compile error. That is
 * what keeps the runtime list from drifting away from the schema.
 */
export const TENANT_TABLES = [
  'accounts',
  'ap_allocations',
  'ap_document_line_dimensions',
  'ap_document_lines',
  'ap_documents',
  'api_keys',
  'ar_allocations',
  'ar_document_line_dimensions',
  'ar_document_lines',
  'ar_documents',
  'bank_accounts',
  'bank_import_mappings',
  'bank_line_clearings',
  'bank_match_proposals',
  'bank_rule_dimensions',
  'bank_rules',
  'bank_statement_imports',
  'bank_statement_lines',
  'contacts',
  'dimension_values',
  'dimensions',
  'document_sequences',
  'dunning_policies',
  'dunning_sends',
  'dunning_stages',
  'fiscal_periods',
  'idempotency_keys',
  'invoice_deliveries',
  'journal_draft_line_dimensions',
  'journal_draft_lines',
  'journal_drafts',
  'journal_line_dimensions',
  'journal_lines',
  'journal_sequences',
  'journals',
  'org_accounting_settings',
  'org_branding',
  'org_invites',
  'org_members',
  'payments',
  'reconciliation_session_events',
  'reconciliation_sessions',
  'recurring_invoice_template_lines',
  'recurring_invoice_templates',
  'tax_rates',
] as const satisfies readonly TenantTableName[];

/**
 * Exhaustiveness check. Fails to compile if a migration adds a table with a
 * non-nullable `org_id` and nobody adds it to TENANT_TABLES — the array would no
 * longer cover the derived union.
 */
type Uncovered = Exclude<TenantTableName, (typeof TENANT_TABLES)[number]>;
type AssertNoUncoveredTenantTables<_T extends never> = true;
export type _TenantTableCoverage = AssertNoUncoveredTenantTables<Uncovered>;

export function isTenantTable(table: string): table is TenantTableName {
  return (TENANT_TABLES as readonly string[]).includes(table);
}
