import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryClient,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything the bank-account setup screen calls, and the keys it caches it under
 * (OB-095, for the register/deactivate OB-084 deferred; ROADMAP D-46).
 *
 * The keys are local by the same reasoning `reconciliation/queries.ts` and
 * `money-in/queries.ts` give: sibling screens are built in parallel, and a single shared
 * key module is the one file all of them would have edited. Nothing outside this folder
 * reads them, and nothing in a key names the org — the org is ambient and the switcher
 * clears the cache wholesale (`src/query/client.ts`).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, so this
 * screen cannot describe a bank account the server does not serve. A bank account *is* a
 * ledger account plus import metadata (D-46) — there is no balance here, because the
 * balance is the ledger account's, read through the reports a client already has.
 */

export type BankAccount = components['schemas']['BankAccount'];
export type BankAccountPage = components['schemas']['BankAccountPage'];
export type CreateBankAccountBody = components['schemas']['CreateBankAccountRequestInput'];
export type Account = components['schemas']['Account'];

const ROOT = 'bank-accounts';

/**
 * A write disturbs the bank-account list and nothing else here. The ledger-account picker
 * (`ledgerAccounts`) is a directory loaded once and left alone — registering a bank
 * account does not change the chart it was chosen from.
 */
export const bankAccountKeys = {
  everything: [ROOT] as const,
  list: (isActive: boolean | null) => [ROOT, 'list', isActive] as const,
  ledgerAccounts: [ROOT, 'ledger-accounts'] as const,
};

async function invalidateList(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: bankAccountKeys.everything });
}

/**
 * One page of bank accounts, oldest first by creation (D-21), the server's order kept
 * verbatim. `getNextPageParam` returns `nextCursor` and nothing else: presence is the only
 * signal another page exists — a full page does not imply one — so deriving it from
 * `items.length` would request a page that is not there.
 *
 * `isActive: null` is "active and inactive alike"; the setup screen shows both, because a
 * deactivated account is exactly what a reader comes here to reactivate.
 */
const PAGE_LIMIT = 100;

export function useBankAccountList(
  isActive: boolean | null,
): UseInfiniteQueryResult<InfiniteData<BankAccountPage, string | undefined>, Error> {
  return useInfiniteQuery({
    queryKey: bankAccountKeys.list(isActive),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/bank-accounts', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              // The route coerces this one with `z.stringbool()`, so the generated
              // parameter is a string and `String(false)` is `'false'`, not an omission.
              ...(isActive === null ? {} : { isActive: String(isActive) }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useCreateBankAccount(): UseMutationResult<
  BankAccount,
  Error,
  IdempotentVariables<CreateBankAccountBody>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateBankAccountBody>) =>
      unwrap(
        await api.POST('/v1/bank-accounts', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateList(queryClient);
    },
  });
}

export interface SetActiveVariables {
  readonly bankAccountId: string;
  readonly isActive: boolean;
}

/**
 * Deactivate and reactivate are two routes, not a flag on the patch (OB-095), and this
 * helper keeps them two calls rather than collapsing them into a boolean at the transport
 * edge — the two mean different things to a reader of the books, and deactivation carries
 * a guard reactivation does not: it is refused with `bank_account_has_open_session` while a
 * reconciliation session on the account is still open (`refusal.ts` maps it).
 */
export function useSetBankAccountActive(): UseMutationResult<
  BankAccount,
  Error,
  IdempotentVariables<SetActiveVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bankAccountId, isActive, idempotencyKey }) => {
      const path = isActive
        ? ('/v1/bank-accounts/{bankAccountId}/reactivate' as const)
        : ('/v1/bank-accounts/{bankAccountId}/deactivate' as const);
      return unwrap(
        await api.POST(path, {
          params: { path: { bankAccountId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidateList(queryClient);
    },
  });
}

/**
 * The ledger accounts a bank account can be registered over (D-46), loaded to the end.
 *
 * A picker, not a view, so the fetcher follows `nextCursor` to the last page rather than
 * offering the first and quietly omitting the rest — a ledger account the user cannot find
 * in the picker is assumed not to exist. Filtered to active `asset` accounts: a bank
 * account is an asset in every ordinary chart, and an inactive account accepts nothing new.
 * The server does not enforce the type — it will register any ledger account — so this is a
 * narrowing for the person choosing, not a rule this screen invents (D-23).
 */
const PICKER_PAGE_LIMIT = 100;

export function useLedgerAccountOptions(): UseQueryResult<readonly Account[], Error> {
  return useQuery({
    queryKey: bankAccountKeys.ledgerAccounts,
    queryFn: async (): Promise<readonly Account[]> => {
      const items: Account[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/accounts', {
            params: {
              query: {
                type: 'asset',
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
}

/**
 * One `Idempotency-Key` per user intent, minted afresh exactly when the intent changes —
 * the rule `reconciliation/queries.ts` and `money-in/queries.ts` set out. A *retry* carries
 * the **same** key, which is how the server tells "the user asked twice" from "the network
 * dropped the response" (`src/api/idempotency.ts`); a corrected field mints a fresh key
 * rather than colliding with the old one on `idempotency_key_conflict`.
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
