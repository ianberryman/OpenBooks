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
 * Everything OB-105 asks of `/v1/agent-proposals` (OB-060, OB-103, OB-104; ROADMAP D-19,
 * D-60), plus the accounts a line's `accountId` resolves against.
 *
 * ## A proposal *is* a journal draft
 *
 * `listProposals`'s own description: "the same collection `GET /v1/journal-drafts` lists,
 * gated on `agents.review` instead of `journals.read`". There is no separate "proposal"
 * shape anywhere in `openapi.json` — `JournalDraftSummary`/`JournalDraft` are exactly
 * what this screen reads, and approving one is `POST /v1/journal-drafts/{draftId}/post`
 * reached through a differently-permissioned route (`approveProposal`'s description).
 *
 * ## Why the review dialog fetches lines from `/v1/journal-drafts/{draftId}`, not a
 * ## second `/v1/agent-proposals/{draftId}`
 *
 * `GET /v1/agent-proposals` answers `JournalDraftPage`, whose items are
 * `JournalDraftSummary` — the header only, no `lines`. There is no
 * `GET /v1/agent-proposals/{draftId}` in `openapi.json` to fetch one proposal's lines
 * under the `agents.review` gate; the only route that returns lines is
 * `GET /v1/journal-drafts/{draftId}`, gated `journals.read`. Since a proposal is the same
 * underlying row the server's own `agent-proposals.ts` states plainly ("every proposal
 * here *is* an ordinary `journal_drafts` row"), reaching for that route here is correct data —
 * it is not a workaround that reads a different record. It is, however, a second
 * permission gate this screen's own list does not have: the seeded Approver role holds
 * both `agents.review` and `journals.post` together (`agent-proposals.ts`'s own comment),
 * and holding `journals.post` without `journals.read` is not a combination the seeded
 * roles produce, so this is expected to succeed for the caller this screen is built for.
 * A caller with `agents.review` alone and no `journals.read` would see the list but have
 * this call refused — surfaced with the ordinary `ErrorBanner`, the same as any other
 * service-level refusal (D-25) — rather than silently show no lines. Flagged in the OB-105
 * report as a gap worth closing on the server side (either lines on the summary, or a
 * dedicated single-proposal route under `agents.review`).
 */
export type JournalDraftSummary = components['schemas']['JournalDraftSummary'];
export type JournalDraftPage = components['schemas']['JournalDraftPage'];
export type JournalDraft = components['schemas']['JournalDraft'];
export type JournalDraftLine = components['schemas']['JournalDraftLine'];
export type PostedJournal = components['schemas']['PostedJournal'];
export type Account = components['schemas']['Account'];

const PROPOSALS_SCOPE = ['agent-proposals'] as const;

export function proposalListQueryKey(): readonly unknown[] {
  return [...PROPOSALS_SCOPE, 'list'];
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `journal-entry/queries.ts`'s bound: a loop whose exit depends only on the server. */
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

/**
 * The whole chart, for resolving a line's `accountId` to a name — `journal-entry/
 * queries.ts`'s `fetchAccounts`, mirrored for the self-containment reason that module
 * gives. Archived accounts are included rather than filtered: a proposal against one
 * still names it, and this screen never offers an account for selection, only reads one.
 */
export function useAccounts(): {
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly error: unknown;
} {
  const query = useQuery({
    queryKey: ['agent-proposals', 'accounts'],
    queryFn: async () =>
      collect<Account>(async (cursor) =>
        unwrap(await api.GET('/v1/accounts', { params: { query: pageQuery(cursor) } })),
      ),
  });

  const accountsById = useMemo(
    () => new Map((query.data ?? []).map((account) => [account.id, account])),
    [query.data],
  );

  return { accountsById, error: query.error };
}

export function useProposalList(): UseInfiniteQueryResult<
  InfiniteData<JournalDraftPage, string | null>,
  Error
> {
  return useInfiniteQuery({
    queryKey: proposalListQueryKey(),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/agent-proposals', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * One proposal's lines, fetched on demand when the review dialog opens for it — see the
 * module header for why this is `GET /v1/journal-drafts/{draftId}` rather than a route
 * under `/v1/agent-proposals`.
 */
export function useProposalDetail(draftId: string | null): {
  readonly draft: JournalDraft | null;
  readonly isPending: boolean;
  readonly error: unknown;
} {
  const query = useQuery({
    queryKey: ['agent-proposals', 'detail', draftId ?? ''],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/journal-drafts/{draftId}', {
          params: { path: { draftId: draftId ?? '' } },
        }),
      ),
    enabled: draftId !== null,
  });

  return {
    draft: query.data ?? null,
    isPending: draftId !== null && query.isPending,
    error: query.error,
  };
}

/**
 * One idempotency key per user intent — `recurring-invoices/queries.ts`'s `useIntentKey`,
 * copied for the self-containment reason that module gives.
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

function invalidateProposals(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: PROPOSALS_SCOPE });
}

/**
 * Approves and posts, in one transaction, exactly once (D-19) — `approveProposal`'s own
 * description. Provenance on the resulting journal is the approver's, never the proposing
 * agent's.
 */
export function useApproveProposal(): UseMutationResult<
  PostedJournal,
  Error,
  IdempotentVariables<{ readonly draftId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ draftId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/agent-proposals/{draftId}/approve', {
          params: { path: { draftId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateProposals(queryClient);
    },
  });
}

/**
 * Discards the proposal outright — "the same operation a person discarding their own
 * unfinished draft performs" (`rejectProposal`'s own description, D-16). Nothing about a
 * rejected proposal is recorded anywhere, so there is nothing here to read back.
 */
export function useRejectProposal(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<{ readonly draftId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ draftId, idempotencyKey }) => {
      expectNoContent(
        await api.POST('/v1/agent-proposals/{draftId}/reject', {
          params: { path: { draftId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidateProposals(queryClient);
    },
  });
}
