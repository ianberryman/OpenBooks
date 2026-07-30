import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything Q1/Q2/Q3/Q9 ask of `/v1/automations` (ROADMAP D-99, D-100, D-119).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand —
 * `recurring-invoices/queries.ts`'s reason: there is no hand-written mirror of a wire shape
 * anywhere in this package, and one would be a second contract the day either drifts.
 *
 * Self-contained, following `dunning/queries.ts`: no screen folder imports another's, and
 * the org switch already clears the query cache wholesale (`src/query/client.ts`).
 *
 * ## What this module does not do
 *
 * It never calls a model and it never writes a `journal_drafts` row. An `agent_task` action
 * enqueues a work item — `screens/work-items/queries.ts` is the front end for that queue,
 * and a proposal a human turns into a posting is reviewed on `screens/agent-proposals.tsx`,
 * not here (D-100, D-119).
 */

export type Automation = components['schemas']['Automation'];
export type AutomationPage = components['schemas']['AutomationPage'];
export type AutomationTrigger = components['schemas']['AutomationTrigger'];
export type AutomationTriggerType = AutomationTrigger['type'];
export type AutomationScheduleCadence = Extract<
  AutomationTrigger,
  { type: 'scheduled' }
>['cadence'];
export type AutomationAction = components['schemas']['AutomationAction'];
export type CreateAutomationRequest = components['schemas']['CreateAutomationRequestInput'];
export type UpdateAutomationRequest = components['schemas']['UpdateAutomationRequestInput'];
export type AutomationRunResult = components['schemas']['AutomationRunResult'];

/**
 * Automations top out in the tens or low hundreds for any real org — `dunning/queries.ts`'s
 * bound for the same shape of list (a policy table, not a document ledger) — so one page is
 * every page.
 */
const PAGE_LIMIT = 200;

export const automationsKeys = {
  list: ['automations', 'list'] as const,
};

export function useAutomationList(): UseQueryResult<AutomationPage, Error> {
  return useQuery({
    queryKey: automationsKeys.list,
    queryFn: async () =>
      unwrap(await api.GET('/v1/automations', { params: { query: { limit: PAGE_LIMIT } } })),
  });
}

/**
 * One idempotency key per user intent, and an intent is identified by what it would write —
 * `recurring-invoices/queries.ts`'s `useIntentKey`, copied rather than imported for the same
 * self-containment reason.
 */
export function useIntentKey(): (intent: string) => string {
  const held = useRef<{ intent: string; key: string } | null>(null);

  return (intent: string): string => {
    const current = held.current;
    if (current !== null && current.intent === intent) return current.key;

    const key = newIdempotencyKey();
    held.current = { intent, key };
    return key;
  };
}

async function invalidateAutomations(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: automationsKeys.list });
}

export function useCreateAutomation(): UseMutationResult<
  Automation,
  Error,
  IdempotentVariables<CreateAutomationRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateAutomationRequest>) =>
      unwrap(
        await api.POST('/v1/automations', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAutomations(queryClient);
    },
  });
}

export interface UpdateAutomationVariables {
  readonly automationId: string;
  readonly patch: UpdateAutomationRequest;
}

export function useUpdateAutomation(): UseMutationResult<
  Automation,
  Error,
  IdempotentVariables<UpdateAutomationVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ automationId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/automations/{automationId}', {
          body: patch,
          params: { path: { automationId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAutomations(queryClient);
    },
  });
}

/**
 * Activate and deactivate — `workflows.activate`-gated on the server and owner-only, the
 * separate compose-vs-activate split `UpdateAutomationRequest`'s own comment describes: a
 * caller holding only `workflows.write` cannot enable their own automation. Both are
 * idempotent (`activateAutomation`/`deactivateAutomation`'s own descriptions), so a caller
 * without the permission meets the refusal as an ordinary `permission_denied` `ErrorBanner`
 * rather than a control this screen hides (D-25) — `screens/automations.tsx`'s own note.
 */
export function useActivateAutomation(): UseMutationResult<
  Automation,
  Error,
  IdempotentVariables<{ readonly automationId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ automationId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/automations/{automationId}/activate', {
          params: { path: { automationId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAutomations(queryClient);
    },
  });
}

export function useDeactivateAutomation(): UseMutationResult<
  Automation,
  Error,
  IdempotentVariables<{ readonly automationId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ automationId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/automations/{automationId}/deactivate', {
          params: { path: { automationId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAutomations(queryClient);
    },
  });
}

/**
 * Fires an automation once, on demand — the same `workflows.activate` gate as activate/
 * deactivate. Returns what the firing produced (`AutomationRunResult`), not the automation
 * itself, but the list is invalidated anyway rather than left to assume `lastFiredRunDate`
 * is unaffected: `runAutomation`'s own description says nothing either way about a manual
 * fire touching that field, and a stale "last fired" date is cheap to guard against and
 * expensive to explain.
 */
export function useRunAutomation(): UseMutationResult<
  AutomationRunResult,
  Error,
  IdempotentVariables<{ readonly automationId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ automationId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/automations/{automationId}/run', {
          params: { path: { automationId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAutomations(queryClient);
    },
  });
}
