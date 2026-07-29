import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, Combobox, Field, FieldLabel, formatMinorUnits } from '../../components';
import type { Account, BankStatementLine } from './queries';
import { MatchRefusal } from './refusal';

/**
 * Correcting a line: code it to an account the user chooses (OB-086).
 *
 * The override the API can honour on any line — a `post_entry` to a chosen account, the
 * *other* side of the entry. Picking a lower-ranked candidate instead is already a click on
 * that candidate's own Accept, so this dialog owns the one thing the ranked list cannot
 * offer: an account nothing proposed.
 *
 * ## Deliberately still a single account, not a table of splits
 *
 * A line clears once (`uq_blc_line`), but a clearing may now hold several entries (D-80,
 * OB-137) — `multi-entry-dialog.tsx`'s `MultiEntryDialog` is where a split across several
 * accounts, several documents, or an early-pay discount is built. This dialog stays the
 * one-account fast path on purpose: most corrections are "code the whole line to the right
 * account", and offering a full entries editor for that common case would be the multi-step
 * form D-43's "one accepted keystroke" was written against. "Multiple entries" on the row is
 * the way to the general editor.
 */
export interface CorrectDialogProps {
  readonly line: BankStatementLine;
  readonly accounts: readonly Account[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (accountId: string) => void;
  readonly onClose: () => void;
}

export function CorrectDialog({
  line,
  accounts,
  pending,
  error,
  onSubmit,
  onClose,
}: CorrectDialogProps): ReactElement {
  const [accountId, setAccountId] = useState<string | null>(null);

  const options = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: account.name,
        // Omitted rather than `undefined` under `exactOptionalPropertyTypes`.
        ...(account.code === null ? {} : { detail: account.code }),
      })),
    [accounts],
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {line.postedDate} · {line.description} ·{' '}
        <span className="font-mono tabular-nums">{formatMinorUnits(line.amount)}</span>
      </p>

      <Field hint="The other side of the entry — the expense, income or balance-sheet account this line is. The bank account's own ledger account is the near side and is never named here.">
        <FieldLabel>Code to account</FieldLabel>
        <Combobox
          value={accountId}
          onValueChange={setAccountId}
          options={options}
          placeholder="Search accounts…"
        />
      </Field>

      {error !== undefined && error !== null && <MatchRefusal error={error} />}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={accountId === null || pending}
          onClick={() => {
            if (accountId !== null) onSubmit(accountId);
          }}
        >
          Code line
        </Button>
      </div>
    </div>
  );
}
