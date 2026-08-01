import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api';
import type { components } from '../../api';

/**
 * Everything the journals list-and-detail screen reads, and the keys it reads it under
 * (OB-236).
 *
 * Local and namespaced under `journals` rather than folded into `journal-entry`'s
 * `journalEntryKeys`, for `sales/queries.ts`'s reason: a shared key module makes one
 * screen's invalidation another screen's problem, and the org switch already clears the
 * cache wholesale (`src/query/client.ts`), so nothing depends on two screens agreeing
 * about a key. Reference data (accounts, contacts, dimensions) is genuinely shared with
 * the journal-entry screen's own posted view, so that stays `journal-entry/queries.ts`'s
 * `useReferenceData` rather than a duplicate fetched under a different key.
 */
export type JournalSummary = components['schemas']['JournalSummary'];
export type JournalPage = components['schemas']['JournalPage'];
export type PostedJournal = components['schemas']['PostedJournal'];

export const journalsKeys = {
  list: ['journals', 'list'] as const,
  detail: (journalId: string) => ['journals', 'detail', journalId] as const,
};

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

export interface JournalsListResult {
  readonly items: readonly JournalSummary[];
  readonly isPending: boolean;
  readonly error: unknown;
  /** Whether the server reported a further page — `document-list.tsx`'s reason for
   * showing this rather than paging automatically: a list that quietly paged forever
   * would hang the tab, and the affordance tells the user to narrow instead. */
  readonly truncated: boolean;
  readonly refetch: () => void;
}

/**
 * One page of posted journals, oldest first — the server's own order
 * (`listJournals`'s description: entry date, then the org's gapless entry number).
 * There is no filter on this list yet (no contact, no date range), so a single
 * `limit`-only request is the whole query.
 */
export function useJournalsList(): JournalsListResult {
  const query = useQuery({
    queryKey: journalsKeys.list,
    queryFn: async () =>
      unwrap(await api.GET('/v1/journals', { params: { query: { limit: PAGE_LIMIT } } })),
  });

  return {
    items: query.data?.items ?? [],
    isPending: query.isPending,
    error: query.error,
    truncated: query.data?.nextCursor != null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface JournalResult {
  readonly journal: PostedJournal | null;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * One posted journal, by id — what the detail route deep-links to.
 *
 * `GET /v1/journals/{journalId}` is the other half of OB-236, built in parallel on the
 * server and not yet in `schema.d.ts`. This call is authored against the contract the
 * orchestrator pinned (`PostedJournal`, the same shape `journal-entry/posted-entry.tsx`
 * already renders) and does not typecheck until the client is regenerated at
 * integration — expected, not a defect in this file.
 */
export function useJournal(journalId: string | null): JournalResult {
  const query = useQuery({
    queryKey: journalsKeys.detail(journalId ?? ''),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/journals/{journalId}', {
          params: { path: { journalId: journalId ?? '' } },
        }),
      ),
    enabled: journalId !== null,
  });

  return {
    journal: query.data ?? null,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
