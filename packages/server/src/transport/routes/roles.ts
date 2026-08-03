import {
  assignableRoleSchema,
  createRoleRequestSchema,
  permissionCatalogSchema,
  roleDetailSchema,
  updateRoleRequestSchema,
} from '@openbooks/shared-types';
import type { AssignableRole, PermissionCatalog, RoleDetail } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  createRole,
  deleteRole,
  getPermissionCatalog,
  getRoleDetail,
  updateRole,
} from '../../modules/roles';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  ORG_SCOPED_WRITE_HOOKS,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/permissions`, `/v1/roles/{roleId}` — the custom-role editor's authoring
 * surface (OB-226; spec §5's v2 role editor).
 *
 * ## Why the read half is split from `members.ts`
 *
 * `GET /v1/roles` (the assignable-role list a picker renders) and `GET /v1/roles/
 * {roleId}` (the full detail an editor prefills from) look like the same
 * resource and are not the same read: OB-040 already shipped the list, gated on
 * `roles.read`, and it stays in `members.ts` because moving it here for no
 * behavioural reason would be a diff an unrelated ticket has to review. This file
 * owns everything OB-226 adds — the catalog and the authoring verbs — and calls
 * the same `roles.read`/`roles.write` keys the list already established.
 *
 * ## The three refusals this file does not implement, and must not
 *
 * An unknown permission key, a duplicate role name, and "this role is still
 * assigned" are all decided in `roles.service.ts`, under the transaction that
 * makes each one true rather than merely likely (spec §2.4, §5). A route that
 * pre-checked any of them would be a second answer that can disagree with the
 * first.
 */

const TAG = 'Roles';

const roleParamsSchema = z.strictObject({ roleId: z.uuid() });

export function registerRoleRoutes(app: App): void {
  app.get(
    '/v1/permissions',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getPermissionCatalog',
        summary: 'List every permission a custom role may include',
        description:
          'Takes `roles.read`. `group` is the key prefix before the dot, so a role-builder ' +
          'checklist can section itself without a second source of grouping. Sorted by group ' +
          'then code, so the body is stable across calls.',
        tags: [TAG],
        response: { 200: permissionCatalogSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<PermissionCatalog> => ({
      permissions: wireList(await getPermissionCatalog(getContext())),
    }),
  );

  app.get(
    '/v1/roles/:roleId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getRole',
        summary: 'Read a role and the permissions it grants',
        description:
          'Takes `roles.read`. Resolves a system role as well as a custom one, so an editor can ' +
          'show what a seeded role like Bookkeeper grants without being able to change it — ' +
          '`isSystem` is what tells the two apart. A role belonging to another org answers the ' +
          'same `not_found` as one that does not exist (A7).',
        tags: [TAG],
        params: roleParamsSchema,
        response: { 200: roleDetailSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<RoleDetail> => {
      const { roleId } = request.params;
      return getRoleDetail(roleId, getContext());
    },
  );

  app.post(
    '/v1/roles',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createRole',
        summary: 'Create a custom role in this organization',
        description:
          'Takes `roles.write`. `code` is minted from `name` and never resubmitted — it is a ' +
          'slug, unique per org, and stable once created. The full permission catalog is ' +
          'authorable with no key excluded: an org is entitled to combine its own permissions ' +
          'however it chooses.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createRoleRequestSchema,
        response: { 201: assignableRoleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createRole', request: request.body, successStatus: 201 },
        () => createRole(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<AssignableRole>(result));
    },
  );

  app.patch(
    '/v1/roles/:roleId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateRole',
        summary: 'Replace a custom role’s name, description, and permission set',
        description:
          'Takes `roles.write`. The permission set is replaced in full, not diffed against the ' +
          'stored one — the body is the role’s whole intended bundle. Refused on a system role or ' +
          'another org’s role with `not_found` (A7); `code` cannot be changed here.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: roleParamsSchema,
        body: updateRoleRequestSchema,
        response: { 200: assignableRoleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { roleId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'updateRole', request: { roleId, ...request.body }, successStatus: 200 },
        () => updateRole(roleId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<AssignableRole>(result));
    },
  );

  app.delete(
    '/v1/roles/:roleId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteRole',
        summary: 'Delete a custom role',
        description:
          'Takes `roles.write`. Refused with `conflict` while any member or pending invitation ' +
          'still names the role — remove or re-role them first. Refused with `not_found` on a ' +
          'system role or another org’s role (A7).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: roleParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { roleId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteRole', request: { roleId }, successStatus: 204 },
        () => deleteRole(roleId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
