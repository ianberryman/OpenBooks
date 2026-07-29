import type { ReactElement } from 'react';
import { useState } from 'react';

import { Combobox, ErrorBanner, Field, FieldLabel, Select } from '../../components';
import { Amount, AmountCell, todayCalendarDate } from './amounts';
import { CheckboxField, DateField } from './controls';
import type { AgingAmounts, AgingControls, AgingDocument, AgingRow } from './queries';
import { useAging, useContactOptions } from './queries';

/**
 * Aging, as at a date (OB-070; ROADMAP D-34, D-40, acceptance C8).
 *
 * ## The date control is the report, not a filter on it
 *
 * D-40 requires aging to be computed **as at** a historical date, and says why: using
 * today's allocations against a past date's documents produces a report that cannot be
 * reproduced tomorrow. So `asOf` is part of the query key and changing it re-asks the
 * server. Nothing here narrows a loaded report to an earlier date, and there is nothing to
 * narrow it with — every figure in the response, including each document's own
 * `outstanding`, was computed as at that date from the allocations dated on or before it.
 *
 * The endpoint makes `asOf` required for the same reason, alone among the reports in this
 * API: a default of "today" would answer differently overnight, and the request that
 * produced a figure someone filed would no longer reproduce it.
 *
 * ## The credit row, and why it is not netted
 *
 * An unapplied payment or credit note is money already sitting in the control account
 * (D-37, D-39), so the buckets would overstate what the business is owed by exactly that
 * amount without it — and C8 is that the buckets tie to the control account. It therefore
 * appears as its own detail row with a **negative** amount, a null due date, and no age.
 *
 * Netting it across the open invoices was the alternative and is refused: it would invent an
 * allocation nobody made, move money between buckets, and make this report disagree with the
 * invoice's own outstanding amount everywhere else in the system — outstanding has exactly
 * one definition, total minus allocations (D-34). So the credit rows sort last, under a
 * heading that says what they are, and the detail sums to the total printed above it.
 *
 * ## Nothing here is recomputed
 *
 * Every figure arrives summed. The screen places strings in columns; it does not add
 * buckets, does not derive a total, and does not decide a status. That is D-34 applied to a
 * viewer, and it is also the reason a wrong total cannot originate on this page.
 */

const LEDGER_OPTIONS = [
  { value: 'receivable', label: 'Receivable — what customers owe us' },
  { value: 'payable', label: 'Payable — what we owe vendors' },
];

/**
 * The five columns, named from the boundaries the contract publishes as data
 * (`AGING_BUCKET_UPPER_BOUNDS`) so that "31–60" cannot mean one thing in the report and
 * another on the page printing the heading. `shared-types` is not a dependency of this
 * package, so the labels are restated here and the keys are the contract's own.
 */
const BUCKETS: readonly {
  readonly key: keyof Omit<AgingAmounts, 'total'>;
  readonly label: string;
}[] = [
  { key: 'current', label: 'Current' },
  { key: 'days1To30', label: '1–30' },
  { key: 'days31To60', label: '31–60' },
  { key: 'days61To90', label: '61–90' },
  { key: 'days90Plus', label: '90+' },
];

const DOCUMENT_LABELS: Readonly<Record<AgingDocument['documentType'], string>> = {
  invoice: 'Invoice',
  bill: 'Bill',
  payment: 'Payment on account',
  credit_note: 'Credit note',
  vendor_credit: 'Vendor credit',
  // Cash application (D-106): a discount always fully settles the document it was
  // written for, so it never actually surfaces here with anything outstanding — the
  // label exists for the type's sake, not because this row is expected in practice.
  discount: 'Early-pay discount',
};

/**
 * A credit is exactly the row with no due date, and that pairing is the contract's:
 * `dueDate` and `daysPastDue` are nullable together and are null on the credit rows only —
 * a credit is allocated, not chased, so a zero would read as "due today", which is a
 * different and false statement.
 */
function isCreditRow(entry: AgingDocument): boolean {
  return entry.dueDate === null;
}

/**
 * Aged documents first, credits last — a stable partition rather than a sort.
 *
 * The server already orders a contact's documents this way, and this does not second-guess
 * it: within each half the server's order is preserved exactly, so the oldest-first
 * ordering the person chasing the money works in survives. What the partition buys is that
 * the presentation does not *depend* on that ordering, which matters because the credit
 * rows are rendered under a heading of their own — a heading whose contents were decided by
 * an ordering somewhere else would be a section that silently mislabels a row.
 */
function creditsLast(documents: readonly AgingDocument[]): {
  readonly aged: readonly AgingDocument[];
  readonly credits: readonly AgingDocument[];
} {
  return {
    aged: documents.filter((entry) => !isCreditRow(entry)),
    credits: documents.filter(isCreditRow),
  };
}

export function AgingView(): ReactElement {
  const [controls, setControls] = useState<AgingControls>({
    asOf: todayCalendarDate(),
    ledger: 'receivable',
    contactId: null,
    detail: false,
    includeZero: false,
  });

  const contacts = useContactOptions();
  const report = useAging(controls);

  function set<K extends keyof AgingControls>(key: K, value: AgingControls[K]): void {
    setControls((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-72">
            <FieldLabel>Ledger</FieldLabel>
            <Select
              value={controls.ledger}
              options={LEDGER_OPTIONS}
              onValueChange={(value) => {
                set('ledger', value === 'payable' ? 'payable' : 'receivable');
              }}
            />
          </Field>

          <DateField
            label="As at"
            className="w-44"
            value={controls.asOf}
            hint="Changing this re-runs the report on the server."
            onChange={(asOf) => {
              set('asOf', asOf);
            }}
          />

          <Field className="w-56">
            <FieldLabel>Contact</FieldLabel>
            <Combobox
              value={controls.contactId}
              options={[
                { value: 'all', label: 'Every contact' },
                ...contacts.map((contact) => ({ value: contact.id, label: contact.displayName })),
              ]}
              placeholder="Every contact"
              onValueChange={(value) => {
                set('contactId', value === 'all' || value === null ? null : value);
              }}
            />
          </Field>

          <CheckboxField
            label="Show the documents behind each row"
            checked={controls.detail}
            onCheckedChange={(detail) => {
              set('detail', detail);
            }}
          />

          <CheckboxField
            label="Include contacts with nothing outstanding"
            checked={controls.includeZero}
            onCheckedChange={(includeZero) => {
              set('includeZero', includeZero);
            }}
          />
        </div>

        <p className="text-xs text-text-subtle">
          Computed as at the date above, from the documents and the allocations dated on or before
          it — so last month&rsquo;s aging still prints last month&rsquo;s figures next year. It is
          not a filter over what is already loaded, and it cannot be: today&rsquo;s allocations
          against a past date&rsquo;s documents would be a report nobody could reproduce.
        </p>
      </div>

      {report.isPending && (
        <p role="status" className="text-text-subtle">
          Running the report…
        </p>
      )}

      {report.isError && (
        <ErrorBanner
          error={report.error}
          onRetry={() => {
            void report.refetch();
          }}
        />
      )}

      {report.isSuccess && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 border-b border-border-strong pb-2">
            <h2 className="text-lg font-semibold text-text">
              {report.data.ledger === 'receivable' ? 'Accounts receivable' : 'Accounts payable'}{' '}
              aging
            </h2>
            <p className="text-sm text-text-muted">
              As at {report.data.asOf}, aged from the due date — which is what &ldquo;overdue&rdquo;
              means to the person chasing it.
            </p>
          </div>

          {report.data.rows.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
              Nothing is outstanding on this side as at {report.data.asOf}.
            </p>
          ) : (
            <>
              <SummaryTable rows={report.data.rows} totals={report.data.totals} />
              {controls.detail &&
                report.data.rows.map((row) => <DetailTable key={row.contactId} row={row} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryTable({
  rows,
  totals,
}: {
  readonly rows: readonly AgingRow[];
  readonly totals: AgingAmounts;
}): ReactElement {
  return (
    <table className="w-full border-collapse text-base">
      <caption className="sr-only">Aging by contact and bucket</caption>
      <thead>
        <tr className="border-b border-border text-left text-sm text-text-muted">
          <th scope="col" className="py-2 pr-3 font-medium">
            Contact
          </th>
          {BUCKETS.map((bucket) => (
            <th key={bucket.key} scope="col" className="px-3 py-2 text-right font-medium">
              {bucket.label}
            </th>
          ))}
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.contactId} className="border-b border-border">
            <th scope="row" className="py-1 pr-3 text-left font-normal text-text">
              {row.contactName}
            </th>
            {BUCKETS.map((bucket) => (
              <AmountCell key={bucket.key} value={row.amounts[bucket.key]} />
            ))}
            <AmountCell value={row.amounts.total} emphasis />
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-border-strong">
          <th scope="row" className="py-1 pr-3 text-left font-semibold text-text">
            All contacts
          </th>
          {BUCKETS.map((bucket) => (
            <AmountCell key={bucket.key} value={totals[bucket.key]} emphasis />
          ))}
          <AmountCell value={totals.total} emphasis />
        </tr>
      </tfoot>
    </table>
  );
}

function DetailTable({ row }: { readonly row: AgingRow }): ReactElement | null {
  if (row.documents === null || row.documents.length === 0) return null;

  const { aged, credits } = creditsLast(row.documents);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-text">{row.contactName}</h3>
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">
          Open items for {row.contactName}, oldest first, with money on account last
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-sm text-text-muted">
            <th scope="col" className="py-1 pr-3 font-medium">
              Document
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Kind
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Issued
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Due
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Days past due
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Outstanding
            </th>
          </tr>
        </thead>
        <tbody>
          {aged.map((entry) => (
            <DetailRow key={entry.documentId} entry={entry} />
          ))}

          {credits.length > 0 && (
            <tr className="border-b border-border bg-surface-sunken">
              <th scope="colgroup" colSpan={6} className="py-1 pr-3 text-left text-sm font-medium">
                <span className="text-text">Money on account</span>
                <span className="block text-xs font-normal text-text-subtle">
                  Already in the control account and not yet applied to anything. Shown as its own
                  negative row rather than netted across the documents above — netting would invent
                  an allocation nobody made.
                </span>
              </th>
            </tr>
          )}
          {credits.map((entry) => (
            <DetailRow key={entry.documentId} entry={entry} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong">
            <th scope="row" colSpan={5} className="py-1 pr-3 text-left font-semibold text-text">
              Total for {row.contactName}
            </th>
            <AmountCell value={row.amounts.total} emphasis />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DetailRow({ entry }: { readonly entry: AgingDocument }): ReactElement {
  const credit = isCreditRow(entry);

  return (
    <tr className="border-b border-border">
      <td className="py-1 pr-3 font-mono text-sm text-text">
        {entry.documentNumber}
        {entry.reference !== null && (
          <span className="block text-xs text-text-subtle">{entry.reference}</span>
        )}
      </td>
      <td className="py-1 pr-3 text-sm text-text-muted">{DOCUMENT_LABELS[entry.documentType]}</td>
      <td className="py-1 pr-3 font-mono text-sm text-text-muted">{entry.issueDate}</td>
      <td className="py-1 pr-3 font-mono text-sm text-text-muted">
        {/* Null on exactly the credit rows, and said in words rather than left blank: a
            blank cell reads as missing data, and this one is a statement. */}
        {entry.dueDate ?? (credit ? 'Not chased' : '\u2014')}
      </td>
      <td className="py-1 pr-3 text-right font-mono text-sm text-text-muted">
        {entry.daysPastDue === null ? '\u2014' : entry.daysPastDue}
      </td>
      <td className="px-3 py-1 text-right">
        <Amount value={entry.outstanding} />
      </td>
    </tr>
  );
}
