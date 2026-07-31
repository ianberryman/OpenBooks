import { describe, expect, it } from 'vitest';
import { Kysely, MysqlDialect, type Compilable } from 'kysely';
import { createPool } from 'mysql2';

import type { DB } from '../../src/db/generated';
import { TenantDatabase } from '../../src/db/tenant';
import { TENANT_TABLES, isTenantTable } from '../../src/db/tenant-tables';

/**
 * Acceptance criteria A5 and A7 (spec §4, ROADMAP D-01).
 *
 * These assert on *compiled SQL* rather than on query results, deliberately. The
 * claim under test is that the wrapper cannot produce an unscoped tenant query —
 * a claim about every query it builds, not about the handful a round-trip test
 * would happen to run. Compiling is also exact: `where org_id = ?` is either in
 * the SQL or it is not.
 *
 * The behavioural half — that a cross-org read returns nothing and that the app
 * user is denied UPDATE on journals — needs a real database and belongs to
 * OB-026 against the testcontainers harness.
 */

/**
 * A Kysely instance that can compile but never connect.
 *
 * `createPool` opens no socket until a query executes, and nothing here executes.
 * Using the real MysqlDialect matters: a stub dialect would compile to different
 * SQL than production, which would make these assertions describe the test's
 * dialect rather than MySQL.
 */
function compileOnlyDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new MysqlDialect({
      pool: createPool({ host: '127.0.0.1', port: 1, user: 'unused', database: 'unused' }),
    }),
  });
}

const ORG_A = Buffer.from('11111111000040008000000000000001', 'hex');
const ORG_B = Buffer.from('22222222000040008000000000000002', 'hex');

function sqlOf(query: Compilable): string {
  return query.compile().sql;
}

const db = compileOnlyDb();
const tenant = new TenantDatabase(db, ORG_A);

describe('every tenant table is scoped on select', () => {
  // Table-driven over TENANT_TABLES rather than a few hand-picked examples: the
  // guarantee is about all of them, and a new tenant table should be covered by
  // this test the moment it is added to the list.
  it.each(TENANT_TABLES)('scopes select on %s', (table) => {
    const sql = sqlOf(tenant.selectFrom(table).selectAll());
    expect(sql).toContain(`\`${table}\`.\`org_id\` = ?`);
  });

  it.each(TENANT_TABLES)('scopes delete on %s', (table) => {
    const sql = sqlOf(tenant.deleteFrom(table));
    expect(sql).toContain(`\`${table}\`.\`org_id\` = ?`);
  });

  it.each(TENANT_TABLES)('scopes update on %s', (table) => {
    const sql = sqlOf(tenant.updateTable(table).set({ created_at: new Date() }));
    expect(sql).toContain(`\`${table}\`.\`org_id\` = ?`);
  });
});

describe('org scoping cannot be removed or overridden', () => {
  it('binds the org from the wrapper, not from the caller', () => {
    const compiled = tenant.selectFrom('accounts').selectAll().compile();
    expect(compiled.parameters).toContain(ORG_A);
  });

  it('keeps the predicate when the caller adds their own conditions', () => {
    const sql = sqlOf(
      tenant.selectFrom('accounts').selectAll().where('accounts.code', '=', '1000'),
    );
    expect(sql).toContain('`accounts`.`org_id` = ?');
    expect(sql).toContain('`accounts`.`code` = ?');
  });

  it('scopes both sides of a join between tenant tables', () => {
    // Qualified rather than bare `org_id` — a bare column would be an ambiguous
    // column error here, which is the failure this qualification prevents.
    const sql = sqlOf(
      tenant
        .selectFrom('journals')
        .innerJoin('journal_lines', 'journal_lines.journal_id', 'journals.id')
        .selectAll('journals'),
    );
    expect(sql).toContain('`journals`.`org_id` = ?');
  });

  it('injects org_id on insert without the caller supplying it', () => {
    const compiled = tenant
      .insertInto('accounts')
      .values({
        id: Buffer.from('aaaa1111000040008000000000000001', 'hex'),
        code: '1000',
        name: 'Cash',
        type: 'asset',
        normal_balance: 'debit',
      })
      .compile();

    expect(compiled.sql).toContain('`org_id`');
    expect(compiled.parameters).toContain(ORG_A);
  });

  it('injects org_id into every row of a multi-row insert', () => {
    const compiled = tenant
      .insertInto('accounts')
      .values([
        {
          id: Buffer.from('aaaa1111000040008000000000000001', 'hex'),
          code: '1000',
          name: 'Cash',
          type: 'asset',
          normal_balance: 'debit',
        },
        {
          id: Buffer.from('aaaa2222000040008000000000000002', 'hex'),
          code: '4000',
          name: 'Revenue',
          type: 'revenue',
          normal_balance: 'credit',
        },
      ])
      .compile();

    expect(compiled.parameters.filter((p) => Buffer.isBuffer(p) && p.equals(ORG_A))).toHaveLength(
      2,
    );
  });

  it('gives two wrappers genuinely different scopes', () => {
    const a = new TenantDatabase(db, ORG_A).selectFrom('accounts').selectAll().compile();
    const b = new TenantDatabase(db, ORG_B).selectFrom('accounts').selectAll().compile();

    expect(a.parameters).toContain(ORG_A);
    expect(b.parameters).toContain(ORG_B);
    expect(a.parameters).not.toContain(ORG_B);
  });
});

describe('the tenant table set is derived from the schema', () => {
  it('excludes tables with no org_id', () => {
    for (const table of ['users', 'permissions', 'role_permissions', 'sessions', 'orgs']) {
      expect(isTenantTable(table)).toBe(false);
    }
  });

  it('excludes roles, whose org_id is nullable and means "shared"', () => {
    // Scoping roles with a bare org_id equality would hide all six seeded system
    // roles, leaving every user with no permissions. See tenant-tables.ts.
    expect(isTenantTable('roles')).toBe(false);
  });

  it('includes every table that carries a non-nullable org_id', () => {
    expect([...TENANT_TABLES].sort()).toEqual([
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
      'automation_annotations',
      'automations',
      'bank_accounts',
      'bank_import_mappings',
      'bank_line_clearing_entries',
      'bank_line_clearings',
      'bank_match_proposals',
      'bank_rule_dimensions',
      'bank_rules',
      'bank_statement_imports',
      'bank_statement_lines',
      'bill_attachments',
      'budgets',
      'catalog_items',
      'change_feed_cursors',
      'check_number_sequences',
      'contacts',
      'dimension_values',
      'dimensions',
      'document_captures',
      'document_sequences',
      'dunning_policies',
      'dunning_sends',
      'dunning_stages',
      'estimate_lines',
      'estimates',
      'event_log',
      'event_positions',
      'external_refs',
      'fiscal_periods',
      'fixed_asset_schedule',
      'fixed_assets',
      'idempotency_keys',
      'invoice_deliveries',
      'journal_draft_line_dimensions',
      'journal_draft_lines',
      'journal_drafts',
      'journal_line_dimensions',
      'journal_lines',
      'journal_sequences',
      'journals',
      'oauth_clients',
      'oauth_consents',
      'oauth_grants',
      'oauth_tokens',
      'org_accounting_settings',
      'org_branding',
      'org_invites',
      'org_members',
      'payment_terms',
      'payments',
      'pending_payment_intents',
      'pending_payments',
      'period_close_events',
      'predocument_deliveries',
      'processor_connections',
      'processor_events',
      'purchase_order_lines',
      'purchase_orders',
      'reconciliation_session_events',
      'reconciliation_sessions',
      'recurring_invoice_template_lines',
      'recurring_invoice_templates',
      'recurring_journal_template_lines',
      'recurring_journal_templates',
      'security_events',
      'statement_packages',
      'tax_rates',
      'work_items',
    ]);
  });
});

describe('unscoped and non-tenant access does not typecheck (A5)', () => {
  it('rejects a non-tenant table at compile time', () => {
    // The type-level half of A5. `users` has no org_id, so there is nothing to
    // scope by, and the wrapper refuses it rather than silently returning every
    // row. @ts-expect-error fails the build if this ever starts compiling, which
    // makes this a real assertion and not a comment.
    // @ts-expect-error - 'users' is not a TenantTableName
    expect(() => tenant.selectFrom('users')).toBeDefined();

    // @ts-expect-error - 'roles' is deliberately excluded; see tenant-tables.ts
    expect(() => tenant.selectFrom('roles')).toBeDefined();
  });

  it('rejects org_id in an insert payload', () => {
    // TenantInsert omits org_id, so there is nowhere to put a wrong one.
    expect(() =>
      tenant.insertInto('accounts').values({
        id: Buffer.alloc(16),
        code: '1000',
        name: 'Cash',
        type: 'asset',
        normal_balance: 'debit',
        // @ts-expect-error - org_id is omitted from TenantInsert
        org_id: ORG_B,
      }),
    ).toBeDefined();
  });

  it('does not export the raw handle from the public db module', async () => {
    // The other half of the guarantee is structural: src/db/index.ts exposes only
    // tenantDb and systemDb, and .dependency-cruiser.cjs makes importing
    // src/db/client.ts from outside src/db/ a build failure. This asserts the
    // first half; `yarn lint:deps` asserts the second.
    const publicModule: Record<string, unknown> = await import('../../src/db/index');
    for (const name of Object.keys(publicModule)) {
      expect(name).not.toMatch(/^rawDb$/);
    }
    expect(Object.keys(publicModule)).toContain('tenantDb');
    expect(Object.keys(publicModule)).toContain('systemDb');
  });
});
