import type { ReactElement } from 'react';
import { useState } from 'react';

import {
  Button,
  Combobox,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
  useFieldControl,
} from '../../components';
import type { SelectOption } from '../../components';
import { newIdempotencyKey } from '../../api';
import { Notice, SettingsSection } from '../settings/section';
import type {
  PayoutAccountMapEntry,
  PayoutSyncConfig as PayoutSyncConfigData,
} from './payout-sync-queries';
import { useAccounts, usePayoutSyncConfig, useUpdatePayoutSyncConfig } from './payout-sync-queries';

/**
 * The payout-sync config screen (OB-237; ROADMAP D-237-1, D-237-2, D-237-6) —
 * `discount-accounts.tsx`'s shape (one section, one Save, seed-then-edit), stretched to a
 * mode toggle, an auto-post checkbox, and a six-way category→account mapping instead of two
 * fixed pickers.
 *
 * ## Why one Save and not per-field autosave
 *
 * The wire is one `PUT` carrying `syncMode`/`autoPost`/`entries` together, and the mapping
 * is "replaced wholesale" (`schema.d.ts`'s own words on `UpdatePayoutSyncConfigRequest`) —
 * a lone category edit sent alone would silently drop every other row the org had already
 * mapped. `discount-accounts.tsx`'s reasoning for a single button applies unchanged.
 *
 * ## Why the pickers are not narrowed by account type
 *
 * `discount-accounts.tsx` narrows its two pickers because the server enforces
 * `discountAccountType`. Nothing here enforces a type per category (D-237-6 lists
 * "typically" a revenue/contra-revenue/expense/liability/loss account, never a `type`
 * constraint on `PayoutAccountMapEntry`), so narrowing the options would be inventing a
 * rule the server does not hold the org to. Each field's hint names the usual choice
 * instead; `useAccounts()` offers the whole active chart.
 */

type ReportingCategory = PayoutAccountMapEntry['reportingCategory'];
type SyncMode = PayoutSyncConfigData['syncMode'];

const CATEGORY_ORDER: readonly ReportingCategory[] = [
  'charge',
  'refund',
  'fee',
  'tax',
  'dispute',
  'adjustment',
];

const CATEGORY_LABEL: Readonly<Record<ReportingCategory, string>> = {
  charge: 'Charges',
  refund: 'Refunds',
  fee: 'Processor fees',
  tax: 'Tax collected',
  dispute: 'Disputes',
  adjustment: 'Other adjustments',
};

const CATEGORY_HINT: Readonly<Record<ReportingCategory, string>> = {
  charge: "This payout's gross sales. Typically a revenue account.",
  refund: 'Refunded amounts. Typically a contra-revenue/returns account.',
  fee: "The processor's cut. Typically an expense account.",
  tax: 'Sales tax collected. Typically a Sales Tax Payable liability.',
  dispute: 'Chargebacks and disputes. Typically a loss account.',
  adjustment: 'Anything else the payout groups. A catch-all account.',
};

const MODE_OPTIONS: readonly SelectOption[] = [
  { value: 'apply_payments', label: 'Apply to payments' },
  { value: 'summary_sales', label: 'Summary sales' },
];

const MODE_HINT: Readonly<Record<SyncMode, string>> = {
  apply_payments: 'Each charge clears the invoice it paid — no summary journal is booked here.',
  summary_sales:
    'One grossed-up journal per payout, split across the categories below. Per-charge posting is suppressed (D-237-1: the two modes double-count revenue together).',
};

type Mapping = Readonly<Record<ReportingCategory, string | null>>;

const EMPTY_MAPPING: Mapping = {
  charge: null,
  refund: null,
  fee: null,
  tax: null,
  dispute: null,
  adjustment: null,
};

function mappingFromEntries(entries: readonly PayoutAccountMapEntry[]): Mapping {
  const mapping: Record<ReportingCategory, string | null> = { ...EMPTY_MAPPING };
  for (const entry of entries) {
    mapping[entry.reportingCategory] = entry.accountId;
  }
  return mapping;
}

function entriesFromMapping(mapping: Mapping): PayoutAccountMapEntry[] {
  return CATEGORY_ORDER.flatMap((category) => {
    const accountId = mapping[category];
    return accountId === null ? [] : [{ reportingCategory: category, accountId }];
  });
}

function mappingEqual(a: Mapping, b: Mapping): boolean {
  return CATEGORY_ORDER.every((category) => a[category] === b[category]);
}

export interface PayoutSyncConfigProps {
  readonly connectionId: string;
}

export function PayoutSyncConfig({ connectionId }: PayoutSyncConfigProps): ReactElement {
  const config = usePayoutSyncConfig(connectionId);
  const accounts = useAccounts();
  const update = useUpdatePayoutSyncConfig(connectionId);

  const accountOptions = accounts.accounts.map((account) => ({
    value: account.id,
    label: account.name,
    detail: account.code,
  }));

  // Seeded from the fetched config the first time it arrives, then edited freely —
  // `discount-accounts.tsx`'s seed-then-edit pattern.
  const [seeded, setSeeded] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>('apply_payments');
  const [autoPost, setAutoPost] = useState(false);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);

  if (!seeded && config.config !== undefined) {
    setSeeded(true);
    setSyncMode(config.config.syncMode);
    setAutoPost(config.config.autoPost);
    setMapping(mappingFromEntries(config.config.entries));
  }

  const dirty =
    config.config !== undefined &&
    (syncMode !== config.config.syncMode ||
      autoPost !== config.config.autoPost ||
      !mappingEqual(mapping, mappingFromEntries(config.config.entries)));

  const autoPostEnabled = syncMode === 'summary_sales';

  function setMappingFor(category: ReportingCategory, accountId: string | null): void {
    setMapping((current) => ({ ...current, [category]: accountId }));
  }

  return (
    <SettingsSection
      title="Payout sync"
      description={
        <>
          How Stripe payouts land on the books (D-237-1): apply each charge straight to the invoice
          it paid, or book one grossed-up summary journal per payout and route it through the
          mapping below.
        </>
      }
    >
      {config.error != null && <ErrorBanner error={config.error} onRetry={config.refetch} />}
      {accounts.error != null && <ErrorBanner error={accounts.error} onRetry={accounts.refetch} />}
      {update.isError && <ErrorBanner error={update.error} />}
      {update.isSuccess && !dirty && (
        <Notice tone="success">
          Saved. This changes how future payouts sync — nothing already posted is restated.
        </Notice>
      )}

      <Field className="w-72" hint={MODE_HINT[syncMode]}>
        <FieldLabel>Sync mode</FieldLabel>
        <Select
          value={syncMode}
          options={MODE_OPTIONS}
          onValueChange={(value) => {
            setSyncMode(value as SyncMode);
          }}
        />
      </Field>

      <CheckboxField
        label="Post each payout's summary journal automatically"
        hint={
          autoPostEnabled
            ? 'Off by default: a summary journal waits as "pending review" until posted by hand.'
            : 'Only applies in summary-sales mode.'
        }
        checked={autoPost}
        disabled={!autoPostEnabled}
        onCheckedChange={setAutoPost}
      />

      <div className="flex flex-wrap gap-4">
        {CATEGORY_ORDER.map((category) => (
          <Field key={category} className="w-72" hint={CATEGORY_HINT[category]}>
            <FieldLabel>{CATEGORY_LABEL[category]}</FieldLabel>
            <Combobox
              value={mapping[category]}
              options={accountOptions}
              placeholder="Search accounts…"
              emptyMessage="No active accounts."
              onValueChange={(accountId) => {
                setMappingFor(category, accountId);
              }}
            />
          </Field>
        ))}
      </div>

      <div>
        <Button
          variant="primary"
          disabled={!dirty || update.isPending}
          onClick={() => {
            update.mutate({
              syncMode,
              autoPost,
              entries: entriesFromMapping(mapping),
              idempotencyKey: newIdempotencyKey(),
            });
          }}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </SettingsSection>
  );
}

/**
 * The one control `src/components` does not have — `money-in/controls.tsx`'s
 * `CheckboxField`, copied and given a `disabled` prop (D-24: a component arrives with the
 * screen that needs it, and this screen is the first checkbox that needs to gray out).
 */
function CheckboxField({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <Field className="gap-0" hint={hint}>
      <div className="flex items-center gap-2">
        <CheckboxControl checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        <FieldLabel>{label}</FieldLabel>
      </div>
    </Field>
  );
}

function CheckboxControl({
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <input
      {...control}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      className="size-4 rounded-sm border border-border accent-accent disabled:opacity-50"
      onChange={(event) => {
        onCheckedChange(event.target.checked);
      }}
    />
  );
}
