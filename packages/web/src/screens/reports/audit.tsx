import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { api, presentApiError, unwrap } from '../../api';
import type { components } from '../../api';
import { Button, ErrorBanner, ResponsiveTable, Select } from '../../components';
import { cx } from '../../lib/cx';
import { ReportPending, ReportTitle } from './layout';

/**
 * The audit trail (initiative P, OB-196; ROADMAP D-98) — who changed what, and when.
 *
 * ## Its own tab, off the shared toolbar, for the same reason budget vs actual is
 *
 * `reports.tsx`'s `CAPABILITIES` map exists for the four statements that share one range,
 * one slice axis and one basis. This report shares none of that: its filters are a date
 * window over *when the event happened* plus an optional actor, neither of which
 * `ReportControls` expresses, so — like `budget-vs-actual.tsx` and
 * `cash-flow-projection.tsx` before it — it renders its own toolbar and stays off the
 * shared one rather than accept controls it would have to ignore.
 *
 * ## `audit.read` is not `reports.read`, and the nav link cannot know that
 *
 * The Reports link in `nav.ts` is gated on `reports.read`, which is enough to see every
 * other tab. This one needs `audit.read` as well (the module header on
 * `shared-types/accountant/audit.ts` explains why the two are separate codes), so a
 * `reports.read`-only caller reaches this tab and is then refused by the service. That is
 * not an error to bury behind `ErrorBanner`'s red box — it is the expected shape for a
 * caller whose role legitimately stops here — so a `permission_denied` on the *first* page
 * renders a plain empty state instead. A `permission_denied` after that (there is none in
 * practice, since the permission cannot be lost mid-scroll) would fall through to the same
 * banner every other report uses.
 */

type AuditEntry = components['schemas']['AuditEntry'];
/**
 * `auditActorSchema` carries no `id` (`shared-types/accountant/audit.ts`), so — like
 * `ReportBasis` in `statement-packages/queries.ts` — it publishes inline on `AuditEntry`
 * rather than as a named component. Derived from the field rather than duplicated here.
 */
type AuditActor = AuditEntry['actor'];
type OrgMember = components['schemas']['OrgMember'];

const PAGE_SIZE = 50;

const MEMBERS_QUERY_KEY = ['reports', 'audit', 'members'] as const;

/**
 * The actor picker's options.
 *
 * `GET /v1/members` takes `members.read`, a permission distinct from `audit.read` — an
 * accountant holding only the latter can read the trail but not this list. The picker is a
 * convenience over a filter the wire already accepts by id, not a precondition for the tab,
 * so a refusal here empties the picker rather than failing the view; `retry: false` keeps an
 * expected 403 from spending three attempts finding that out.
 */
function useActorOptions(): readonly OrgMember[] {
  const query = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/members')),
    retry: false,
  });
  return query.data?.members ?? [];
}

export interface AuditFilterState {
  readonly from: string;
  readonly to: string;
  readonly actorId: string | null;
}

const INITIAL_FILTERS: AuditFilterState = { from: '', to: '', actorId: null };

const NO_ACTOR = 'any';

function toWireQuery(filters: AuditFilterState): Record<string, string> {
  const wire: Record<string, string> = {};
  if (filters.from !== '') wire['from'] = filters.from;
  if (filters.to !== '') wire['to'] = filters.to;
  if (filters.actorId !== null) wire['actorId'] = filters.actorId;
  return wire;
}

/**
 * Keyset-paged the same way `money-in/queries.ts`'s `usePaymentList` is: `getNextPageParam`
 * returns `nextCursor` verbatim, and presence — not a full page — is the only signal more
 * exists (D-21).
 */
function useAuditReport(filters: AuditFilterState) {
  return useInfiniteQuery({
    queryKey: ['reports', 'audit', 'entries', filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/reports/audit', {
          params: {
            query: {
              ...toWireQuery(filters),
              limit: PAGE_SIZE,
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
}

export function AuditView(): ReactElement {
  const [filters, setFilters] = useState<AuditFilterState>(INITIAL_FILTERS);
  const actors = useActorOptions();
  const report = useAuditReport(filters);

  const rows = useMemo(
    () => report.data?.pages.flatMap((page) => page.entries) ?? [],
    [report.data],
  );

  const presented = report.error == null ? null : presentApiError(report.error);
  /**
   * The one code this view treats specially. `not_found` also carries `recovery:
   * 'no-access'` (A7 makes the two indistinguishable on purpose), but there is no
   * resource id in this query for that to mean — so narrowing to the code, not the
   * recovery, keeps a genuine 404 (there is none the report can produce today, but the
   * mapping should not assume that forever) on the ordinary error banner.
   */
  const deniedAudit = presented?.code === 'permission_denied';

  return (
    <div className="flex flex-col gap-4">
      <ReportTitle
        title="Audit trail"
        subtitle="Postings and period closes, newest first — who did it, and when."
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <DateControl
          label="From"
          value={filters.from}
          onChange={(from) => {
            setFilters((current) => ({ ...current, from }));
          }}
        />
        <DateControl
          label="To"
          value={filters.to}
          onChange={(to) => {
            setFilters((current) => ({ ...current, to }));
          }}
        />

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">Actor</span>
          <Select
            aria-label="Actor"
            value={filters.actorId ?? NO_ACTOR}
            options={[
              { value: NO_ACTOR, label: 'Everyone' },
              ...actors.map((actor) => ({ value: actor.userId, label: actor.displayName })),
            ]}
            onValueChange={(value) => {
              setFilters((current) => ({ ...current, actorId: value === NO_ACTOR ? null : value }));
            }}
            className="w-56"
          />
        </div>
      </div>

      {deniedAudit ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          The audit trail needs its own <code className="font-mono">audit.read</code> permission —
          separate from the reports you can already run here. Ask an administrator to grant it if
          you expect to see this.
        </p>
      ) : report.isPending ? (
        <ReportPending />
      ) : report.isError ? (
        <ErrorBanner
          error={report.error}
          onRetry={() => {
            void report.refetch();
          }}
        />
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
              No activity in this window.
            </p>
          ) : (
            <ResponsiveTable>
              <table aria-label="Audit trail" className="w-full border-collapse text-base">
                <thead>
                  <tr className="border-b border-border text-left text-sm text-text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      When
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Actor
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Action
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Summary
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      Reference
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </ResponsiveTable>
          )}

          {/* Presence of a cursor is the only signal more exists — a full page does not
              imply another (D-21), the same rule `money-in/payments.tsx`'s button follows. */}
          {report.hasNextPage && (
            <div>
              <Button
                disabled={report.isFetchingNextPage}
                onClick={() => {
                  void report.fetchNextPage();
                }}
              >
                {report.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function actorLabel(actor: AuditActor): string {
  if (actor.name !== null) return actor.name;
  if (actor.type === 'automation') return 'Automation';
  return actor.type === 'agent' ? 'Agent' : 'Removed user';
}

/**
 * `source` is null for a period-close event and the journal's origin string otherwise
 * (`'manual'`, `'adjusting'`, `'reclassifying'`, `'reversal'`, …) — the audit schema's own
 * words. Flagging only the two an accountant's period-end review cares about; an ordinary
 * manual entry or a reversal is not called out, because calling out everything is the same
 * as calling out nothing.
 */
function EntryRow({ entry }: { readonly entry: AuditEntry }): ReactElement {
  const flagged = entry.source === 'adjusting' || entry.source === 'reclassifying';

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="py-2 pr-3 font-mono text-sm whitespace-nowrap text-text-muted">
        {formatTimestamp(entry.occurredAt)}
      </td>
      <td className="py-2 pr-3">
        <span className="text-text">{actorLabel(entry.actor)}</span>
        <span className="block text-xs text-text-subtle">{entry.actor.type}</span>
      </td>
      <td className="py-2 pr-3 text-sm text-text-muted">{entry.action}</td>
      <td className="py-2 pr-3 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          {entry.summary}
          {flagged && (
            <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
              {entry.source === 'adjusting' ? 'Adjusting' : 'Reclassifying'}
            </span>
          )}
        </span>
      </td>
      <td className="py-2 font-mono text-sm text-text-subtle">{entry.reference ?? '—'}</td>
    </tr>
  );
}

/**
 * A real instant (`occurredAt`) in the reader's own zone — `settings/support.ts`'s
 * `formatTimestamp`, copied rather than imported for the self-containment reason every
 * screen folder in this package gives.
 */
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/** `reports/controls.tsx`'s own `DateControl`, copied for the same reason. */
function DateControl({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cx(
          'h-9 rounded-md border border-border bg-surface px-2 text-base text-text',
          'font-mono tabular-nums',
        )}
      />
    </label>
  );
}
