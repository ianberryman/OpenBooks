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
 * Everything OB-176 asks of `/v1/estimates` — the AR mirror of a purchase order
 * (initiative M, OB-172, OB-175…177; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * Types come straight off `components['schemas'][…]` — `fixed-assets/queries.ts`'s reason
 * applies here too: there is no hand-written mirror of a wire shape in this package, and
 * one would be a second contract the day either drifts.
 *
 * ## An estimate posts no journal
 *
 * `draft` → `approved` → `converted` is stored, not derived (`Estimate.status`'s own
 * words) — there is no ledger for D-38's usual "computed from the journals" derivation to
 * apply to. Approving allocates a gapless number and nothing else; converting builds a
 * *draft* invoice from the header and lines and hands back that invoice (`Invoice`, not a
 * second `Estimate`), which is why `useConvertEstimateToInvoice` below is typed against
 * `Invoice` rather than `Estimate`.
 *
 * ## Why the list and the edit dialog read from two different shapes
 *
 * `EstimatePage` carries `EstimateSummary` rows — no `lines` — for the same reason
 * `sales/queries.ts` keeps a page of documents thin. Opening an estimate to edit it fetches
 * the full `Estimate` by id (`useEstimate`) rather than editing off the summary the list
 * already has.
 */
export type Estimate = components['schemas']['Estimate'];
export type EstimatePage = components['schemas']['EstimatePage'];
export type EstimateSummary = components['schemas']['EstimateSummary'];
export type EstimateStatus = EstimateSummary['status'];
export type CreateEstimateRequest = components['schemas']['CreateEstimateRequestInput'];
export type UpdateEstimateRequest = components['schemas']['UpdateEstimateRequestInput'];
export type PredocumentLineRequest = components['schemas']['PredocumentLineRequestInput'];
export type PredocumentDelivery = components['schemas']['PredocumentDelivery'];
export type SendEstimateRequest = components['schemas']['SendPredocumentRequestInput'];
export type Invoice = components['schemas']['Invoice'];

export type Contact = components['schemas']['Contact'];
export type Account = components['schemas']['Account'];

/**
 * Query keys, local to this screen — `fixed-assets/queries.ts`'s reason: there is no
 * shared key module, so a second screen changing shape never has to agree with this one
 * about what its keys mean.
 */
const ESTIMATES_SCOPE = ['estimates'] as const;

export function estimateListQueryKey(status: EstimateStatus | null): readonly unknown[] {
  return [...ESTIMATES_SCOPE, 'list', status];
}

function estimateDetailQueryKey(estimateId: string): readonly unknown[] {
  return [...ESTIMATES_SCOPE, 'detail', estimateId];
}

const CONTACTS_QUERY_KEY = ['estimates', 'contacts'] as const;
const ACCOUNTS_QUERY_KEY = ['estimates', 'accounts'] as const;

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `fixed-assets/queries.ts`'s bound: a picker that pages forever hangs the tab. */
const MAX_PAGES = 50;

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
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

export interface EstimateReferenceData {
  readonly contacts: readonly Contact[];
  /** Every contact with `isCustomer` set — `sales.tsx`'s own client-side filter, since an
   *  estimate is addressed to a customer even though `createEstimate` itself checks only
   *  that the contact exists (no `requireCustomer` guard on the AR side of this codebase). */
  readonly customers: readonly Contact[];
  readonly accounts: readonly Account[];
  readonly contactsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Contacts and revenue accounts, as one thing that is either loaded or not —
 * `recurring-invoices/queries.ts`'s `useTemplateReferenceData`, mirrored rather than
 * imported: each screen folder is self-contained (no screen imports another's
 * `queries.ts`), so a second, small copy is the cost of that rather than a cross-screen
 * dependency.
 *
 * `type: 'revenue'` on the account fetch is not cosmetic: an estimate becomes an invoice
 * line-for-line at convert, and an invoice line's `accountId` is the income account it
 * credits — the same restriction `recurring-invoices/queries.ts` applies to its own line
 * picker, for the same reason.
 *
 * Both arrive unfiltered by their own active flag: an estimate saved while a contact or
 * account was active still names it after that thing is archived, and a picker that had
 * never heard of it would show an empty box where the estimate's own choice is. They are
 * offered disabled instead — see `estimate-form.tsx`.
 */
export function useEstimateReferenceData(): {
  readonly data: EstimateReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const contacts = useQuery({
    queryKey: CONTACTS_QUERY_KEY,
    queryFn: async () =>
      collect<Contact>(async (cursor) =>
        unwrap(await api.GET('/v1/contacts', { params: { query: pageQuery(cursor) } })),
      ),
  });

  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () =>
      collect<Account>(async (cursor) =>
        unwrap(
          await api.GET('/v1/accounts', {
            params: { query: { ...pageQuery(cursor), type: 'revenue' } },
          }),
        ),
      ),
  });

  const data = useMemo<EstimateReferenceData | null>(() => {
    if (contacts.data === undefined || accounts.data === undefined) return null;
    return {
      contacts: contacts.data,
      customers: contacts.data.filter((contact) => contact.isCustomer),
      accounts: accounts.data,
      contactsById: index(contacts.data),
      accountsById: index(accounts.data),
    };
  }, [contacts.data, accounts.data]);

  return {
    data,
    error: contacts.error ?? accounts.error,
    refetch: () => {
      void contacts.refetch();
      void accounts.refetch();
    },
  };
}

/**
 * One page of the org's estimates, oldest first (D-21) — `fixed-assets/queries.ts`'s
 * `useFixedAssetList` shape: presence of `nextCursor` is the only signal that more exists.
 */
export function useEstimateList(
  status: EstimateStatus | null,
): UseInfiniteQueryResult<InfiniteData<EstimatePage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: estimateListQueryKey(status),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/estimates', {
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
 * The full estimate, lines included — what the edit dialog reads from rather than the
 * `EstimateSummary` row the list already holds (see the file header).
 */
export function useEstimate(estimateId: string | null): UseQueryResult<Estimate, Error> {
  return useQuery({
    queryKey: estimateDetailQueryKey(estimateId ?? ''),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/estimates/{estimateId}', {
          params: { path: { estimateId: estimateId ?? '' } },
        }),
      ),
    enabled: estimateId !== null,
  });
}

/**
 * One idempotency key per user intent — `fixed-assets/queries.ts`'s `useIntentKey`,
 * copied rather than imported for the self-containment reason this file's other hooks
 * give. The key is held against a fingerprint of what would be sent, so a retry after a
 * dropped response replays the original outcome and a corrected form gets a fresh key.
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

function invalidateEstimates(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ESTIMATES_SCOPE });
}

export function useCreateEstimate(): UseMutationResult<
  Estimate,
  Error,
  IdempotentVariables<CreateEstimateRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateEstimateRequest>) =>
      unwrap(
        await api.POST('/v1/estimates', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateEstimates(queryClient);
    },
  });
}

export interface UpdateEstimateVariables {
  readonly estimateId: string;
  readonly patch: UpdateEstimateRequest;
}

export function useUpdateEstimate(): UseMutationResult<
  Estimate,
  Error,
  IdempotentVariables<UpdateEstimateVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ estimateId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/estimates/{estimateId}', {
          body: patch,
          params: { path: { estimateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateEstimates(queryClient);
    },
  });
}

/**
 * Discards a draft outright (`discardEstimate` — draft only, and it holds no number to
 * protect). A 204 carries no body, so `unwrap` is the wrong helper — `expectNoContent`
 * is, exactly as `settings/dimensions.tsx` uses it for its own `DELETE`.
 */
export function useDiscardEstimate(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<{ readonly estimateId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ estimateId, idempotencyKey }) =>
      expectNoContent(
        await api.DELETE('/v1/estimates/{estimateId}', {
          params: { path: { estimateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateEstimates(queryClient);
    },
  });
}

/**
 * Approves a draft: allocates its gapless number and stamps `approvedAt`. No journal — an
 * estimate never posts one (D-M3) — so there is nothing else this call changes.
 */
export function useApproveEstimate(): UseMutationResult<
  Estimate,
  Error,
  IdempotentVariables<{ readonly estimateId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ estimateId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/estimates/{estimateId}/approve', {
          params: { path: { estimateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateEstimates(queryClient);
    },
  });
}

/**
 * Converts an approved estimate into a **draft invoice** carrying every line across
 * (D-M4) — hence the `Invoice` return type, not `Estimate`. Convert-once: the server's own
 * `FOR UPDATE` read and `convertedInvoiceId IS NULL` check is what actually enforces it;
 * this screen only avoids offering the action twice (`list.tsx`'s status gate).
 */
export function useConvertEstimateToInvoice(): UseMutationResult<
  Invoice,
  Error,
  IdempotentVariables<{ readonly estimateId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ estimateId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/estimates/{estimateId}/convert', {
          params: { path: { estimateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateEstimates(queryClient);
    },
  });
}

export interface SendEstimateVariables {
  readonly estimateId: string;
  readonly recipientEmail: string | null;
}

/**
 * Emails an approved estimate to its customer (D-M5: lean send — no hosted page, no PDF,
 * just an HTML summary and an append-only delivery record). `recipientEmail` overrides the
 * customer's own address for this one send; `null` leaves it to the server's own fallback.
 */
export function useSendEstimate(): UseMutationResult<
  PredocumentDelivery,
  Error,
  IdempotentVariables<SendEstimateVariables>
> {
  return useMutation({
    mutationFn: async ({ estimateId, recipientEmail, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/estimates/{estimateId}/send', {
          body: { recipientEmail },
          params: { path: { estimateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
  });
}
