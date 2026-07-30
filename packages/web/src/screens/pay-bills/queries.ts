import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-116 calls, and the keys it caches it under (ROADMAP D-63…D-68, D-109,
 * D-110).
 *
 * Local by the same ticket instruction every other M-era screen was built under: nothing
 * outside this folder reads these keys, and none of them names the org — the org is
 * ambient and the switcher clears the cache wholesale (`src/query/client.ts`).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand.
 */

export type PayableBill = components['schemas']['PayableBill'];
export type PendingPayment = components['schemas']['PendingPayment'];
export type PendingPaymentStatus = PendingPayment['status'];
export type Rail = PendingPayment['rail'];
export type CreatePendingPaymentRequest = components['schemas']['CreatePendingPaymentRequestInput'];
export type PendingPaymentIntentInput = CreatePendingPaymentRequest['intents'][number];
export type UpdatePendingPaymentRequest = components['schemas']['UpdatePendingPaymentRequestInput'];
export type IssuePendingPaymentRequest = components['schemas']['IssuePendingPaymentRequestInput'];
export type IssueOutcome = components['schemas']['IssueOutcome'];
export type IssueResult = components['schemas']['IssueResult'];
export type VendorDisbursementDetails = components['schemas']['VendorDisbursementDetails'];
export type UpdateVendorDisbursementDetailsRequest =
  components['schemas']['UpdateVendorDisbursementDetailsRequestInput'];
export type BankAccount = components['schemas']['BankAccount'];
export type VendorCredit = components['schemas']['VendorCreditSummary'];
export type DiscountSuggestion = components['schemas']['DiscountSuggestion'];

const ROOT = 'pay-bills';

/**
 * Building a payment changes what a bill has `committed`/`availableToPay` (D-68), and
 * issuing, editing or cancelling one changes the queue itself — so every write here
 * invalidates both scopes rather than trying to patch either surgically. Neither list is
 * paged (`PayableBillList`, `PendingPaymentList` are both plain arrays, bounded per org),
 * so a refetch is the whole answer, not a page of it.
 */
export const payBillsKeys = {
  payableBills: [ROOT, 'payable-bills'] as const,
  pendingPayments: (status: PendingPaymentStatus | null) =>
    [ROOT, 'pending-payments', status] as const,
  pendingPaymentsScope: [ROOT, 'pending-payments'] as const,
  bankAccounts: [ROOT, 'bank-accounts'] as const,
  disbursementDetails: (contactId: string) => [ROOT, 'disbursement-details', contactId] as const,
  vendorCredits: (contactId: string) => [ROOT, 'vendor-credits', contactId] as const,
  discountSuggestion: (billId: string, asOfDate: string) =>
    [ROOT, 'discount-suggestion', billId, asOfDate] as const,
};

async function invalidateAfterWrite(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: payBillsKeys.payableBills }),
    queryClient.invalidateQueries({ queryKey: payBillsKeys.pendingPaymentsScope }),
  ]);
}

/**
 * The Pay Bills window's source list — every approved, non-void, not-fully-paid bill, with
 * payability computed on read (D-34, D-68). Not paged: `PayableBillList` is a plain array.
 */
export function usePayableBills(): UseQueryResult<readonly PayableBill[], Error> {
  return useQuery({
    queryKey: payBillsKeys.payableBills,
    queryFn: async (): Promise<readonly PayableBill[]> =>
      unwrap(await api.GET('/v1/payable-bills', {})).bills,
  });
}

/**
 * The queue. `status` narrows server-side — `open` is what building and issuing usually
 * want, `null` (omitted) is every status, which is what a "history" view would ask for.
 */
export function usePendingPayments(
  status: PendingPaymentStatus | null,
): UseQueryResult<readonly PendingPayment[], Error> {
  return useQuery({
    queryKey: payBillsKeys.pendingPayments(status),
    queryFn: async (): Promise<readonly PendingPayment[]> =>
      unwrap(
        await api.GET('/v1/pending-payments', {
          params: { query: status === null ? {} : { status } },
        }),
      ).pendingPayments,
  });
}

export interface PayBillsVariables {
  readonly payments: readonly CreatePendingPaymentRequest[];
}

/**
 * The batch build (D-63): one element per vendor, because a `PendingPayment` carries one
 * contact and an allocation may never cross contacts. Used for the whole run, including a
 * run of one vendor — there is no separate "single vendor" path on this screen, so a build
 * of any size carries exactly one idempotency key and is one write.
 */
export function usePayBills(): UseMutationResult<
  readonly PendingPayment[],
  Error,
  IdempotentVariables<PayBillsVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ payments, idempotencyKey }: IdempotentVariables<PayBillsVariables>) =>
      unwrap(
        await api.POST('/v1/pay-bills', {
          body: { payments: [...payments] },
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ).pendingPayments,
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

export interface UpdatePendingPaymentVariables {
  readonly pendingPaymentId: string;
  readonly patch: UpdatePendingPaymentRequest;
}

/**
 * Editing an open pending payment — on this screen, rail routing. `PATCH` replaces `intents`
 * wholesale when supplied (`updatePendingPayment`'s own words) so this hook is never used to
 * patch a single line; the queue table only ever sends `{ rail }`.
 */
export function useUpdatePendingPayment(): UseMutationResult<
  PendingPayment,
  Error,
  IdempotentVariables<UpdatePendingPaymentVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      pendingPaymentId,
      patch,
      idempotencyKey,
    }: IdempotentVariables<UpdatePendingPaymentVariables>) =>
      unwrap(
        await api.PATCH('/v1/pending-payments/{pendingPaymentId}', {
          body: patch,
          params: { path: { pendingPaymentId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

/**
 * Cancelling frees every bill the payment named (only `open` intents count toward
 * `committed`, D-68) and posts nothing — a pending payment is pencil (D-64).
 */
export function useCancelPendingPayment(): UseMutationResult<
  PendingPayment,
  Error,
  IdempotentVariables<{ readonly pendingPaymentId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      pendingPaymentId,
      idempotencyKey,
    }: IdempotentVariables<{ readonly pendingPaymentId: string }>) =>
      unwrap(
        await api.POST('/v1/pending-payments/{pendingPaymentId}/cancel', {
          params: { path: { pendingPaymentId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

export interface IssuePendingPaymentVariables {
  readonly pendingPaymentId: string;
  readonly body: IssuePendingPaymentRequest;
}

/**
 * Materialises one pending payment into a real Payment (D-65). The response is an
 * `IssueOutcome`, not a `Payment` — `status: 'failed'` is a normal, non-throwing answer
 * (a bad ACH detail, say), so this never lands in `.isError`; the caller branches on
 * `outcome.status` the way `issue-dialog.tsx` does.
 */
export function useIssuePendingPayment(): UseMutationResult<
  IssueOutcome,
  Error,
  IdempotentVariables<IssuePendingPaymentVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      pendingPaymentId,
      body,
      idempotencyKey,
    }: IdempotentVariables<IssuePendingPaymentVariables>) =>
      unwrap(
        await api.POST('/v1/pending-payments/{pendingPaymentId}/issue', {
          body,
          params: { path: { pendingPaymentId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

export interface IssuePendingPaymentsVariables {
  readonly pendingPaymentIds: readonly string[];
  readonly date: string;
}

/**
 * Issuing several at once. Atomic per payment, not per run (G2/D-63): one bad ACH detail
 * leaves the rest issued and reports that one `failed` in the returned `IssueResult` rather
 * than refusing the whole call, so — like the single-issue hook above — this resolves
 * rather than throws on a partial failure.
 */
export function useIssuePendingPayments(): UseMutationResult<
  IssueResult,
  Error,
  IdempotentVariables<IssuePendingPaymentsVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      pendingPaymentIds,
      date,
      idempotencyKey,
    }: IdempotentVariables<IssuePendingPaymentsVariables>) =>
      unwrap(
        await api.POST('/v1/disbursements/issue', {
          body: { pendingPaymentIds: [...pendingPaymentIds], date },
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient);
    },
  });
}

const PICKER_PAGE_LIMIT = 100;

/**
 * The bank accounts a payment can be drawn from, loaded to the end — a picker, not a view,
 * so it follows `nextCursor` rather than offering the first page and quietly omitting the
 * rest (`money-in/queries.ts`'s `useMoneyAccountOptions` gives the fuller reason). Active
 * only: an inactive bank account takes no new activity.
 */
export function useBankAccountOptions(): readonly BankAccount[] {
  const query = useQuery({
    queryKey: payBillsKeys.bankAccounts,
    queryFn: async (): Promise<readonly BankAccount[]> => {
      const items: BankAccount[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/bank-accounts', {
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
 * A vendor's ACH/wire coordinates (D-67), gated on `contacts.read`/`contacts.write` rather
 * than a Pay-Bills-specific key — these are contact fields, not payment ones.
 */
export function useVendorDisbursementDetails(
  contactId: string | null,
): UseQueryResult<VendorDisbursementDetails, Error> {
  return useQuery({
    queryKey: payBillsKeys.disbursementDetails(contactId ?? ''),
    queryFn: async (): Promise<VendorDisbursementDetails> =>
      unwrap(
        await api.GET('/v1/contacts/{contactId}/disbursement-details', {
          params: { path: { contactId: contactId ?? '' } },
        }),
      ),
    enabled: contactId !== null,
  });
}

export interface UpdateDisbursementDetailsVariables {
  readonly contactId: string;
  readonly patch: UpdateVendorDisbursementDetailsRequest;
}

export function useUpdateVendorDisbursementDetails(): UseMutationResult<
  VendorDisbursementDetails,
  Error,
  IdempotentVariables<UpdateDisbursementDetailsVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      contactId,
      patch,
      idempotencyKey,
    }: IdempotentVariables<UpdateDisbursementDetailsVariables>) =>
      unwrap(
        await api.PATCH('/v1/contacts/{contactId}/disbursement-details', {
          body: patch,
          params: { path: { contactId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: (details, variables) => {
      queryClient.setQueryData(payBillsKeys.disbursementDetails(variables.contactId), details);
    },
  });
}

/**
 * A vendor's spendable credits — approved, with something left on them (D-39's payables
 * mirror). Loaded to the end for the same reason every picker here is: an operator cannot
 * apply a credit they cannot see. Scoped per vendor and fetched only once a vendor group is
 * open, not for every payable bill up front.
 */
export function useVendorCredits(
  contactId: string | null,
): UseQueryResult<readonly VendorCredit[], Error> {
  return useQuery({
    queryKey: payBillsKeys.vendorCredits(contactId ?? ''),
    queryFn: async (): Promise<readonly VendorCredit[]> => {
      const items: VendorCredit[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/vendor-credits', {
            params: {
              query: {
                contactId: contactId ?? '',
                status: 'approved',
                unappliedOnly: 'true',
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
    enabled: contactId !== null,
  });
}

/**
 * The terms-driven discount preview (D-79), asked for a bill this screen is about to pay —
 * the payables side of `money-in/queries.ts`'s own `useDiscountSuggestion`, whose comment
 * explains the `204` handling this copies verbatim: not an error, the ordinary case for a
 * bill with no term, a simple term, or one whose window has passed relative to `asOfDate`.
 *
 * Unlike the money-in receipt screen — which has nowhere to post a manual-receipt discount
 * yet — this one does: `discountAmount`/`discountAccountId` are real fields on
 * `CreatePendingPaymentRequest.intents[]`, so "Apply discount" here fills them rather than
 * only narrating the suggestion.
 */
export function useDiscountSuggestion(
  billId: string | null,
  asOfDate: string,
): UseQueryResult<DiscountSuggestion | null, Error> {
  return useQuery({
    queryKey: payBillsKeys.discountSuggestion(billId ?? '', asOfDate),
    queryFn: async (): Promise<DiscountSuggestion | null> => {
      const result = await api.GET('/v1/payment-terms/discount-suggestion', {
        params: { query: { targetType: 'bill', targetId: billId ?? '', asOfDate } },
      });
      if (result.response.status === 204) return null;
      return unwrap(result);
    },
    enabled: billId !== null && asOfDate !== '',
  });
}

/**
 * One `Idempotency-Key` per user intent (`money-in/queries.ts`'s `useIntentKey` gives the
 * full reasoning). Every write on this screen moves money or reserves it against a vendor's
 * bill, so the same care applies: a duplicated build is a check the business never meant to
 * cut twice, and a duplicated issue is one it actually did.
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
