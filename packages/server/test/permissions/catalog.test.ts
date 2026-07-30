import { describe, expect, it } from 'vitest';

import {
  isPermissionKey,
  PERMISSION_KEYS,
  selectCatalogCodes,
  type PermissionKey,
} from '../../src/modules/permissions';
import { useServiceDatabase } from './support';

/**
 * The catalog union against the seeded table (spec §5).
 *
 * This is the test that makes `catalog.ts` safe to hand-maintain. The union cannot
 * be derived — `permissions.code` is `VARCHAR(64)`, so the generated schema types it
 * as `string` — so the guarantee has to be a test, and it has to run against a
 * database that was migrated by the real migrator, which is what the harness
 * provides.
 *
 * Both directions are asserted separately rather than as one set comparison, because
 * they fail for different reasons and the message should say which:
 *
 *  - Seeded but not declared: a permission no service can ever check, because
 *    `requirePermission` will not accept the string.
 *  - Declared but not seeded: a `requirePermission` call that compiles and can never
 *    pass, because `role_permissions.permission_code` has a foreign key into
 *    `permissions` and so no role can hold a code that table does not contain.
 */
describe('the permission catalog and the seeded table agree', () => {
  const db = useServiceDatabase();

  it('declares every code the database seeds', async () => {
    const declared = new Set<string>(PERMISSION_KEYS);
    const seeded = await selectCatalogCodes();

    expect(seeded.filter((code) => !declared.has(code))).toEqual([]);
  });

  it('declares no code the database does not seed', async () => {
    const seeded = new Set(await selectCatalogCodes());

    expect(PERMISSION_KEYS.filter((code) => !seeded.has(code))).toEqual([]);
  });

  it('has 70 codes, the number migration 0001 seeds', async () => {
    // Pinned in both places on purpose. `_CatalogSize` in catalog.ts fails the
    // build if the array changes length; this fails the suite if the migration
    // does. Neither alone catches a coordinated-looking edit to one side.
    // 53 → 56: Pay Bills added pending_payments.read/write and disbursements.issue (D-109).
    // 56 → 60: Fixed assets & recurring journals added recurring_journals.read/write and
    // fixed_assets.read/write (D-117).
    // 60 → 67: Procure-to-pay added purchase_orders.read/write, estimates.read/write, and
    // expenses.read/write/approve (M, D-M2).
    // 67 → 69: Budgets added budgets.read/write (N, D-N6).
    // 69 → 70: Accountant access & period close added audit.read (P, D-98).
    expect(await selectCatalogCodes()).toHaveLength(70);
    expect(PERMISSION_KEYS).toHaveLength(70);
  });

  it('lists no code twice', async () => {
    // A duplicate in the array would make the set equality above pass while
    // `PERMISSION_KEYS.length` and the real catalog size disagreed.
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);

    const seeded = await selectCatalogCodes();
    expect(new Set(seeded).size).toBe(seeded.length);
  });

  it('reads the same rows through the harness handle', async () => {
    // `selectCatalogCodes()` goes through `systemDb()` — the process handle
    // support.ts points at the app user — while the harness has its own pool. This
    // pins that the two are looking at one database, so a drift failure above
    // cannot be an artifact of the service reading somewhere else entirely.
    const throughHarness = await db.app.selectFrom('permissions').select('code').execute();

    expect(throughHarness.map((row) => row.code).sort()).toEqual(
      [...(await selectCatalogCodes())].sort(),
    );
  });
});

describe('the union rejects what the catalog does not contain', () => {
  it('narrows a string at runtime', () => {
    expect(isPermissionKey('journals.post')).toBe(true);
    expect(isPermissionKey('invoices.write')).toBe(true);
    // A plausible typo, and the exact reason the loose `${string}.${string}` in
    // plugin-api was not good enough: it would have accepted this.
    expect(isPermissionKey('invoice.write')).toBe(false);
    expect(isPermissionKey('journals.delete')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
  });

  it('rejects a non-catalog key at compile time', () => {
    // The type-level half. @ts-expect-error fails the build if this ever starts
    // compiling, which is what makes it an assertion rather than a comment.
    // @ts-expect-error - 'invoice.write' is a typo and not in the catalog
    const _typo: PermissionKey = 'invoice.write';
    // @ts-expect-error - the loose plugin-api shape is no longer sufficient
    const _loose: PermissionKey = 'anything.goes';

    const real: PermissionKey = 'invoices.write';
    expect(isPermissionKey(real)).toBe(true);
  });
});
