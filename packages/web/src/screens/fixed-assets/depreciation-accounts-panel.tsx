import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../../api';
import { Button, Combobox, ErrorBanner, Field, FieldLabel } from '../../components';
import { Notice, SettingsSection } from '../settings/section';
import type { DepreciationAccounts, FixedAssetReferenceData } from './queries';
import { useDepreciationAccounts, useUpdateDepreciationAccounts } from './queries';

/**
 * The org's default depreciation accounts (D-115) — `settings/discount-accounts.tsx`'s
 * shape, adapted to this pair: consulted only when a fixed asset's own registration or edit
 * leaves one of the two account fields unset. Changing a default reaches only assets
 * registered after the change — an asset already registered keeps the accounts it resolved
 * at registration (`UpdateDepreciationAccountsRequest`'s own words) — so this panel lives
 * beside the register it feeds rather than on the Settings screen, and nothing else in the
 * app needs to read or write it.
 *
 * One `PATCH` carries both fields in one transaction, so there is one Save button rather
 * than two, the same reasoning `discount-accounts.tsx` gives for its pair.
 */
export interface DepreciationAccountsPanelProps {
  readonly reference: FixedAssetReferenceData;
}

export function DepreciationAccountsPanel({
  reference,
}: DepreciationAccountsPanelProps): ReactElement {
  const depreciationAccounts = useDepreciationAccounts();
  const update = useUpdateDepreciationAccounts();

  // Seeded from the fetched nominations the first time they arrive, then edited freely —
  // `discount-accounts.tsx`'s own seeding pattern, applied for the same reason: a settings
  // section has no open/close moment to key the seed on the way a dialog does.
  const [seeded, setSeeded] = useState(false);
  const [accumulated, setAccumulated] = useState<string | null>(null);
  const [expense, setExpense] = useState<string | null>(null);

  if (!seeded && depreciationAccounts.data !== undefined) {
    setSeeded(true);
    setAccumulated(depreciationAccounts.data.accumulatedDepreciationAccountId);
    setExpense(depreciationAccounts.data.depreciationExpenseAccountId);
  }

  const saved: DepreciationAccounts | undefined = depreciationAccounts.data;
  const dirty =
    saved !== undefined &&
    (accumulated !== saved.accumulatedDepreciationAccountId ||
      expense !== saved.depreciationExpenseAccountId);

  return (
    <SettingsSection
      title="Depreciation account defaults"
      description={
        <>
          Which of the organization&rsquo;s accounts a newly registered asset uses when it does not
          nominate its own (D-115). Either may be left unset — registering an asset with neither
          named, and no default here, is refused.
        </>
      }
    >
      {depreciationAccounts.isError && (
        <ErrorBanner
          error={depreciationAccounts.error}
          onRetry={() => {
            void depreciationAccounts.refetch();
          }}
        />
      )}
      {update.isError && <ErrorBanner error={update.error} />}
      {update.isSuccess && !dirty && (
        <Notice tone="success">
          Saved. This reaches assets registered from now on — nothing already registered is
          restated.
        </Notice>
      )}

      <div className="flex flex-wrap gap-4">
        <Field
          className="w-72"
          hint="Credited period after period. An ordinary asset/credit account (D-115)."
        >
          <FieldLabel>Accumulated depreciation</FieldLabel>
          <Combobox
            value={accumulated}
            options={reference.assetTypeAccounts.map((account) => ({
              value: account.id,
              label: account.name,
              detail: account.code,
              disabled: !account.isActive,
            }))}
            placeholder="Search asset accounts…"
            emptyMessage="No active asset accounts."
            onValueChange={setAccumulated}
          />
        </Field>
        <Field className="w-72" hint="Debited each posted period. An expense account.">
          <FieldLabel>Depreciation expense</FieldLabel>
          <Combobox
            value={expense}
            options={reference.expenseTypeAccounts.map((account) => ({
              value: account.id,
              label: account.name,
              detail: account.code,
              disabled: !account.isActive,
            }))}
            placeholder="Search expense accounts…"
            emptyMessage="No active expense accounts."
            onValueChange={setExpense}
          />
        </Field>
      </div>

      <div>
        <Button
          variant="primary"
          disabled={!dirty || update.isPending}
          onClick={() => {
            update.mutate({
              accumulatedDepreciationAccountId: accumulated,
              depreciationExpenseAccountId: expense,
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
