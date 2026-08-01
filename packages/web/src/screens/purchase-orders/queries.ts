import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, expectNoContent, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything this screen reads and writes on `/v1/purchase-orders` (D-M3, D-M6).
 *
 * Types come straight off `components['schemas'][…]` — `fixed-assets/queries.ts`'s reason
 * applies here too: there is no hand-written mirror of a wire shape in this package.
 *
 * ## What this screen never computes
 *
 * `totals` is the sum of rounded lines, priced by the server on create and on every update
 * (D-35's rounding rule, applied here the same as on a bill or an invoice). This screen
 * shows whatever the last save returned; it never adds up lines itself, the reason
 * `MoneyInput`'s own header gives for keeping money arithmetic out of every screen.
 *
 * `status` is stored, not derived (unlike a posting document's D-38 status): `draft` until
 * approved, `approved` once a gapless number is allocated, `converted` once
 * `convertPurchaseOrderToBill` has produced a bill. A purchase order posts no journal at
 * all (D-M3) — approval only allocates the number, and the ledger is told only once the
 * *converted* bill is itself approved.
 */
export type PurchaseOrder = components['schemas']['PurchaseOrder'];
export type PurchaseOrderPage = components['schemas']['PurchaseOrderPage'];
export type PurchaseOrderSummary = components['schemas']['PurchaseOrderSummary'];
export type PurchaseOrderStatus = PurchaseOrder['status'];
export type CreatePurchaseOrderRequest = components['schemas']['CreatePurchaseOrderRequestInput'];
export type UpdatePurchaseOrderRequest = components['schemas']['UpdatePurchaseOrderRequestInput'];
export type SendPurchaseOrderRequest = components['schemas']['SendPredocumentRequestInput'];
export type PredocumentDelivery = components['schemas']['PredocumentDelivery'];
export type DocumentLine = components['schemas']['DocumentLine'];
export type Bill = components['schemas']['Bill'];
export type PurchaseOrdersSummary = components['schemas']['PurchaseOrdersSummary'];

export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];

/**
 * Query keys, local to this screen — `fixed-assets/queries.ts`'s reason: there is no
 * shared key module, so a second screen changing shape never has to agree with this one
 * about what its keys mean.
 */
const PURCHASE_ORDERS_SCOPE = ['purchase-orders'] as const;

export function purchaseOrderListQueryKey(status: PurchaseOrderStatus | null): readonly unknown[] {
  return [...PURCHASE_ORDERS_SCOPE, 'list', status];
}

function purchaseOrderDetailQueryKey(purchaseOrderId: string): readonly unknown[] {
  return [...PURCHASE_ORDERS_SCOPE, 'detail', purchaseOrderId];
}

export const VENDORS_QUERY_KEY = ['purchase-orders', 'vendors'] as const;
const ACCOUNTS_QUERY_KEY = ['purchase-orders', 'accounts'] as const;
const PURCHASE_ORDERS_SUMMARY_QUERY_KEY = ['purchase-orders', 'summary'] as const;

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `fixed-assets/queries.ts`'s bound: a picker that pages forever hangs the tab. */
const MAX_PAGES = 50;

function pageQuery(cursor: string | undefined): { limit: number; cursor?: string } {
  // Spread rather than `cursor: undefined`: `exactOptionalPropertyTypes` makes an absent
  // property and an explicitly-undefined one different types.
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

async function collect<T>(
  load: (cursor: string | undefined) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
  }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await load(cursor);
    all.push(...result.items);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }

  throw new Error(
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} rows behind one picker. Refusing to keep ` +
      `paging rather than list part of the set as though it were all of it.`,
  );
}

/**
 * Vendors only, archived ones included and offered disabled — `purchases/queries.ts`'s
 * `fetchVendors`, copied rather than imported for the self-containment reason every screen
 * folder here gives: a purchase order's `contactId` "must be a vendor —
 * `contact_is_not_a_vendor` otherwise" (`createPurchaseOrder`'s own description), so a
 * picker offering customers would offer a choice the service refuses.
 */
async function fetchVendors(): Promise<Contact[]> {
  return collect(async (cursor) =>
    unwrap(
      await api.GET('/v1/contacts', {
        params: { query: { ...pageQuery(cursor), isVendor: 'true' } },
      }),
    ),
  );
}

async function fetchAccounts(): Promise<Account[]> {
  return collect(async (cursor) =>
    unwrap(await api.GET('/v1/accounts', { params: { query: pageQuery(cursor) } })),
  );
}

export interface PurchaseOrderReferenceData {
  readonly vendors: readonly Contact[];
  readonly accounts: readonly Account[];
  readonly vendorsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The org's vendors and its whole chart, fetched once for every picker this screen shows
 * (the vendor combobox on the form, the account combobox on each line).
 */
export function usePurchaseOrderReferenceData(): {
  readonly data: PurchaseOrderReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const vendors = useQuery({ queryKey: VENDORS_QUERY_KEY, queryFn: fetchVendors });
  const accounts = useQuery({ queryKey: ACCOUNTS_QUERY_KEY, queryFn: fetchAccounts });

  const data = useMemo<PurchaseOrderReferenceData | null>(() => {
    if (vendors.data === undefined || accounts.data === undefined) return null;
    return {
      vendors: vendors.data,
      accounts: accounts.data,
      vendorsById: index(vendors.data),
      accountsById: index(accounts.data),
    };
  }, [vendors.data, accounts.data]);

  return {
    data,
    error: vendors.error ?? accounts.error,
    refetch: () => {
      void vendors.refetch();
      void accounts.refetch();
    },
  };
}

/**
 * The register, keyset-paged over `(created_at, id)` (D-21) — `fixed-assets/queries.ts`'s
 * `useFixedAssetList` shape: presence of `nextCursor` is the only signal that more exists.
 */
export function usePurchaseOrderList(
  status: PurchaseOrderStatus | null,
): UseInfiniteQueryResult<InfiniteData<PurchaseOrderPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: purchaseOrderListQueryKey(status),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/purchase-orders', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(status === null ? {} : { status }),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * One purchase order, with its lines — fetched on demand rather than carried on the list
 * row, because `PurchaseOrderPage.items` is `PurchaseOrderSummary[]` and a summary carries
 * no lines at all. The routed detail/editor fetches this by id (`useEstimate`'s shape on the
 * AR side) rather than editing off the summary the list already holds, so a cold URL lands
 * on a full order.
 */
export function usePurchaseOrder(
  purchaseOrderId: string | null,
): UseQueryResult<PurchaseOrder, Error> {
  return useQuery({
    queryKey: purchaseOrderDetailQueryKey(purchaseOrderId ?? ''),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/purchase-orders/{purchaseOrderId}', {
          params: { path: { purchaseOrderId: purchaseOrderId ?? '' } },
        }),
      ),
    enabled: purchaseOrderId !== null,
  });
}

/** The server-side narrowings the redesigned list offers — the same two `/v1/purchase-orders`
 * accepts. The draft/approved/converted card narrowing and any text search stay client-side
 * (`order-presentation.ts`), for `estimates.tsx`'s reason: they are not filters the API has. */
export interface PurchaseOrderListFilters {
  readonly contactId?: string;
  readonly status?: PurchaseOrderStatus;
}

/**
 * One capped page of purchase orders for the redesigned list — flattened and filterable,
 * unlike the infinite `usePurchaseOrderList` the old screen paged with. `truncated` is the
 * presence of a next cursor, echoed the way `sales/queries.ts`' `useDocumentList` does it, so
 * the list can say "narrow the filter to reach the rest" rather than fake a second page.
 */
export function usePurchaseOrderListItems(filters: PurchaseOrderListFilters = {}): {
  readonly items: readonly PurchaseOrderSummary[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly truncated: boolean;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: [
      ...PURCHASE_ORDERS_SCOPE,
      'list-page',
      filters.contactId ?? null,
      filters.status ?? null,
    ],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/purchase-orders', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
              ...(filters.status === undefined ? {} : { status: filters.status }),
            },
          },
        }),
      ),
  });

  return {
    items: query.data?.items ?? [],
    isPending: query.isPending,
    error: query.error,
    truncated: query.data?.nextCursor != null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface PurchaseOrdersSummaryResult {
  readonly data: PurchaseOrdersSummary | null;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The three headline figures above the purchase-orders list — draft value, approved value
 * awaiting conversion, and what converted in the last 30 days. Server-computed
 * (`GET /v1/purchase-orders/summary`) rather than summed from the page for
 * `estimates/summary-cards.tsx`'s reason: the list is one capped page, and only the server
 * sees every purchase order. The "converted last 30 days" figure in particular needs
 * `convertedAt`, which is not on the summary rows the list holds.
 */
export function usePurchaseOrdersSummary(): PurchaseOrdersSummaryResult {
  const query = useQuery({
    queryKey: PURCHASE_ORDERS_SUMMARY_QUERY_KEY,
    queryFn: async () =>
      unwrap(await api.GET('/v1/purchase-orders/summary', { params: { query: {} } })),
  });

  return {
    data: query.data ?? null,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
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

function invalidatePurchaseOrders(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: PURCHASE_ORDERS_SCOPE });
}

export function useCreatePurchaseOrder(): UseMutationResult<
  PurchaseOrder,
  Error,
  IdempotentVariables<CreatePurchaseOrderRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreatePurchaseOrderRequest>) =>
      unwrap(
        await api.POST('/v1/purchase-orders', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePurchaseOrders(queryClient);
    },
  });
}

export interface UpdatePurchaseOrderVariables {
  readonly purchaseOrderId: string;
  readonly patch: UpdatePurchaseOrderRequest;
}

export function useUpdatePurchaseOrder(): UseMutationResult<
  PurchaseOrder,
  Error,
  IdempotentVariables<UpdatePurchaseOrderVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ purchaseOrderId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/purchase-orders/{purchaseOrderId}', {
          body: patch,
          params: { path: { purchaseOrderId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePurchaseOrders(queryClient);
    },
  });
}

export interface PurchaseOrderIdVariables {
  readonly purchaseOrderId: string;
}

/**
 * Allocates the gapless number and stamps `approvedAt` (D-M6). Posts no journal (D-M3) —
 * that is `convertPurchaseOrderToBill`'s and then the resulting bill's own approval to do.
 */
export function useApprovePurchaseOrder(): UseMutationResult<
  PurchaseOrder,
  Error,
  IdempotentVariables<PurchaseOrderIdVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ purchaseOrderId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/purchase-orders/{purchaseOrderId}/approve', {
          params: { path: { purchaseOrderId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePurchaseOrders(queryClient);
    },
  });
}

/**
 * Builds a draft bill from the purchase order's header and stored lines (D-M4).
 * Convert-once — a second attempt is `purchase_order_already_converted` naming the bill
 * already produced, so this screen never tries to guess whether one has happened; it
 * simply gates the button on `status === 'approved'` and lets the server's own refusal
 * cover the race.
 */
export function useConvertPurchaseOrderToBill(): UseMutationResult<
  Bill,
  Error,
  IdempotentVariables<PurchaseOrderIdVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ purchaseOrderId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/purchase-orders/{purchaseOrderId}/convert', {
          params: { path: { purchaseOrderId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidatePurchaseOrders(queryClient);
    },
  });
}

export interface SendPurchaseOrderVariables {
  readonly purchaseOrderId: string;
  readonly request: SendPurchaseOrderRequest;
}

export function useSendPurchaseOrder(): UseMutationResult<
  PredocumentDelivery,
  Error,
  IdempotentVariables<SendPurchaseOrderVariables>
> {
  return useMutation({
    mutationFn: async ({ purchaseOrderId, request, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/purchase-orders/{purchaseOrderId}/send', {
          body: request,
          params: { path: { purchaseOrderId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
  });
}

/**
 * Discards a draft and its lines (D-16's shape for a document that never reached the
 * ledger): nothing was approved and no number was allocated, so nothing here is restated
 * and no gap is left in the series `approvePurchaseOrder` allocates from.
 */
export function useDiscardPurchaseOrder(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<PurchaseOrderIdVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ purchaseOrderId, idempotencyKey }) => {
      expectNoContent(
        await api.DELETE('/v1/purchase-orders/{purchaseOrderId}', {
          params: { path: { purchaseOrderId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidatePurchaseOrders(queryClient);
    },
  });
}
