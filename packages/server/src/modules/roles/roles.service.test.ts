import { describe, expect, it } from 'vitest';

import { newUuid, uuidToBuffer } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { hasPermission } from '../permissions';

import { SYSTEM_ROLE_UUIDS } from '../../../test/db';
import { actorIn, contextFor, useServiceDatabase } from '../../../test/members/support';

import { createRole, deleteRole, getRoleDetail, updateRole } from './roles.service';

/**
 * `roles.service.ts` against real MySQL (spec §11 — never a mock).
 *
 * The load-bearing claim these tests exist to prove is not "the row round-trips" —
 * it is that a role this module writes is the *same* role `permissions.repository.ts`
 * resolves at enforcement time. `test/members/support.ts#useServiceDatabase` points
 * the process-wide database handle at the harness container (rather than only the
 * harness's own pool), which is what makes `hasPermission` — reached through
 * `requirePermission`'s production path, not re-implemented here — a statement about
 * this module's writes and not about a second copy of the resolution logic.
 *
 * `hasPermission` memoizes per `RequestContext` object (`permissions.service.ts`), so
 * every assertion below that needs to see a role change takes a *freshly built*
 * context rather than reusing one from before the write — reusing one would prove
 * only that the memo works, which is a different module's test.
 */
const db = useServiceDatabase();

describe('createRole', () => {
  it('creates a non-system role, persisted under the org, holding the given keys', async () => {
    const actor = await actorIn(db, 'owner');

    const role = await createRole(
      {
        name: 'Reception',
        description: 'Reads contacts, writes accounts.',
        permissionKeys: ['contacts.read', 'accounts.write'],
      },
      actor.ctx,
    );

    expect(role.isSystem).toBe(false);
    expect(role.name).toBe('Reception');
    expect(role.code).toBe('reception');

    const row = await db.app
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', uuidToBuffer(role.id))
      .executeTakeFirstOrThrow();
    expect(row.org_id).not.toBeNull();
    expect(row.org_id?.equals(actor.orgId)).toBe(true);
    expect(row.is_system).toBe(0);

    const keys = await db.app
      .selectFrom('role_permissions')
      .select('permission_code')
      .where('role_id', '=', uuidToBuffer(role.id))
      .execute();
    expect(keys.map((k) => k.permission_code).sort()).toEqual(['accounts.write', 'contacts.read']);
  });

  it('refuses a second role with the same name in the same org', async () => {
    const actor = await actorIn(db, 'owner');
    const input = {
      name: 'Duplicate Name',
      description: 'First.',
      permissionKeys: ['contacts.read'],
    };

    await createRole(input, actor.ctx);

    await expect(
      createRole({ ...input, description: 'Second.' }, actor.ctx),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows the full catalog with no key excluded (D-226-4)', async () => {
    const actor = await actorIn(db, 'owner');

    const role = await createRole(
      {
        name: 'Owner-Adjacent',
        description: 'Holds a separation-of-duties key, deliberately.',
        permissionKeys: ['disbursements.issue', 'roles.write'],
      },
      actor.ctx,
    );

    expect(role.isSystem).toBe(false);
  });
});

describe('the DB-driven resolution a custom role produces', () => {
  it('grants exactly the keys the role bundles, nothing more', async () => {
    const actor = await actorIn(db, 'owner');
    const role = await createRole(
      {
        name: 'Custom Clerk',
        description: 'contacts.read + accounts.write only.',
        permissionKeys: ['contacts.read', 'accounts.write'],
      },
      actor.ctx,
    );

    const member = await db.factories.user();
    await db.factories.orgMember({
      orgId: actor.orgId,
      userId: member.id,
      roleId: uuidToBuffer(role.id),
    });
    const memberCtx = contextFor(actor.orgUuid, role.id, member.uuid);

    expect(await hasPermission(memberCtx, 'contacts.read')).toBe(true);
    expect(await hasPermission(memberCtx, 'accounts.write')).toBe(true);
    expect(await hasPermission(memberCtx, 'journals.post')).toBe(false);
  });

  it('updateRole changes what the member may do on the next resolution', async () => {
    const actor = await actorIn(db, 'owner');
    const role = await createRole(
      {
        name: 'Reassigned Clerk',
        description: 'Starts with contacts.read.',
        permissionKeys: ['contacts.read'],
      },
      actor.ctx,
    );

    const member = await db.factories.user();
    await db.factories.orgMember({
      orgId: actor.orgId,
      userId: member.id,
      roleId: uuidToBuffer(role.id),
    });

    const before = contextFor(actor.orgUuid, role.id, member.uuid);
    expect(await hasPermission(before, 'contacts.read')).toBe(true);
    expect(await hasPermission(before, 'journals.post')).toBe(false);

    await updateRole(
      role.id,
      {
        name: 'Reassigned Clerk',
        description: 'Now journals.post instead.',
        permissionKeys: ['journals.post'],
      },
      actor.ctx,
    );

    // A fresh context: `hasPermission` memoizes per context object, so reusing
    // `before` would prove the memo and not the write.
    const after = contextFor(actor.orgUuid, role.id, member.uuid);
    expect(await hasPermission(after, 'journals.post')).toBe(true);
    expect(await hasPermission(after, 'contacts.read')).toBe(false);
  });
});

describe('deleteRole', () => {
  it('refuses while a member holds the role, and succeeds once nobody does', async () => {
    const actor = await actorIn(db, 'owner');
    const role = await createRole(
      { name: 'In Use', description: 'Assigned below.', permissionKeys: ['contacts.read'] },
      actor.ctx,
    );

    const member = await db.factories.user();
    await db.factories.orgMember({
      orgId: actor.orgId,
      userId: member.id,
      roleId: uuidToBuffer(role.id),
    });

    await expect(deleteRole(role.id, actor.ctx)).rejects.toBeInstanceOf(ConflictError);

    await db.app
      .deleteFrom('org_members')
      .where('org_id', '=', actor.orgId)
      .where('user_id', '=', member.id)
      .execute();

    await deleteRole(role.id, actor.ctx);

    await expect(getRoleDetail(role.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses while a pending invite still names the role', async () => {
    const actor = await actorIn(db, 'owner');
    const role = await createRole(
      {
        name: 'Invited Only',
        description: 'Named by an invite, not a member.',
        permissionKeys: [],
      },
      actor.ctx,
    );

    await db.app
      .insertInto('org_invites')
      .values({
        id: uuidToBuffer(newUuid()),
        org_id: actor.orgId,
        email: 'invited@example.test',
        role_id: uuidToBuffer(role.id),
        token_hash: 'x'.repeat(64),
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .execute();

    await expect(deleteRole(role.id, actor.ctx)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('a system role or another org’s role', () => {
  it('is 404, indistinguishably, to update, delete, and read (A7)', async () => {
    const actor = await actorIn(db, 'owner');

    await expect(
      updateRole(
        SYSTEM_ROLE_UUIDS.owner,
        { name: 'Hijacked', description: 'x', permissionKeys: [] },
        actor.ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteRole(SYSTEM_ROLE_UUIDS.owner, actor.ctx)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const other = await actorIn(db, 'owner');
    const otherRole = await createRole(
      { name: 'Belongs To Other Org', description: 'x', permissionKeys: ['contacts.read'] },
      other.ctx,
    );

    await expect(getRoleDetail(otherRole.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateRole(
        otherRole.id,
        { name: 'Hijacked', description: 'x', permissionKeys: [] },
        actor.ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteRole(otherRole.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
  });
});
