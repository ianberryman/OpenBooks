import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Select } from '../components';
import type { SelectOption } from '../components';
import { AccountTable } from './accounts/account-table';
import type {
  Account,
  AccountFilters,
  AccountType,
  ChartTemplateId,
  CreateAccountBody,
  UpdateAccountBody,
} from './accounts/accounts-api';
import {
  accountsQueryKeys,
  applyChartTemplate,
  createAccount,
  deleteAccount,
  fetchAccountsPage,
  fetchChartTemplates,
  setAccountActive,
  updateAccount,
} from './accounts/accounts-api';
import {
  CreateAccountDialog,
  DeleteAccountDialog,
  EditAccountDialog,
} from './accounts/account-dialogs';
import { ApplyTemplateDialog } from './accounts/apply-template-dialog';
import { useIntentKey } from './accounts/intent-key';
import { Refusal } from './accounts/refusal';
import { buildAccountTree } from './accounts/tree';
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, isAccountType } from './accounts/vocabulary';

/**
 * The chart of accounts (OB-048; spec §2.1).
 *
 * ## What this screen is for
 *
 * Four of the server's rules are invisible in a plain CRUD form, and each is the sort a
 * user meets as a failure rather than as a boundary. The screen's job is to make them
 * legible before they refuse, and to render the refusal as something to act on when they
 * do — not to re-enforce any of them, which would be a second copy of a rule that already
 * lives in `packages/server/src/modules/accounts/`:
 *
 * - **A code is immutable (D-27).** It is absent from the update request entirely, so the
 *   edit form has no field for it and says why where the field would be.
 * - **`type` and `normalBalance` freeze once an account has postings.** The refusal is a
 *   `precondition_failed` naming `account_has_postings`; the form then offers to put those
 *   two fields back, so the rest of the edit still saves.
 * - **Deletion and deactivation are two operations.** Both are offered together and
 *   described separately, because only one of them is ever available to a posted account
 *   and the difference is what happens to the entries it carries.
 * - **`normalBalance` is not derived from `type`.** Neither select preselects the other,
 *   and the contra combination is confirmed in neutral prose rather than flagged.
 *
 * ## Paging and the tree
 *
 * The list is keyset-paged over `(code, id)` (D-21, D-27) and the cursor goes back
 * verbatim. The tree is therefore built from the pages fetched so far, and an account
 * whose parent has not arrived renders at the top level and says so — see
 * `buildAccountTree`.
 */
export function AccountsScreen(): ReactElement {
  const queryClient = useQueryClient();

  const [typeFilter, setTypeFilter] = useState<AccountType | null>(null);
  const [activeFilter, setActiveFilter] = useState<boolean | null>(null);
  const filters: AccountFilters = { type: typeFilter, isActive: activeFilter };

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [applying, setApplying] = useState(false);

  const rowIntentKey = useIntentKey();

  const list = useInfiniteQuery({
    queryKey: accountsQueryKeys.list(filters),
    queryFn: ({ pageParam }) => fetchAccountsPage(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    /**
     * `nextCursor` and nothing else. Its presence is the only signal that more exists: a
     * full page does not imply another, so inferring one from `items.length === limit`
     * would put a pointless request at the end of every exhausted list — and, on a list
     * whose length happens to be a multiple of the page size, a "Load more" button that
     * loads nothing.
     */
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const templates = useQuery({
    queryKey: accountsQueryKeys.chartTemplates,
    queryFn: fetchChartTemplates,
    // Only once the picker is open. A starter chart is opt-in (D-23), so nothing about one
    // should load on the majority of visits that never apply it.
    enabled: applying,
  });

  const accounts = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const rows = useMemo(() => buildAccountTree(accounts), [accounts]);

  async function refreshChart(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: accountsQueryKeys.everything });
  }

  const create = useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: CreateAccountBody; idempotencyKey: string }) =>
      createAccount(body, idempotencyKey),
    onSuccess: async () => {
      setCreating(false);
      await refreshChart();
    },
  });

  const update = useMutation({
    mutationFn: ({
      accountId,
      body,
      idempotencyKey,
    }: {
      accountId: string;
      body: UpdateAccountBody;
      idempotencyKey: string;
    }) => updateAccount(accountId, body, idempotencyKey),
    onSuccess: async () => {
      setEditing(null);
      await refreshChart();
    },
  });

  const activation = useMutation({
    mutationFn: ({
      accountId,
      isActive,
      idempotencyKey,
    }: {
      accountId: string;
      isActive: boolean;
      idempotencyKey: string;
    }) => setAccountActive(accountId, isActive, idempotencyKey),
    onSuccess: async () => {
      setRemoving(null);
      await refreshChart();
    },
  });

  const remove = useMutation({
    mutationFn: ({ accountId, idempotencyKey }: { accountId: string; idempotencyKey: string }) =>
      deleteAccount(accountId, idempotencyKey),
    onSuccess: async () => {
      setRemoving(null);
      await refreshChart();
    },
  });

  const applyTemplate = useMutation({
    mutationFn: ({
      templateId,
      idempotencyKey,
    }: {
      templateId: ChartTemplateId;
      idempotencyKey: string;
    }) => applyChartTemplate(templateId, idempotencyKey),
    onSuccess: async () => {
      setApplying(false);
      await refreshChart();
    },
  });

  /**
   * The removal dialog drives two mutations, and the one the user reached last owns the
   * message: a deletion refused for having postings, followed by a deactivation that also
   * failed, must not still be showing the first refusal.
   */
  const removalError = remove.error ?? activation.error;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Chart of accounts</h1>
          <p className="text-sm text-text-muted">
            Ordered by code, with each account nested under the one it rolls up into.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              applyTemplate.reset();
              setApplying(true);
            }}
          >
            Apply a starter chart
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            New account
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Filter by type"
          className="w-48"
          value={typeFilter ?? ALL}
          options={TYPE_FILTER_OPTIONS}
          onValueChange={(value) => {
            setTypeFilter(isAccountType(value) ? value : null);
          }}
        />
        <Select
          aria-label="Filter by status"
          className="w-48"
          value={statusFilterValue(activeFilter)}
          options={STATUS_FILTER_OPTIONS}
          onValueChange={(value) => {
            setActiveFilter(value === ALL ? null : value === 'active');
          }}
        />
      </div>

      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {/* A row-level deactivation has no dialog of its own to report into. */}
      {activation.error !== null && removing === null && <Refusal error={activation.error} />}

      {list.isPending && <p className="text-text-subtle">Loading the chart of accounts…</p>}

      {!list.isPending && !list.isError && rows.length === 0 && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-6">
          <p className="text-base font-medium text-text">
            {typeFilter === null && activeFilter === null
              ? 'This organization has no accounts yet.'
              : 'No accounts match these filters.'}
          </p>
          {typeFilter === null && activeFilter === null && (
            <p className="text-sm text-text-muted">
              Start from a shipped starter chart, or add accounts one at a time. A starter chart is
              copied in: the accounts become ordinary accounts with no further relationship to the
              template, and none of it arrives unless it is asked for.
            </p>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <AccountTable
            rows={rows}
            busyAccountId={activation.isPending ? activation.variables.accountId : null}
            onEdit={(account) => {
              update.reset();
              setEditing(account);
            }}
            onRemove={(account) => {
              remove.reset();
              activation.reset();
              setRemoving(account);
            }}
            onSetActive={(account, isActive) => {
              activation.mutate({
                accountId: account.id,
                isActive,
                idempotencyKey: rowIntentKey(
                  `${isActive ? 'reactivate' : 'deactivate'}:${account.id}`,
                ),
              });
            }}
          />

          <div className="flex items-center gap-3">
            <p className="text-sm text-text-subtle">
              {accounts.length} account{accounts.length === 1 ? '' : 's'} loaded
              {list.hasNextPage ? '.' : ' — that is the whole chart.'}
            </p>
            {list.hasNextPage && (
              <Button
                disabled={list.isFetchingNextPage}
                onClick={() => {
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}

      {creating && (
        <CreateAccountDialog
          open
          onOpenChange={setCreating}
          accounts={accounts}
          pending={create.isPending}
          error={create.error}
          onSubmit={(body, idempotencyKey) => {
            create.mutate({ body, idempotencyKey });
          }}
        />
      )}

      {editing !== null && (
        <EditAccountDialog
          account={editing}
          accounts={accounts}
          pending={update.isPending}
          error={update.error}
          onOpenChange={() => {
            setEditing(null);
          }}
          onSubmit={(body, idempotencyKey) => {
            update.mutate({ accountId: editing.id, body, idempotencyKey });
          }}
        />
      )}

      {removing !== null && (
        <DeleteAccountDialog
          account={removing}
          pending={remove.isPending || activation.isPending}
          error={removalError}
          onOpenChange={() => {
            setRemoving(null);
          }}
          onDelete={(idempotencyKey) => {
            activation.reset();
            remove.mutate({ accountId: removing.id, idempotencyKey });
          }}
          onDeactivate={(idempotencyKey) => {
            remove.reset();
            activation.mutate({ accountId: removing.id, isActive: false, idempotencyKey });
          }}
        />
      )}

      {applying && (
        <ApplyTemplateDialog
          templates={templates.data ?? []}
          loading={templates.isPending}
          loadError={templates.error}
          pending={applyTemplate.isPending}
          error={applyTemplate.error}
          onOpenChange={() => {
            setApplying(false);
          }}
          onApply={(templateId, idempotencyKey) => {
            applyTemplate.mutate({ templateId, idempotencyKey });
          }}
        />
      )}
    </div>
  );
}

/** Radix models "nothing selected" as an absent value; a filter's "no filter" is a choice. */
const ALL = 'all';

const TYPE_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: ALL, label: 'All types' },
  ...ACCOUNT_TYPES.map((type) => ({ value: type, label: ACCOUNT_TYPE_LABELS[type] })),
];

const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: ALL, label: 'Active and inactive' },
  { value: 'active', label: 'Active only' },
  { value: 'inactive', label: 'Inactive only' },
];

function statusFilterValue(isActive: boolean | null): string {
  if (isActive === null) return ALL;
  return isActive ? 'active' : 'inactive';
}
