import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, Combobox, Field, FieldLabel, Select } from '../../components';
import { OpenSessionDialog } from './open-session-dialog';
import type { SessionFilters, SessionState } from './queries';
import { NO_SESSION_FILTERS, useBankAccountOptions, useLedgerAccount } from './queries';
import { SessionDetail } from './session-detail';
import { SessionList } from './session-list';

/**
 * Bank reconciliation (OB-087; ROADMAP E5–E7, D-45, D-46, D-50, D-51).
 *
 * A reconciliation is a session against one bank account: it tests what the ledger holds
 * against what a statement claims, at a stated closing balance and date, and either asserts
 * the two agree (finalise, E5) or reports why they do not. This screen opens sessions, lists
 * them, and drills into one to finalise, reopen and read its report. It does not *clear*
 * lines into a session — that is the matching screen (OB-086).
 *
 * ## What this screen is careful not to couple
 *
 * A reconciliation session and a fiscal-period close are independent locks (D-45, E7).
 * Nothing here shows or asks about a period; finalising freezes the session's own membership
 * (D-51), not the ledger, and a closed period asserts no reconciliation. Keeping the two
 * apart on screen is what keeps them apart in the user's head.
 *
 * ## Every balance is the server's
 *
 * `clearedBalance`, `bookBalance`, `difference`, `unclearedAmount` — all computed on read
 * from the journal lines (D-46), all reflected here exactly as the server sends them. The
 * one figure that is stored rather than computed is `statementClosingBalance`, the claim the
 * reconciliation exists to test. This screen does no money arithmetic; it formats strings.
 */

const STATE_OPTIONS = [
  { value: 'any', label: 'Open and finalised' },
  { value: 'open', label: 'Open' },
  { value: 'finalised', label: 'Finalised' },
];

const ANY = 'any';

function toState(value: string): SessionState | null {
  if (value === 'open') return 'open';
  return value === 'finalised' ? 'finalised' : null;
}

export function ReconciliationScreen(): ReactElement {
  const [filters, setFilters] = useState<SessionFilters>(NO_SESSION_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const accounts = useBankAccountOptions();

  // The ledger account the chosen bank account *is* (D-46), fetched only for its
  // `normalBalance`: the balances the server sends are in the account's normal frame
  // (OB-227b), so on a credit-normal account a positive figure is the amount owed and the
  // detail panel labels it as such. The bank-account row already holds `accountId`, so this
  // is one extra `GET`, not a second lookup the user waits on to pick an account.
  const selectedBankAccount = accounts.find((account) => account.id === filters.bankAccountId);
  const ledgerAccount = useLedgerAccount(selectedBankAccount?.accountId ?? null);
  const isCreditNormal = ledgerAccount.data?.normalBalance === 'credit';

  function filter<K extends keyof SessionFilters>(key: K, value: SessionFilters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Reconciliation</h1>
          <p className="max-w-form text-text-muted">
            Test what the books hold against what a statement claims. Finalising asserts they agree
            at a stated balance; an unpresented cheque is a reconciling difference the report
            explains, not a reason they disagree.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={filters.bankAccountId === null}
          onClick={() => {
            setOpening(true);
          }}
        >
          Open reconciliation
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-64">
          <FieldLabel>Bank account</FieldLabel>
          <Combobox
            value={filters.bankAccountId}
            options={accounts.map((account) => ({
              value: account.id,
              label: account.name,
              ...(account.institutionName === null ? {} : { detail: account.institutionName }),
            }))}
            placeholder="Choose a bank account…"
            onValueChange={(bankAccountId) => {
              filter('bankAccountId', bankAccountId);
              // The selected session belongs to the account that was showing; changing
              // account clears it rather than leaving a detail panel for a session no longer
              // in the list.
              setSelected(null);
            }}
          />
        </Field>

        <Field className="w-52">
          <FieldLabel>State</FieldLabel>
          <Select
            value={filters.state ?? ANY}
            options={STATE_OPTIONS}
            onValueChange={(value) => {
              filter('state', toState(value));
            }}
          />
        </Field>
      </div>

      <SessionList filters={filters} selectedId={selected} onSelect={setSelected} />

      {selected !== null && (
        <SessionDetail
          /* Keyed on the session, so opening a second starts from its own state rather than
             the previous panel's tab and half-typed reopen reason. */
          key={selected}
          sessionId={selected}
          isCreditNormal={isCreditNormal}
        />
      )}

      <OpenSessionDialog
        open={opening}
        onOpenChange={setOpening}
        bankAccountId={filters.bankAccountId}
        onOpened={(sessionId) => {
          // Selected rather than merely listed: the detail panel is where the balance the
          // new session must agree with is stated, which is what the person who opened it
          // needs to see next.
          setSelected(sessionId);
        }}
      />
    </div>
  );
}
