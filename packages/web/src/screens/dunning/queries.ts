import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything the dunning screen reads and writes (OB-132; ROADMAP D-13; the OB-129/130
 * dunning engine this screen is the front end for).
 *
 * ## `DunningStage` is not a schema
 *
 * `openapi.json` has no named `DunningStage` component — a stage is an inline array
 * element on `DunningPolicy`, `CreateDunningPolicyRequest` and `UpdateDunningPolicyRequest`
 * alike, so `DunningStage` here is a type *alias* for that element rather than a mirror of
 * a contract that does not exist. If a named schema is added later, this alias starts
 * pointing at it and no call site changes.
 *
 * ## Why there is no `isActive` filter on the list query
 *
 * `GET /v1/dunning-policies` takes no `isActive` parameter, so this hook — unlike
 * `settings/dimensions.tsx`'s axis list, which filters client-side for the same reason —
 * has nothing to filter: the server always returns every policy, active and paused alike,
 * and the screen tells them apart with a `Pill`.
 */

export type DunningPolicy = components['schemas']['DunningPolicy'];
export type DunningStage = DunningPolicy['stages'][number];

export interface CreateDunningPolicyBody {
  readonly name: string;
  readonly stages: readonly DunningStage[];
}

/** Policies top out in the tens for any real org, so one page is every page (the same
 * bound `settings/dimensions.tsx` states for axes, which are smaller still but the same
 * shape of list). */
const PAGE_LIMIT = 200;

export const dunningKeys = {
  policies: ['dunning', 'policies'] as const,
  overdue: (asOf: string) => ['dunning', 'overdue', asOf] as const,
};

export function useDunningPolicies(): UseQueryResult<
  { items: readonly DunningPolicy[]; nextCursor: string | null },
  Error
> {
  return useQuery({
    queryKey: dunningKeys.policies,
    queryFn: async () =>
      unwrap(await api.GET('/v1/dunning-policies', { params: { query: { limit: PAGE_LIMIT } } })),
  });
}

async function invalidatePolicies(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: dunningKeys.policies });
}

export function useCreateDunningPolicy(): UseMutationResult<
  DunningPolicy,
  Error,
  IdempotentVariables<CreateDunningPolicyBody>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      name,
      stages,
    }: IdempotentVariables<CreateDunningPolicyBody>) =>
      unwrap(
        await api.POST('/v1/dunning-policies', {
          body: { name, stages: [...stages] },
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
    },
  });
}

export interface UpdatePolicyVariables {
  readonly policyId: string;
  readonly name: string;
  readonly stages: readonly DunningStage[];
}

/**
 * The full-form edit: name and the whole ladder, replaced together. Kept separate from
 * `useSetDunningPolicyActive` below even though both are a `PATCH` to the same route,
 * because they are different user intents with different idempotency keys — the same
 * reason `dimensions.tsx` keeps `rename` and `setArchived` as two mutations rather than one
 * generic patch.
 */
export function useUpdateDunningPolicy(): UseMutationResult<
  DunningPolicy,
  Error,
  IdempotentVariables<UpdatePolicyVariables>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      policyId,
      name,
      stages,
    }: IdempotentVariables<UpdatePolicyVariables>) =>
      unwrap(
        await api.PATCH('/v1/dunning-policies/{policyId}', {
          body: { name, stages: [...stages] },
          params: { path: { policyId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
    },
  });
}

export interface SetActiveVariables {
  readonly policyId: string;
  readonly isActive: boolean;
}

/** Pause (`isActive: false`) and resume (`isActive: true`) — the quick toggle, not the
 * form. `UpdateDunningPolicyRequest.isActive`'s own description says `POST …/deactivate` is
 * the preferred way to retire a policy and this field exists mainly so a full edit can also
 * flip it; a bare toggle is exactly the "also" case. */
export function useSetDunningPolicyActive(): UseMutationResult<
  DunningPolicy,
  Error,
  IdempotentVariables<SetActiveVariables>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      policyId,
      isActive,
    }: IdempotentVariables<SetActiveVariables>) =>
      unwrap(
        await api.PATCH('/v1/dunning-policies/{policyId}', {
          body: { isActive },
          params: { path: { policyId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
    },
  });
}

/**
 * The dedicated one-way retire (spec: "Prefer `POST …/deactivate`"). Kept as its own
 * mutation and its own confirmed control in `policy-list.tsx` rather than folded into the
 * pause toggle: pausing is reversible by the same click that made it, and deactivating is
 * the deliberate "stop chasing this ladder" action the ticket calls out separately.
 */
export function useDeactivateDunningPolicy(): UseMutationResult<
  DunningPolicy,
  Error,
  IdempotentVariables<{ policyId: string }>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, policyId }: IdempotentVariables<{ policyId: string }>) =>
      unwrap(
        await api.POST('/v1/dunning-policies/{policyId}/deactivate', {
          params: { path: { policyId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
    },
  });
}

/**
 * `YYYY-MM-DD` for today, local time. Duplicated from `sales/document-state.ts` and
 * `money-in/amounts.tsx` rather than imported: each screen is self-contained (`sales/
 * queries.ts`'s header gives the reason — a shared module would make one screen's change
 * another's problem), and this is three lines with nothing to drift.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** One overdue invoice, flattened out of the aging report for the read-only panel. */
export interface OverdueInvoice {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly contactName: string;
  readonly dueDate: string;
  readonly daysPastDue: number;
  readonly outstanding: string;
}

/**
 * The overdue panel's data — the AR aging report, flattened and filtered to what dunning
 * would actually chase.
 *
 * There is no dunning-specific "what's overdue" endpoint; `GET /v1/reports/aging` is the
 * one source for it, and it returns a contact/bucket summary with the open documents
 * nested under `detail=true` (`components['schemas']['Aging']`,
 * `screens/money-in/aging.tsx` renders the same report in full). This hook asks for detail,
 * then keeps only the rows a reminder ladder is for: `invoice` rows (never `bill`,
 * `payment`, `credit_note` or `vendor_credit` — this is receivables, not the whole ledger)
 * that are actually past due (`daysPastDue` positive; `current` and the credit rows, whose
 * `daysPastDue` is null, are dropped). `asOf` is today and is not a control on this panel —
 * unlike the full aging report (D-40), this is "what needs chasing right now", not a
 * reproducible historical statement, so there is nothing to date-pick.
 */
export function useOverdueInvoices(asOf: string): UseQueryResult<readonly OverdueInvoice[], Error> {
  return useQuery({
    queryKey: dunningKeys.overdue(asOf),
    queryFn: async () => {
      const aging = unwrap(
        await api.GET('/v1/reports/aging', {
          params: { query: { asOf, ledger: 'receivable', detail: 'true' } },
        }),
      );

      const overdue: OverdueInvoice[] = [];
      for (const row of aging.rows) {
        for (const document of row.documents ?? []) {
          if (document.documentType !== 'invoice') continue;
          if (document.daysPastDue === null || document.daysPastDue <= 0) continue;
          overdue.push({
            documentId: document.documentId,
            documentNumber: document.documentNumber,
            contactName: row.contactName,
            dueDate: document.dueDate ?? '',
            daysPastDue: document.daysPastDue,
            outstanding: document.outstanding,
          });
        }
      }

      // Furthest overdue first — what a person chasing invoices looks at first.
      return overdue.sort((a, b) => b.daysPastDue - a.daysPastDue);
    },
    enabled: asOf !== '',
  });
}
