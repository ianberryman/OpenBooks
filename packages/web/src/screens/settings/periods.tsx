import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeEvent, ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';
import {
  Button,
  CONTROL_CLASSES,
  Dialog,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  Select,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import { Notice, Pill, SettingsSection, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from './section';
import {
  currentCalendarMonth,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  formatCalendarDate,
  formatTimestamp,
  monthKey,
  monthName,
} from './support';

/**
 * Fiscal periods (OB-050; spec §7, ROADMAP D-08, D-17).
 *
 * ## Why this section comes first on the screen
 *
 * D-17 made generation explicit and never implicit, because auto-creating the enclosing
 * period at posting time would let a posting silently manufacture a period inside a year
 * that had already been closed. The consequence lands here: `journals.period_id` is
 * `NOT NULL`, so **an org with no periods cannot post anything at all**, and `POST
 * /v1/journals` answers `precondition_failed` until this button has been pressed once.
 *
 * A new user has no way to know that. So the empty state is not a polite "nothing here
 * yet" — it says the books are unusable and puts the one control that fixes it directly
 * underneath, and it is the first thing on the settings screen rather than the third.
 *
 * ## The start month is the org's, and it is frequently not January
 *
 * `fiscalYearStartMonth` comes from the org (D-17 — April, July and October are all
 * common) and never from this screen, which is also why the request body carries only a
 * year: a caller that could choose the start month per call could generate two overlapping
 * years for one org. Every year offered here is therefore labelled with the twelve months
 * it actually spans, because "FY 2026" means April 2026 to March 2027 for a large minority
 * of orgs and there is nothing on the screen to infer that from.
 */
const IDENTITY_QUERY_KEY = ['settings', 'identity'] as const;
const PERIODS_QUERY_KEY = ['settings', 'fiscal-periods'] as const;

type FiscalPeriod = components['schemas']['FiscalPeriod'];
type PeriodCloseCheck = components['schemas']['PeriodCloseCheck'];

function closeChecklistQueryKey(periodId: string | null): readonly unknown[] {
  return ['settings', 'fiscal-periods', 'close-checklist', periodId];
}

/** How many years either side of the current one the generator offers. */
const YEAR_WINDOW = 2;

export function FiscalPeriodsSection(): ReactElement {
  const queryClient = useQueryClient();

  /**
   * The org's start month, read from the caller's identity rather than from a settings
   * endpoint: `GET /v1/auth/me` already returns every membership with its `OrgSummary`,
   * and the active one is the org every other request on this screen is scoped to.
   */
  const identity = useQuery({
    queryKey: IDENTITY_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/auth/me')),
  });

  const periods = useQuery({
    queryKey: PERIODS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/fiscal-periods')),
  });

  const activeOrg = useMemo(() => {
    const data = identity.data;
    if (data === undefined || data.activeOrgId === null) return null;
    return (
      data.memberships.find((membership) => membership.org.id === data.activeOrgId)?.org ?? null
    );
  }, [identity.data]);

  const startMonth = activeOrg?.fiscalYearStartMonth ?? 1;
  const currentFiscalYear = fiscalYearOf(currentCalendarMonth(), startMonth);

  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const fiscalYear = selectedYear ?? currentFiscalYear;

  const generate = useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<{ fiscalYear: number }>) =>
      unwrap(
        await api.POST('/v1/fiscal-years', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PERIODS_QUERY_KEY });
    },
  });

  /**
   * Close and reopen (initiative P, OB-193; ROADMAP D-97), each carrying an optional note
   * — a sign-off on a close, a reason on a reopen. Two mutations rather than one with a
   * computed path and a shared `action`, for the reason the pre-P version of this code
   * already gave: close and reopen are separate operations with separate permissions on
   * the server, and the generated client types each path independently.
   */
  const closePeriod = useMutation({
    mutationFn: async ({
      idempotencyKey,
      periodId,
      note,
    }: IdempotentVariables<{ periodId: string; note: string }>) =>
      unwrap(
        await api.POST('/v1/fiscal-periods/{periodId}/close', {
          params: { path: { periodId }, header: idempotencyHeader(idempotencyKey) },
          // An empty sign-off note is the same as none, so `{}` is sent rather than
          // `{ note: '' }` — `note` is optional on `ClosePeriodRequest`, and a blank
          // string recorded against the close event would read as a note someone typed.
          body: note.trim() === '' ? {} : { note: note.trim() },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PERIODS_QUERY_KEY });
      // The audit report (initiative P) records every close and reopen, so it is stale the
      // moment this succeeds. Its own mutations must invalidate it explicitly
      // (`query/client.ts`'s contract) — without this a user who closes a period and opens
      // the audit trail inside the 30s staleTime sees a trail missing their own action.
      await queryClient.invalidateQueries({ queryKey: ['reports', 'audit'] });
    },
  });

  const reopenPeriod = useMutation({
    mutationFn: async ({
      idempotencyKey,
      periodId,
      note,
    }: IdempotentVariables<{ periodId: string; note: string }>) =>
      unwrap(
        await api.POST('/v1/fiscal-periods/{periodId}/reopen', {
          params: { path: { periodId }, header: idempotencyHeader(idempotencyKey) },
          body: note.trim() === '' ? {} : { note: note.trim() },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PERIODS_QUERY_KEY });
      // Same as the close handler above: a reopen is an audit-recorded event, so the audit
      // report's cache must be invalidated here too.
      await queryClient.invalidateQueries({ queryKey: ['reports', 'audit'] });
    },
  });

  const [closeTarget, setCloseTarget] = useState<FiscalPeriod | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const [reopenTarget, setReopenTarget] = useState<FiscalPeriod | null>(null);
  const [reopenNote, setReopenNote] = useState('');

  const closingPeriodId = closeTarget?.id ?? null;

  /**
   * The advisory checklist (P3; `GET …/close-checklist`), fetched fresh every time the
   * close dialog opens for a period — a side-effect-free preview, recomputed and recorded
   * for real only when the close itself is confirmed (the route's own description).
   */
  const closeChecklist = useQuery({
    queryKey: closeChecklistQueryKey(closingPeriodId),
    enabled: closingPeriodId !== null,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/fiscal-periods/{periodId}/close-checklist', {
          // `enabled` guarantees `closingPeriodId` is non-null whenever this actually runs.
          params: { path: { periodId: closingPeriodId as string } },
        }),
      ),
  });

  function closeDialog(open: boolean): void {
    if (open) return;
    setCloseTarget(null);
    setCloseNote('');
  }

  function reopenDialog(open: boolean): void {
    if (open) return;
    setReopenTarget(null);
    setReopenNote('');
  }

  const existingMonths = useMemo(
    () => new Set((periods.data?.periods ?? []).map((period) => period.startDate.slice(0, 7))),
    [periods.data],
  );

  const yearOptions = useMemo(() => {
    return Array.from({ length: YEAR_WINDOW * 2 + 1 }, (_unused, index) => {
      const year = currentFiscalYear - YEAR_WINDOW + index;
      const complete = fiscalYearMonths(year, startMonth).every((month) =>
        existingMonths.has(monthKey(month)),
      );
      return {
        value: String(year),
        label: complete
          ? `${fiscalYearLabel(year, startMonth)} — already generated`
          : fiscalYearLabel(year, startMonth),
        /**
         * Disabled rather than hidden. Regenerating is not destructive — the server
         * refuses an overlap — but an option that silently does nothing is worse than one
         * that says why it is unavailable.
         */
        disabled: complete,
      };
    });
  }, [currentFiscalYear, existingMonths, startMonth]);

  const groups = useMemo(
    () => groupByFiscalYear(periods.data?.periods ?? [], startMonth),
    [periods.data, startMonth],
  );

  const hasNoPeriods = periods.isSuccess && periods.data.periods.length === 0;

  return (
    <SettingsSection
      title="Fiscal periods"
      description={
        <>
          The accounting calendar. A period is a calendar month, and twelve of them are generated at
          a time from the month this organization&rsquo;s fiscal year begins in —{' '}
          <strong className="font-medium text-text">{monthName(startMonth)}</strong>. Every entry
          must fall inside one, and generating them is always something you do, never something a
          posting does for you.
        </>
      }
    >
      {identity.isError && <ErrorBanner error={identity.error} />}
      {periods.isError && (
        <ErrorBanner
          error={periods.error}
          onRetry={() => {
            void periods.refetch();
          }}
        />
      )}

      {hasNoPeriods && (
        <Notice tone="warning" title="This organization cannot record anything yet">
          Nothing can be posted until the periods exist — every entry belongs to a period, and
          nothing creates one on your behalf. Generate the first fiscal year below; it takes one
          press and can be repeated for earlier and later years at any time.
        </Notice>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-text">Fiscal year</span>
          <Select
            aria-label="Fiscal year to generate"
            value={String(fiscalYear)}
            options={yearOptions}
            onValueChange={(value) => {
              setSelectedYear(Number(value));
            }}
            className="w-72"
          />
        </div>
        <Button
          variant="primary"
          disabled={generate.isPending || identity.isPending}
          onClick={() => {
            // One key per intent: minted here, at the press, and carried in the variables so
            // that a retry of *this* generation replays it rather than making a second year.
            generate.mutate({ fiscalYear, idempotencyKey: newIdempotencyKey() });
          }}
        >
          {generate.isPending ? 'Generating…' : 'Generate 12 periods'}
        </Button>
      </div>

      {generate.isError && <ErrorBanner error={generate.error} />}
      {generate.isSuccess && (
        <Notice tone="success">
          Generated {String(generate.data.periods.length)} periods,{' '}
          {formatCalendarDate(generate.data.startDate)} to{' '}
          {formatCalendarDate(generate.data.endDate)}.
        </Notice>
      )}

      {groups.map((group) => (
        <div key={group.fiscalYear} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-text">
            {fiscalYearLabel(group.fiscalYear, startMonth)}
          </h3>
          <ResponsiveTable>
            <table className={TABLE_CLASSES}>
              <caption className="sr-only">
                Periods in {fiscalYearLabel(group.fiscalYear, startMonth)}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASSES}>
                    Period
                  </th>
                  <th scope="col" className={TH_CLASSES}>
                    Dates
                  </th>
                  <th scope="col" className={TH_CLASSES}>
                    Status
                  </th>
                  <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.periods.map((period) => {
                  const closed = period.status === 'closed';
                  const busy = closed
                    ? reopenPeriod.isPending && reopenPeriod.variables?.periodId === period.id
                    : closePeriod.isPending && closePeriod.variables?.periodId === period.id;

                  return (
                    <tr key={period.id}>
                      <td className={cx(TD_CLASSES, 'font-mono')}>{period.name}</td>
                      <td className={cx(TD_CLASSES, 'text-text-muted')}>
                        {formatCalendarDate(period.startDate)} –{' '}
                        {formatCalendarDate(period.endDate)}
                      </td>
                      <td className={TD_CLASSES}>
                        <Pill tone={closed ? 'muted' : 'positive'}>
                          {closed ? 'Closed' : 'Open'}
                        </Pill>
                        {closed && period.closedAt !== null && (
                          <span className="ml-2 text-xs text-text-subtle">
                            {formatTimestamp(period.closedAt)}
                          </span>
                        )}
                      </td>
                      <td className={cx(TD_CLASSES, 'text-right')}>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            // Opens the sign-off dialog rather than closing directly (P3):
                            // the checklist is fetched once the target is set, below.
                            if (closed) setReopenTarget(period);
                            else setCloseTarget(period);
                          }}
                        >
                          {closed ? 'Reopen' : 'Close'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ResponsiveTable>
        </div>
      ))}

      {groups.length > 0 && (
        <p className="max-w-prose text-xs text-text-subtle">
          Closing a period refuses any entry dated inside it. Reopening withdraws figures that may
          already have been reported, so it is a separate permission from closing rather than the
          same switch in the other direction.
        </p>
      )}

      <Dialog open={closeTarget !== null} onOpenChange={closeDialog}>
        <DialogContent
          title={closeTarget === null ? 'Close period' : `Close ${closeTarget.name}`}
          description={
            'The checks below are advisory — a warning never blocks the close. Sign off over ' +
            'one if it is expected, and the note travels with the close event for whoever ' +
            'reviews it later.'
          }
          footer={
            <>
              <Button
                onClick={() => {
                  closeDialog(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={closePeriod.isPending}
                onClick={() => {
                  if (closeTarget === null) return;
                  closePeriod.mutate(
                    {
                      periodId: closeTarget.id,
                      note: closeNote,
                      idempotencyKey: newIdempotencyKey(),
                    },
                    { onSuccess: () => closeDialog(false) },
                  );
                }}
              >
                {closePeriod.isPending ? 'Closing…' : 'Close period'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {closePeriod.isError && <ErrorBanner error={closePeriod.error} />}

            {closeChecklist.isError && (
              <ErrorBanner
                error={closeChecklist.error}
                onRetry={() => {
                  void closeChecklist.refetch();
                }}
              />
            )}
            {closeChecklist.isPending && <p className="text-text-subtle">Checking…</p>}
            {closeChecklist.isSuccess && (
              <ul className="flex flex-col gap-2">
                {closeChecklist.data.checks.map((check) => (
                  <CloseCheckRow key={check.key} check={check} />
                ))}
              </ul>
            )}

            <Field>
              <FieldLabel>Sign-off note (optional)</FieldLabel>
              <TextArea
                value={closeNote}
                onChange={(event) => {
                  setCloseNote(event.target.value);
                }}
              />
            </Field>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reopenTarget !== null} onOpenChange={reopenDialog}>
        <DialogContent
          title={reopenTarget === null ? 'Reopen period' : `Reopen ${reopenTarget.name}`}
          description={
            'Reopening withdraws a statement that may already have been relied on. The reason ' +
            'is recorded with the reopen event.'
          }
          footer={
            <>
              <Button
                onClick={() => {
                  reopenDialog(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={reopenPeriod.isPending}
                onClick={() => {
                  if (reopenTarget === null) return;
                  reopenPeriod.mutate(
                    {
                      periodId: reopenTarget.id,
                      note: reopenNote,
                      idempotencyKey: newIdempotencyKey(),
                    },
                    { onSuccess: () => reopenDialog(false) },
                  );
                }}
              >
                {reopenPeriod.isPending ? 'Reopening…' : 'Reopen period'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {reopenPeriod.isError && <ErrorBanner error={reopenPeriod.error} />}

            <Field>
              <FieldLabel>Reason (optional)</FieldLabel>
              <TextArea
                value={reopenNote}
                onChange={(event) => {
                  setReopenNote(event.target.value);
                }}
              />
            </Field>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

/**
 * One advisory check (P3). `warn` never disables the sign-off button above it — that is
 * the whole of D-97's "advisory" — so the only thing this row does is make a warning
 * legible enough to sign off over on purpose rather than by not reading it.
 */
function CloseCheckRow({ check }: { readonly check: PeriodCloseCheck }): ReactElement {
  const warn = check.status === 'warn';

  return (
    <li
      className={cx(
        'flex flex-col gap-0.5 rounded-md border px-3 py-2 text-sm',
        warn
          ? 'border-warning-border bg-warning-soft text-warning-text'
          : 'border-border bg-surface-sunken text-text-muted',
      )}
    >
      <span className="flex items-center justify-between gap-2 font-medium">
        <span>{check.label}</span>
        <span className="text-xs tracking-wide uppercase">{warn ? 'Warning' : 'Pass'}</span>
      </span>
      <span>
        {check.detail}
        {check.count !== undefined && ` — ${String(check.count)}`}
      </span>
    </li>
  );
}

/**
 * The sign-off note and the reopen reason — `contacts/contact-form.tsx`'s own `TextArea`,
 * copied rather than imported for the self-containment reason every screen folder here
 * gives: no screen imports another's local control.
 */
function TextArea({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <textarea
      {...control}
      value={value}
      rows={3}
      maxLength={1000}
      className={cx(CONTROL_CLASSES, 'border-border h-auto py-1.5')}
      onChange={onChange}
    />
  );
}

interface FiscalYearGroup {
  readonly fiscalYear: number;
  readonly periods: readonly FiscalPeriod[];
}

/**
 * Periods grouped into the fiscal years they belong to, newest first.
 *
 * Grouped rather than listed flat because with a non-January start month a flat list of
 * `2026-01 … 2026-12` is actively misleading about which twelve months were closed
 * together, and closing a year is the operation the grouping exists to make visible.
 */
function groupByFiscalYear(
  periods: readonly FiscalPeriod[],
  startMonth: number,
): readonly FiscalYearGroup[] {
  const byYear = new Map<number, FiscalPeriod[]>();

  for (const period of periods) {
    const year = Number(period.startDate.slice(0, 4));
    const month = Number(period.startDate.slice(5, 7));
    const fiscalYear = fiscalYearOf({ year, month }, startMonth);
    const bucket = byYear.get(fiscalYear);
    if (bucket === undefined) byYear.set(fiscalYear, [period]);
    else bucket.push(period);
  }

  return [...byYear.entries()]
    .sort(([left], [right]) => right - left)
    .map(([fiscalYear, group]) => ({
      fiscalYear,
      periods: [...group].sort((left, right) => left.startDate.localeCompare(right.startDate)),
    }));
}
