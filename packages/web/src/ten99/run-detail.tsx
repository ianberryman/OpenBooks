import type { ReactElement } from 'react';

import type { Ten99Form, Ten99Run, Ten99RunStatus } from '@openbooks/shared-types';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner, Pill, ResponsiveTable, formatMoney } from '../components';
import type { PillTone } from '../components';
import { API_BASE_URL } from '../env';
import { cx } from '../lib/cx';
import { useEfileTen99Run, useTen99Run } from './queries';

/**
 * One filing run: its status, its e-file action, and its immutable forms (OB-228 Wave-1
 * Stream D, D-228-5/6).
 *
 * Every form here is a fait accompli — generated is a snapshot, and this screen offers no
 * way to edit or delete one, mirroring the sales screen's own "nothing is deleted" stance
 * (D-16) applied to a compliance document instead of a journal. The only action this run
 * can still take is e-file, and v1 offers `manual` only (D-228-6): there is no dedicated
 * transmit sign-off key yet, so the button here is available to anyone with `ten99.write`
 * rather than gated a second way in the UI beyond what the server itself enforces.
 */

const STATUS_TONE: Readonly<Record<Ten99RunStatus, PillTone>> = {
  draft: 'neutral',
  generated: 'accent',
  submitted: 'accent',
  accepted: 'positive',
  rejected: 'negative',
};

const STATUS_LABEL: Readonly<Record<Ten99RunStatus, string>> = {
  draft: 'Draft',
  generated: 'Generated',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

/** A real instant (`createdAt`) in the reader's own zone — copied for the self-containment
 * reason every screen folder here gives (`settings/support.ts`'s `formatTimestamp`). */
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

const LINK_CLASSES = cx(
  'rounded-sm text-text underline-offset-2 hover:underline',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
);

export interface Ten99RunDetailProps {
  readonly runId: string;
  readonly onBack: () => void;
}

export function Ten99RunDetail({ runId, onBack }: Ten99RunDetailProps): ReactElement {
  const run = useTen99Run(runId);
  const efile = useEfileTen99Run();

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" onClick={onBack}>
        ← Back to runs
      </Button>

      {run.error != null && <ErrorBanner error={run.error} onRetry={() => void run.refetch()} />}
      {run.isPending && <p className="text-text-subtle">Loading the run…</p>}

      {run.isSuccess && (
        <RunBody
          run={run.data}
          efilePending={efile.isPending}
          efileError={efile.isError ? efile.error : null}
          onEfile={() => {
            efile.mutate({ runId, provider: 'manual', idempotencyKey: newIdempotencyKey() });
          }}
        />
      )}
    </div>
  );
}

function RunBody({
  run,
  efilePending,
  efileError,
  onEfile,
}: {
  readonly run: Ten99Run;
  readonly efilePending: boolean;
  readonly efileError: unknown;
  readonly onEfile: () => void;
}): ReactElement {
  const canEfile = run.status === 'generated' && !efilePending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">1099 run — {run.taxYear}</h1>
        <Pill tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Pill>
      </div>
      <p className="text-sm text-text-muted">
        Threshold applied: {formatMoney(run.thresholdMinor)}. Generated{' '}
        {formatTimestamp(run.createdAt)}.
      </p>

      {efileError !== null && <ErrorBanner error={efileError} />}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div>
          <p className="text-sm font-medium text-text">E-file</p>
          <p className="text-sm text-text-muted">
            {run.efileProvider === null
              ? 'Not yet submitted.'
              : `Submitted via ${run.efileProvider}` +
                `${run.efileRef !== null ? ` — ${run.efileRef}` : ''}.`}
          </p>
        </div>
        <div className="flex-1" />
        <Button
          variant="primary"
          disabled={!canEfile}
          onClick={onEfile}
          title={
            run.status !== 'generated' ? `A ${run.status} run cannot be e-filed again.` : undefined
          }
        >
          {efilePending ? 'Submitting…' : 'E-file (manual)'}
        </Button>
      </div>

      {run.forms.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          This run generated no forms.
        </p>
      ) : (
        <ResponsiveTable aria-label="Filed 1099 forms">
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">The forms this run generated</caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Vendor
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Form
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Box
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  TIN
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {run.forms.map((form) => (
                <FormRow key={form.id} form={form} />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </div>
  );
}

function FormRow({ form }: { readonly form: Ten99Form }): ReactElement {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="py-2 pr-3 text-sm text-text">{form.recipientLegalName}</td>
      <td className="py-2 pr-3 text-sm text-text-muted uppercase">
        {form.formType.replace('_', '-')}
      </td>
      <td className="py-2 pr-3 text-sm text-text-muted">{form.boxCode}</td>
      <td className="py-2 pr-3 text-right text-sm text-text tabular-nums">
        {formatMoney(form.amountMinor)}
      </td>
      <td className="py-2 pr-3 font-mono text-sm whitespace-nowrap text-text-muted">
        {form.recipientTinLast4 === null ? '—' : `••${form.recipientTinLast4}`}
      </td>
      <td className="py-2 text-right">
        {/*
         * The on-demand render route (`GET /v1/ten99/forms/{id}/pdf`), not the wire form's
         * `downloadUrl`. That field is a signed URL to a *deterministic storage key* that is
         * only populated the first time the form is rendered (`ten99.service.ts` assumption 1),
         * and nothing renders eagerly — so a cold link 404s ("No such artifact"). This route
         * renders, stores, and streams in one call, so it works from a never-rendered state and
         * always reflects current branding. Built from `API_BASE_URL` so a cross-origin
         * deployment reaches the api, not the static host; same-origin resolves to a plain path.
         */}
        <a
          href={`${API_BASE_URL}/v1/ten99/forms/${form.id}/pdf`}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLASSES}
        >
          Download Copy B
        </a>
      </td>
    </tr>
  );
}
