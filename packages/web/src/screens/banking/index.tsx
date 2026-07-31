import type { ReactElement } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { cx } from '../../lib/cx';
import { BankAccountsScreen } from '../bank-accounts';
import { BankImportScreen } from '../bank-import';
import { MatchingScreen } from '../banking-match';
import { ReconciliationScreen } from '../reconciliation';

/**
 * The banking section (M4), and the one reason it is a section rather than three top-level
 * destinations.
 *
 * Import, matching and reconciliation are one workflow read left to right — a statement is
 * imported, its lines are matched, and a session reconciles them against the bank — so they
 * belong under one heading a user returns to, not siblings of Sales and Reports. The sub-tabs
 * are the workflow in order — accounts are set up, statements imported, lines matched, sessions
 * reconciled. Matching stays the landing because it is the recurring daily work once an account
 * exists, where setting up an account is once, importing is periodic, and reconciling is
 * monthly; a first-run org with no account reaches the Accounts tab from the same bar.
 *
 * This wrapper is transport only: it owns the tab bar and the nested route table and holds
 * no banking logic or data of its own. Each sub-screen keeps its own bank-account picker, so
 * the section adds no shared state the three would otherwise have to agree on. As with every
 * other screen, mounting is unconditional (D-25) — the nav entry is gated on `banking.read`,
 * the routes are not, and the services refuse regardless.
 */
// Absolute paths, not relative. A `NavLink` resolves `to` against the current URL, and this
// wrapper is mounted under the `/banking/*` splat — so a relative `to="import"` from
// `/banking/match` resolves to `/banking/match/import`, which no child route matches, so the
// `*` catch-all below redirects again and the URL grows without bound (an OOM the E2E caught
// and the jsdom tests could not, because they mount the sub-screens directly). Absolute `to`
// resolves the same from every sub-route.
const TABS: readonly { readonly to: string; readonly label: string }[] = [
  { to: '/banking/accounts', label: 'Accounts' },
  { to: '/banking/import', label: 'Import' },
  { to: '/banking/match', label: 'Match' },
  { to: '/banking/reconcile', label: 'Reconcile' },
];

export function BankingScreen(): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <nav
        aria-label="Banking"
        className="flex flex-wrap items-center gap-1 border-b border-border"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cx(
                '-mb-px rounded-t-md px-3 py-2 text-base transition-colors',
                isActive
                  ? 'border-b-2 border-accent font-medium text-text'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Navigate to="/banking/match" replace />} />
        <Route path="accounts" element={<BankAccountsScreen />} />
        <Route path="import" element={<BankImportScreen />} />
        <Route path="match" element={<MatchingScreen />} />
        <Route path="reconcile" element={<ReconciliationScreen />} />
        <Route path="*" element={<Navigate to="/banking/match" replace />} />
      </Routes>
    </div>
  );
}
