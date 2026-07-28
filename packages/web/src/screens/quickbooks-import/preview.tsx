import type { ReactElement, ReactNode } from 'react';

import { formatMinorUnits } from '../../components';
import type {
  QuickBooksAccountDraft,
  QuickBooksContactDraft,
  QuickBooksImportIssue,
  QuickBooksImportPreview as QuickBooksImportPreviewData,
} from './queries';

/**
 * What committing this cutover would do, shown before anything is written.
 *
 * Nothing here computes money — `openingBalance.totalDebits`/`totalCredits` are the
 * server's minor-unit strings (D-13), formatted by `formatMinorUnits` and never divided or
 * multiplied. The three things that would fail a commit — an account or contact code
 * already in use, a trial-balance line naming an account the chart does not have, or an
 * unbalanced trial balance — are surfaced here so the screen can explain why Import stays
 * disabled rather than letting the commit discover them.
 */
export function QuickBooksImportPreview({
  preview,
}: {
  readonly preview: QuickBooksImportPreviewData;
}): ReactElement {
  return (
    <section aria-label="Import preview" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DraftCard
          title="Chart of accounts"
          count={preview.accounts.toCreate}
          noun="account"
          conflicts={preview.accounts.conflicts}
        >
          {preview.accounts.drafts.length > 0 && (
            <AccountDraftTable drafts={preview.accounts.drafts} />
          )}
        </DraftCard>

        <DraftCard
          title="Customers and vendors"
          count={preview.contacts.customers + preview.contacts.vendors}
          noun="contact"
          conflicts={preview.contacts.conflicts}
        >
          {preview.contacts.drafts.length > 0 && (
            <ContactDraftTable drafts={preview.contacts.drafts} />
          )}
          <p className="text-xs text-text-subtle">
            {preview.contacts.customers} customer{preview.contacts.customers === 1 ? '' : 's'},{' '}
            {preview.contacts.vendors} vendor{preview.contacts.vendors === 1 ? '' : 's'}.
          </p>
        </DraftCard>
      </div>

      {preview.openingBalance !== null && (
        <OpeningBalanceCard openingBalance={preview.openingBalance} />
      )}

      {preview.issues.length > 0 && <IssuesList issues={preview.issues} />}
    </section>
  );
}

function DraftCard({
  title,
  count,
  noun,
  conflicts,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly noun: string;
  readonly conflicts: readonly string[];
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        <p className="text-sm text-text-muted">
          {count} {noun}
          {count === 1 ? '' : 's'} to create
        </p>
      </div>

      {conflicts.length > 0 && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-soft p-2 text-xs text-danger-text"
        >
          Already in use, and blocking the import: {conflicts.join(', ')}.
        </p>
      )}

      {children}
    </div>
  );
}

function AccountDraftTable({
  drafts,
}: {
  readonly drafts: readonly QuickBooksAccountDraft[];
}): ReactElement {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Accounts that would be created</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-text-muted">
          <th scope="col" className="py-1 pr-2 font-medium">
            Code
          </th>
          <th scope="col" className="py-1 pr-2 font-medium">
            Name
          </th>
          <th scope="col" className="py-1 font-medium">
            Type
          </th>
        </tr>
      </thead>
      <tbody>
        {drafts.map((draft, index) => (
          // A draft has no id — it is not a persisted thing (`QuickBooksAccountDraft`) — so
          // the index within this preview is a stable enough key for a read-only list.
          <tr key={index} className="border-b border-border align-top">
            <td className="py-1 pr-2 font-mono text-text-muted">{draft.code}</td>
            <td className="py-1 pr-2 text-text">{draft.name}</td>
            <td className="py-1 text-text-muted">{capitalize(draft.type)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContactDraftTable({
  drafts,
}: {
  readonly drafts: readonly QuickBooksContactDraft[];
}): ReactElement {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Customers and vendors that would be created</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-text-muted">
          <th scope="col" className="py-1 pr-2 font-medium">
            Name
          </th>
          <th scope="col" className="py-1 font-medium">
            Role
          </th>
        </tr>
      </thead>
      <tbody>
        {drafts.map((draft, index) => (
          <tr key={index} className="border-b border-border align-top">
            <td className="py-1 pr-2 text-text">{draft.displayName}</td>
            <td className="py-1 text-text-muted">
              {draft.isCustomer && draft.isVendor
                ? 'Customer and vendor'
                : draft.isCustomer
                  ? 'Customer'
                  : 'Vendor'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OpeningBalanceCard({
  openingBalance,
}: {
  readonly openingBalance: NonNullable<QuickBooksImportPreviewData['openingBalance']>;
}): ReactElement {
  const { balanced, totalDebits, totalCredits, lineCount, unmatchedAccounts } = openingBalance;
  const blocked = !balanced || unmatchedAccounts.length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <h2 className="text-sm font-semibold text-text">Opening balance</h2>

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-text-subtle">Lines</dt>
          <dd className="font-mono text-text">{lineCount}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-text-subtle">Total debits</dt>
          <dd className="font-mono tabular-nums text-text">{formatMinorUnits(totalDebits)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-text-subtle">Total credits</dt>
          <dd className="font-mono tabular-nums text-text">{formatMinorUnits(totalCredits)}</dd>
        </div>
      </dl>

      {!balanced && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-soft p-2 text-xs text-danger-text"
        >
          The trial balance does not balance — debits and credits must be equal before this can be
          imported.
        </p>
      )}

      {unmatchedAccounts.length > 0 && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-soft p-2 text-xs text-danger-text"
        >
          These trial-balance lines name an account the chart does not have:{' '}
          {unmatchedAccounts.join(', ')}.
        </p>
      )}

      {!blocked && (
        <p role="status" className="text-xs text-success-text">
          Balanced — ready to post as the opening journal.
        </p>
      )}
    </div>
  );
}

function IssuesList({
  issues,
}: {
  readonly issues: readonly QuickBooksImportIssue[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-soft p-3">
      <h2 className="text-sm font-semibold text-warning-text">
        {issues.length} row{issues.length === 1 ? '' : 's'} skipped
      </h2>
      <p className="text-xs text-warning-text">
        These rows will not be imported. Everything else on the screen is unaffected — fix the
        source file and re-preview to include them.
      </p>
      <ul className="flex flex-col gap-1 text-sm">
        {issues.map((issue, index) => (
          <li key={index} className="text-warning-text">
            <span className="font-mono text-xs">
              {FILE_LABELS[issue.file]} row {issue.row}
            </span>
            {' — '}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

const FILE_LABELS: Readonly<Record<QuickBooksImportIssue['file'], string>> = {
  accounts: 'Chart of accounts',
  customers: 'Customers',
  vendors: 'Vendors',
  trialBalance: 'Trial balance',
};

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
