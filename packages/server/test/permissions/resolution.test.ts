import { describe, expect, it } from 'vitest';

import { PermissionDeniedError, toWireError } from '../../src/errors';
import {
  hasPermission,
  permissionsForContext,
  requirePermission,
  resolveMembership,
} from '../../src/modules/permissions';
import { bufferToUuid, newUuid, newUuidBuffer, SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import type { SystemRoleName } from '../db';
import { contextFor, useServiceDatabase } from './support';

/**
 * Role → permission resolution and `requirePermission` (spec §5).
 *
 * Everything here runs against the migrated container, because the property under
 * test is a property of the seeds: the six system roles are defined in
 * `0001_tenancy.ts` as set operations over the catalog, so their bundles exist
 * nowhere in TypeScript to assert against.
 */

/**
 * What each seeded role should resolve to, derived by hand from the set operations
 * in `0001_tenancy.ts` and asserted against the database rather than instead of it.
 *
 * Both halves are checked below: the resolved set size, and `role_permissions`'
 * own row count. If the two agree with each other but disagree with this table,
 * the seeds changed and the change needs a reason — not a new number here.
 */
const EXPECTED_PERMISSION_COUNTS: ReadonlyArray<readonly [SystemRoleName, number]> = [
  // The entire catalog (78 since OB-226 added roles.write, atop OB-224's
  // inventory.read/inventory.write which took it to 77).
  ['owner', 78],
  // Everything except organization administration: orgs.write, members.write,
  // api_keys.*, integrations.write, processing.write, workflows.activate,
  // disbursements.issue (D-109 — the Pay Bills release key is owner-only), and now
  // banking.connect (OB-227 — connecting a live feed stores a credential) — nine
  // exclusions, so the count holds at 66 even as the catalog grew to 75 (OB-228's
  // ten99.read/write are not administration exclusions, so both are granted). Gains branding.read, branding.write and invoices.send (INV),
  // processing.read (PAY), pending_payments.read/write (PB — the queue keys),
  // recurring_journals.read/write + fixed_assets.read/write (L — no SoD, D-117), and
  // procure-to-pay's purchase_orders.read/write, estimates.read/write and
  // expenses.read/write/approve (M — all seven, none excluded), and N's
  // budgets.read/write (both — the catch-all grants them, no SoD gate to withhold),
  // and P's audit.read (the catch-all grants it — not an administration exclusion), and
  // CAT's catalog.read/write (both — neither is an administration exclusion), and now
  // OB-224's inventory.read/write (both — a stock adjustment is bookkeeping, not
  // administration, so the catch-all grants the pair): 66 → 68. OB-226 adds roles.write
  // to the catalog *and* to the administration exclusions (D-226-5 — composing roles is
  // owner-only), so the count holds at 68 as the catalog grows to 78.
  ['bookkeeper', 68],
  // Every `.read` except api_keys.read (28, now including branding.read,
  // processing.read, pending_payments.read, recurring_journals.read, fixed_assets.read,
  // M's purchase_orders.read/estimates.read/expenses.read, and N's budgets.read via
  // `%.read`), plus agents.review, journals.post, and expenses.approve (M — the approver
  // is the expense-approval gate, the disbursements.issue split applied to expenses),
  // and P's audit.read via `%.read`, and CAT's catalog.read via `%.read` (not
  // catalog.write — the approver reads the catalog but does not maintain it), and OB-228's
  // ten99.read via `%.read` (not ten99.write — the approver reads but does not file),
  // and OB-224's inventory.read via `%.read` (not inventory.write): 34 → 35.
  ['approver', 35],
  // Every `.read` except api_keys.read (now including branding.read, processing.read,
  // pending_payments.read, recurring_journals.read, fixed_assets.read, M's
  // purchase_orders.read/estimates.read/expenses.read, N's budgets.read, P's
  // audit.read, CAT's catalog.read, OB-228's ten99.read, and OB-224's inventory.read):
  // 31 → 32.
  ['readOnly', 32],
  // Accountant (P, D-96): readOnly's read bundle (31, `%.read` minus api_keys.read,
  // audit.read, catalog.read and ten99.read included) plus journals.post/journals.reverse,
  // periods.close/periods.reopen, and OB-228's ten99.write (D-228-6 — 1099 filing is an
  // accountant's job) — the capabilities that make it an accountant rather than a reader
  // (reports.read is already in the read bundle). Now +1 for OB-224's inventory.read via
  // `%.read` (not inventory.write — a stock adjustment is not an accountant's act): 36 → 37.
  ['accountant', 37],
  // 15 document/read codes plus journals.post and journals.reverse (OB-093), the Pay
  // Bills queue keys pending_payments.read/write (D-109 — the AP clerk builds the queue
  // but cannot issue), and M's purchase_orders.read/write + expenses.read/write (raise
  // POs, enter expenses; expenses.approve withheld — the SoD split), and CAT's
  // catalog.read/write (pick and inline-add purchase items while entering a bill/PO),
  // so a clerk can finish — approve, void, pay, queue — the documents they enter.
  ['apOnly', 25],
  // The AR mirror of apOnly, plus invoices.send (INV) so a clerk can send the invoices
  // they raise, M's estimates.read/write (the sales pre-document), and CAT's
  // catalog.read/write (inline-add sales items while entering an invoice/estimate).
  ['arOnly', 22],
];

describe('the six system roles resolve to the bundles migration 0001 gives them', () => {
  const db = useServiceDatabase();

  it.each(EXPECTED_PERMISSION_COUNTS)('%s carries %i permissions', async (role, expected) => {
    const org = await db.factories.org();
    const user = await db.factories.user();
    await db.factories.orgMember({ orgId: org.id, userId: user.id, role });

    const resolved = await permissionsForContext(
      contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    );

    const seeded = await db.app
      .selectFrom('role_permissions')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('role_id', '=', systemRoleId(role))
      .executeTakeFirstOrThrow();

    expect(Number(seeded.count)).toBe(expected);
    expect(resolved.size).toBe(expected);
  });

  it('gives Owner the whole catalog and Read-only none of the writes', async () => {
    const org = await db.factories.org();
    const user = await db.factories.user();

    const owner = await permissionsForContext(
      contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid),
    );
    const readOnly = await permissionsForContext(
      contextFor(org.uuid, SYSTEM_ROLE_UUIDS.readOnly, user.uuid),
    );

    expect(owner.has('journals.post')).toBe(true);
    expect(owner.has('api_keys.write')).toBe(true);
    expect(readOnly.has('journals.read')).toBe(true);
    expect(readOnly.has('journals.post')).toBe(false);
    // Spec §5's Read-only/Accountant sees the books, not the credentials.
    expect(readOnly.has('api_keys.read')).toBe(false);
  });
});

describe('roles.org_id IS NULL means "shared by every org"', () => {
  const db = useServiceDatabase();

  it('resolves a system role even though its org_id is NULL', async () => {
    // This is the regression the whole `org_id = ? OR org_id IS NULL` predicate
    // exists for. A bare `org_id = ?` matches nothing here — MySQL's `NULL = x` is
    // NULL, never true — and the symptom is not an error but every user in the
    // system holding no permissions at all. See tenant-tables.ts.
    const role = await db.app
      .selectFrom('roles')
      .select(['org_id', 'is_system'])
      .where('id', '=', systemRoleId('bookkeeper'))
      .executeTakeFirstOrThrow();

    expect(role.org_id).toBeNull();
    expect(role.is_system).toBe(1);

    const org = await db.factories.org();
    const resolved = await permissionsForContext(
      contextFor(org.uuid, SYSTEM_ROLE_UUIDS.bookkeeper, newUuid()),
    );

    expect(resolved.size).toBeGreaterThan(0);
    expect(resolved.has('journals.post')).toBe(true);
  });

  it('resolves the same system role identically for two unrelated orgs', async () => {
    const [orgA, orgB] = await Promise.all([db.factories.org(), db.factories.org()]);

    const a = await permissionsForContext(
      contextFor(orgA.uuid, SYSTEM_ROLE_UUIDS.apOnly, newUuid()),
    );
    const b = await permissionsForContext(
      contextFor(orgB.uuid, SYSTEM_ROLE_UUIDS.apOnly, newUuid()),
    );

    expect([...a].sort()).toEqual([...b].sort());
  });

  it('keeps a custom role inside its own org', async () => {
    // The other half of the predicate. `IS NULL` admits the shared roles; the
    // `org_id = ?` half is what stops a role id from another org resolving here.
    // Spec §5 defers the custom-role editor to v2; the schema supports it now, so
    // the isolation has to hold now.
    const [orgA, orgB] = await Promise.all([db.factories.org(), db.factories.org()]);
    const roleId = newUuidBuffer();

    await db.app
      .insertInto('roles')
      .values({
        id: roleId,
        org_id: orgA.id,
        code: 'custom_payables',
        name: 'Custom Payables',
        description: 'Test-only custom role.',
        is_system: 0,
      })
      .execute();
    await db.app
      .insertInto('role_permissions')
      .values([
        { role_id: roleId, permission_code: 'bills.read' },
        { role_id: roleId, permission_code: 'bills.write' },
      ])
      .execute();

    const roleUuid = bufferToUuid(roleId);
    const inOwnOrg = await permissionsForContext(contextFor(orgA.uuid, roleUuid, newUuid()));
    const inOtherOrg = await permissionsForContext(contextFor(orgB.uuid, roleUuid, newUuid()));

    expect([...inOwnOrg].sort()).toEqual(['bills.read', 'bills.write']);
    expect(inOtherOrg.size).toBe(0);
  });
});

describe('requirePermission', () => {
  const db = useServiceDatabase();

  it('resolves for a role that carries the permission', async () => {
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, newUuid());

    await expect(requirePermission(ctx, 'journals.post')).resolves.toBeUndefined();
    expect(await hasPermission(ctx, 'journals.post')).toBe(true);
  });

  it('throws PermissionDeniedError for a role that does not', async () => {
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.readOnly, newUuid());

    await expect(requirePermission(ctx, 'journals.post')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(await hasPermission(ctx, 'journals.post')).toBe(false);
  });

  it('names the permission and nothing else (A7)', async () => {
    // A 403 is a statement about the caller. The moment it can name an object it is
    // an existence oracle — see the A7 commentary in src/errors/errors.ts, which is
    // why PermissionDeniedError's constructor takes a permission key and has no
    // channel for an id.
    const org = await db.factories.org();
    const user = await db.factories.user();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.readOnly, user.uuid);

    const thrown = await requirePermission(ctx, 'journals.post').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PermissionDeniedError);
    const wire = toWireError(thrown);

    expect(wire.code).toBe('permission_denied');
    expect(wire.status).toBe(403);
    expect(wire.details).toEqual({ permission: 'journals.post' });
    expect(Object.keys(wire.details ?? {})).toEqual(['permission']);

    // Nothing identifying the caller or any object reaches the payload.
    const serialized = JSON.stringify(wire);
    for (const identifier of [org.uuid, user.uuid, SYSTEM_ROLE_UUIDS.readOnly, ctx.requestId]) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it('denies when the role id names no row at all', async () => {
    // Fail closed. A role deleted under a live session, or a context built from a
    // stale value, must not resolve to "no restrictions".
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, newUuid(), newUuid());

    expect((await permissionsForContext(ctx)).size).toBe(0);
    await expect(requirePermission(ctx, 'accounts.read')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe('membership resolution', () => {
  const db = useServiceDatabase();

  it('produces the role and its permissions for a member', async () => {
    const org = await db.factories.org();
    const user = await db.factories.user();
    await db.factories.orgMember({ orgId: org.id, userId: user.id, role: 'approver' });

    const resolution = await resolveMembership(user.uuid, org.uuid);

    expect(resolution.isMember).toBe(true);
    if (!resolution.isMember) return;
    expect(resolution.roleId).toBe(SYSTEM_ROLE_UUIDS.approver);
    expect(resolution.roleCode).toBe('approver');
    // 35 since OB-224: the `%.read` bundle now also picks up `inventory.read` (34 after
    // OB-228's `ten99.read`, itself after CAT's `catalog.read`, P's `audit.read`, N's
    // `budgets.read`, and M's `purchase_orders.read`/`estimates.read`/`expenses.read` plus
    // the approver's `expenses.approve`).
    expect(resolution.permissions.size).toBe(35);
    expect(resolution.permissions.has('agents.review')).toBe(true);
  });

  it('gives one login a different role in each org (spec §5)', async () => {
    // The many-to-many is the whole reason a role cannot be cached against a user
    // or a session: an accountant is Owner of their own books and Read-only on a
    // client's, in the same login.
    const user = await db.factories.user();
    const [ownBooks, client] = await Promise.all([db.factories.org(), db.factories.org()]);
    await db.factories.orgMember({ orgId: ownBooks.id, userId: user.id, role: 'owner' });
    await db.factories.orgMember({ orgId: client.id, userId: user.id, role: 'readOnly' });

    const asOwner = await resolveMembership(user.uuid, ownBooks.uuid);
    const asAccountant = await resolveMembership(user.uuid, client.uuid);

    expect(asOwner.isMember && asOwner.roleCode).toBe('owner');
    expect(asAccountant.isMember && asAccountant.roleCode).toBe('read_only');
    expect(asOwner.isMember && asOwner.permissions.has('journals.post')).toBe(true);
    expect(asAccountant.isMember && asAccountant.permissions.has('journals.post')).toBe(false);
  });

  it('reports a clean non-membership rather than throwing', async () => {
    const user = await db.factories.user();
    const org = await db.factories.org();

    expect(await resolveMembership(user.uuid, org.uuid)).toEqual({ isMember: false });
  });

  it('answers a non-existent org exactly as it answers a real one (A7)', async () => {
    // `sessions.active_org_id` is a hint that is re-validated here (see the sessions
    // commentary in 0001_tenancy.ts). "Removed from that org" and "no such org" have
    // to be one answer, or the org switcher becomes an existence oracle.
    const user = await db.factories.user();
    const realOrgTheyLeft = await db.factories.org();

    expect(await resolveMembership(user.uuid, realOrgTheyLeft.uuid)).toEqual({ isMember: false });
    expect(await resolveMembership(user.uuid, newUuid())).toEqual({ isMember: false });
    // A malformed id is the same answer again, not a 500 — the org can be
    // client-supplied at an org switch.
    expect(await resolveMembership(user.uuid, 'not-a-uuid')).toEqual({ isMember: false });
    expect(await resolveMembership('not-a-uuid', realOrgTheyLeft.uuid)).toEqual({
      isMember: false,
    });
  });

  it('distinguishes a member holding an empty role from a non-member', async () => {
    // The LEFT JOIN in selectMembershipRole. Both cases would be an empty result set
    // under an inner join, and they must not collapse: the first owes the caller a
    // 403 on everything, the second owes them a 404.
    const org = await db.factories.org();
    const user = await db.factories.user();
    const roleId = newUuidBuffer();

    await db.app
      .insertInto('roles')
      .values({
        id: roleId,
        org_id: org.id,
        code: 'grants_nothing',
        name: 'Grants Nothing',
        description: 'Test-only custom role with an empty bundle.',
        is_system: 0,
      })
      .execute();
    await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId });

    const resolution = await resolveMembership(user.uuid, org.uuid);

    expect(resolution.isMember).toBe(true);
    if (!resolution.isMember) return;
    expect(resolution.roleCode).toBe('grants_nothing');
    expect(resolution.permissions.size).toBe(0);
  });
});
