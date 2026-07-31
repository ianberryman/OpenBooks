import type { ReactElement } from 'react';

import { ResponsiveTable, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import type { BankStatementImportPreview } from './queries';

/**
 * What importing this file would do, shown before anything is written (OB-085; D-42, E1).
 *
 * The one fact a preview adds that the file cannot is per-row: `isDuplicate`, a line
 * already present on this account. Making it visible here is E1 made legible — a user
 * re-uploading last month's file to catch a straggler sees which rows are already in
 * before committing, and learns that overlap is ordinary rather than dangerous.
 *
 * Amounts are the parser's signed minor units (positive into the account, negative out),
 * formatted by string manipulation (D-13) — never `Number()`d and never divided by 100.
 * The closing balance and external account id are the file's own claims (D-46), shown so
 * a wrong-account upload is noticed here rather than by a reconciliation weeks later.
 */
export function ImportPreview({
  preview,
}: {
  readonly preview: BankStatementImportPreview;
}): ReactElement {
  const { result, sample } = preview;

  return (
    <section aria-label="Import preview" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
        <p className="text-sm text-text">
          Of {result.linesRead} row{result.linesRead === 1 ? '' : 's'} in this file,{' '}
          <span className="font-semibold text-text">{result.linesImported} would be new</span> and{' '}
          <span className="font-semibold text-text">
            {result.linesDuplicate} already {result.linesDuplicate === 1 ? 'exists' : 'exist'}
          </span>{' '}
          on this account.
        </p>
        <p className="text-xs text-text-subtle">
          Already-present rows are skipped, not doubled — re-importing an overlapping statement is
          safe (E1). This is a prediction; the import reports its own final counts.
        </p>

        <ClaimsRow preview={preview} />
      </div>

      {preview.externalAccountMatches === false && (
        <p
          role="status"
          className="rounded-lg border border-warning-border bg-warning-soft p-3 text-sm text-warning-text"
        >
          This file names account <span className="font-mono">{preview.externalAccountId}</span>,
          which is not the identifier on this bank account. Check you are importing into the right
          account before you continue.
        </p>
      )}

      {sample.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          The file parsed, but no transaction rows were read from it.
        </p>
      ) : (
        <ResponsiveTable>
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">The first rows as they would be read</caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Posted
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Description
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Duplicate</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sample.map((line, index) => (
                <tr
                  // The draft is not a persisted thing and has no id (`BankStatementLineDraft`);
                  // index within this preview is a stable enough key for a read-only sample.
                  key={index}
                  className={cx(
                    'border-b border-border align-top',
                    line.isDuplicate && 'text-text-subtle',
                  )}
                >
                  <td className="py-2 pr-3 font-mono text-sm text-text-muted">{line.postedDate}</td>
                  <td className="py-2 pr-3">
                    <span className="text-text">{line.description}</span>
                    {line.counterparty !== null && (
                      <span className="block text-xs text-text-subtle">{line.counterparty}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <SignedAmount value={line.amount} />
                  </td>
                  <td className="py-2 text-right">
                    {line.isDuplicate && (
                      <span className="rounded-sm border border-border bg-surface-sunken px-1.5 py-0.5 text-xs text-text-muted">
                        Already present
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </section>
  );
}

function ClaimsRow({
  preview,
}: {
  readonly preview: BankStatementImportPreview;
}): ReactElement | null {
  const hasClosing = preview.statementClosingBalance !== null;
  const hasExternal = preview.externalAccountId !== null;
  const hasRange = preview.statementStart !== null && preview.statementEnd !== null;
  if (!hasClosing && !hasExternal && !hasRange) return null;

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {hasRange && (
        <div className="flex gap-2">
          <dt className="text-text-subtle">Statement period</dt>
          <dd className="font-mono text-text">
            {preview.statementStart} – {preview.statementEnd}
          </dd>
        </div>
      )}
      {hasClosing && (
        <div className="flex gap-2">
          <dt className="text-text-subtle">Closing balance</dt>
          {/* The file's stated balance — evidence for a reconciliation, never read as this
              account's balance (D-46). Formatted as a string; no arithmetic. */}
          <dd className="font-mono tabular-nums text-text">
            {formatMinorUnits(preview.statementClosingBalance ?? '0')}
          </dd>
        </div>
      )}
      {hasExternal && (
        <div className="flex gap-2">
          <dt className="text-text-subtle">File account</dt>
          <dd className="font-mono text-text">{preview.externalAccountId}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * A signed statement amount, in the ledger's two amount roles.
 *
 * `amount-positive`/`amount-negative` rather than `success`/`danger`: money out of the
 * account is not a fault, and the token layer keeps the roles apart for that reason
 * (`styles/tokens.css`).
 */
function SignedAmount({ value }: { readonly value: string }): ReactElement {
  const negative = value.startsWith('-') && value !== '-0';
  return (
    <span
      className={cx(
        'font-mono tabular-nums',
        negative ? 'text-amount-negative' : 'text-amount-positive',
      )}
    >
      {formatMinorUnits(value)}
    </span>
  );
}
