import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../api';
import {
  Button,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  Select,
  TextInput,
} from '../components';
import { cx } from '../lib/cx';
import { useCreateStatementPackage, useStatementPackages } from './statement-packages/queries';
import type { ReportBasis, StatementPackage } from './statement-packages/queries';

/**
 * Statement packages (initiative P, OB-195; ROADMAP D-96…D-98) — a branded P&L / Balance
 * Sheet / Cash Flow bundle rendered to one PDF for a date range, so an accountant handing a
 * client a period's figures does not run three reports and stitch them by hand.
 *
 * ## What this screen is not
 *
 * It renders nothing itself. `POST /v1/statement-packages` runs the same three reports this
 * package's `reports.tsx` already runs and staples the result into a PDF server-side, so
 * this screen needs no basis logic, no dimension slicing, none of `reports/filters.ts` — it
 * collects a date range and an optional basis override and shows what has already been
 * rendered. `downloadUrl` is a short-lived signed URL minted fresh on every list read
 * (`statement-package.ts`'s own words), so the link on each row is only ever the one just
 * fetched — never cached across a remount the way the row's other fields safely are.
 */

const ORG_DEFAULT_BASIS = 'org-default';

const BASIS_OPTIONS = [
  { value: ORG_DEFAULT_BASIS, label: 'Org default' },
  { value: 'accrual', label: 'Accrual' },
  { value: 'cash', label: 'Cash' },
];

function toBasis(value: string): ReportBasis | undefined {
  if (value === 'accrual') return 'accrual';
  return value === 'cash' ? 'cash' : undefined;
}

/** `2026-01-05`, matching the calendar-date formatting every other screen folder repeats. */
function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) return date;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A real instant (`createdAt`) in the reader's own zone — copied for the self-containment
 * reason every screen folder here gives (`settings/support.ts`'s `formatTimestamp`). */
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export function StatementPackagesScreen(): ReactElement {
  const packages = useStatementPackages();
  const create = useCreateStatementPackage();

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [basis, setBasis] = useState(ORG_DEFAULT_BASIS);

  const canSubmit = periodStart !== '' && periodEnd !== '' && !create.isPending;

  function submit(): void {
    if (!canSubmit) return;
    const resolvedBasis = toBasis(basis);
    create.mutate(
      {
        periodStart,
        periodEnd,
        ...(resolvedBasis === undefined ? {} : { basis: resolvedBasis }),
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          setPeriodStart('');
          setPeriodEnd('');
          setBasis(ORG_DEFAULT_BASIS);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Statement packages</h1>
        <p className="max-w-form text-text-muted">
          The P&amp;L, Balance Sheet and Cash Flow for a date range, rendered to one branded PDF and
          kept here so it can be re-downloaded later. Renders nothing new — it stitches together
          reports you can already run.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-44">
          <FieldLabel>Period start</FieldLabel>
          <TextInput
            type="date"
            value={periodStart}
            disabled={create.isPending}
            onChange={(event) => {
              setPeriodStart(event.target.value);
            }}
          />
        </Field>

        <Field className="w-44">
          <FieldLabel>Period end</FieldLabel>
          <TextInput
            type="date"
            value={periodEnd}
            disabled={create.isPending}
            onChange={(event) => {
              setPeriodEnd(event.target.value);
            }}
          />
        </Field>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">Basis</span>
          <Select
            aria-label="Basis"
            value={basis}
            options={BASIS_OPTIONS}
            disabled={create.isPending}
            onValueChange={setBasis}
            className="w-40"
          />
        </div>

        <Button variant="primary" className="ml-auto" disabled={!canSubmit} onClick={submit}>
          {create.isPending ? 'Rendering…' : 'Generate package'}
        </Button>
      </div>

      {create.isError && <ErrorBanner error={create.error} />}

      {packages.isError && (
        <ErrorBanner
          error={packages.error}
          onRetry={() => {
            void packages.refetch();
          }}
        />
      )}

      {packages.isPending && <p className="text-text-muted">Loading…</p>}

      {packages.isSuccess && packages.data.packages.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          No packages rendered yet.
        </p>
      )}

      {packages.isSuccess && packages.data.packages.length > 0 && (
        <ResponsiveTable>
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">Rendered statement packages, newest first</caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Period
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Basis
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Rendered
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {packages.data.packages.map((pkg) => (
                <PackageRow key={pkg.id} pkg={pkg} />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </div>
  );
}

function PackageRow({ pkg }: { readonly pkg: StatementPackage }): ReactElement {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="py-2 pr-3 font-mono text-sm whitespace-nowrap">
        {formatCalendarDate(pkg.periodStart)} – {formatCalendarDate(pkg.periodEnd)}
      </td>
      <td className="py-2 pr-3 text-sm text-text-muted">
        {pkg.basis === 'cash' ? 'Cash' : 'Accrual'}
      </td>
      <td className="py-2 pr-3 text-sm text-text-muted">
        <span>{formatTimestamp(pkg.createdAt)}</span>
        <span className="block text-xs text-text-subtle">
          {pkg.generatedByName ?? 'A user no longer in this organization'}
        </span>
      </td>
      <td className="py-2 text-right">
        <a
          href={pkg.downloadUrl}
          target="_blank"
          rel="noreferrer"
          className={cx(
            'rounded-sm text-text underline-offset-2 hover:underline',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
          )}
        >
          Download PDF
        </a>
      </td>
    </tr>
  );
}
