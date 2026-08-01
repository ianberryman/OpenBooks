import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Ten99WorksheetRow } from '@openbooks/shared-types';

import { newIdempotencyKey } from '../api';
import {
  Button,
  ErrorBanner,
  Field,
  FieldLabel,
  MoneyInput,
  Pill,
  ResponsiveTable,
  formatMinorUnits,
  formatMoney,
} from '../components';
import { useCreateTen99Run, useTen99Worksheet } from './queries';
import { VendorTaxProfileDialog } from './vendor-tax-profile-dialog';

/**
 * The Worksheet tab of the 1099 Center (OB-228 Wave-1 Stream D).
 *
 * This is the human-review step D-228-3 is built around: the worksheet is cash actually
 * paid to each 1099-eligible vendor in the tax year (card and third-party payments
 * excluded server-side, D-228-4), with three flags per row — over threshold, has a TIN on
 * file, likely exempt as a corporation — and **nothing here generates a form on its own**.
 * "Generate 1099s" is a deliberate second step, gated on there being at least one
 * over-threshold vendor, so a run is never produced from an empty or stale worksheet.
 */
export function Ten99Worksheet({ taxYear }: { readonly taxYear: number }): ReactElement {
  const navigate = useNavigate();
  const [thresholdMinor, setThresholdMinor] = useState<string | null>(null);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [editingContactName, setEditingContactName] = useState('');

  const worksheet = useTen99Worksheet(taxYear, thresholdMinor ?? undefined);
  const createRun = useCreateTen99Run();

  const rows = worksheet.data?.rows ?? [];
  const overThreshold = rows.filter((row) => row.meetsThreshold);
  const canGenerate = overThreshold.length > 0 && !createRun.isPending;

  function openProfile(row: Ten99WorksheetRow): void {
    setEditingContactId(row.contactId);
    setEditingContactName(row.contactName);
  }

  function generate(): void {
    if (!canGenerate) return;
    createRun.mutate(
      {
        taxYear,
        ...(thresholdMinor === null ? {} : { thresholdMinor }),
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (run) => {
          void navigate(`/ten99/runs/${run.id}`);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-40" hint="Blank uses the $600 NEC default.">
          <FieldLabel>Reporting threshold</FieldLabel>
          <MoneyInput
            value={thresholdMinor}
            placeholder={
              worksheet.data === undefined
                ? '0.00'
                : formatMinorUnits(worksheet.data.thresholdMinor)
            }
            onValueChange={setThresholdMinor}
          />
        </Field>

        <div className="flex-1" />

        <Button
          variant="primary"
          disabled={!canGenerate}
          onClick={generate}
          title={
            overThreshold.length === 0
              ? 'No vendor is currently over the reporting threshold.'
              : undefined
          }
        >
          {createRun.isPending ? 'Generating…' : 'Generate 1099s'}
        </Button>
      </div>

      {createRun.isError && <ErrorBanner error={createRun.error} />}

      <p className="text-sm text-text-muted">
        Review this list before generating. It is the live cash-paid total for {taxYear} — card and
        third-party payments are excluded — not a filing; nothing is submitted anywhere until a run
        is generated and, separately, e-filed.
      </p>

      {worksheet.error != null && (
        <ErrorBanner error={worksheet.error} onRetry={() => void worksheet.refetch()} />
      )}

      {worksheet.isPending && <p className="text-text-subtle">Loading the worksheet…</p>}

      {worksheet.isSuccess && rows.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          No 1099-eligible vendor was paid in {taxYear}.
        </p>
      )}

      {worksheet.isSuccess && rows.length > 0 && (
        <ResponsiveTable aria-label="1099 worksheet">
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">
              1099 worksheet for {taxYear}, one row per eligible vendor
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Vendor
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Legal name
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  TIN
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Paid
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Review
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Edit profile</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <WorksheetRow key={row.contactId} row={row} onEdit={() => openProfile(row)} />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}

      <VendorTaxProfileDialog
        contactId={editingContactId}
        contactName={editingContactName}
        onClose={() => {
          setEditingContactId(null);
        }}
      />
    </div>
  );
}

function WorksheetRow({
  row,
  onEdit,
}: {
  readonly row: Ten99WorksheetRow;
  readonly onEdit: () => void;
}): ReactElement {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="py-2 pr-3 text-sm text-text">{row.contactName}</td>
      <td className="py-2 pr-3 text-sm text-text-muted">{row.legalName}</td>
      <td className="py-2 pr-3 font-mono text-sm whitespace-nowrap text-text-muted">
        {row.taxIdLast4 === null ? '—' : `••${row.taxIdLast4}`}
      </td>
      <td className="py-2 pr-3 text-right text-sm text-text tabular-nums">
        {formatMoney(row.paidMinor)}
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap gap-1">
          <Pill tone={row.meetsThreshold ? 'accent' : 'neutral'}>
            {row.meetsThreshold ? 'Over threshold' : 'Under threshold'}
          </Pill>
          <Pill tone={row.hasTaxId ? 'positive' : 'negative'}>
            {row.hasTaxId ? 'Has TIN' : 'No TIN'}
          </Pill>
          {row.likelyExempt && <Pill tone="muted">Likely exempt</Pill>}
        </div>
      </td>
      <td className="py-2 text-right">
        <Button size="sm" onClick={onEdit}>
          Edit profile
        </Button>
      </td>
    </tr>
  );
}
