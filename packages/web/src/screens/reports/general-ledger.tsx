import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { Button, Combobox, ErrorBanner, ResponsiveTable } from '../../components';
import { Amount, AmountCell } from './cells';
import type { ReportFilterState } from './filters';
import { encodeDimensionFilters, rangeQuery } from './filters';
import { ReportPending, ReportTitle, describeRange } from './layout';

/**
 * The general ledger for one account (OB-044; B4, B6; D-21).
 *
 * ## This response is not the list envelope
 *
 * Every other collection on this API is `{ items, nextCursor }`. A general-ledger page is
 * not a list but a report containing one: the account, the range, and the opening /
 * movement / closing balances are the subject, and the entries are the working that
 * explains them. The paging *protocol* is the same opaque cursor as everywhere else — only
 * the key the entries sit under differs.
 *
 * ## The header is recomputed per page, and this screen shows it
 *
 * `opening`, `movement` and `closing` ride on every page and are re-read each time. That is
 * the one thing paging an append-only ledger cannot hide: a back-dated entry posted between
 * two fetches moves `closing`, and the running balance steps at the page boundary. The
 * schema made the totals per-page precisely so a client could *see* that, so this view
 * remembers the closing balance of the page it left and says so when the next page reports
 * a different one. Papering over it — holding page one's header above page nine's lines —
 * is the failure the design refuses.
 *
 * Paging is a page at a time rather than an accumulating scroll for the same reason: two
 * pages fetched at different moments are two statements about the ledger, and stacking them
 * into one column of running balances would present them as one.
 */

type GeneralLedger = components['schemas']['GeneralLedger'];
type GeneralLedgerEntry = components['schemas']['GeneralLedgerEntry'];
type GeneralLedgerAmounts = components['schemas']['GeneralLedgerAmounts'];
type Account = components['schemas']['Account'];

const PAGE_SIZE = 100;

/**
 * A remount token: the enquiry the paging state belongs to.
 *
 * Used as a React `key` by the screen, so changing account, range or filter starts at page
 * one with no remembered closing balance. Carrying a cursor across a changed query would
 * page into a different list with a position taken from another.
 */
export function generalLedgerKey(state: ReportFilterState, accountId: string | null): string {
  return [accountId ?? '', state.from, state.to, encodeDimensionFilters(state) ?? ''].join('|');
}

export interface GeneralLedgerViewProps {
  readonly state: ReportFilterState;
  readonly accountId: string | null;
  readonly onAccountChange: (accountId: string | null) => void;
}

export function GeneralLedgerView({
  state,
  accountId,
  onAccountChange,
}: GeneralLedgerViewProps): ReactElement {
  const accounts = useAccounts();

  /** One entry per page visited, so Previous is a cursor rather than a re-derivation. */
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [closingLeftBehind, setClosingLeftBehind] = useState<string | null>(null);

  const dimensions = encodeDimensionFilters(state);
  const cursor = cursors[pageIndex];
  const query = {
    accountId: accountId ?? '',
    limit: PAGE_SIZE,
    ...rangeQuery(state),
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(cursor === undefined ? {} : { cursor }),
  };

  const page = useQuery({
    queryKey: ['reports', 'general-ledger', query],
    queryFn: async (): Promise<GeneralLedger> =>
      unwrap(await api.GET('/v1/reports/general-ledger', { params: { query } })),
    enabled: accountId !== null,
  });

  return (
    <div className="flex flex-col gap-3">
      <label className="flex max-w-form flex-col gap-1">
        <span className="text-sm font-medium text-text">Account</span>
        <Combobox
          aria-label="Account"
          value={accountId}
          onValueChange={onAccountChange}
          placeholder="Search the chart of accounts…"
          options={accounts.map((account) => ({
            value: account.id,
            label: account.name,
            detail: account.code,
          }))}
        />
      </label>

      {accountId === null ? (
        <p className="text-text-muted">
          Choose an account, or open one from any line of another report.
        </p>
      ) : page.isPending ? (
        <ReportPending />
      ) : page.isError ? (
        <ErrorBanner
          error={page.error}
          onRetry={() => {
            void page.refetch();
          }}
        />
      ) : (
        <>
          <GeneralLedgerPage page={page.data} closingLeftBehind={closingLeftBehind} />

          <div className="flex items-center gap-2">
            <Button
              disabled={pageIndex === 0}
              onClick={() => {
                setPageIndex(pageIndex - 1);
              }}
            >
              Previous
            </Button>
            <Button
              disabled={page.data.nextCursor === null}
              onClick={() => {
                const next = page.data.nextCursor;
                if (next === null) return;
                // Captured on the way out, so the next page can be compared against the
                // ledger as it stood when this one was read.
                setClosingLeftBehind(page.data.closing.balance);
                setCursors(
                  pageIndex + 1 < cursors.length
                    ? cursors
                    : [...cursors.slice(0, pageIndex + 1), next],
                );
                setPageIndex(pageIndex + 1);
              }}
            >
              Next
            </Button>
            <span className="text-sm text-text-subtle">Page {pageIndex + 1}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function GeneralLedgerPage({
  page,
  closingLeftBehind,
}: {
  readonly page: GeneralLedger;
  readonly closingLeftBehind: string | null;
}): ReactElement {
  const moved = closingLeftBehind !== null && closingLeftBehind !== page.closing.balance;

  return (
    <div className="flex flex-col gap-3">
      <ReportTitle
        title={`${page.code} — ${page.name}`}
        subtitle={describeRange(page.from, page.to)}
      />

      {moved && (
        <p
          role="status"
          className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-text"
        >
          The ledger moved while this was being read. The previous page closed at{' '}
          <Amount value={closingLeftBehind} /> and this page reports{' '}
          <Amount value={page.closing.balance} /> — an entry was posted into the range between the
          two fetches. Each page&rsquo;s totals are true of the ledger at the moment that page was
          read.
        </p>
      )}

      <ResponsiveTable>
        <table aria-label="Balances" className="w-full border-collapse text-base">
          <caption className="pb-1 text-left text-sm text-text-subtle">
            Opening plus movement equals closing (B4), recomputed on every page.
          </caption>
          <thead>
            <tr className="border-b border-border text-xs text-text-subtle">
              <th scope="col" className="px-3 py-1 text-left font-medium" />
              <th scope="col" className="px-3 py-1 text-right font-medium">
                Debits
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                Credits
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            <AmountsRow label="Opening" amounts={page.opening} />
            <AmountsRow label="Movement" amounts={page.movement} />
            <AmountsRow label="Closing" amounts={page.closing} emphasis />
          </tbody>
        </table>
      </ResponsiveTable>

      <ResponsiveTable>
        <table aria-label="Entries" className="w-full border-collapse text-base">
          <thead>
            <tr className="border-b border-border text-xs text-text-subtle">
              <th scope="col" className="px-3 py-1 text-left font-medium">
                Date
              </th>
              <th scope="col" className="px-3 py-1 text-left font-medium">
                Entry
              </th>
              <th scope="col" className="px-3 py-1 text-left font-medium">
                Memo
              </th>
              <th scope="col" className="px-3 py-1 text-left font-medium">
                Other side
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                Debit
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                Credit
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                Running balance
              </th>
            </tr>
          </thead>
          <tbody>
            {page.entries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-2 text-text-subtle">
                  No entries in this range.
                </td>
              </tr>
            )}
            {page.entries.map((entry) => (
              <EntryRow key={entry.lineId} entry={entry} />
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </div>
  );
}

function AmountsRow({
  label,
  amounts,
  emphasis,
}: {
  readonly label: string;
  readonly amounts: GeneralLedgerAmounts;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <tr className="border-b border-border last:border-0">
      <th scope="row" className="px-3 py-1 text-left font-medium">
        {label}
      </th>
      <AmountCell value={amounts.debits} />
      <AmountCell value={amounts.credits} />
      <AmountCell value={amounts.balance} emphasis={emphasis ?? false} />
    </tr>
  );
}

function EntryRow({ entry }: { readonly entry: GeneralLedgerEntry }): ReactElement {
  const memo = entry.lineMemo ?? entry.journalMemo;

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-3 py-1 font-mono text-sm whitespace-nowrap">{entry.date}</td>
      <td className="px-3 py-1 font-mono text-sm whitespace-nowrap">{entry.sequenceNumber}</td>
      <td className="px-3 py-1">
        <span className="flex flex-col gap-0.5">
          <span>{memo ?? ''}</span>
          {entry.contact !== null && (
            <span className="text-xs text-text-subtle">{entry.contact.displayName}</span>
          )}
          {entry.tags.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {entry.tags.map((tag) => (
                <span
                  key={`${tag.dimensionId}:${tag.dimensionValueId}`}
                  className="rounded-full border border-border px-1.5 text-xs text-text-subtle"
                >
                  {tag.dimensionCode}: {tag.name}
                </span>
              ))}
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-1 text-sm">{counterpartyLabel(entry)}</td>
      <AmountCell value={entry.debit} />
      <AmountCell value={entry.credit} />
      <AmountCell value={entry.runningBalance} />
    </tr>
  );
}

/**
 * The accounts on the opposite debit/credit side of the same journal.
 *
 * No amount is shown against any of them, and none can be: a journal records that its
 * debits equal its credits, not which debit paid for which credit, so on a three-against-one
 * split there is no such fact to report and apportioning one would be inventing it. More
 * than one account is the classic split entry; the list is truncated by the server, and
 * `accountCount` is what tells a complete list from a truncated one.
 */
function counterpartyLabel(entry: GeneralLedgerEntry): string {
  const { accounts, accountCount } = entry.counterparty;
  if (accountCount === 0) return '—';
  if (accountCount === 1) {
    const only = accounts[0];
    return only === undefined ? '—' : `${only.code} ${only.name}`;
  }
  const named = accounts.map((account) => account.code).join(', ');
  const hidden = accountCount - accounts.length;
  return hidden > 0 ? `— Split — ${named} +${String(hidden)} more` : `— Split — ${named}`;
}

/**
 * The chart of accounts for the picker, followed to the end of the cursor.
 *
 * A picker that showed the first page and silently omitted the rest would be a picker that
 * cannot reach an account, which is worse than a slow one.
 */
function useAccounts(): readonly Account[] {
  const query = useQuery({
    queryKey: ['reports', 'general-ledger', 'accounts'],
    queryFn: async (): Promise<readonly Account[]> => {
      const items: Account[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/accounts', {
            params: { query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) } },
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
