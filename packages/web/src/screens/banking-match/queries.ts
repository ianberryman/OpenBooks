import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryClient,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';

import { api, expectNoContent, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-086 calls, and the keys it caches it under (ROADMAP M4; D-43, D-48).
 *
 * Local by ticket instruction, as the sibling screens are: four M4 waves were built in
 * parallel and a single shared key module is the one file all four would have edited.
 * Nothing outside this folder reads these keys, and nothing in one names the org — the org
 * is ambient and the switcher clears the cache wholesale (`src/query/client.ts`).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, so this screen
 * cannot describe a field the server does not serve — the discriminated `BankMatchProposal`
 * union included.
 */

export type BankAccount = components['schemas']['BankAccount'];
export type BankStatementLine = components['schemas']['BankStatementLine'];
export type BankStatementLinePage = components['schemas']['BankStatementLinePage'];
export type BankLineClearing = components['schemas']['BankLineClearing'];
export type BankLineProposals = components['schemas']['BankLineProposals'];
export type BankMatchProposal = components['schemas']['BankMatchProposal'];
export type BankMatchReason = components['schemas']['BankMatchReason'];
export type ProposalKind = BankMatchProposal['kind'];
export type ClearRequest = components['schemas']['ClearBankStatementLineRequestInput'];
export type Account = components['schemas']['Account'];

const ROOT = 'banking-match';

/**
 * `proposalsScope` covers every proposal query so one clear invalidates them all: accepting
 * one line changes what is still available to match on every other line on the page (an
 * invoice a proposal offered may now be settled), so the whole page's proposals are re-asked
 * rather than surgically patched.
 */
export const matchKeys = {
  bankAccounts: [ROOT, 'bank-accounts'] as const,
  accounts: [ROOT, 'accounts'] as const,
  lines: (bankAccountId: string, cleared: boolean) =>
    [ROOT, 'lines', bankAccountId, cleared] as const,
  linesScope: [ROOT, 'lines'] as const,
  proposals: (lineIds: readonly string[]) => [ROOT, 'proposals', lineIds] as const,
  proposalsScope: [ROOT, 'proposals'] as const,
};

async function invalidateAfterClear(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: matchKeys.linesScope }),
    queryClient.invalidateQueries({ queryKey: matchKeys.proposalsScope }),
  ]);
}

const PICKER_PAGE_LIMIT = 100;

/**
 * The bank accounts the user reconciles, loaded to the end.
 *
 * A picker rather than a view, so the fetcher follows `nextCursor` to the end instead of
 * offering the first page and quietly omitting the rest — an account the user cannot select
 * is an account they cannot reconcile. Active only: an inactive bank account takes no new
 * lines and has nothing to match.
 */
export function useBankAccountOptions(): readonly BankAccount[] {
  const query = useQuery({
    queryKey: matchKeys.bankAccounts,
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
 * The whole chart, active only, for the correction picker.
 *
 * Every account, not the asset/liability subset `money-in` narrows to: a `post_entry`
 * clearing names the *other* side of the line — the expense, income or balance-sheet
 * account this bank movement is — and the bank account's own ledger account is the near
 * side, never chosen here. The narrowing money-in makes would hide exactly the expense
 * accounts a bank charge has to be coded to.
 */
export function useAccountOptions(): readonly Account[] {
  const query = useQuery({
    queryKey: matchKeys.accounts,
    queryFn: async (): Promise<readonly Account[]> => {
      const items: Account[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/accounts', {
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

const LINE_PAGE_LIMIT = 200;

/**
 * The lines of one bank account, filtered by whether they are cleared — the uncleared set is
 * the work of this screen, the cleared set is where an undo starts.
 *
 * `cleared` is the whole filter: presence of `clearing` *is* the reconciled state (there is
 * no status column), so an accepted line simply stops matching the `cleared=false` query and
 * leaves the "to match" view on the next refetch — and appears in the `cleared=true` one.
 * Keyset-paged over `(posted_date, id)`; a line is never modified after import (D-42), so its
 * posted date cannot move under a cursor the way an editable column would. `nextCursor`
 * presence is the only signal another page exists — a full page does not imply one — and it
 * goes back verbatim.
 *
 * `LINE_PAGE_LIMIT` is 200 because E10 is a 5,000-line statement without pathological
 * behaviour: a server page of a couple of hundred lines feeds the client window (the visible
 * page), and the proposal batch below is one request over exactly that window's `lineIds`.
 */
export function useStatementLines(
  bankAccountId: string | null,
  cleared: boolean,
): UseInfiniteQueryResult<InfiniteData<BankStatementLinePage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: matchKeys.lines(bankAccountId ?? '', cleared),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/statement-lines', {
          params: {
            query: {
              bankAccountId: bankAccountId ?? '',
              cleared: cleared ? 'true' : 'false',
              limit: LINE_PAGE_LIMIT,
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: bankAccountId !== null,
  });
}

/**
 * The ranked proposals for a named set of lines, in one request (E10).
 *
 * ## One batch per visible page, never one request per line
 *
 * The endpoint takes `{ lineIds }` — "answer this question about this named set", bounded by
 * a page's worth of lines rather than by the org's data. The caller passes the lines the
 * screen is *showing*; a few hundred proposals arrive in a single round trip, and scrolling
 * to the next page asks a second time for the next set. A per-line query would be the
 * pathological behaviour E10 names, and the reason the server modelled a batch at all.
 *
 * ## Why a `POST` that only reads mints a fresh key
 *
 * Proposing is write-shaped on the wire — every mutation on this API carries an
 * `Idempotency-Key` — but a proposal is computed, not stored (D-43): the call writes
 * nothing. So a fresh key per attempt is harmless here, where on a real write it would be a
 * second posting. The key is minted inside the fetcher rather than bound to the line set,
 * because there is no intent to deduplicate — re-asking the same set is meant to recompute.
 *
 * The `lineIds` are keyed as given: the caller sorts nothing, the cache entry is the page
 * as shown, and an empty set is not asked at all (`enabled`).
 */
export function useLineProposals(
  lineIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, readonly BankMatchProposal[]>, Error> {
  return useQuery({
    queryKey: matchKeys.proposals(lineIds),
    queryFn: async (): Promise<ReadonlyMap<string, readonly BankMatchProposal[]>> => {
      const result = unwrap(
        await api.POST('/v1/bank-match-proposals', {
          body: { lineIds: [...lineIds] },
          params: { header: idempotencyHeader(newIdempotencyKey()) },
        }),
      );

      const byLine = new Map<string, readonly BankMatchProposal[]>();
      for (const line of result.lines) {
        // Best first — the server ranks them, and `rank` is the confidence D-48 refused to
        // reduce to a number. Kept in the order it arrived; the screen renders it verbatim.
        byLine.set(line.lineId, line.proposals);
      }
      return byLine;
    },
    enabled: lineIds.length > 0,
  });
}

/**
 * Accepting: `method` chooses one of three writes, and the proposal already carries the
 * target, so an accept is one keystroke.
 *
 * On success the line list and every proposal on the page are invalidated — an accepted line
 * leaves the uncleared view and the documents its neighbours could match on have changed.
 * `201` returns the clearing; nothing here seeds a detail panel with it, because the row it
 * belonged to is on its way out of the list.
 */
export interface ClearLineVariables {
  readonly lineId: string;
  readonly body: ClearRequest;
}

export function useClearLine(): UseMutationResult<
  BankLineClearing,
  Error,
  IdempotentVariables<ClearLineVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ lineId, body, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/statement-lines/{lineId}/clearing', {
          body,
          params: { path: { lineId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateAfterClear(queryClient);
    },
  });
}

/**
 * Undoing a clearing.
 *
 * Where the clearing posted a journal, that journal is reversed — never deleted (D-16) — so
 * `date` is the reversal's own entry date and must fall in an open period, which is why the
 * undo asks for it rather than assuming today. A 204, so `expectNoContent` rather than
 * `unwrap`, which would refuse a bodiless success.
 */
export interface UndoClearingVariables {
  readonly lineId: string;
  readonly date: string;
  readonly memo?: string | null;
}

export function useUndoClearing(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<UndoClearingVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ lineId, date, memo, idempotencyKey }) => {
      expectNoContent(
        await api.DELETE('/v1/statement-lines/{lineId}/clearing', {
          body: { date, ...(memo === undefined || memo === null ? {} : { memo }) },
          params: { path: { lineId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await invalidateAfterClear(queryClient);
    },
  });
}

/**
 * A proposal, turned into the clearing request that accepts it.
 *
 * The three `kind`s map one-to-one onto three of the four `method`s the clearing
 * endpoint's entries accept — that correspondence is the contract (`clearing.ts`
 * accepts the same three, plus `discount`, D-43/D-80). Each proposal already
 * carries what its method needs: `post_entry` the account (and any contact and
 * dimensions the rule or history suggested), `link_entry` the journal,
 * `allocate_document` the invoice or bill. Wrapped in a single-element `entries`
 * array — Cash application generalised the clear to an array (D-80), and nothing
 * here builds more than one entry: the add/remove-entries editor that would let an
 * operator split a line is OB-140's, not this screen's yet.
 */
export function proposalToClearRequest(proposal: BankMatchProposal): ClearRequest {
  switch (proposal.kind) {
    case 'post_entry':
      return {
        entries: [
          {
            method: 'post_entry',
            accountId: proposal.accountId,
            ...(proposal.contactId === null ? {} : { contactId: proposal.contactId }),
            ...(proposal.dimensionValueIds.length === 0
              ? {}
              : { dimensionValueIds: [...proposal.dimensionValueIds] }),
          },
        ],
      };
    case 'link_entry':
      return { entries: [{ method: 'link_entry', journalId: proposal.journalId }] };
    case 'allocate_document':
      return {
        entries: [
          {
            method: 'allocate_document',
            targetType: proposal.targetType,
            targetId: proposal.targetId,
          },
        ],
      };
  }
}

/**
 * A `post_entry` to an account the user picked instead — the "correct" path.
 *
 * The one override this screen offers that the API can honour on any line: code the line to
 * a chosen account. The account is the other side of the entry, exactly as an accepted
 * `post_entry` proposal's is.
 */
export function postEntryToAccount(accountId: string): ClearRequest {
  return { entries: [{ method: 'post_entry', accountId }] };
}
