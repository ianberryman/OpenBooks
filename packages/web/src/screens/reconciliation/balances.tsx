import type { ReactElement } from 'react';

import { formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import type { ReconciliationBalances } from './queries';

/**
 * The balances object, shown plainly and in the frame D-46 and D-50 put it in.
 *
 * ## Two questions, kept apart, because they are not the same question
 *
 * A reconciliation asks one thing to finalise and reports another alongside it, and merging
 * them is the misreading this panel exists to prevent:
 *
 * 1. **The test (E5, D-50).** Does what the bank has *actually processed* — the cleared
 *    balance — equal what the bank *says* it processed — the statement's closing balance?
 *    Their gap is the **difference**, and it is what must reach zero to finalise. A non-zero
 *    difference means the books and the bank disagree: a clearing is missing or wrong. It is
 *    shown in the warning role, never the danger one — it is "not done yet", not "broken".
 *
 * 2. **The explanation (D-50).** The **book balance** is the ledger's own figure, and it
 *    differs from the cleared balance by exactly the entries the bank has not caught up with
 *    — a cheque written and not presented, a deposit in transit. That gap is the **uncleared
 *    amount**, and it is an *expected* reconciling difference, not a fault: it can be
 *    non-zero on a perfectly reconciled account. So it is shown in the neutral money role,
 *    under a heading that says it explains the gap rather than being one.
 *
 * The case that makes the distinction concrete: an unpresented cheque leaves the difference
 * at zero — the account reconciles and can be finalised — while the uncleared amount is the
 * cheque's value. A panel that ran the two figures together would either block a good
 * reconciliation or hide a real disagreement.
 *
 * Every figure here except `statementClosingBalance` is computed on read (D-46). This panel
 * formats what the server sent and does no arithmetic on it — not even the two subtractions
 * the schema documents, which the server has already done.
 */

function isZero(wireAmount: string): boolean {
  return wireAmount === '0' || wireAmount === '-0';
}

function isNegative(wireAmount: string): boolean {
  return wireAmount.startsWith('-') && wireAmount !== '-0';
}

/**
 * A signed figure whose sign is made to read. `formatMoney` carries the `-`; the `+` is
 * added for a positive non-zero amount so a reconciling difference states its direction
 * — money the books show that the bank has not, versus the other way round — rather than
 * leaving the reader to infer it.
 */
export function SignedAmount({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string | undefined;
}): ReactElement {
  const formatted = formatMoney(value);
  const withSign = isZero(value) || isNegative(value) ? formatted : `+${formatted}`;
  return (
    <span
      className={cx(
        'font-mono tabular-nums',
        isNegative(value) ? 'text-amount-negative' : 'text-amount-positive',
        className,
      )}
    >
      {withSign}
    </span>
  );
}

function Figure({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm text-text">{label}</span>
        <span className="text-xs text-text-subtle">{hint}</span>
      </div>
      <div className="shrink-0 text-right">{children}</div>
    </div>
  );
}

export function BalancesPanel({
  balances,
  unclearedLineCount,
}: {
  readonly balances: ReconciliationBalances;
  readonly unclearedLineCount: number;
}): ReactElement {
  const balanced = isZero(balances.difference);

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="The reconciliation"
        className="flex flex-col rounded-lg border border-border bg-surface p-4"
      >
        <h3 className="pb-1 text-sm font-semibold text-text">What must agree to finalise</h3>
        <Figure
          label="Cleared balance"
          hint="Opening balance plus every line cleared into this session — what the bank has actually processed."
        >
          <span className="font-mono tabular-nums text-text">
            {formatMoney(balances.clearedBalance)}
          </span>
        </Figure>
        <Figure
          label="Statement closing balance"
          hint="What the statement says the account held at the end date — the claim from outside being tested."
        >
          <span className="font-mono tabular-nums text-text">
            {formatMoney(balances.statementClosingBalance)}
          </span>
        </Figure>

        <div className="mt-1 border-t border-border pt-2">
          <div className="flex items-baseline justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-text">Difference</span>
              <span className="text-xs text-text-subtle">
                Statement closing balance minus cleared balance. It must reach zero to finalise.
              </span>
            </div>
            <div className="shrink-0 text-right">
              {balanced ? (
                <span className="font-mono text-base font-semibold tabular-nums text-success-text">
                  {formatMoney('0')}
                </span>
              ) : (
                <span className="font-mono text-base font-semibold tabular-nums text-warning-text">
                  {formatMoney(balances.difference)}
                </span>
              )}
              <span
                className={cx(
                  'block text-xs',
                  balanced ? 'text-success-text' : 'text-warning-text',
                )}
              >
                {balanced ? 'Balanced' : 'Not reconciled yet'}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section
        aria-label="Reconciling differences"
        className="flex flex-col rounded-lg border border-border bg-surface p-4"
      >
        <h3 className="text-sm font-semibold text-text">Reconciling differences — expected</h3>
        <p className="pb-1 text-xs text-text-subtle">
          Why the ledger and the cleared balance are not the same figure. These are normal and do
          not block a reconciliation: an unpresented cheque or a deposit in transit is money the
          books show that the bank has not yet.
        </p>
        <Figure
          label="Book balance"
          hint="The ledger account's own balance at the end date, computed from journal lines."
        >
          <span className="font-mono tabular-nums text-text">
            {formatMoney(balances.bookBalance)}
          </span>
        </Figure>
        <Figure
          label="Uncleared amount"
          hint="Book balance minus cleared balance — the ledger entries no statement line has cleared."
        >
          <span className="flex flex-col items-end">
            <SignedAmount value={balances.unclearedAmount} />
            <span className="text-xs text-text-subtle">
              {unclearedLineCount === 1
                ? '1 uncleared line'
                : `${String(unclearedLineCount)} uncleared lines`}
            </span>
          </span>
        </Figure>
      </section>
    </div>
  );
}
