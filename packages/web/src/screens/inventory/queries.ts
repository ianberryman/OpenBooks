import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * OB-224's read models and writes. Types come straight off `components['schemas'][…]` —
 * `fixed-assets/queries.ts`'s reason applies here too: there is no hand-written mirror of a
 * wire shape in this package, and one would be a second contract the day either drifts.
 */
export type InventoryValuation = components['schemas']['InventoryValuation'];
export type InventoryValuationRow = components['schemas']['InventoryValuationRow'];
export type ReorderAlerts = components['schemas']['ReorderAlerts'];
export type ReorderAlert = components['schemas']['ReorderAlert'];
export type InventoryAdjustment = components['schemas']['InventoryAdjustment'];
export type CreateInventoryAdjustmentRequest =
  components['schemas']['CreateInventoryAdjustmentRequestInput'];
export type InventoryItemLedger = components['schemas']['InventoryItemLedger'];
export type InventoryLedgerEntry = components['schemas']['InventoryLedgerEntry'];
export type CatalogItem = components['schemas']['CatalogItem'];
export type CreateCatalogItemRequest = components['schemas']['CreateCatalogItemRequestInput'];
export type ControlAccounts = components['schemas']['ControlAccounts'];
export type UpdateControlAccountsRequest =
  components['schemas']['UpdateControlAccountsRequestInput'];
export type Account = components['schemas']['Account'];

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

function itemLedgerQueryKey(itemId: string): readonly unknown[] {
  return [...INVENTORY_SCOPE, 'item', itemId];
}

const INVENTORY_ACCOUNTS_QUERY_KEY = [...INVENTORY_SCOPE, 'accounts'] as const;
const INVENTORY_SETTINGS_QUERY_KEY = [...INVENTORY_SCOPE, 'settings'] as const;

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
 * One item's complete, oldest-first movement ledger — the append-only audit trail behind
 * its current on-hand. The last entry's running totals equal the header's, by construction
 * on the server; nothing here re-folds the deltas to check that.
 */
export function useItemLedger(itemId: string): UseQueryResult<InventoryItemLedger, Error> {
  return useQuery({
    queryKey: itemLedgerQueryKey(itemId),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/inventory/items/{itemId}/movements', {
          params: { path: { itemId } },
        }),
      ),
  });
}

/** `fixed-assets/queries.ts`'s `PAGE_LIMIT`/`MAX_PAGES` bound, copied for the reason given
 *  there: a picker that pages forever hangs the tab, and every active account tops out well
 *  under this in practice. */
const ACCOUNTS_PAGE_LIMIT = 200;
const ACCOUNTS_MAX_PAGES = 50;

async function collectActiveAccounts(): Promise<readonly Account[]> {
  const items: Account[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page += 1) {
    const result = unwrap(
      await api.GET('/v1/accounts', {
        params: {
          query: {
            isActive: 'true',
            limit: ACCOUNTS_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      }),
    );
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }

  throw new Error(
    `More than ${String(ACCOUNTS_MAX_PAGES * ACCOUNTS_PAGE_LIMIT)} active accounts behind one ` +
      `picker. Refusing to keep paging rather than list part of the chart as though it were all of it.`,
  );
}

export interface InventoryReferenceData {
  /** Every active account, unfiltered. */
  readonly accounts: readonly Account[];
  /** `type === 'asset'` — what a new tracked item's inventory-asset account picker offers. */
  readonly assetTypeAccounts: readonly Account[];
  /** `type === 'expense'` — what a new tracked item's COGS picker, and the shrinkage-account
   *  picker, offer. */
  readonly expenseTypeAccounts: readonly Account[];
}

/**
 * The org's active chart, once, sliced two ways client-side — `fixed-assets/queries.ts`'s
 * `useFixedAssetReferenceData` shape, copied rather than imported for this folder's usual
 * self-containment reason.
 */
export function useInventoryAccounts(): {
  readonly data: InventoryReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const accounts = useQuery({
    queryKey: INVENTORY_ACCOUNTS_QUERY_KEY,
    queryFn: collectActiveAccounts,
  });

  const data = useMemo<InventoryReferenceData | null>(() => {
    if (accounts.data === undefined) return null;
    return {
      accounts: accounts.data,
      assetTypeAccounts: accounts.data.filter((account) => account.type === 'asset'),
      expenseTypeAccounts: accounts.data.filter((account) => account.type === 'expense'),
    };
  }, [accounts.data]);

  return {
    data,
    error: accounts.error,
    refetch: () => {
      void accounts.refetch();
    },
  };
}

/**
 * The org's control-account nominations. This screen owns only `inventoryShrinkageAccountId`
 * of the three — `payableControlAccountId`/`receivableControlAccountId` belong to AR/AP, so a
 * save from here patches the one field it shows rather than round-tripping all three (the
 * wire is a partial update: "an omitted field is left as it is").
 */
export function useInventorySettings(): UseQueryResult<ControlAccounts, Error> {
  return useQuery({
    queryKey: INVENTORY_SETTINGS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/accounting-settings')),
  });
}

export function useUpdateInventorySettings(): UseMutationResult<
  ControlAccounts,
  Error,
  IdempotentVariables<UpdateControlAccountsRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<UpdateControlAccountsRequest>) =>
      unwrap(
        await api.PATCH('/v1/accounting-settings', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(INVENTORY_SETTINGS_QUERY_KEY, saved);
    },
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

/**
 * Creates a tracked (`direction: 'inventory'`) catalog item. A brand-new item starts at
 * zero on hand, so it belongs in the same read models a movement affects — invalidating the
 * `['inventory']` scope is what makes it appear in the stock list and the adjustment form's
 * item picker without a page reload.
 */
export function useCreateTrackedItem(): UseMutationResult<
  CatalogItem,
  Error,
  IdempotentVariables<CreateCatalogItemRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreateCatalogItemRequest>) =>
      unwrap(
        await api.POST('/v1/catalog-items', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: INVENTORY_SCOPE });
    },
  });
}
