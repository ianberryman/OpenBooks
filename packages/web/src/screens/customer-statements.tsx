import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../api';
import {
  Button,
  Combobox,
  ErrorBanner,
  Field,
  FieldLabel,
  Pill,
  ResponsiveTable,
  TextInput,
} from '../components';
import type { PillTone } from '../components';
import { cx } from '../lib/cx';
import { formatMoney } from '../money/format';
import { useCreateCustomerStatement, useCustomerStatements } from './customer-statements/queries';
import type { CustomerStatement } from './customer-statements/queries';
import { useSalesReferenceData } from './sales/queries';

/**
 * Customer statement of account (OB-220 part 1).
 *
 * ## What this screen is not
 *
 * A statement is the aging report (`money-in/aging.tsx`) scoped to one customer, rendered
 * to a branded PDF server-side and optionally emailed — `POST /v1/customer-statements`'s
 * own description. This screen therefore needs no aging logic of its own: it collects a
 * customer, an as-at date and an optional recipient, and shows what has already been
 * rendered, the same division `statement-packages.tsx` draws for the P&L/Balance
 * Sheet/Cash Flow bundle. `downloadUrl` is a short-lived signed URL minted fresh on every
 * list read, so — as that screen's own comment puts it — the link on each row is only ever
 * the one just fetched, never cached across a remount the way the row's other fields
 * safely are.
 */

/** `YYYY-MM-DD` in the reader's own timezone — copied per the self-containment reason
 * `formatTimestamp` below gives (`money-in/amounts.tsx`'s `todayCalendarDate`). */
function todayCalendarDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

const STATUS_TONE: Readonly<Record<CustomerStatement['status'], PillTone>> = {
  generated: 'neutral',
  sent: 'positive',
  failed: 'negative',
};

const STATUS_LABEL: Readonly<Record<CustomerStatement['status'], string>> = {
  generated: 'Generated',
  sent: 'Sent',
  failed: 'Failed',
};

const LINK_CLASSES = cx(
  'rounded-sm text-text underline-offset-2 hover:underline',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
);

export function CustomerStatementsScreen(): ReactElement {
  const reference = useSalesReferenceData();
  const statements = useCustomerStatements();
  const create = useCreateCustomerStatement();

  const [contactId, setContactId] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(todayCalendarDate());
  const [recipientEmail, setRecipientEmail] = useState('');

  // Same filter `screens/sales.tsx`'s "New invoice" seeding applies: a statement is a
  // customer-facing document, so the picker offers only contacts flagged as customers.
  const customers = reference.data?.contacts.filter((contact) => contact.isCustomer) ?? [];
  const customerOptions = customers.map((contact) => ({
    value: contact.id,
    label: contact.displayName,
  }));

  const trimmedEmail = recipientEmail.trim();
  const referenceReady = reference.data !== null;
  const canSubmit = contactId !== null && asOf !== '' && referenceReady && !create.isPending;

  function submit(): void {
    if (!canSubmit || contactId === null) return;
    create.mutate(
      {
        contactId,
        asOf,
        ...(trimmedEmail === '' ? {} : { delivery: { recipientEmail: trimmedEmail } }),
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          setRecipientEmail('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Customer statements</h1>
        <p className="max-w-form text-text-muted">
          The aging report for one customer, rendered to a branded PDF that can be downloaded here
          or emailed straight to them.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-64">
          <FieldLabel>Customer</FieldLabel>
          <Combobox
            value={contactId}
            options={customerOptions}
            placeholder="Choose a customer…"
            emptyMessage="No customers yet."
            disabled={create.isPending || !referenceReady}
            onValueChange={setContactId}
          />
        </Field>

        <Field className="w-40">
          <FieldLabel>As at</FieldLabel>
          <TextInput
            type="date"
            value={asOf}
            disabled={create.isPending}
            onChange={(event) => {
              setAsOf(event.target.value);
            }}
          />
        </Field>

        <Field className="w-64" hint="Leave blank to generate for download only.">
          <FieldLabel>Email to</FieldLabel>
          <TextInput
            type="email"
            value={recipientEmail}
            placeholder="customer@example.com"
            disabled={create.isPending}
            onChange={(event) => {
              setRecipientEmail(event.target.value);
            }}
          />
        </Field>

        <Button variant="primary" className="ml-auto" disabled={!canSubmit} onClick={submit}>
          {create.isPending ? 'Generating…' : trimmedEmail === '' ? 'Generate' : 'Generate & send'}
        </Button>
      </div>

      {create.isError && <ErrorBanner error={create.error} />}

      {reference.error !== null && (
        <ErrorBanner
          error={reference.error}
          onRetry={() => {
            reference.refetch();
          }}
        />
      )}

      {statements.isError && (
        <ErrorBanner
          error={statements.error}
          onRetry={() => {
            void statements.refetch();
          }}
        />
      )}

      {statements.isPending && <p className="text-text-muted">Loading…</p>}

      {statements.isSuccess && statements.data.statements.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          No statements generated yet.
        </p>
      )}

      {statements.isSuccess && statements.data.statements.length > 0 && (
        <ResponsiveTable>
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">Customer statements, newest first</caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Customer
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  As at
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Balance due
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Generated by
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {statements.data.statements.map((statement) => (
                <StatementRow key={statement.id} statement={statement} />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </div>
  );
}

function StatementRow({ statement }: { readonly statement: CustomerStatement }): ReactElement {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="py-2 pr-3 text-sm text-text">{statement.contactName}</td>
      <td className="py-2 pr-3 font-mono text-sm whitespace-nowrap">
        {formatCalendarDate(statement.asOf)}
      </td>
      <td className="py-2 pr-3">
        <Pill tone={STATUS_TONE[statement.status]}>{STATUS_LABEL[statement.status]}</Pill>
      </td>
      <td className="py-2 pr-3 text-sm text-text">{formatMoney(statement.closingBalanceMinor)}</td>
      <td className="py-2 pr-3 text-sm text-text-muted">
        <span>{formatTimestamp(statement.createdAt)}</span>
        <span className="block text-xs text-text-subtle">
          {statement.generatedByName ?? 'A user no longer in this organization'}
        </span>
      </td>
      <td className="py-2 text-right">
        <div className="flex flex-col items-end gap-1">
          <a href={statement.downloadUrl} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
            Download PDF
          </a>
          {statement.publicUrl !== null && (
            <a href={statement.publicUrl} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
              Customer link
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}
