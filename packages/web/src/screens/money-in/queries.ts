import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryClient,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { ApiError, api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-070 calls, and the keys it caches it under.
 *
 * The keys are local by ticket instruction and there is no shared key module: five screens
 * were built in parallel and a single `query-keys.ts` is the one file all five would have
 * edited. Nothing outside this folder reads them. Nothing in a key names the org either —
 * the org is ambient and the switcher clears the cache wholesale (`src/query/client.ts`).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, so this screen
 * cannot describe a field the server does not serve.
 */

export type Payment = components['schemas']['Payment'];
export type PaymentSummary = components['schemas']['PaymentSummary'];
export type PaymentPage = components['schemas']['PaymentPage'];
export type PaymentDirection = Payment['direction'];
export type PaymentStatus = Payment['status'];
export type Allocation = components['schemas']['Allocation'];
export type AllocationRequest = components['schemas']['AllocationRequestInput'];
export type CreatePaymentRequest = components['schemas']['CreatePaymentRequestInput'];
export type VoidRequest = components['schemas']['VoidDocumentRequestInput'];
export type Aging = components['schemas']['Aging'];
export type AgingRow = components['schemas']['AgingRow'];
export type AgingDocument = components['schemas']['AgingDocument'];
export type AgingAmounts = components['schemas']['AgingAmounts'];
export type AgingLedger = Aging['ledger'];
export type Contact = components['schemas']['Contact'];
export type Account = components['schemas']['Account'];
export type DiscountSuggestion = components['schemas']['DiscountSuggestion'];

const ROOT = 'money-in';

/**
 * Three prefixes a write disturbs, and two it does not.
 *
 * A payment or an allocation changes what is outstanding everywhere it is reported —
 * the payment itself, the aging report, and the open documents the allocation form
 * offers — because all three are computed on read from the same rows (D-34). It changes
 * no contact and no account, so those two loops are left alone; refetching the whole
 * chart of accounts after every receipt is a cost with nothing behind it.
 */
export const moneyInKeys = {
  payments: [ROOT, 'payments'] as const,
  paymentList: (filters: PaymentFilters) => [ROOT, 'payments', 'list', filters] as const,
  payment: (paymentId: string) => [ROOT, 'payments', 'detail', paymentId] as const,
  aging: (controls: AgingControls) => [ROOT, 'aging', controls] as const,
  agingScope: [ROOT, 'aging'] as const,
  openDocuments: (direction: PaymentDirection, contactId: string) =>
    [ROOT, 'open-documents', direction, contactId] as const,
  openDocumentsScope: [ROOT, 'open-documents'] as const,
  contacts: [ROOT, 'contacts'] as const,
  accounts: [ROOT, 'accounts'] as const,
  discountSuggestion: (targetId: string, asOfDate: string) =>
    [ROOT, 'discount-suggestion', targetId, asOfDate] as const,
};

async function invalidateAfterWrite(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: moneyInKeys.payments }),
    queryClient.invalidateQueries({ queryKey: moneyInKeys.agingScope }),
    queryClient.invalidateQueries({ queryKey: moneyInKeys.openDocumentsScope }),
  ]);
}

/**
 * `null` is "no filter" rather than a value, and it is `null` rather than `undefined`
 * because this object is hashed into a query key: `JSON.stringify` drops an `undefined`
 * member and keeps a `null` one, so two filter sets differing only in which they used
 * would share a cache entry.
 */
export interface PaymentFilters {
  readonly direction: PaymentDirection | null;
  readonly status: PaymentStatus | null;
  readonly contactId: string | null;
  /** D-37's credit balance, asked for directly: the payments with something left on them. */
  readonly unallocatedOnly: boolean;
  readonly from: string;
  readonly to: string;
}

export const NO_PAYMENT_FILTERS: PaymentFilters = {
  direction: null,
  status: null,
  contactId: null,
  unallocatedOnly: false,
  from: '',
  to: '',
};

function toWireFilters(filters: PaymentFilters): Record<string, string> {
  const wire: Record<string, string> = {};
  if (filters.direction !== null) wire['direction'] = filters.direction;
  if (filters.status !== null) wire['status'] = filters.status;
  if (filters.contactId !== null) wire['contactId'] = filters.contactId;
  // The route coerces this one with `z.stringbool()`, so the generated parameter is a
  // string. Sent only when it is on: `false` is the default and asking for it explicitly
  // would make two identical enquiries two cache entries.
  if (filters.unallocatedOnly) wire['unallocatedOnly'] = 'true';
  if (filters.from !== '') wire['from'] = filters.from;
  if (filters.to !== '') wire['to'] = filters.to;
  return wire;
}

/**
 * The list, keyset-paged over `(created_at, id)` and **not** over `date` (D-21): payments
 * are recorded in whatever order the paperwork surfaces, so a back-dated one would land
 * behind a cursor that had already passed its date and appear on no page at all.
 *
 * `getNextPageParam` returns `nextCursor` verbatim and nothing else. Presence is the only
 * signal that more exists — a full page does not imply another — so deriving it from
 * `items.length` would ask for a page that is not there, and minting a cursor from a row's
 * `createdAt` would page over an encoding this client does not own.
 */
export function usePaymentList(
  filters: PaymentFilters,
): UseInfiniteQueryResult<InfiniteData<PaymentPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: moneyInKeys.paymentList(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/payments', {
          params: {
            query: {
              ...toWireFilters(filters),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * One payment with its allocations. `settlement.outstanding` on it is the credit still
 * available on the contact (D-37), computed by the server on read.
 */
export function usePayment(paymentId: string | null): UseQueryResult<Payment, Error> {
  return useQuery({
    queryKey: moneyInKeys.payment(paymentId ?? ''),
    queryFn: async (): Promise<Payment> =>
      unwrap(
        await api.GET('/v1/payments/{paymentId}', {
          params: { path: { paymentId: paymentId ?? '' } },
        }),
      ),
    enabled: paymentId !== null,
  });
}

export function useRecordPayment(): UseMutationResult<
  Payment,
  Error,
  IdempotentVariables<CreatePaymentRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreatePaymentRequest>) =>
      unwrap(
        await api.POST('/v1/payments', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (payment) => {
      await invalidateAfterWrite(queryClient);
      /**
       * Seeded rather than refetched. The 201 body *is* the payment the detail panel is
       * about to render, allocations and computed settlement included, so asking for it
       * again would show an empty panel for one round trip at the exact moment the user
       * is looking for the credit their receipt just created.
       */
      queryClient.setQueryData(moneyInKeys.payment(payment.id), payment);
    },
  });
}

export interface AllocateVariables {
  readonly paymentId: string;
  readonly date: string;
  readonly allocations: readonly AllocationRequest[];
}

/**
 * Applies a recorded payment to documents — a batch, because "this transfer paid three
 * invoices" is one decision by one person and has to succeed or fail as one. Over-allocating
 * any target refuses the whole request (C3).
 */
export function useAllocatePayment(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<AllocateVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ paymentId, date, allocations, idempotencyKey }) => {
      unwrap(
        await api.POST('/v1/payments/{paymentId}/allocations', {
          body: { date, allocations: [...allocations] },
          params: { path: { paymentId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

/**
 * Un-applying, which is a real delete and not a reversal.
 *
 * An allocation posted no journal — by the time one is written both sides are already in
 * the ledger — so removing it restates no financial statement. What it changes is what is
 * outstanding, and that is computed on read (D-34), so there is nothing else to correct.
 */
export function useDeleteAllocation(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<{ readonly allocationId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ allocationId, idempotencyKey }) => {
      const result = await api.DELETE('/v1/allocations/{allocationId}', {
        params: { path: { allocationId }, header: idempotencyHeader(idempotencyKey) },
      });

      // `unwrap` refuses a 2xx with no body on purpose and says a 204 route needs its own
      // helper (`src/api/errors.ts`). `expectNoContent` is that helper, and it throws the
      // same `ApiError`, so a failed un-apply presents like every other failure here.
      if (!result.response.ok || result.error !== undefined) {
        throw ApiError.from(result.response, result.error);
      }
    },
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

export interface VoidPaymentVariables {
  readonly paymentId: string;
  readonly body: VoidRequest;
}

export function useVoidPayment(): UseMutationResult<
  Payment,
  Error,
  IdempotentVariables<VoidPaymentVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ paymentId, body, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/payments/{paymentId}/void', {
          body,
          params: { path: { paymentId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

export interface AgingControls {
  /** Required by the endpoint, and the reason is D-40: a report that defaulted to today
   * would answer differently tomorrow, and reproducibility is the point of this one. */
  readonly asOf: string;
  readonly ledger: AgingLedger;
  readonly contactId: string | null;
  readonly detail: boolean;
  readonly includeZero: boolean;
}

/**
 * Aging, as at a date.
 *
 * `asOf` is part of the query key, which is the whole mechanism behind "changing the date
 * re-asks the server": everything in the response — the buckets, and each document's own
 * `outstanding` — is computed as at that date from the allocations dated on or before it
 * (D-40). Filtering a loaded report down to a past date would use today's allocations
 * against a past date's documents and produce a figure that cannot be reproduced tomorrow.
 *
 * Not paginated, on purpose: a page of buckets sums to nothing in particular.
 */
export function useAging(controls: AgingControls): UseQueryResult<Aging, Error> {
  return useQuery({
    queryKey: moneyInKeys.aging(controls),
    queryFn: async (): Promise<Aging> =>
      unwrap(
        await api.GET('/v1/reports/aging', {
          params: {
            query: {
              asOf: controls.asOf,
              ledger: controls.ledger,
              ...(controls.contactId === null ? {} : { contactId: controls.contactId }),
              // `z.stringbool()` again — the querystring takes strings.
              ...(controls.detail ? { detail: 'true' } : {}),
              ...(controls.includeZero ? { includeZero: 'true' } : {}),
            },
          },
        }),
      ),
    enabled: controls.asOf !== '',
  });
}

/**
 * The pick-from-all lists: every contact, and every account.
 *
 * Both endpoints are keyset-paged (D-21) and both of these are pickers rather than views,
 * so the fetcher follows `nextCursor` to the end instead of offering the first page and
 * quietly omitting the rest — a contact the user cannot find in a picker is assumed not to
 * exist. The loop is a loop because neither list is bounded by anything.
 */
const PICKER_PAGE_LIMIT = 100;

export function useContactOptions(): readonly Contact[] {
  const query = useQuery({
    queryKey: moneyInKeys.contacts,
    queryFn: async (): Promise<readonly Contact[]> => {
      const items: Contact[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/contacts', {
            params: {
              query: {
                isActive: 'true',
                limit: PICKER_PAGE_LIMIT,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        );
        items.push(...page.items);
        if (page.nextCursor === null) return items;
        cursor = page.nextCursor;
      }
    },
  });

  return query.data ?? [];
}

/**
 * The accounts money can move through.
 *
 * Narrowed to assets and liabilities *after* the whole list is loaded, not by a
 * `type` filter per request, because two filtered lists would be two paged loops for one
 * picker. The narrowing is a convenience and not a rule the server holds: `recordPayment`
 * requires only that the account exist and be active, so this hides revenue and expense
 * accounts from a picker whose field is "the bank or cash account the money moved through"
 * — a credit card is a liability and is a real answer to it.
 */
export function useMoneyAccountOptions(): readonly Account[] {
  const query = useQuery({
    queryKey: moneyInKeys.accounts,
    queryFn: async (): Promise<readonly Account[]> => {
      const items: Account[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/accounts', {
            params: {
              query: {
                isActive: 'true',
                limit: PICKER_PAGE_LIMIT,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        );
        items.push(...page.items);
        if (page.nextCursor === null) return items;
        cursor = page.nextCursor;
      }
    },
  });

  return (query.data ?? []).filter(
    (account) => account.type === 'asset' || account.type === 'liability',
  );
}

/**
 * A document an allocation can settle: the number, the dates, and what is still owed.
 *
 * `outstanding` is the server's `settlement.outstanding` carried through unchanged. It is
 * total minus allocations, computed on read and stored nowhere (D-34), and this screen
 * neither recomputes it from the allocation rows it happens to hold nor caches it as a
 * number — it is the figure the over-allocation refusal is measured against.
 */
export interface OpenDocument {
  readonly id: string;
  readonly targetType: 'invoice' | 'bill';
  readonly number: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly outstanding: string;
}

/**
 * The two statuses that can still be settled, asked for separately.
 *
 * `approved` and `part_paid` are computed rather than stored (D-38) and the list endpoint
 * filters on exactly one at a time, so this is two requests rather than one request
 * filtered client-side. Filtering a keyset-paged list in the browser would drop whatever
 * the first page happened not to contain, which on this form means an invoice the user can
 * see on their own statement and cannot pay.
 */
const SETTLEABLE_STATUSES = ['approved', 'part_paid'] as const;

/**
 * The open documents a payment in this direction can settle, for this contact.
 *
 * A `received` payment settles invoices and a `made` payment settles bills — the direction
 * decides the subledger, and an allocation may never cross it. Scoped to the contact
 * because an unapplied amount is a credit balance on the contact it came from (D-37) and
 * the server refuses a cross-contact allocation outright.
 */
export function useOpenDocuments(
  direction: PaymentDirection,
  contactId: string | null,
): UseQueryResult<readonly OpenDocument[], Error> {
  return useQuery({
    queryKey: moneyInKeys.openDocuments(direction, contactId ?? ''),
    queryFn: async (): Promise<readonly OpenDocument[]> => {
      const documents: OpenDocument[] = [];

      for (const status of SETTLEABLE_STATUSES) {
        let cursor: string | undefined;
        for (;;) {
          const query = {
            contactId: contactId ?? '',
            status,
            limit: PICKER_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          };
          const page =
            direction === 'received'
              ? unwrap(await api.GET('/v1/invoices', { params: { query } }))
              : unwrap(await api.GET('/v1/bills', { params: { query } }));

          for (const item of page.items) {
            documents.push({
              id: item.id,
              targetType: direction === 'received' ? 'invoice' : 'bill',
              // An approved document always carries a number (D-36 makes the sequence
              // gapless per org per type); the null is the draft case, which this list
              // never asks for.
              number: item.documentNumber ?? '—',
              issueDate: item.issueDate,
              dueDate: item.dueDate,
              outstanding: item.settlement.outstanding,
            });
          }

          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
      }

      return documents;
    },
    enabled: contactId !== null,
  });
}

/**
 * The terms-driven discount preview (OB-138), asked for an invoice a receipt is about to
 * settle — D-81's "the money-in screen remains for receipts not in the feed" surfaced here
 * as the same suggestion the bank-match workbench offers (OB-140).
 *
 * `204` is not an error (`suggestDiscount`'s own contract): it is the ordinary case for a
 * document with no term, a simple term, or one whose window has passed relative to
 * `asOfDate`, so it resolves to `null` rather than throwing through `unwrap`, which refuses
 * a bodiless 2xx on purpose because it cannot otherwise tell that apart from a broken read.
 *
 * Read-only here on purpose (see `allocation-editor.tsx`'s own note on the gap this leaves):
 * confirming a discount has a write path from the bank-match workbench
 * (`clearBankStatementLine`'s `discount` entry) but none yet for a manual receipt, so this
 * screen shows the suggestion and stops short of an "apply" that would have nowhere to post.
 */
export function useDiscountSuggestion(
  targetType: 'invoice' | 'bill',
  targetId: string | null,
  asOfDate: string,
): UseQueryResult<DiscountSuggestion | null, Error> {
  return useQuery({
    queryKey: moneyInKeys.discountSuggestion(targetId ?? '', asOfDate),
    queryFn: async (): Promise<DiscountSuggestion | null> => {
      const result = await api.GET('/v1/payment-terms/discount-suggestion', {
        params: { query: { targetType, targetId: targetId ?? '', asOfDate } },
      });
      if (result.response.status === 204) return null;
      return unwrap(result);
    },
    enabled: targetId !== null,
  });
}

/**
 * One `Idempotency-Key` per user intent, and a new one exactly when the intent changes.
 *
 * The header's value is that a *retry* carries the **same** key: that is how the server
 * tells "the user asked twice" from "the network dropped the response"
 * (`src/api/idempotency.ts`). Minting inside the mutation makes every attempt a fresh
 * intent, so a resubmitted form is a second payment. Minting once when a dialog opens is
 * the opposite failure: the user corrects the field the server rejected, the body no longer
 * matches the key, and the form dies on `idempotency_key_conflict`.
 *
 * So the key is bound to a fingerprint of what is being sent. That matters more here than
 * on any other screen in the application: the two writes this returns keys for both move
 * money, and a duplicated one is a receipt the business never had.
 */
export function useIntentKey(): (fingerprint: string) => string {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);

  return useCallback((fingerprint: string): string => {
    const current = held.current;
    if (current !== null && current.fingerprint === fingerprint) return current.key;

    const key = newIdempotencyKey();
    held.current = { fingerprint, key };
    return key;
  }, []);
}

/**
 * The stable token naming which precondition a refusal carries —
 * `document_over_allocated`, `source_over_allocated`, `allocation_contact_mismatch`,
 * `document_not_approved`, `document_void`, `payment_void`.
 *
 * Branched on rather than the prose, because `src/errors/codes.ts` makes the token the part
 * of the contract that is never renamed. `details` is `{ [key: string]: unknown }` in the
 * generated types — OpenAPI cannot say more about a free-form bag — so the chain below
 * narrows rather than casts, the same construction `fieldErrorsFrom` walks in
 * `src/api/presentation.ts`. Anything unexpected reads as "no token" and the caller falls
 * back to the shared error surface.
 */
export const DOCUMENT_OVER_ALLOCATED = 'document_over_allocated';
export const SOURCE_OVER_ALLOCATED = 'source_over_allocated';

export function preconditionToken(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const envelope: unknown = body.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return null;
  const details: unknown = envelope.details;
  if (typeof details !== 'object' || details === null || !('precondition' in details)) return null;

  const token: unknown = details.precondition;
  return typeof token === 'string' ? token : null;
}
