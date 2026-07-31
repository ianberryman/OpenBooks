import type { ReactElement } from 'react';
import { useMemo } from 'react';

import {
  Button,
  Combobox,
  Field,
  FieldLabel,
  Select,
  TextInput,
  formatMoney,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { sumMinorUnits } from './amounts';
import type { BillDraft, VendorSettings } from './draft';
import type { BankAccount, PayableBill, Rail } from './queries';

/**
 * One vendor's slice of the build — the bank account and rail `CreatePendingPaymentRequest`
 * carries once per request (D-63), plus the bills it will disburse. Rendered per vendor
 * rather than as one global picker because two vendors paid from different accounts in the
 * same run is the ordinary case this batch shape exists for (D-63's fan-out).
 */
export interface VendorPaymentGroupProps {
  readonly contactId: string;
  readonly vendorName: string;
  readonly bills: readonly PayableBill[];
  readonly drafts: ReadonlyMap<string, BillDraft>;
  readonly settings: VendorSettings;
  readonly bankAccounts: readonly BankAccount[];
  readonly disabled: boolean;
  readonly incomplete: boolean;
  readonly onChange: (patch: Partial<VendorSettings>) => void;
  readonly onEditDisbursementDetails: () => void;
}

const RAIL_OPTIONS: readonly { readonly value: Rail; readonly label: string }[] = [
  { value: 'check', label: 'Check' },
  { value: 'ach', label: 'ACH' },
  { value: 'wire', label: 'Wire' },
];

export function VendorPaymentGroup({
  vendorName,
  bills,
  drafts,
  settings,
  bankAccounts,
  disabled,
  incomplete,
  onChange,
  onEditDisbursementDetails,
}: VendorPaymentGroupProps): ReactElement {
  const bankAccountOptions = useMemo<ComboboxOption[]>(
    () =>
      bankAccounts.map((account) => ({
        value: account.id,
        label: account.name,
        ...(account.institutionName === null ? {} : { detail: account.institutionName }),
      })),
    [bankAccounts],
  );

  const total = useMemo(
    () => sumMinorUnits(bills.map((bill) => drafts.get(bill.billId)?.payAmount ?? '0')),
    [bills, drafts],
  );

  return (
    <div
      // `aria-labelledby` would need an id this card mints for one heading with no other
      // reader — `aria-label` says the same thing without it.
      aria-label={`Payment to ${vendorName}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-text">{vendorName}</p>
          <p className="text-sm text-text-muted">
            {bills.length} {bills.length === 1 ? 'bill' : 'bills'} ·{' '}
            <span className="font-mono tabular-nums">{formatMoney(total)}</span>
          </p>
        </div>
        <Button size="sm" disabled={disabled} onClick={onEditDisbursementDetails}>
          Vendor bank details
        </Button>
      </div>

      <ul className="flex flex-col gap-0.5" aria-label={`Bills paid to ${vendorName}`}>
        {bills.map((bill) => {
          const draft = drafts.get(bill.billId);
          return (
            <li key={bill.billId} className="flex justify-between text-sm text-text-muted">
              <span className="font-mono">{bill.reference ?? bill.billId}</span>
              <span className="font-mono tabular-nums">{formatMoney(draft?.payAmount ?? '0')}</span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-56">
          <FieldLabel>Bank account</FieldLabel>
          <Combobox
            options={bankAccountOptions}
            value={settings.bankAccountId}
            disabled={disabled}
            placeholder="Search bank accounts…"
            onValueChange={(bankAccountId) => {
              onChange({ bankAccountId });
            }}
          />
        </Field>

        <Field className="w-32">
          <FieldLabel>Rail</FieldLabel>
          <Select
            value={settings.rail}
            options={RAIL_OPTIONS}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ rail: value as Rail });
            }}
          />
        </Field>

        <Field className="min-w-48 flex-1">
          <FieldLabel>Memo</FieldLabel>
          <TextInput
            value={settings.memo}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => {
              onChange({ memo: event.target.value });
            }}
          />
        </Field>
      </div>

      {incomplete && (
        <p className="text-xs text-warning-text">Pick a bank account before building payments.</p>
      )}
    </div>
  );
}
