import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Select } from '../../components';
import type { SelectOption } from '../../components';
import { CreateBankAccountDialog } from './create-dialog';
import type { BankAccount } from './queries';
import { useBankAccountList, useIntentKey, useSetBankAccountActive } from './queries';
import { DeactivateRefusal } from './refusal';

/**
 * Bank-account setup (OB-095, closing the gap OB-084 left; ROADMAP D-46).
 *
 * The banking screens could *pick* a bank account from a list but nothing in the UI
 * *created* one; this screen is where an org registers a bank account, sees the ones it has
 * — active and inactive alike — and deactivates or reactivates each. A bank account is a
 * ledger account plus import metadata (D-46), so registering one chooses a ledger account
 * rather than inventing it (D-23), and there is no balance on this screen: the balance is
 * the ledger account's, read through the reports a client already has.
 *
 * ## The one rule that is not plain CRUD
 *
 * Deactivation is refused while a reconciliation session on the account is still open
 * (`bank_account_has_open_session`): a deactivated account settles no clearing, so a live
 * session would be stranded. The screen does not re-enforce that — the server does — it only
 * renders the refusal as a sequence to follow (`refusal.tsx`), the way the reconciliation
 * screen renders the balance-mismatch refusal it cannot pre-empt either.
 *
 * This screen exports itself and is wired into the Banking section at integration; it does
 * not touch the shell nav.
 */
export function BankAccountsScreen(): ReactElement {
  const [activeFilter, setActiveFilter] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);

  const rowIntentKey = useIntentKey();

  const list = useBankAccountList(activeFilter);
  const setActive = useSetBankAccountActive();

  const accounts = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  function toggleActive(account: BankAccount): void {
    const isActive = !account.isActive;
    setActive.reset();
    setActive.mutate({
      bankAccountId: account.id,
      isActive,
      idempotencyKey: rowIntentKey(`${isActive ? 'reactivate' : 'deactivate'}:${account.id}`),
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Bank accounts</h1>
          <p className="max-w-form text-sm text-text-muted">
            Each bank account is a ledger account plus the metadata a statement import needs. Its
            balance is the ledger account&rsquo;s — reconciliation tests a statement against it.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          Register bank account
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Filter by status"
          className="w-52"
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

      {/* A row-level activation error surfaces here — the open-session refusal is the one
          worth its own reading (`refusal.tsx`); anything else falls back to the shared
          surface. Cleared when the successful counterpart runs (invalidation refetches). */}
      {setActive.error !== null && <DeactivateRefusal error={setActive.error} />}

      {list.isPending && <p className="text-text-subtle">Loading bank accounts…</p>}

      {!list.isPending && !list.isError && accounts.length === 0 && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-6">
          <p className="text-base font-medium text-text">
            {activeFilter === null
              ? 'This organization has no bank accounts yet.'
              : 'No bank accounts match this filter.'}
          </p>
          {activeFilter === null && (
            <p className="text-sm text-text-muted">
              Register one over a ledger account to import statements into it and reconcile it.
            </p>
          )}
        </div>
      )}

      {accounts.length > 0 && (
        <>
          <BankAccountTable
            accounts={accounts}
            busyId={setActive.isPending ? setActive.variables.bankAccountId : null}
            onToggleActive={toggleActive}
          />

          <div className="flex items-center gap-3">
            <p className="text-sm text-text-subtle">
              {accounts.length} bank account{accounts.length === 1 ? '' : 's'} loaded
              {list.hasNextPage ? '.' : ' — that is all of them.'}
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

      <CreateBankAccountDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

const CELL = 'px-3 py-2 align-top';
const HEADER_CELL = 'px-3 py-2 text-left text-xs font-medium text-text-muted';

function BankAccountTable({
  accounts,
  busyId,
  onToggleActive,
}: {
  readonly accounts: readonly BankAccount[];
  readonly busyId: string | null;
  readonly onToggleActive: (account: BankAccount) => void;
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">Bank accounts, active and inactive.</caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={HEADER_CELL}>
              Name
            </th>
            <th scope="col" className={HEADER_CELL}>
              Institution
            </th>
            <th scope="col" className={HEADER_CELL}>
              Bank identifier
            </th>
            <th scope="col" className={HEADER_CELL}>
              Status
            </th>
            <th scope="col" className={`${HEADER_CELL} text-right`}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id} className="border-b border-border last:border-b-0">
              <td className={CELL}>
                <span className={account.isActive ? 'text-text' : 'text-text-muted'}>
                  {account.name}
                </span>
              </td>
              <td className={`${CELL} text-text-muted`}>{account.institutionName ?? '—'}</td>
              <td className={`${CELL} font-mono text-text-muted`}>
                {account.externalAccountId ?? '—'}
              </td>
              <td className={`${CELL} whitespace-nowrap`}>
                <span className={account.isActive ? 'text-text-muted' : 'text-warning-text'}>
                  {account.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td className={`${CELL} whitespace-nowrap text-right`}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === account.id}
                  onClick={() => {
                    onToggleActive(account);
                  }}
                >
                  {account.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Radix models "nothing selected" as an absent value; a filter's "no filter" is a choice. */
const ALL = 'all';

const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: ALL, label: 'Active and inactive' },
  { value: 'active', label: 'Active only' },
  { value: 'inactive', label: 'Inactive only' },
];

function statusFilterValue(isActive: boolean | null): string {
  if (isActive === null) return ALL;
  return isActive ? 'active' : 'inactive';
}
