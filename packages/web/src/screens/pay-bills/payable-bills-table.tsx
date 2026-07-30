import type { ReactElement } from 'react';
import { useMemo } from 'react';

import { Button, Combobox, MoneyInput, formatMinorUnits } from '../../components';
import type { ComboboxOption } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { subtractMinorUnits, sumMinorUnits } from './amounts';
import type { BillDraft } from './draft';
import type { PayableBill } from './queries';
import { useDiscountSuggestion, useVendorCredits } from './queries';

/**
 * Every payable bill, selectable and editable in place (OB-116; ROADMAP D-63, D-68, D-79).
 *
 * `outstanding`, `committed` and `availableToPay` are read, never derived — all three are
 * computed on the server on every read (D-34, D-68) and this table shows exactly what it was
 * last told, the same discipline `recurring-invoices/list.tsx` states for `nextRunDate`. A
 * bill an open pending payment already covers arrives with `availableToPay: "0"`, and its row
 * is disabled rather than hidden — hiding it would make "why can't I select this bill" a
 * mystery the operator has to go find the queue to answer.
 */
export interface PayableBillsTableProps {
  readonly bills: readonly PayableBill[];
  readonly drafts: ReadonlyMap<string, BillDraft>;
  /** The date `intents[].discountAmount` is evaluated against — the payment's own date, not
   * today, so a run entered late still sees the discount it was actually eligible for. */
  readonly paymentDate: string;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly onChange: (billId: string, patch: Partial<BillDraft>) => void;
}

export function PayableBillsTable({
  bills,
  drafts,
  paymentDate,
  disabled,
  loading,
  onChange,
}: PayableBillsTableProps): ReactElement {
  const sorted = useMemo(
    () =>
      [...bills].sort(
        (a, b) =>
          a.vendorName.localeCompare(b.vendorName) ||
          (a.dueDate ?? '').localeCompare(b.dueDate ?? ''),
      ),
    [bills],
  );

  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Payable bills</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className={TH_CLASSES}>
              Vendor
            </th>
            <th scope="col" className={TH_CLASSES}>
              Bill
            </th>
            <th scope="col" className={TH_CLASSES}>
              Due
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Outstanding
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Committed
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Available
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Pay amount
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <EmptyRow columns={8}>
              {loading ? 'Loading…' : 'Nothing is payable right now.'}
            </EmptyRow>
          )}
          {sorted.map((bill) => (
            <BillRow
              key={bill.billId}
              bill={bill}
              draft={drafts.get(bill.billId) ?? null}
              paymentDate={paymentDate}
              disabled={disabled}
              onChange={(patch) => {
                onChange(bill.billId, patch);
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NONE = '';
const NO_VENDOR_CREDIT: ComboboxOption = { value: NONE, label: 'No credit applied' };

function BillRow({
  bill,
  draft,
  paymentDate,
  disabled,
  onChange,
}: {
  readonly bill: PayableBill;
  readonly draft: BillDraft | null;
  readonly paymentDate: string;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<BillDraft>) => void;
}): ReactElement {
  const selected = draft?.selected ?? false;
  const payable = bill.availableToPay !== '0';

  // Asked for only once a row is selected — `useDiscountSuggestion`/`useVendorCredits` are
  // both `enabled` on their id being non-null, so an unselected row costs nothing.
  const suggestion = useDiscountSuggestion(selected ? bill.billId : null, paymentDate);
  const credits = useVendorCredits(selected ? bill.contactId : null);

  const creditOptions = useMemo<ComboboxOption[]>(
    () => [
      NO_VENDOR_CREDIT,
      ...(credits.data ?? []).map((credit) => ({
        value: credit.id,
        label: credit.documentNumber ?? 'Vendor credit',
        detail: formatMinorUnits(credit.settlement.outstanding),
      })),
    ],
    [credits.data],
  );

  return (
    <tr className={cx('align-top', !payable && 'opacity-60')}>
      <td className={TD_CLASSES}>
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled || !payable}
          aria-label={`Select ${bill.vendorName}${bill.reference !== null ? ` — ${bill.reference}` : ''}`}
          className="size-4 rounded-sm border border-border accent-accent"
          onChange={(event) => {
            const checked = event.target.checked;
            onChange(
              checked
                ? { selected: true, payAmount: bill.availableToPay }
                : {
                    selected: false,
                    payAmount: null,
                    discountAmount: null,
                    discountAccountId: null,
                    appliedVendorCreditId: null,
                  },
            );
          }}
        />
      </td>
      <td className={TD_CLASSES}>{bill.vendorName}</td>
      <td className={TD_CLASSES}>
        <span className="font-mono text-sm">{bill.reference ?? '—'}</span>
        <span className="block text-xs text-text-subtle">Issued {bill.issueDate}</span>
      </td>
      <td className={cx(TD_CLASSES, 'font-mono')}>{bill.dueDate ?? '—'}</td>
      <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
        {formatMinorUnits(bill.outstanding)}
      </td>
      <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums text-text-muted')}>
        {formatMinorUnits(bill.committed)}
      </td>
      <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
        {formatMinorUnits(bill.availableToPay)}
      </td>
      <td className={cx(TD_CLASSES, 'min-w-48')}>
        {selected ? (
          <div className="flex flex-col items-end gap-1">
            <MoneyInput
              className="w-32"
              aria-label={`Pay amount for ${bill.vendorName}`}
              value={draft?.payAmount ?? null}
              disabled={disabled}
              onValueChange={(amount) => {
                onChange({ payAmount: amount });
              }}
            />

            {suggestion.data !== null && suggestion.data !== undefined && (
              <DiscountAffordance
                suggestion={suggestion.data}
                draft={draft}
                disabled={disabled}
                onChange={onChange}
              />
            )}

            {creditOptions.length > 1 && (
              <div className="w-40">
                <Combobox
                  aria-label={`Apply a vendor credit to ${bill.vendorName}`}
                  options={creditOptions}
                  value={draft?.appliedVendorCreditId ?? NONE}
                  disabled={disabled}
                  placeholder="No credit applied"
                  onValueChange={(value) => {
                    onChange({
                      appliedVendorCreditId: value === null || value === NONE ? null : value,
                    });
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <span className="block text-right text-text-subtle">
            {payable ? '—' : 'Fully committed'}
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * The early-pay discount, offered rather than applied (D-43) — one click fills
 * `discountAmount`/`discountAccountId` from the preview and reduces `payAmount` by the same
 * amount, which the operator can still type over. Unlike `money-in/allocation-editor.tsx`'s
 * `DiscountHint`, which only narrates the suggestion because a manual receipt has nowhere to
 * post one, `CreatePendingPaymentRequest.intents[]` has real fields for it, so this affordance
 * finishes what that one could only describe — the same gap `queries.ts` calls out.
 */
function DiscountAffordance({
  suggestion,
  draft,
  disabled,
  onChange,
}: {
  readonly suggestion: {
    readonly accountId: string;
    readonly deadline: string;
    readonly discountAmountMinor: string;
  };
  readonly draft: BillDraft | null;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<BillDraft>) => void;
}): ReactElement {
  const applied = draft?.discountAmount !== null && draft?.discountAmount !== undefined;

  return (
    <p className="text-right text-xs text-accent">
      Eligible for {formatMinorUnits(suggestion.discountAmountMinor)} off if paid by{' '}
      {suggestion.deadline}.{' '}
      {applied ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            const restored =
              draft?.payAmount !== null &&
              draft?.payAmount !== undefined &&
              draft.discountAmount !== null
                ? sumMinorUnits([draft.payAmount, draft.discountAmount])
                : (draft?.payAmount ?? null);
            onChange({ discountAmount: null, discountAccountId: null, payAmount: restored });
          }}
        >
          Remove discount
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            const reduced =
              draft?.payAmount !== null && draft?.payAmount !== undefined
                ? subtractMinorUnits(draft.payAmount, suggestion.discountAmountMinor)
                : null;
            onChange({
              discountAmount: suggestion.discountAmountMinor,
              discountAccountId: suggestion.accountId,
              payAmount: reduced,
            });
          }}
        >
          Apply discount
        </Button>
      )}
    </p>
  );
}
