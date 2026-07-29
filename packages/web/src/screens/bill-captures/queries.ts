import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything the bill-captures screen reads and writes (OB-189; the OB-128-adjacent
 * capture backend this is the review front end for).
 *
 * Self-contained, following `dunning/queries.ts` and `sales/queries.ts`: a shared module
 * would make one screen's change another screen's problem, and the org switch already
 * clears the query cache wholesale (`src/query/client.ts`).
 */

export type DocumentCapture = components['schemas']['DocumentCapture'];
export type DocumentCapturePage = components['schemas']['DocumentCapturePage'];
export type ExtractedCaptureLine = components['schemas']['ExtractedCaptureLine'];
export type CaptureStatus = DocumentCapture['status'];
export type InboundEmailAddress = components['schemas']['InboundEmailAddress'];
export type UploadCaptureBody = components['schemas']['UploadCaptureRequestInput'];
export type CreateDraftFromCaptureBody =
  components['schemas']['CreateDraftFromCaptureRequestInput'];
export type Bill = components['schemas']['Bill'];
export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];
export type TaxRate = components['schemas']['TaxRate'];
export type DocumentLineRequest = components['schemas']['DocumentLineRequestInput'];
export type TaxMode = CreateDraftFromCaptureBody['taxMode'];

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const LIST_LIMIT = 100;

/** `journal-entry/queries.ts`'s bound, for its reason: a picker that pages forever hangs
 * the tab, and listing part of a set as though it were all of it is worse. */
const MAX_PAGES = 50;
const PAGE_LIMIT = 200;

export const billCapturesKeys = {
  list: (status: CaptureStatus | null) => ['bill-captures', 'list', status ?? 'all'] as const,
  inboundAddress: ['bill-captures', 'inbound-address'] as const,
  vendors: ['bill-captures', 'vendors'] as const,
  accounts: ['bill-captures', 'accounts'] as const,
  taxRates: ['bill-captures', 'tax-rates'] as const,
};

export interface ListResult<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The review queue, filterable by status. `status: null` sends no filter at all and shows
 * every capture — extracting, extracted, failed, drafted and dismissed alike — which is
 * what the API does when `status` is omitted (`listBillCaptures`'s own description).
 */
export function useBillCaptures(status: CaptureStatus | null): ListResult<DocumentCapture> {
  const query = useQuery({
    queryKey: billCapturesKeys.list(status),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/bills/captures', {
          params: {
            query: { limit: LIST_LIMIT, ...(status === null ? {} : { status }) },
          },
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

export function useInboundBillEmailAddress(): UseQueryResult<InboundEmailAddress, Error> {
  return useQuery({
    queryKey: billCapturesKeys.inboundAddress,
    queryFn: async () => unwrap(await api.GET('/v1/bills/inbound-address')),
  });
}

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

async function collect<T>(load: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
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

function pageQuery(cursor: string | undefined): { limit: number; cursor?: string } {
  // Spread rather than `cursor: undefined`: `exactOptionalPropertyTypes` makes an absent
  // property and an explicitly-undefined one different types.
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

/**
 * Vendors only, following `purchases/queries.ts`' `fetchVendors`: a bill's `contactId`
 * must be a vendor (`contact_is_not_a_vendor` otherwise), so a picker offering customers
 * would offer a choice the service refuses. Inactive vendors arrive and are offered
 * disabled — a capture reviewed after its vendor was archived still names it.
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

/**
 * `type: 'expense'`, and this is a narrower picker than `purchases/queries.ts`'
 * `fetchAccounts`, which fetches every account unfiltered.
 *
 * The server does not restrict which account type a bill line may post to — a bill can
 * legitimately debit an asset (inventory, a prepayment) as well as an expense — so this
 * filter is a usability choice for *this* screen and not a rule `purchases` also follows.
 * The reasoning: a capture is an extracted vendor bill with no line-level signal beyond a
 * description and an amount, review happens fast, and the overwhelming majority of what
 * gets captured this way (a utility bill, a subscription, an invoice for services) debits
 * an expense account. Narrowing the list here trades away the asset/liability case — which
 * still exists and is not blocked by the server — for a shorter, faster-to-scan list on the
 * screen built for high-volume triage. A reviewer who needs to post a capture to a
 * non-expense account still can: save it as a draft bill via `purchases` instead, where
 * every account is offered, exactly as today.
 */
async function fetchExpenseAccounts(): Promise<Account[]> {
  return collect(async (cursor) =>
    unwrap(
      await api.GET('/v1/accounts', {
        params: { query: { ...pageQuery(cursor), type: 'expense' } },
      }),
    ),
  );
}

/** `appliesTo: 'purchases'` is a usability predicate on the server, not an equality — it
 * returns the unrestricted `both` rates as well (`purchases/queries.ts`'
 * `fetchPurchaseTaxRates`, matched here for the same reason: a bill draft is what this
 * screen produces). */
async function fetchPurchaseTaxRates(): Promise<TaxRate[]> {
  return collect(async (cursor) =>
    unwrap(
      await api.GET('/v1/tax-rates', {
        params: { query: { ...pageQuery(cursor), appliesTo: 'purchases' } },
      }),
    ),
  );
}

export interface ReferenceData {
  readonly vendors: readonly Contact[];
  readonly accounts: readonly Account[];
  readonly taxRates: readonly TaxRate[];
  readonly vendorsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly taxRatesById: ReadonlyMap<string, TaxRate>;
}

export interface ReferenceDataResult {
  /** `null` until all three have arrived — a half-loaded picker reads as missing data. */
  readonly data: ReferenceData | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function useReferenceData(): ReferenceDataResult {
  const vendors = useQuery({ queryKey: billCapturesKeys.vendors, queryFn: fetchVendors });
  const accounts = useQuery({ queryKey: billCapturesKeys.accounts, queryFn: fetchExpenseAccounts });
  const taxRates = useQuery({
    queryKey: billCapturesKeys.taxRates,
    queryFn: fetchPurchaseTaxRates,
  });

  const data = useMemo<ReferenceData | null>(() => {
    if (vendors.data === undefined || accounts.data === undefined || taxRates.data === undefined) {
      return null;
    }
    return {
      vendors: vendors.data,
      accounts: accounts.data,
      taxRates: taxRates.data,
      vendorsById: index(vendors.data),
      accountsById: index(accounts.data),
      taxRatesById: index(taxRates.data),
    };
  }, [vendors.data, accounts.data, taxRates.data]);

  return {
    data,
    isPending: vendors.isPending || accounts.isPending || taxRates.isPending,
    error: vendors.error ?? accounts.error ?? taxRates.error,
    refetch: () => {
      void vendors.refetch();
      void accounts.refetch();
      void taxRates.refetch();
    },
  };
}

async function invalidateCaptures(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['bill-captures', 'list'] });
}

export function useCreateBillCapture(): UseMutationResult<
  DocumentCapture,
  Error,
  IdempotentVariables<UploadCaptureBody>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<UploadCaptureBody>) =>
      unwrap(
        await api.POST('/v1/bills/captures', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCaptures(queryClient);
    },
  });
}

export function useDismissBillCapture(): UseMutationResult<
  DocumentCapture,
  Error,
  IdempotentVariables<{ captureId: string }>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ idempotencyKey, captureId }: IdempotentVariables<{ captureId: string }>) =>
      unwrap(
        await api.POST('/v1/bills/captures/{captureId}/dismiss', {
          params: { path: { captureId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCaptures(queryClient);
    },
  });
}

export interface CreateDraftVariables {
  readonly captureId: string;
  readonly body: CreateDraftFromCaptureBody;
}

export function useCreateDraftFromCapture(): UseMutationResult<
  Bill,
  Error,
  IdempotentVariables<CreateDraftVariables>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      captureId,
      body,
    }: IdempotentVariables<CreateDraftVariables>) =>
      unwrap(
        await api.POST('/v1/bills/captures/{captureId}/draft', {
          body,
          params: { path: { captureId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCaptures(queryClient);
    },
  });
}
