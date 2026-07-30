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
 * Everything OB-167 asks of `/v1/recurring-journals`, and the reference data its form
 * pickers need — `recurring-invoices/queries.ts`'s shape, adapted to a GL template (D-90).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, for that
 * file's reason: there is no hand-written mirror of a wire shape anywhere in this package,
 * and one would be a second contract the day either drifts.
 *
 * ## What a GL template is, and isn't
 *
 * A line here is already a posting instruction — `{ accountId, side, amount }`, exactly
 * what `postJournal` takes — so nothing on this screen prices anything the way `sales/`
 * prices a quantity and a unit amount. There is also no `taxMode`: a recurring GL journal
 * carries no tax of its own, only what each line's fixed amount already says. `contactId`
 * and `description` are per-*line*, not per-template, because both are `journal_lines`
 * columns (OB-059) and a template with mixed contacts across its lines is an ordinary
 * multi-party journal, not a special case.
 *
 * `materializationMode` has two values here, not three: `draft` lands an editable journal
 * draft each cycle, `posted` posts it directly under the org's automation actor. There is
 * no `approved` — a GL journal has no separate approval step the way a sales document does.
 */
export type RecurringJournalTemplate = components['schemas']['RecurringJournalTemplate'];
export type RecurringJournalTemplatePage = components['schemas']['RecurringJournalTemplatePage'];
export type RecurringJournalLine = components['schemas']['RecurringJournalLine'];
export type TemplateLineRequest = components['schemas']['RecurringJournalLineInput'];
export type CreateTemplateRequest =
  components['schemas']['CreateRecurringJournalTemplateRequestInput'];
export type UpdateTemplateRequest =
  components['schemas']['UpdateRecurringJournalTemplateRequestInput'];
export type TemplateFrequency = RecurringJournalTemplate['frequency'];
export type TemplateMaterializationMode = RecurringJournalTemplate['materializationMode'];
export type TemplateLineSide = RecurringJournalLine['side'];

export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];

/**
 * Query keys, local to this screen — `recurring-invoices/queries.ts`'s reason: there is
 * no shared key module (a shared file is the one thing every parallel screen would edit
 * at once), and the org switch already clears the cache wholesale.
 */
const TEMPLATES_SCOPE = ['recurring-journals', 'templates'] as const;

export function templateListQueryKey(activeOnly: boolean | null): readonly unknown[] {
  return [...TEMPLATES_SCOPE, 'list', activeOnly];
}

const referenceKeys = {
  contacts: ['recurring-journals', 'contacts'] as const,
  accounts: ['recurring-journals', 'accounts'] as const,
};

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `journal-entry/queries.ts`'s bound: a picker that pages forever hangs the tab. */
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
  readonly contactsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Contacts and the whole chart of accounts, as one thing that is either loaded or not —
 * `recurring-invoices/queries.ts`'s `useTemplateReferenceData`, mirrored rather than
 * imported for the same self-containment reason (no screen imports another's
 * `queries.ts`).
 *
 * The chart arrives unfiltered by `type` — `journal-entry/queries.ts`'s `fetchAccounts`,
 * for the same reason: a GL line is a plain posting instruction and may hit any account,
 * unlike a recurring invoice line, which credits only revenue. Archived accounts and
 * contacts are included too, and for the same reason `journal-entry` gives: a template
 * saved while one was active still names it after it is archived, and a picker that had
 * never heard of it would show an empty box where the template's own choice is. They are
 * offered disabled instead — see `line-row.tsx`.
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
        unwrap(await api.GET('/v1/accounts', { params: { query: pageQuery(cursor) } })),
      ),
  });

  const data = useMemo<TemplateReferenceData | null>(() => {
    if (contacts.data === undefined || accounts.data === undefined) return null;
    return {
      contacts: contacts.data,
      accounts: accounts.data,
      contactsById: index(contacts.data),
      accountsById: index(accounts.data),
    };
  }, [contacts.data, accounts.data]);

  return {
    data,
    error: contacts.error ?? accounts.error,
    refetch: () => {
      void contacts.refetch();
      void accounts.refetch();
    },
  };
}

/**
 * The list, keyset-paged over `(created_at, id)` — `recurring-invoices/queries.ts`'s
 * `useTemplateList`, mirrored for the same reason.
 */
export function useTemplateList(
  activeOnly: boolean | null,
): UseInfiniteQueryResult<InfiniteData<RecurringJournalTemplatePage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: templateListQueryKey(activeOnly),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/recurring-journals', {
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
 * One idempotency key per user intent — `recurring-invoices/queries.ts`'s `useIntentKey`,
 * copied rather than imported for the same self-containment reason.
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
  RecurringJournalTemplate,
  Error,
  IdempotentVariables<CreateTemplateRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateTemplateRequest>) =>
      unwrap(
        await api.POST('/v1/recurring-journals', {
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
  RecurringJournalTemplate,
  Error,
  IdempotentVariables<UpdateTemplateVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/recurring-journals/{templateId}', {
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
 * pause/resume endpoint, only `PATCH { isActive }` (`recurring-invoices/queries.ts`'s
 * `useSetTemplateActive`, same reasoning). Reversible in both directions, which is exactly
 * what makes it the wrong control for retiring a template for good — see
 * `useDeactivateTemplate`.
 */
export function useSetTemplateActive(): UseMutationResult<
  RecurringJournalTemplate,
  Error,
  IdempotentVariables<SetTemplateActiveVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, active, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/recurring-journals/{templateId}', {
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
  RecurringJournalTemplate,
  Error,
  IdempotentVariables<{ readonly templateId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/recurring-journals/{templateId}/deactivate', {
          params: { path: { templateId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateTemplates(queryClient);
    },
  });
}
