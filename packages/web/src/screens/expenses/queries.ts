import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, expectNoContent, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything this screen asks of `/v1/expenses`, plus the two reference lists its form
 * needs (the chart, and the employees an expense may name).
 *
 * ## An expense is a bill (D-M1, D-M2)
 *
 * There is no `Expense` schema on the wire — `createExpense` and `getExpense` both answer
 * `Bill`, and `/v1/expenses` is `/v1/bills` filtered to contacts carrying `isEmployee`
 * (`listExpenses`'s own words). This module therefore types everything off `Bill`/
 * `BillSummary`/`BillPage`, exactly as `purchases/queries.ts` does for a vendor bill —
 * there is no second, hand-written shape for "an expense" to drift from the one the
 * server actually returns.
 *
 * ## Why the employee picker filters client-side
 *
 * `GET /v1/contacts` takes `isCustomer` and `isVendor` as querystring filters but no
 * `isEmployee` — `listContacts`'s own parameters. So `useExpenseReferenceData` fetches
 * every active contact once, the same page-collection `collectActiveAccounts` already
 * does for the chart, and narrows to `isEmployee` client-side, mirroring how
 * `fixed-assets/queries.ts` slices one active-accounts fetch three ways rather than
 * filtering server-side three times.
 */
export type Bill = components['schemas']['Bill'];
export type BillSummary = components['schemas']['BillSummary'];
export type BillPage = components['schemas']['BillPage'];
export type CreateExpenseRequest = components['schemas']['CreateExpenseRequestInput'];
export type UpdateExpenseRequest = components['schemas']['UpdateExpenseRequestInput'];
export type DocumentLine = components['schemas']['DocumentLine'];
export type DocumentLineRequest = components['schemas']['DocumentLineRequestInput'];
export type ExpenseStatus = Bill['status'];

export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];

/**
 * Query keys, local to this screen — `fixed-assets/queries.ts`'s reason: there is no
 * shared key module, so a second screen changing shape never has to agree with this one
 * about what its keys mean.
 */
const EXPENSES_SCOPE = ['expenses'] as const;

export function expenseListQueryKey(status: ExpenseStatus | null): readonly unknown[] {
  return [...EXPENSES_SCOPE, 'list', status];
}

function expenseDetailQueryKey(expenseId: string): readonly unknown[] {
  return [...EXPENSES_SCOPE, 'detail', expenseId];
}

const ACCOUNTS_QUERY_KEY = ['expenses', 'accounts'] as const;
export const EMPLOYEE_CONTACTS_QUERY_KEY = ['expenses', 'employee-contacts'] as const;

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `fixed-assets/queries.ts`'s bound: a picker that pages forever hangs the tab. */
const MAX_PAGES = 50;

async function collectActiveAccounts(): Promise<readonly Account[]> {
  const items: Account[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = unwrap(
      await api.GET('/v1/accounts', {
        params: {
          query: {
            isActive: 'true',
            limit: PAGE_LIMIT,
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
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} active accounts behind one picker. Refusing ` +
      `to keep paging rather than list part of the chart as though it were all of it.`,
  );
}

/**
 * Every active contact — vendors, customers, employees, any combination. `isEmployee` is
 * narrowed client-side in `useExpenseReferenceData`; see this module's own commentary for
 * why the server offers no such filter to ask for instead.
 */
async function collectActiveContacts(): Promise<readonly Contact[]> {
  const items: Contact[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = unwrap(
      await api.GET('/v1/contacts', {
        params: {
          query: {
            isActive: 'true',
            limit: PAGE_LIMIT,
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
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} active contacts behind one picker. Refusing ` +
      `to keep paging rather than list part of the directory as though it were all of it.`,
  );
}

export interface ExpenseReferenceData {
  readonly accounts: readonly Account[];
  readonly accountsById: ReadonlyMap<string, Account>;
  /** Active contacts carrying `isEmployee` — the only contacts a `contactId` may name here
   *  (`contact_is_not_an_employee` otherwise). A contact that is also a vendor still
   *  appears, exactly as `listExpenses`'s own description allows. */
  readonly employees: readonly Contact[];
  readonly employeesById: ReadonlyMap<string, Contact>;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function useExpenseReferenceData(): {
  readonly data: ExpenseReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: collectActiveAccounts,
  });
  const contacts = useQuery({
    queryKey: EMPLOYEE_CONTACTS_QUERY_KEY,
    queryFn: collectActiveContacts,
  });

  const data = useMemo<ExpenseReferenceData | null>(() => {
    if (accounts.data === undefined || contacts.data === undefined) return null;
    const employees = contacts.data.filter((contact) => contact.isEmployee);
    return {
      accounts: accounts.data,
      accountsById: index(accounts.data),
      employees,
      employeesById: index(employees),
    };
  }, [accounts.data, contacts.data]);

  return {
    data,
    error: accounts.error ?? contacts.error,
    refetch: () => {
      void accounts.refetch();
      void contacts.refetch();
    },
  };
}

/**
 * The expense list, keyset-paged over `(created_at, id)` — `fixed-assets/queries.ts`'s
 * `useFixedAssetList` shape: presence of `nextCursor` is the only signal that more exists.
 */
export function useExpenseList(
  status: ExpenseStatus | null,
): UseInfiniteQueryResult<InfiniteData<BillPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: expenseListQueryKey(status),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/expenses', {
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

export interface ExpenseResult {
  readonly expense: Bill | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * One expense with its lines — fetched separately from the list because `BillSummary`
 * (what the list holds) carries none, exactly the split `purchases/queries.ts`'s
 * `useBill` makes for the same reason. `null` fetches nothing: opening the form to create
 * has no id to ask for yet.
 */
export function useExpense(expenseId: string | null): ExpenseResult {
  const query = useQuery({
    queryKey: expenseDetailQueryKey(expenseId ?? ''),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/expenses/{expenseId}', {
          params: { path: { expenseId: expenseId ?? '' } },
        }),
      ),
    enabled: expenseId !== null,
  });

  return {
    expense: query.data ?? null,
    isPending: expenseId !== null && query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
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

/**
 * One key per `(operation, expenseId)`, for the two row actions that carry no body at all
 * — approve and discard. `purchases/intent-keys.ts`'s `documentIntentKey` shape: a
 * module-level map rather than a hook, so the key survives a row's own component
 * unmounting between a click and a retry, and a double click is one intent rather than
 * two journals.
 */
const rowIntentKeys = new Map<string, string>();

export function expenseIntentKey(operation: string, expenseId: string): string {
  const cacheKey = `${operation}:${expenseId}`;
  const existing = rowIntentKeys.get(cacheKey);
  if (existing !== undefined) return existing;

  const minted = newIdempotencyKey();
  rowIntentKeys.set(cacheKey, minted);
  return minted;
}

export function releaseExpenseIntentKey(operation: string, expenseId: string): void {
  rowIntentKeys.delete(`${operation}:${expenseId}`);
}

function invalidateExpenses(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: EXPENSES_SCOPE });
}

export function useCreateExpense(): UseMutationResult<
  Bill,
  Error,
  IdempotentVariables<CreateExpenseRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateExpenseRequest>) =>
      unwrap(
        await api.POST('/v1/expenses', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateExpenses(queryClient);
    },
  });
}

export interface UpdateExpenseVariables {
  readonly expenseId: string;
  readonly patch: UpdateExpenseRequest;
}

export function useUpdateExpense(): UseMutationResult<
  Bill,
  Error,
  IdempotentVariables<UpdateExpenseVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ expenseId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/expenses/{expenseId}', {
          body: patch,
          params: { path: { expenseId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateExpenses(queryClient);
    },
  });
}

export interface ApproveExpenseVariables {
  readonly expenseId: string;
}

/**
 * The irreversible step (D-38): posts the journal, allocates the gapless number, and turns
 * a draft into a payable. There is no field to collect for it — the route carries no
 * body — so this mutation exists to carry the one thing that is not free: the
 * idempotency key a double click must not turn into two journals.
 */
export function useApproveExpense(): UseMutationResult<
  Bill,
  Error,
  IdempotentVariables<ApproveExpenseVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ expenseId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/expenses/{expenseId}/approve', {
          params: { path: { expenseId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateExpenses(queryClient);
    },
  });
}

export interface DiscardExpenseVariables {
  readonly expenseId: string;
}

export function useDiscardExpense(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<DiscardExpenseVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ expenseId, idempotencyKey }) => {
      expectNoContent(
        await api.DELETE('/v1/expenses/{expenseId}', {
          params: { path: { expenseId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidateExpenses(queryClient);
    },
  });
}
