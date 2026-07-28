import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '../../components';
import type { Account } from './accounts-api';
import { needsCashBasisClassification } from './vocabulary';

/**
 * The setup nudge for per-account cash/accrual classification (D-87, OB-154).
 *
 * A cash-basis P&L reads `cash_basis_role` to tell a cash event from a pure-accrual
 * holding account, and a brand-new chart has neither set — every account is created
 * unclassified (`createAccountRequestSchema`'s commentary). Nothing forces
 * classification before the fact, because most orgs never touch cash-basis reporting
 * and a mandatory field on every account creation would tax the majority for the
 * minority's report. This is the alternative: surfaced where the chart is, naming
 * exactly which accounts still need a decision, and easy to act on or to set aside.
 *
 * ## What it counts, and what it does not
 *
 * `accounts` is whatever the screen has loaded so far — this list is keyset-paged
 * (D-21, D-27) — so a chart with more pages than have been fetched under-counts here
 * exactly as `buildAccountTree` under-nests a parent that has not arrived yet. That is
 * an acceptable trade for a nudge: it only ever *narrows* what is asked about, never
 * invents an account that is not there, and loading the rest of the chart (the "Load
 * more" control already on the screen) only ever adds to what it can find, never
 * removes an account that no longer needs asking about.
 *
 * Inactive accounts are excluded (see `needsCashBasisClassification`): one that can no
 * longer be posted to will not appear in a future report either way.
 *
 * ## Dismissal is per visit, not persisted
 *
 * There is no server-side "seen this" state for a setup nudge, and inventing one — a
 * user preference, a local-storage key — is more machinery than a banner that goes away
 * on request and returns if the screen is revisited with accounts still unclassified.
 * A user who classifies everything simply stops seeing it, which is the outcome that
 * matters.
 */
export interface CashBasisNudgeProps {
  readonly accounts: readonly Account[];
  /** Opens that account's edit dialog, where the classification control lives. */
  readonly onClassify: (account: Account) => void;
}

/** How many accounts to name before falling back to a count. */
const NAMED_LIMIT = 6;

export function CashBasisNudge({ accounts, onClassify }: CashBasisNudgeProps): ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  const unclassified = accounts.filter(needsCashBasisClassification);

  if (dismissed || unclassified.length === 0) return null;

  const named = unclassified.slice(0, NAMED_LIMIT);
  const remaining = unclassified.length - named.length;

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-warning-border bg-warning-soft p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-warning-text">
            {unclassified.length} account{unclassified.length === 1 ? ' is' : 's are'} not yet
            classified for cash-basis reporting
          </p>
          <p className="max-w-prose text-sm text-warning-text">
            A cash-basis report needs to know which accounts are cash or a cash equivalent and which
            are pure-accrual holding accounts (prepaid, accrued, deferred, deposits). An
            unclassified account is simply left out of that recognition until it is set.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setDismissed(true);
          }}
        >
          Dismiss
        </Button>
      </div>

      <ul className="flex flex-wrap gap-2">
        {named.map((account) => (
          <li key={account.id}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onClassify(account);
              }}
            >
              {account.code} — {account.name}
            </Button>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <p className="text-xs text-warning-text">
          and {remaining} more — visible further down the chart below.
        </p>
      )}
    </div>
  );
}
