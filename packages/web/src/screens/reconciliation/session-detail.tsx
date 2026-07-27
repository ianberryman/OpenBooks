import type { ReactElement } from 'react';
import { useState } from 'react';

import {
  Button,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
  formatMinorUnits,
} from '../../components';
import { cx } from '../../lib/cx';
import { BalancesPanel } from './balances';
import type { ReconciliationSession, ReconciliationSessionEvent } from './queries';
import { useFinaliseSession, useIntentKey, useReopenSession, useSession } from './queries';
import { FinaliseRefusal } from './refusal';
import { ReconciliationReportView } from './report';

/**
 * One reconciliation session (OB-087; ROADMAP E5, E6, E7, D-50, D-51).
 *
 * The panel does four things and defers the fifth. It shows the balances in the frame D-50
 * puts them in (`BalancesPanel`); it lets an open session be **finalised** — the assertion
 * E5 exists to make — and a finalised one be **reopened** with a reason (E6); it shows the
 * **event log** that is E6's record; and it links the **reconciliation report** that explains
 * the gap. What it does not do is *clear* lines into the session — that is the matching
 * screen (OB-086). This one opens, tracks, finalises, reopens and reports.
 *
 * ## Finalisation is the server's to assert, not this screen's to decide
 *
 * The Finalise button is enabled when the difference is zero, because a difference is what
 * E5 forbids and disabling the button there spares the user a call that would only be
 * refused. But the difference this screen holds was computed on read (D-46), and the figure
 * that decides is the one the server recomputes at the moment of the call — so the button
 * does not *gate* on its own copy and skip the call. It makes the call and, if the server
 * refuses with `reconciliation_session_balance_mismatch`, surfaces the mapped refusal. The
 * client is a convenience; the server is the authority.
 *
 * ## The lock is not the period's (E7)
 *
 * Nothing here shows or asks about a fiscal period. A reconciliation session and a
 * period close are independent locks (D-45), and coupling them on this screen — a period
 * field, a "closed" note — would put back the confusion E7 was drawn to prevent.
 */

type Tab = 'summary' | 'report';

export function SessionDetail({ sessionId }: { readonly sessionId: string }): ReactElement {
  const session = useSession(sessionId);
  const [tab, setTab] = useState<Tab>('summary');

  if (session.isPending) {
    return <p className="text-text-muted">Loading the session…</p>;
  }

  if (session.isError) {
    return (
      <ErrorBanner
        error={session.error}
        onRetry={() => {
          void session.refetch();
        }}
      />
    );
  }

  const data = session.data;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-text">Reconciliation to {data.endDate}</h2>
          <p className="text-sm text-text-subtle">
            Covering {data.startDate} to {data.endDate}
          </p>
        </div>
        <StateBadge session={data} />
      </div>

      <div role="group" aria-label="Session view" className="flex flex-wrap gap-1">
        <TabButton
          label="Balances"
          selected={tab === 'summary'}
          onSelect={() => setTab('summary')}
        />
        <TabButton label="Report" selected={tab === 'report'} onSelect={() => setTab('report')} />
      </div>

      {tab === 'summary' ? (
        <div className="flex flex-col gap-4">
          <BalancesPanel balances={data.balances} unclearedLineCount={data.unclearedLineCount} />
          {data.state === 'open' ? (
            <FinalisePanel session={data} />
          ) : (
            <ReopenPanel session={data} />
          )}
          <EventLog events={data.events} />
        </div>
      ) : (
        <ReconciliationReportView sessionId={sessionId} />
      )}
    </div>
  );
}

function StateBadge({ session }: { readonly session: ReconciliationSession }): ReactElement {
  const finalised = session.state === 'finalised';
  const balanced = session.balances.difference === '0' || session.balances.difference === '-0';
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className={cx(
          'rounded-full border px-2.5 py-0.5 text-xs font-medium',
          finalised
            ? 'border-success-border bg-success-soft text-success-text'
            : 'border-border bg-surface-sunken text-text-muted',
        )}
      >
        {finalised ? 'Finalised' : 'Open'}
      </span>
      {!finalised && (
        <span className={cx('text-xs', balanced ? 'text-success-text' : 'text-warning-text')}>
          {balanced ? 'Balances' : 'Not reconciled yet'}
        </span>
      )}
    </div>
  );
}

function TabButton({
  label,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        'rounded-md border px-3 py-1 text-base transition-colors',
        selected
          ? 'border-border bg-surface-selected font-medium text-text'
          : 'border-transparent text-text-muted hover:bg-surface-hover hover:text-text',
      )}
    >
      {label}
    </button>
  );
}

/**
 * The finalise control. Enabled when the difference is zero; the call still goes to the
 * server, which recomputes the balances and is the one that refuses a mismatch (D-50).
 */
function FinalisePanel({ session }: { readonly session: ReconciliationSession }): ReactElement {
  const finalise = useFinaliseSession();
  const intentKey = useIntentKey();
  const balanced = session.balances.difference === '0' || session.balances.difference === '-0';

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <p className="text-sm text-text">Finalise this reconciliation</p>
      <p className="text-xs text-text-subtle">
        Asserts that the cleared balance equals the statement&rsquo;s closing balance at the end
        date, and freezes the lines this session covered. An unpresented cheque does not stand in
        the way — it is a reconciling difference, not a disagreement.
      </p>
      {finalise.isError && <FinaliseRefusal error={finalise.error} />}
      <div>
        <Button
          variant="primary"
          disabled={finalise.isPending || !balanced}
          onClick={() => {
            finalise.mutate({
              sessionId: session.id,
              idempotencyKey: intentKey(`finalise:${session.id}`),
            });
          }}
        >
          {finalise.isPending ? 'Finalising…' : 'Finalise reconciliation'}
        </Button>
        {!balanced && (
          <p className="pt-1 text-xs text-text-subtle">
            The difference must reach zero first. Clear the missing lines on the matching screen.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The reopen control (E6). Requires a `reason` — a required field, because who and when are
 * known without asking and why is not. It is `banking.reopen`-gated; a role without the
 * permission is refused with `permission_denied`, which `ErrorBanner` phrases as "not
 * available to you".
 */
function ReopenPanel({ session }: { readonly session: ReconciliationSession }): ReactElement {
  const reopen = useReopenSession();
  const intentKey = useIntentKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const canSubmit = reason.trim() !== '' && !reopen.isPending;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <p className="text-sm text-text">Reopen this reconciliation</p>
      <p className="text-xs text-text-subtle">
        Reverts it to open so its clearings can change again. The reason is kept on the record — it
        is the one part a later reader cannot reconstruct.
      </p>
      {reopen.isError && <ErrorBanner error={reopen.error} />}
      {open ? (
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            reopen.mutate({
              sessionId: session.id,
              reason: reason.trim(),
              idempotencyKey: intentKey(`reopen:${session.id}:${reason.trim()}`),
            });
          }}
        >
          <Field hint="Required. Why this finalised reconciliation is being reopened.">
            <FieldLabel>Reason</FieldLabel>
            <TextInput
              value={reason}
              autoComplete="off"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={reopen.isPending}
              onClick={() => {
                setOpen(false);
                setReason('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {reopen.isPending ? 'Reopening…' : 'Reopen'}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Reopen…
          </Button>
        </div>
      )}
    </div>
  );
}

const EVENT_LABEL: Readonly<Record<ReconciliationSessionEvent['type'], string>> = {
  opened: 'Opened',
  finalised: 'Finalised',
  reopened: 'Reopened',
};

/**
 * The append-only record (E6): every open, finalise and reopen, with who and when, the
 * reason on a reopen, and the figure that was asserted on a finalise — captured at the
 * moment of the assertion so a session finalised, reopened, corrected and finalised again
 * shows what each assertion actually claimed.
 */
function EventLog({
  events,
}: {
  readonly events: readonly ReconciliationSessionEvent[];
}): ReactElement {
  return (
    <section aria-label="History" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text">History</h3>
      <ol className="flex flex-col gap-2">
        {events.map((event) => (
          <li
            key={event.id}
            className="flex flex-col gap-0.5 rounded-md border border-border bg-surface p-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-text">{EVENT_LABEL[event.type]}</span>
              <time className="font-mono text-xs text-text-subtle">{event.occurredAt}</time>
            </div>
            <span className="text-xs text-text-subtle">by {event.actorUserId}</span>
            {event.type === 'finalised' && event.statementClosingBalance !== null && (
              <span className="text-xs text-text-muted">
                Asserted{' '}
                <span className="font-mono tabular-nums">
                  {formatMinorUnits(event.statementClosingBalance)}
                </span>
              </span>
            )}
            {event.reason !== null && (
              <span className="text-xs text-text-muted">Reason: {event.reason}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
