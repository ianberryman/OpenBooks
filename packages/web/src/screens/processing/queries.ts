import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components, operations } from '../../api';

/**
 * Everything OB-151 asks of `/v1/processing/connections`, and the ledger accounts its
 * connect dialog picks from (OB-147, OB-150; ROADMAP D-82…D-86, D-101…D-104).
 *
 * ## No `components['schemas']['ProcessorConnection']`
 *
 * `connections.ts`'s own header explains why: the schema carries no `.meta({ id })` yet,
 * so `openapi.json` never registers it under `components.schemas` and the generated
 * client only knows its shape per-operation. The types below are read off `operations[…]`
 * instead — still generated, still never hand-restated, just indexed one level deeper
 * than `components['schemas']` reaches.
 *
 * ## `GET /v1/processing/connections` returns a bare array
 *
 * `processing.ts`'s own header: `uq_processor_connections_org_processor` bounds an org to
 * at most one row per `ProcessorKind` — three today — so this is a plain `useQuery`, not
 * the `useInfiniteQuery` every cursor-paged list on this surface uses.
 *
 * ## `secretKey`/`webhookSecret` are inbound-only (D-83)
 *
 * `ConnectProcessorRequest` carries them; `ProcessorConnection` — everything a `GET`
 * returns — does not, and this module has no code path that could echo one: there is no
 * type here a secret could travel back out through even by accident.
 */
export type ProcessorConnection =
  operations['getProcessorConnection']['responses'][200]['content']['application/json'];
export type ConnectProcessorRequest =
  operations['connectProcessor']['requestBody']['content']['application/json'];
export type Account = components['schemas']['Account'];

/**
 * Query keys, local to this screen — no shared key module, for `recurring-invoices/
 * queries.ts`'s reason: every screen folder is self-contained, and the org switch clears
 * the query cache wholesale regardless (`src/query/client.ts`), so nothing depends on two
 * screens agreeing about a key.
 */
const CONNECTIONS_SCOPE = ['processing', 'connections'] as const;
const ACCOUNTS_KEY = ['processing', 'accounts'] as const;

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `recurring-invoices/queries.ts`'s bound: a picker that pages forever hangs the tab. */
const MAX_PAGES = 50;

function invalidateConnections(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: CONNECTIONS_SCOPE });
}

export function useConnectionList(): {
  readonly connections: readonly ProcessorConnection[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: CONNECTIONS_SCOPE,
    queryFn: async () => unwrap(await api.GET('/v1/processing/connections')),
  });

  return {
    connections: query.data ?? [],
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useConnectProcessor(): UseMutationResult<
  ProcessorConnection,
  Error,
  IdempotentVariables<ConnectProcessorRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<ConnectProcessorRequest>) =>
      unwrap(
        await api.POST('/v1/processing/connections', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateConnections(queryClient);
    },
  });
}

export interface SetConnectionActiveVariables {
  readonly connectionId: string;
  readonly active: boolean;
}

/**
 * Deactivate and reactivate as two routes, not a flag on a patch — `bank-accounts/
 * queries.ts`'s `useSetBankAccountActive`, mirrored for the identical shape
 * (`processing.ts`'s header: idempotency matters here, and a `PATCH` would be a second
 * way to reach the same transition with no `Idempotency-Key` semantics of its own).
 * Unlike a bank account, there is no open-session guard to surface: `connections.service.
 * ts` notes a processor connection strands nothing when deactivated, so any refusal here
 * falls to the shared `ErrorBanner` rather than a bespoke reading.
 */
export function useSetConnectionActive(): UseMutationResult<
  ProcessorConnection,
  Error,
  IdempotentVariables<SetConnectionActiveVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ connectionId, active, idempotencyKey }) => {
      const path = active
        ? ('/v1/processing/connections/{connectionId}/reactivate' as const)
        : ('/v1/processing/connections/{connectionId}/deactivate' as const);
      return unwrap(
        await api.POST(path, {
          params: { path: { connectionId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidateConnections(queryClient);
    },
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

export interface ProcessingReferenceData {
  /** Every active account, indexed by id — how the list resolves a connection's
   *  `clearingAccountId`/`feeAccountId` to a code and a name, for any account type: the
   *  server does not restrict either field to one type (D-23), so the lookup does not
   *  either. */
  readonly accountsById: ReadonlyMap<string, Account>;
  /** Offered for `clearingAccountId` — an asset in every ordinary chart (D-82's "before
   *  any payout reaches the bank"). Not a server-enforced rule (`connections.ts`'s own
   *  header), so this is the connect dialog's narrowing, not the API's. */
  readonly clearingAccountOptions: readonly Account[];
  /** Offered for `feeAccountId` — the processor's cut is an expense (D-104/D-84). Same
   *  caveat as `clearingAccountOptions`: the server accepts any active account. */
  readonly feeAccountOptions: readonly Account[];
}

/**
 * One fetch of every active ledger account, sliced three ways: the full map a
 * connection's stored ids resolve against, and the two type-narrowed lists the connect
 * dialog's pickers offer. One network round trip rather than three, because every option
 * either list could offer is already present in the unfiltered set.
 */
export function useProcessingReferenceData(): {
  readonly data: ProcessingReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const accounts = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: async () =>
      collect<Account>(async (cursor) =>
        unwrap(
          await api.GET('/v1/accounts', {
            params: {
              query: {
                isActive: 'true',
                limit: PAGE_LIMIT,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        ),
      ),
  });

  const data = useMemo<ProcessingReferenceData | null>(() => {
    if (accounts.data === undefined) return null;
    return {
      accountsById: new Map(accounts.data.map((account) => [account.id, account])),
      clearingAccountOptions: accounts.data.filter((account) => account.type === 'asset'),
      feeAccountOptions: accounts.data.filter((account) => account.type === 'expense'),
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
 * One idempotency key per user intent — `recurring-invoices/queries.ts`'s
 * `useIntentKey`, copied rather than imported for the self-containment reason its own
 * comment gives.
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
