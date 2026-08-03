import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * OB-224's two read models and the one write. Types come straight off
 * `components['schemas'][…]` — `fixed-assets/queries.ts`'s reason applies here too: there
 * is no hand-written mirror of a wire shape in this package, and one would be a second
 * contract the day either drifts.
 */
export type InventoryValuation = components['schemas']['InventoryValuation'];
export type InventoryValuationRow = components['schemas']['InventoryValuationRow'];
export type ReorderAlerts = components['schemas']['ReorderAlerts'];
export type ReorderAlert = components['schemas']['ReorderAlert'];
export type InventoryAdjustment = components['schemas']['InventoryAdjustment'];
export type CreateInventoryAdjustmentRequest =
  components['schemas']['CreateInventoryAdjustmentRequestInput'];

/**
 * Query keys, local to this screen — `fixed-assets/queries.ts`'s reason: there is no
 * shared key module, so a second screen changing shape never has to agree with this one
 * about what its keys mean.
 */
const INVENTORY_SCOPE = ['inventory'] as const;

function inventoryValuationQueryKey(asOf: string | null): readonly unknown[] {
  return [...INVENTORY_SCOPE, 'valuation', asOf];
}

const REORDER_ALERTS_QUERY_KEY = [...INVENTORY_SCOPE, 'reorder'] as const;

/** Reserved for a future paged on-hand list; kept alongside the other two so all three
 *  scopes this screen cares about are named in one place. */
export function inventoryListQueryKey(): readonly unknown[] {
  return [...INVENTORY_SCOPE, 'list'];
}

/**
 * The valuation report, `asOf` a given date or (when `null`) the server's default of today
 * — `reports/balance-sheet.tsx`'s `asOf` shape, except optional here: the stock-adjustment
 * form also reads this hook (for its item picker) with no date control of its own, and
 * always wants the current valuation rather than a historical one.
 */
export function useInventoryValuation(
  asOf: string | null,
): UseQueryResult<InventoryValuation, Error> {
  return useQuery({
    queryKey: inventoryValuationQueryKey(asOf),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/reports/inventory-valuation', {
          params: { query: { ...(asOf === null ? {} : { asOf }) } },
        }),
      ),
  });
}

export function useReorderAlerts(): UseQueryResult<ReorderAlerts, Error> {
  return useQuery({
    queryKey: REORDER_ALERTS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/inventory/reorder-alerts')),
  });
}

/**
 * One idempotency key per user intent — `fixed-assets/queries.ts`'s `useIntentKey`, copied
 * rather than imported for the self-containment reason this file's other hooks give. The
 * key is held against a fingerprint of what would be sent, so a retry after a dropped
 * response replays the original outcome and a corrected form gets a fresh key.
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

/**
 * A posted adjustment moves on-hand quantity and value, so both read models this screen
 * shows are stale the instant it succeeds — invalidating the whole `['inventory']` scope
 * rather than naming the two query keys individually keeps this in sync with a future
 * third read model without a second edit here.
 */
export function useCreateInventoryAdjustment(): UseMutationResult<
  InventoryAdjustment,
  Error,
  IdempotentVariables<CreateInventoryAdjustmentRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreateInventoryAdjustmentRequest>) =>
      unwrap(
        await api.POST('/v1/inventory/adjustments', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: INVENTORY_SCOPE });
    },
  });
}
