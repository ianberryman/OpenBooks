import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { api, expectNoContent, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-226 asks of `/v1/roles` and `/v1/permissions` — the custom, per-org role
 * builder.
 *
 * Types come from `components['schemas'][…]` and are never restated by hand — the same
 * reason `api-keys/queries.ts` gives: there is no hand-written mirror of a wire shape
 * anywhere in this package, and one would be a second contract the day either drifts.
 *
 * A system role's permissions are fixed by the product, not by this org, so there is no
 * mutation that targets one — `role-editor.tsx` renders it read-only rather than this
 * module refusing a call the transport would refuse anyway.
 */
export type AssignableRole = components['schemas']['AssignableRole'];
export type AssignableRoleList = components['schemas']['AssignableRoleList'];
export type RoleDetail = components['schemas']['RoleDetail'];
export type PermissionCatalog = components['schemas']['PermissionCatalog'];
export type PermissionCatalogEntry = PermissionCatalog['permissions'][number];
export type CreateRoleRequest = components['schemas']['CreateRoleRequestInput'];
export type UpdateRoleRequest = components['schemas']['UpdateRoleRequestInput'];

const ROLES_SCOPE = ['roles'] as const;
export const ROLES_QUERY_KEY = [...ROLES_SCOPE, 'list'] as const;
const PERMISSIONS_QUERY_KEY = ['permissions', 'catalog'] as const;

export function roleDetailQueryKey(roleId: string): readonly unknown[] {
  return [...ROLES_SCOPE, 'detail', roleId];
}

/** The list source — seeded system roles and this org's custom ones, together. */
export function useRoleList(): UseQueryResult<AssignableRoleList, Error> {
  return useQuery({
    queryKey: ROLES_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/roles')),
  });
}

/**
 * Fetched to prefill the editor. `enabled: false` while `roleId` is `null` (the create
 * case), so opening "New role" never issues a request for an id that does not exist.
 */
export function useRoleDetail(roleId: string | null): UseQueryResult<RoleDetail, Error> {
  return useQuery({
    queryKey: roleDetailQueryKey(roleId ?? ''),
    enabled: roleId !== null,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/roles/{roleId}', {
          // Safe: `enabled` gates this from ever running while `roleId` is `null`.
          params: { path: { roleId: roleId as string } },
        }),
      ),
  });
}

/** The checklist source — every permission this org's roles may be composed from, grouped. */
export function usePermissionCatalog(): UseQueryResult<PermissionCatalog, Error> {
  return useQuery({
    queryKey: PERMISSIONS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/permissions')),
  });
}

function invalidateRoles(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ROLES_SCOPE });
}

export function useCreateRole(): UseMutationResult<
  AssignableRole,
  Error,
  IdempotentVariables<CreateRoleRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateRoleRequest>) =>
      unwrap(
        await api.POST('/v1/roles', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateRoles(queryClient);
    },
  });
}

export function useUpdateRole(): UseMutationResult<
  AssignableRole,
  Error,
  IdempotentVariables<UpdateRoleRequest & { readonly roleId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      roleId,
      ...body
    }: IdempotentVariables<UpdateRoleRequest & { readonly roleId: string }>) =>
      unwrap(
        await api.PATCH('/v1/roles/{roleId}', {
          body,
          params: { path: { roleId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateRoles(queryClient);
    },
  });
}

export function useDeleteRole(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<{ readonly roleId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    // A 204 carries no body, so `unwrap` is the wrong helper — see `expectNoContent`.
    mutationFn: async ({ idempotencyKey, roleId }) =>
      expectNoContent(
        await api.DELETE('/v1/roles/{roleId}', {
          params: { path: { roleId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateRoles(queryClient);
    },
  });
}
