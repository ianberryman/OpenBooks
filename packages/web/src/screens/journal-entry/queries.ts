import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';

/**
 * Everything this screen reads, and the keys it reads it under.
 *
 * The keys are local and namespaced under `journal-entry` rather than shared. A shared
 * key module would make one screen's invalidation another screen's problem, and the org
 * switch already clears the cache wholesale (`src/query/client.ts`), so nothing depends
 * on two screens agreeing about a key.
 */
export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];
export type Dimension = components['schemas']['Dimension'];
export type DimensionValue = components['schemas']['DimensionValue'];
export type JournalDraft = components['schemas']['JournalDraft'];
export type JournalDraftLine = components['schemas']['JournalDraftLine'];
export type JournalDraftSummary = components['schemas']['JournalDraftSummary'];
export type PostedJournal = components['schemas']['PostedJournal'];
export type CreateDraftRequest = components['schemas']['CreateDraftRequestInput'];
export type UpdateDraftRequest = components['schemas']['UpdateDraftRequestInput'];
export type DraftLineRequest = components['schemas']['JournalDraftLineRequestInput'];

export const journalEntryKeys = {
  accounts: ['journal-entry', 'accounts'] as const,
  contacts: ['journal-entry', 'contacts'] as const,
  axes: ['journal-entry', 'axes'] as const,
  drafts: ['journal-entry', 'drafts'] as const,
  draft: (draftId: string) => ['journal-entry', 'draft', draftId] as const,
};

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/**
 * A hard stop on the paging loop. Ten thousand accounts is not a chart of accounts, and
 * a loop whose exit depends only on the server saying `nextCursor: null` is a loop that
 * hangs the tab when something upstream is wrong. Refusing loudly beats a picker that
 * quietly lists the first half of the chart.
 */
const MAX_PAGES = 50;

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
  // Spread rather than `cursor: undefined`: `exactOptionalPropertyTypes` makes an absent
  // property and an explicitly-undefined one different types.
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

/**
 * The whole chart, archived accounts included.
 *
 * Filtering to `isActive` would be smaller and wrong: a draft written before an account
 * was deactivated still names it, and a picker that had never heard of it would show an
 * empty box where the user's chosen account is. They arrive here and are offered as
 * disabled options instead, so the label is visible and the reason it cannot be chosen
 * for a new line is too.
 */
async function fetchAccounts(): Promise<Account[]> {
  return collect(async (cursor) =>
    unwrap(await api.GET('/v1/accounts', { params: { query: pageQuery(cursor) } })),
  );
}

async function fetchContacts(): Promise<Contact[]> {
  return collect(async (cursor) =>
    unwrap(await api.GET('/v1/contacts', { params: { query: pageQuery(cursor) } })),
  );
}

export interface DimensionAxis {
  readonly dimension: Dimension;
  readonly values: readonly DimensionValue[];
}

/**
 * The axes and their values as one query rather than one plus N.
 *
 * D-18 makes dimensions unlimited and D-29 bounds them at eight per org, so the fan-out
 * is small and bounded. One cache entry means the tagging panel is either fully loaded
 * or not loaded — never eight axes of which two are still arriving, which in a per-line
 * tag editor reads as tags that vanish and come back.
 */
async function fetchAxes(): Promise<DimensionAxis[]> {
  const dimensions = await collect<Dimension>(async (cursor) =>
    unwrap(await api.GET('/v1/dimensions', { params: { query: pageQuery(cursor) } })),
  );

  return Promise.all(
    dimensions.map(async (dimension) => ({
      dimension,
      values: await collect<DimensionValue>(async (cursor) =>
        unwrap(
          await api.GET('/v1/dimensions/{dimensionId}/values', {
            params: { path: { dimensionId: dimension.id }, query: pageQuery(cursor) },
          }),
        ),
      ),
    })),
  );
}

export interface ReferenceData {
  readonly accounts: readonly Account[];
  readonly contacts: readonly Contact[];
  readonly axes: readonly DimensionAxis[];
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly contactsById: ReadonlyMap<string, Contact>;
  readonly valuesById: ReadonlyMap<string, DimensionValue>;
}

export interface ReferenceDataResult {
  /** `null` until all three have arrived — see `fetchAxes` on why partial is worse. */
  readonly data: ReferenceData | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function useReferenceData(): ReferenceDataResult {
  const accounts = useQuery({ queryKey: journalEntryKeys.accounts, queryFn: fetchAccounts });
  const contacts = useQuery({ queryKey: journalEntryKeys.contacts, queryFn: fetchContacts });
  const axes = useQuery({ queryKey: journalEntryKeys.axes, queryFn: fetchAxes });

  const data = useMemo<ReferenceData | null>(() => {
    if (accounts.data === undefined || contacts.data === undefined || axes.data === undefined) {
      return null;
    }
    return {
      accounts: accounts.data,
      contacts: contacts.data,
      axes: axes.data,
      accountsById: index(accounts.data),
      contactsById: index(contacts.data),
      valuesById: index(axes.data.flatMap((axis) => axis.values)),
    };
  }, [accounts.data, contacts.data, axes.data]);

  return {
    data,
    isPending: accounts.isPending || contacts.isPending || axes.isPending,
    error: accounts.error ?? contacts.error ?? axes.error,
    refetch: () => {
      void accounts.refetch();
      void contacts.refetch();
      void axes.refetch();
    },
  };
}

export function useDrafts(): {
  readonly drafts: readonly JournalDraftSummary[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: journalEntryKeys.drafts,
    queryFn: async () => unwrap(await api.GET('/v1/journal-drafts', { params: { query: {} } })),
  });

  return {
    drafts: query.data?.items ?? [],
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useDraft(draftId: string | null): {
  readonly draft: JournalDraft | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: journalEntryKeys.draft(draftId ?? ''),
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
    refetch: () => {
      void query.refetch();
    },
  };
}
