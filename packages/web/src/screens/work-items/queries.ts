import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything Q4…Q7 ask of `/v1/work-items` (ROADMAP D-99, D-118).
 *
 * Self-contained, following `bill-captures/queries.ts`: no screen folder imports another's,
 * and the org switch already clears the query cache wholesale (`src/query/client.ts`).
 *
 * ## What this module does not do
 *
 * A work item is leased and submitted only over MCP (`work_queue.poll`,
 * `work_queue.submitProposal`) — this application never leases one and never submits a
 * proposal on its behalf, so there is no mutation here for either. The one write this
 * screen offers is `cancelWorkItem`, withdrawing an item before an agent finishes with it.
 */

export type WorkItem = components['schemas']['WorkItem'];
export type WorkItemPage = components['schemas']['WorkItemPage'];
export type WorkItemStatus = WorkItem['status'];

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const LIST_LIMIT = 100;

export const workItemsKeys = {
  list: (status: WorkItemStatus | null) => ['work-items', 'list', status ?? 'all'] as const,
};

export interface ListResult<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The queue, filterable by status — `bill-captures/queries.ts`'s `useBillCaptures` shape.
 * `status: null` sends no filter and shows every item (`listWorkItems`'s own default),
 * queued through cancelled alike.
 */
export function useWorkItems(status: WorkItemStatus | null): ListResult<WorkItem> {
  const query = useQuery({
    queryKey: workItemsKeys.list(status),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/work-items', {
          params: { query: { limit: LIST_LIMIT, ...(status === null ? {} : { status }) } },
        }),
      ),
  });

  return {
    items: query.data?.items ?? [],
    truncated: query.data?.nextCursor != null,
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

async function invalidateWorkItems(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['work-items', 'list'] });
}

/**
 * Withdraws a queued or leased item so no agent picks it up, or finishes acting on it
 * (`cancelWorkItem`'s own description). Idempotent on the server — an already-cancelled
 * item comes back unchanged rather than refused — so this is safe to send again after a
 * dropped response with the same key.
 */
export function useCancelWorkItem(): UseMutationResult<
  WorkItem,
  Error,
  IdempotentVariables<{ readonly workItemId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workItemId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/work-items/{workItemId}/cancel', {
          params: { path: { workItemId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateWorkItems(queryClient);
    },
  });
}
