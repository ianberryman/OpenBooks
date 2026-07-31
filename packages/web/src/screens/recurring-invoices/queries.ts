import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-133 asks of `/v1/recurring-invoices`, and the reference data its form
 * pickers need (OB-128, OB-130; ROADMAP D-75, D-76).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, for
 * `sales/queries.ts`' reason: there is no hand-written mirror of a wire shape anywhere in
 * this package, and one would be a second contract the day either drifts.
 *
 * ## What a template is not
 *
 * A template holds no `netAmount`, no `taxAmount` and no `grossAmount` on its lines, and
 * nothing here computes one — `RecurringInvoiceLine`'s own description says why: "a
 * template is not a posted document". Each cycle is priced by `createInvoice` when the
 * engine materialises it, from the inputs this screen collects. There is also no `status`:
 * a template is simply active or not, and that is the one flag this screen writes after
 * creation — `isActive` through the general `PATCH`, because there is no dedicated
 * pause/resume route. `POST …/deactivate` is the one-way door; clearing `isActive` by hand
 * is the reversible pause.
 */
export type RecurringInvoiceTemplate = components['schemas']['RecurringInvoiceTemplate'];
export type RecurringInvoiceTemplatePage = components['schemas']['RecurringInvoiceTemplatePage'];
export type RecurringInvoiceLine = components['schemas']['RecurringInvoiceLine'];
export type TemplateLineRequest = components['schemas']['RecurringInvoiceLineInput'];
export type CreateTemplateRequest =
  components['schemas']['CreateRecurringInvoiceTemplateRequestInput'];
export type UpdateTemplateRequest =
  components['schemas']['UpdateRecurringInvoiceTemplateRequestInput'];
export type TemplateFrequency = RecurringInvoiceTemplate['frequency'];
export type TemplateTaxMode = RecurringInvoiceTemplate['taxMode'];
export type TemplateMaterializationMode = RecurringInvoiceTemplate['materializationMode'];

export type Contact = components['schemas']['Contact'];
export type Account = components['schemas']['Account'];
export type TaxRate = components['schemas']['TaxRate'];

/**
 * Query keys, local to this screen — there is no shared key module (`contacts/queries.ts`'
 * reason: a shared file is the one thing every parallel screen would edit at once, and the
 * org switch already clears the cache wholesale, so nothing depends on two screens
 * agreeing about a key).
 */
const TEMPLATES_SCOPE = ['recurring-invoices', 'templates'] as const;

export function templateListQueryKey(activeOnly: boolean | null): readonly unknown[] {
  return [...TEMPLATES_SCOPE, 'list', activeOnly];
}

export const referenceKeys = {
  contacts: ['recurring-invoices', 'contacts'] as const,
  accounts: ['recurring-invoices', 'income-accounts'] as const,
  taxRates: ['recurring-invoices', 'tax-rates'] as const,
};

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `sales/queries.ts`' bound: a picker that pages forever hangs the tab. */
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

export interface TemplateReferenceData {
  readonly contacts: readonly Contact[];
  readonly accounts: readonly Account[];
  readonly taxRates: readonly TaxRate[];
  readonly contactsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly taxRatesById: ReadonlyMap<string, TaxRate>;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Contacts, income accounts and sales tax rates, as one thing that is either loaded or not
 * — `sales/queries.ts`' `useSalesReferenceData`, mirrored rather than imported: each screen
 * folder is self-contained (no screen imports another's `queries.ts`), so a second, small
 * copy is the cost of that rather than a cross-screen dependency.
 *
 * `type: 'revenue'` is not cosmetic: a line's `accountId` is "the income account this line
 * credits on the invoice each cycle materialises" (`RecurringInvoiceLine`'s own words), so
 * an asset or expense account is never a valid choice here and is not offered rather than
 * offered and refused. `appliesTo: 'sales'` on tax rates is the same idea applied to tax —
 * every cycle materialises an invoice, never a bill, so a purchases-only rate would post
 * reclaimable input tax against a sale.
 *
 * All three arrive unfiltered by their own active flag: a template saved while a contact,
 * account or rate was active still names it after that thing is archived, and a picker
 * that had never heard of it would show an empty box where the template's own choice is.
 * They are offered disabled instead — see `template-form.tsx`.
 */
export function useTemplateReferenceData(): {
  readonly data: TemplateReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const contacts = useQuery({
    queryKey: referenceKeys.contacts,
    queryFn: async () =>
      collect<Contact>(async (cursor) =>
        unwrap(await api.GET('/v1/contacts', { params: { query: pageQuery(cursor) } })),
      ),
  });

  const accounts = useQuery({
    queryKey: referenceKeys.accounts,
    queryFn: async () =>
      collect<Account>(async (cursor) =>
        unwrap(
          await api.GET('/v1/accounts', {
            params: { query: { ...pageQuery(cursor), type: 'revenue' } },
          }),
        ),
      ),
  });

  const taxRates = useQuery({
    queryKey: referenceKeys.taxRates,
    queryFn: async () =>
      collect<TaxRate>(async (cursor) =>
        unwrap(
          await api.GET('/v1/tax-rates', {
            params: { query: { ...pageQuery(cursor), appliesTo: 'sales' } },
          }),
        ),
      ),
  });

  const data = useMemo<TemplateReferenceData | null>(() => {
    if (contacts.data === undefined || accounts.data === undefined || taxRates.data === undefined) {
      return null;
    }
    return {
      contacts: contacts.data,
      accounts: accounts.data,
      taxRates: taxRates.data,
      contactsById: index(contacts.data),
      accountsById: index(accounts.data),
      taxRatesById: index(taxRates.data),
    };
  }, [contacts.data, accounts.data, taxRates.data]);

  return {
    data,
    error: contacts.error ?? accounts.error ?? taxRates.error,
    refetch: () => {
      void contacts.refetch();
      void accounts.refetch();
      void taxRates.refetch();
    },
  };
}

/**
 * The list, keyset-paged over `(created_at, id)` — `contacts/queries.ts`' shape, for the
 * same reason: presence of `nextCursor` is the only signal that more exists, so
 * `getNextPageParam` returns it verbatim rather than deriving an answer from `items.length`.
 */
export function useTemplateList(
  activeOnly: boolean | null,
): UseInfiniteQueryResult<InfiniteData<RecurringInvoiceTemplatePage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: templateListQueryKey(activeOnly),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/recurring-invoices', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(activeOnly === null ? {} : { isActive: String(activeOnly) }),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * One idempotency key per user intent, and an intent is identified by what it would write
 * — `contacts/queries.ts`' `useIntentKey`, copied rather than imported for the same
 * self-containment reason `useTemplateReferenceData` gives.
 *
 * Minting a fresh key per *attempt* would turn a retry after a dropped response into a
 * second template; minting once per *dialog* would leave a corrected form unable to
 * resubmit once the server has refused the first body (`idempotency_key_conflict`). So the
 * key is held against a fingerprint of what would be sent, and only a changed fingerprint
 * gets a new one.
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

function invalidateTemplates(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: TEMPLATES_SCOPE });
}

export function useCreateTemplate(): UseMutationResult<
  RecurringInvoiceTemplate,
  Error,
  IdempotentVariables<CreateTemplateRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateTemplateRequest>) =>
      unwrap(
        await api.POST('/v1/recurring-invoices', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateTemplates(queryClient);
    },
  });
}

export interface UpdateTemplateVariables {
  readonly templateId: string;
  readonly patch: UpdateTemplateRequest;
}

export function useUpdateTemplate(): UseMutationResult<
  RecurringInvoiceTemplate,
  Error,
  IdempotentVariables<UpdateTemplateVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/recurring-invoices/{templateId}', {
          body: patch,
          params: { path: { templateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateTemplates(queryClient);
    },
  });
}

export interface SetTemplateActiveVariables {
  readonly templateId: string;
  readonly active: boolean;
}

/**
 * Pause and resume as one hook over the one route both are — there is no dedicated
 * pause/resume endpoint, only `PATCH { isActive }` (unlike `contacts/queries.ts`'
 * `useSetContactActive`, which has a route each). Reversible in both directions, which is
 * exactly what makes it the wrong control for retiring a template for good — see
 * `useDeactivateTemplate`.
 */
export function useSetTemplateActive(): UseMutationResult<
  RecurringInvoiceTemplate,
  Error,
  IdempotentVariables<SetTemplateActiveVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, active, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/recurring-invoices/{templateId}', {
          body: { isActive: active },
          params: { path: { templateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateTemplates(queryClient);
    },
  });
}

/**
 * The one-way retirement. Idempotent on the server — an already-inactive template comes
 * back unchanged rather than refused — so this is safe to send again after a dropped
 * response with the same key, which is exactly what a plain retry does.
 */
export function useDeactivateTemplate(): UseMutationResult<
  RecurringInvoiceTemplate,
  Error,
  IdempotentVariables<{ readonly templateId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/recurring-invoices/{templateId}/deactivate', {
          params: { path: { templateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateTemplates(queryClient);
    },
  });
}
