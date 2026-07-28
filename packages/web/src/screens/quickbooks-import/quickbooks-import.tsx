import type { ChangeEvent, ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, ErrorBanner, Field, FieldLabel, TextInput } from '../../components';
import { newIdempotencyKey } from '../../api';
import { cx } from '../../lib/cx';
import { QuickBooksImportPreview } from './preview';
import type {
  QuickBooksImportPreview as QuickBooksImportPreviewData,
  QuickBooksImportRequest,
  QuickBooksImportResult,
} from './queries';
import { useImportQuickBooks, usePreviewQuickBooksImport } from './queries';

/**
 * Import a QuickBooks cutover (Phase 3, the launch gate; ROADMAP D-33, the QuickBooks
 * migration format seam pinned in `packages/shared-types/src/imports/quickbooks.ts`).
 *
 * ## The shape of the task
 *
 * A one-time cutover, not a sync: a chart of accounts, optional customer and vendor lists,
 * and an optional opening trial balance, brought across as a single atomic commit. Every
 * file is CSV, which is text — read client-side with `FileReader.readAsText`, exactly as
 * `bank-import` reads its file — and sent as a string in the JSON body, so there is no
 * multipart. Modelled closely on that screen: preview first (writes nothing), then import
 * (all-or-nothing), with `ErrorBanner` for whatever either call refuses.
 *
 * ## Preview, then import — no poll
 *
 * Unlike the bank statement import, applying a chart plus contacts plus one journal is
 * already small, bounded and synchronous server-side (the module header in
 * `packages/shared-types/src/imports/quickbooks.ts`), so there is no queued handle and no
 * `ImportProgress`-style poll here — `useImportQuickBooks` resolves with the finished
 * `QuickBooksImportResult` directly.
 *
 * ## What blocks Import
 *
 * A successful preview is necessary but not sufficient. Three things the commit itself would
 * refuse are surfaced here first, so Import stays disabled and says why rather than letting
 * the user discover them from a failed commit: an account or contact code already in use, a
 * trial-balance line naming an account the chart file does not have, and an unbalanced trial
 * balance. Row-level `issues` do not block — a bad customer row is simply skipped, not fatal
 * to the cutover.
 */
export function QuickBooksImportScreen(): ReactElement {
  const [asOfDate, setAsOfDate] = useState<string>(todayCalendarDate);
  const [accounts, setAccounts] = useState<FileState | null>(null);
  const [customers, setCustomers] = useState<FileState | null>(null);
  const [vendors, setVendors] = useState<FileState | null>(null);
  const [trialBalance, setTrialBalance] = useState<FileState | null>(null);

  const previewMutation = usePreviewQuickBooksImport();
  const importMutation = useImportQuickBooks();

  const preview = previewMutation.data ?? null;
  const result = importMutation.data ?? null;

  const request = useMemo<QuickBooksImportRequest | null>(() => {
    if (accounts === null || asOfDate === '') return null;
    return {
      asOfDate,
      accounts: accounts.content,
      ...(customers === null ? {} : { customers: customers.content }),
      ...(vendors === null ? {} : { vendors: vendors.content }),
      ...(trialBalance === null ? {} : { trialBalance: trialBalance.content }),
    };
  }, [asOfDate, accounts, customers, vendors, trialBalance]);

  function resetDownstream(): void {
    previewMutation.reset();
    importMutation.reset();
  }

  function readFile(
    onLoaded: (state: FileState) => void,
  ): (event: ChangeEvent<HTMLInputElement>) => void {
    return (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      if (file === undefined) return;
      const reader = new FileReader();
      reader.onload = () => {
        onLoaded({
          filename: file.name,
          content: typeof reader.result === 'string' ? reader.result : '',
        });
        resetDownstream();
      };
      // Text, never binary: a QuickBooks list export is CSV and the wire body is a string
      // (the module header's reasoning, mirroring `bank-import.tsx`'s `onFile`).
      reader.readAsText(file);
    };
  }

  function runPreview(): void {
    if (request === null) return;
    previewMutation.mutate({ ...request, idempotencyKey: newIdempotencyKey() });
  }

  function runImport(): void {
    if (request === null) return;
    importMutation.mutate({ ...request, idempotencyKey: newIdempotencyKey() });
  }

  function startOver(): void {
    setAccounts(null);
    setCustomers(null);
    setVendors(null);
    setTrialBalance(null);
    resetDownstream();
  }

  const blockers = preview === null ? [] : blockingProblems(preview);
  const canPreview = request !== null && !previewMutation.isPending;
  const canImport =
    preview !== null && blockers.length === 0 && request !== null && !importMutation.isPending;

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Import from QuickBooks</h1>
        <p className="max-w-form text-text-muted">
          A one-time cutover: bring your chart of accounts, customers, vendors and opening trial
          balance across from QuickBooks. History stays in QuickBooks — this brings the balances
          forward so you can start posting here without re-keying.
        </p>
      </div>

      {result === null && (
        <>
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-3">
            <FileInput
              label="Chart of accounts"
              hint="Required. Name, Type, and optionally Number and Description."
              file={accounts}
              onFile={readFile(setAccounts)}
            />
            <FileInput
              label="Customers"
              hint="Optional. Name, and optionally Number, Email and Phone."
              file={customers}
              onFile={readFile(setCustomers)}
            />
            <FileInput
              label="Vendors"
              hint="Optional. Same columns as customers."
              file={vendors}
              onFile={readFile(setVendors)}
            />
            <FileInput
              label="Trial balance"
              hint="Optional. Account, Debit and Credit — posted as the opening journal."
              file={trialBalance}
              onFile={readFile(setTrialBalance)}
            />

            <Field className="w-48" hint="The opening journal's entry date.">
              <FieldLabel>As of date</FieldLabel>
              <TextInput
                type="date"
                value={asOfDate}
                onChange={(event) => {
                  setAsOfDate(event.target.value);
                  resetDownstream();
                }}
              />
            </Field>
          </div>

          <div className="flex gap-2">
            <Button disabled={!canPreview} onClick={runPreview}>
              {previewMutation.isPending ? 'Reading…' : 'Preview'}
            </Button>
            <Button variant="primary" disabled={!canImport} onClick={runImport}>
              {importMutation.isPending ? 'Importing…' : 'Import'}
            </Button>
          </div>

          {blockers.length > 0 && (
            <ul
              role="alert"
              className="flex flex-col gap-1 rounded-lg border border-danger-border bg-danger-soft p-3 text-sm text-danger-text"
            >
              {blockers.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          {previewMutation.isError && (
            <ErrorBanner error={previewMutation.error} onRetry={runPreview} />
          )}
          {importMutation.isError && (
            <ErrorBanner error={importMutation.error} onRetry={runImport} />
          )}

          {preview !== null && <QuickBooksImportPreview preview={preview} />}
        </>
      )}

      {result !== null && <ImportSummary result={result} onImportAnother={startOver} />}
    </div>
  );
}

interface FileState {
  readonly filename: string;
  readonly content: string;
}

/**
 * `YYYY-MM-DD` in the reader's own timezone, matching `calendarDateSchema`'s format.
 *
 * Not `toISOString().slice(0, 10)`: an opening-balance date is a calendar date and not an
 * instant, and slicing a UTC instant puts a reader west of UTC on tomorrow's date every
 * evening — the same reasoning `screens/reports/filters.ts`'s `todayCalendarDate` and
 * `screens/money-in/amounts.tsx`'s copy give; duplicated locally rather than imported
 * across screens, matching how those two do it.
 */
function todayCalendarDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function FileInput({
  label,
  hint,
  file,
  onFile,
}: {
  readonly label: string;
  readonly hint: string;
  readonly file: FileState | null;
  readonly onFile: (event: ChangeEvent<HTMLInputElement>) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text">{label}</span>
        <input
          type="file"
          aria-label={label}
          accept=".csv,text/csv"
          onChange={onFile}
          className={cx(
            'block text-sm text-text-muted',
            'file:mr-3 file:rounded-md file:border file:border-border file:bg-surface',
            'file:px-3 file:py-1.5 file:text-text hover:file:bg-surface-hover',
          )}
        />
        <span className="text-xs text-text-subtle">{hint}</span>
      </label>

      {file !== null && <p className="text-sm text-text-subtle">{file.filename}</p>}
    </div>
  );
}

/**
 * The reasons Import stays disabled after a successful preview — everything the commit would
 * itself refuse (the screen header's reasoning). Row-level `issues` are deliberately excluded:
 * those rows are skipped, not blocking.
 */
function blockingProblems(preview: QuickBooksImportPreviewData): readonly string[] {
  const problems: string[] = [];

  if (preview.accounts.conflicts.length > 0) {
    problems.push(
      `${preview.accounts.conflicts.length} account code${
        preview.accounts.conflicts.length === 1 ? '' : 's'
      } already in use: ${preview.accounts.conflicts.join(', ')}.`,
    );
  }
  if (preview.contacts.conflicts.length > 0) {
    problems.push(
      `${preview.contacts.conflicts.length} contact code${
        preview.contacts.conflicts.length === 1 ? '' : 's'
      } already in use: ${preview.contacts.conflicts.join(', ')}.`,
    );
  }
  if (preview.openingBalance !== null) {
    if (!preview.openingBalance.balanced) {
      problems.push('The trial balance does not balance.');
    }
    if (preview.openingBalance.unmatchedAccounts.length > 0) {
      problems.push(
        `${preview.openingBalance.unmatchedAccounts.length} trial-balance line${
          preview.openingBalance.unmatchedAccounts.length === 1 ? '' : 's'
        } name an account the chart does not have: ` +
          `${preview.openingBalance.unmatchedAccounts.join(', ')}.`,
      );
    }
  }

  return problems;
}

function ImportSummary({
  result,
  onImportAnother,
}: {
  readonly result: QuickBooksImportResult;
  readonly onImportAnother: () => void;
}): ReactElement {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-success-border bg-success-soft p-4"
    >
      <p className="text-sm font-semibold text-success-text">Import complete.</p>
      <ul className="text-sm text-text">
        <li>
          {result.accountsCreated} account{result.accountsCreated === 1 ? '' : 's'} created
        </li>
        <li>
          {result.customersCreated} customer{result.customersCreated === 1 ? '' : 's'} created
        </li>
        <li>
          {result.vendorsCreated} vendor{result.vendorsCreated === 1 ? '' : 's'} created
        </li>
        {result.openingJournalId !== null && <li>Opening journal posted</li>}
      </ul>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link to="/accounts" className="font-medium text-accent hover:underline">
          View the chart of accounts
        </Link>
        <Link to="/reports" className="font-medium text-accent hover:underline">
          View reports
        </Link>
      </div>
      <div>
        <Button onClick={onImportAnother}>Import another</Button>
      </div>
    </div>
  );
}
