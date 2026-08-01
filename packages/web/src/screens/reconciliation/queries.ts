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
 * Everything OB-087 calls, and the keys it caches it under (ROADMAP E5–E7, D-45, D-46,
 * D-50, D-51).
 *
 * The keys are local by ticket instruction and there is no shared key module — the same
 * reason `money-in/queries.ts` gives: sibling screens are built in parallel and a single
 * `query-keys.ts` is the one file all of them would have edited. Nothing outside this
 * folder reads them, and nothing in a key names the org — the org is ambient and the
 * switcher clears the cache wholesale (`src/query/client.ts`).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, so this
 * screen cannot describe a balance the server does not serve — which matters more here than
 * anywhere, because every figure except the statement's closing balance is computed on read
 * (D-46) and re-deriving one in the browser is the second definition of a balance that D-46
 * exists to prevent.
 */

export type ReconciliationSession = components['schemas']['ReconciliationSession'];
export type ReconciliationSessionSummary = components['schemas']['ReconciliationSessionSummary'];
export type ReconciliationSessionPage = components['schemas']['ReconciliationSessionPage'];
export type ReconciliationBalances = components['schemas']['ReconciliationBalances'];
export type ReconciliationSessionEvent = components['schemas']['ReconciliationSessionEvent'];
export type ReconciliationReport = components['schemas']['ReconciliationReport'];
export type ReconcilingItem = components['schemas']['ReconcilingItem'];
export type UnclearedStatementLine = components['schemas']['UnclearedStatementLine'];
export type SessionState = ReconciliationSession['state'];
export type CreateSessionRequest = components['schemas']['CreateReconciliationSessionRequestInput'];
export type ReopenRequest = components['schemas']['ReopenReconciliationSessionRequestInput'];
export type BankAccount = components['schemas']['BankAccount'];
export type LedgerAccount = components['schemas']['Account'];

const ROOT = 'reconciliation';

/**
 * A write to a session disturbs two loops and no others.
 *
 * Opening, finalising and reopening all change what the *list* shows (a new session, or a
 * state flipping between open and finalised) and what the session's own *report* says (its
 * balances and its reconciling items are computed on read, D-46/D-50). None of them touch
 * the bank-account directory, so that loop — a picker loaded once — is left alone.
 */
export const reconciliationKeys = {
  sessions: [ROOT, 'sessions'] as const,
  sessionList: (filters: SessionFilters) => [ROOT, 'sessions', 'list', filters] as const,
  session: (sessionId: string) => [ROOT, 'sessions', 'detail', sessionId] as const,
  report: (sessionId: string) => [ROOT, 'report', sessionId] as const,
  reports: [ROOT, 'report'] as const,
  bankAccounts: [ROOT, 'bank-accounts'] as const,
  ledgerAccount: (accountId: string) => [ROOT, 'ledger-account', accountId] as const,
};

async function invalidateAfterWrite(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: reconciliationKeys.sessions }),
    queryClient.invalidateQueries({ queryKey: reconciliationKeys.reports }),
  ]);
}

/**
 * `null` is "no filter" rather than a value, and it is `null` rather than `undefined`
 * because this object is hashed into a query key: `JSON.stringify` drops an `undefined`
 * member and keeps a `null` one, so two filter sets differing only in which they used would
 * share a cache entry (the same trap `money-in/queries.ts` documents).
 */
export interface SessionFilters {
  readonly bankAccountId: string | null;
  readonly state: SessionState | null;
}

export const NO_SESSION_FILTERS: SessionFilters = {
  bankAccountId: null,
  state: null,
};

function toWireFilters(filters: SessionFilters): Record<string, string> {
  const wire: Record<string, string> = {};
  if (filters.bankAccountId !== null) wire['bankAccountId'] = filters.bankAccountId;
  if (filters.state !== null) wire['state'] = filters.state;
  return wire;
}

/**
 * The sessions for a bank account, the server's order kept verbatim (newest by end date).
 *
 * Keyset-paged, and `getNextPageParam` returns `nextCursor` and nothing else: presence is
 * the only signal another page exists — a full page does not imply one — so deriving it
 * from `items.length` would ask for a page that is not there (D-21, restated on this
 * endpoint).
 */
export function useSessionList(
  filters: SessionFilters,
): UseInfiniteQueryResult<InfiniteData<ReconciliationSessionPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: reconciliationKeys.sessionList(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/reconciliation-sessions', {
          params: {
            query: {
              ...toWireFilters(filters),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // A session cannot be listed until an account is chosen: the list is per account, and
    // "every session across every account" is not a view this screen offers.
    enabled: filters.bankAccountId !== null,
  });
}

/**
 * One session with its event log and its balances. Every figure on it except
 * `balances.statementClosingBalance` is computed on read (D-46), so what this returns is
 * always the current reconciliation state — there is nothing to recompute.
 */
export function useSession(sessionId: string | null): UseQueryResult<ReconciliationSession, Error> {
  return useQuery({
    queryKey: reconciliationKeys.session(sessionId ?? ''),
    queryFn: async (): Promise<ReconciliationSession> =>
      unwrap(
        await api.GET('/v1/reconciliation-sessions/{sessionId}', {
          params: { path: { sessionId: sessionId ?? '' } },
        }),
      ),
    enabled: sessionId !== null,
  });
}

/**
 * The reconciliation report: the reconciling items that explain the gap between the ledger
 * and the bank. `reconcilingItems` sum to `balances.unclearedAmount` exactly (D-50), and the
 * uncleared statement lines are the other half — shown, but outside that sum because a line
 * with no journal moves neither balance.
 */
export function useReconciliationReport(
  sessionId: string | null,
): UseQueryResult<ReconciliationReport, Error> {
  return useQuery({
    queryKey: reconciliationKeys.report(sessionId ?? ''),
    queryFn: async (): Promise<ReconciliationReport> =>
      unwrap(
        await api.GET('/v1/reconciliation-sessions/{sessionId}/report', {
          params: { path: { sessionId: sessionId ?? '' } },
        }),
      ),
    enabled: sessionId !== null,
  });
}

export function useCreateSession(): UseMutationResult<
  ReconciliationSession,
  Error,
  IdempotentVariables<CreateSessionRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateSessionRequest>) =>
      unwrap(
        await api.POST('/v1/reconciliation-sessions', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (session) => {
      await invalidateAfterWrite(queryClient);
      // Seeded, not refetched: the 201 body is the session the detail panel is about to
      // render, balances and events included.
      queryClient.setQueryData(reconciliationKeys.session(session.id), session);
    },
  });
}

/**
 * Records the assertion (E5). Takes no body — everything it needs is on the session — and
 * is refused unless the cleared balance equals the statement's closing balance at the end
 * date (`reconciliation_session_balance_mismatch`). The refusal is the server's to make: the
 * balances are computed on read, so the figure that decides is the one the server holds at
 * the moment of the call, not the one this screen last drew (D-50).
 */
export function useFinaliseSession(): UseMutationResult<
  ReconciliationSession,
  Error,
  IdempotentVariables<{ readonly sessionId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/reconciliation-sessions/{sessionId}/finalise', {
          params: { path: { sessionId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (session) => {
      await invalidateAfterWrite(queryClient);
      queryClient.setQueryData(reconciliationKeys.session(session.id), session);
    },
  });
}

export interface ReopenVariables {
  readonly sessionId: string;
  readonly reason: string;
}

/**
 * Reverts a finalised session to open, thawing its membership so its clearings can change
 * again (E6, D-51). `reason` is required and kept on the event — the one part of the record a
 * later reader cannot reconstruct. It is `banking.reopen`-gated; a role without the
 * permission is refused with `permission_denied`, which the caller surfaces.
 */
export function useReopenSession(): UseMutationResult<
  ReconciliationSession,
  Error,
  IdempotentVariables<ReopenVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, reason, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/reconciliation-sessions/{sessionId}/reopen', {
          body: { reason },
          params: { path: { sessionId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (session) => {
      await invalidateAfterWrite(queryClient);
      queryClient.setQueryData(reconciliationKeys.session(session.id), session);
    },
  });
}

/**
 * The bank accounts a session can be opened against, loaded to the end.
 *
 * A picker, not a view, so the fetcher follows `nextCursor` to the last page rather than
 * offering the first and quietly omitting the rest — a bank account the user cannot find in
 * the picker is assumed not to exist. Active only: an inactive account keeps its history but
 * accepts no new reconciliation (the `BankAccount` note in the schema).
 */
const PICKER_PAGE_LIMIT = 100;

export function useBankAccountOptions(): readonly BankAccount[] {
  const query = useQuery({
    queryKey: reconciliationKeys.bankAccounts,
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
 * The ledger account a bank account *is* (D-46), fetched only for the one thing this screen
 * cannot read off the `BankAccount` DTO: its `normalBalance`. The balances the server now
 * sends are in the account's normal frame (OB-227b), so on a credit-normal account — a
 * credit card over a liability — a positive figure is the amount *owed*, and the balances
 * panel needs the normal balance to say so rather than leaving the sign to be misread.
 *
 * A single `GET /v1/accounts/{accountId}`, disabled until an account is chosen; the account's
 * type and normal balance are immutable once it carries postings (the `Account` schema note),
 * so the default cache staleness is fine and no write on this screen touches it.
 */
export function useLedgerAccount(accountId: string | null): UseQueryResult<LedgerAccount, Error> {
  return useQuery({
    queryKey: reconciliationKeys.ledgerAccount(accountId ?? ''),
    queryFn: async (): Promise<LedgerAccount> =>
      unwrap(
        await api.GET('/v1/accounts/{accountId}', {
          params: { path: { accountId: accountId ?? '' } },
        }),
      ),
    enabled: accountId !== null,
  });
}

/**
 * One `Idempotency-Key` per user intent, and a new one exactly when the intent changes —
 * the same rule `money-in/queries.ts` sets out at length.
 *
 * A *retry* carries the **same** key: that is how the server tells "the user asked twice"
 * from "the network dropped the response" (`src/api/idempotency.ts`). So the key is bound to
 * a fingerprint of what is being sent — the session and, for a reopen, its reason — and a
 * corrected field mints a fresh key rather than colliding with the old one on
 * `idempotency_key_conflict`. Opening a session moves money into no journal, but a
 * double-opened session is still a second assertion the account did not need; finalise and
 * reopen are exactly-once for the same reason.
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
