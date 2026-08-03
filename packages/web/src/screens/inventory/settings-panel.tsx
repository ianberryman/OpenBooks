import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../../api';
import { Button, Combobox, ErrorBanner, Field, FieldLabel } from '../../components';
import { Notice, SettingsSection } from '../settings/section';
import { useInventoryAccounts, useInventorySettings, useUpdateInventorySettings } from './queries';
import type { ControlAccounts } from './queries';

/**
 * The org's shrinkage-account nomination (OB-224, D-INV-6) — `fixed-assets/depreciation-
 * accounts-panel.tsx`'s shape, narrowed to one field. A stock adjustment posts its
 * offsetting entry here; posting one without a nomination is a `precondition_failed`. This
 * panel patches only `inventoryShrinkageAccountId` of `ControlAccounts`'s three fields — the
 * other two belong to AR/AP, and the wire is a partial update ("an omitted field is left as
 * it is"), so a save from here never touches them.
 */
export function InventorySettingsPanel(): ReactElement {
  const settings = useInventorySettings();
  const reference = useInventoryAccounts();
  const update = useUpdateInventorySettings();

  // Seeded from the fetched nomination the first time it arrives, then edited freely —
  // `discount-accounts.tsx`'s seeding pattern, applied for the same reason: a settings
  // section has no open/close moment to key the seed on the way a dialog does.
  const [seeded, setSeeded] = useState(false);
  const [shrinkageAccountId, setShrinkageAccountId] = useState<string | null>(null);

  if (!seeded && settings.data !== undefined) {
    setSeeded(true);
    setShrinkageAccountId(settings.data.inventoryShrinkageAccountId);
  }

  const saved: ControlAccounts | undefined = settings.data;
  const dirty = saved !== undefined && shrinkageAccountId !== saved.inventoryShrinkageAccountId;

  const accountOptions = (reference.data?.expenseTypeAccounts ?? []).map((account) => ({
    value: account.id,
    label: account.name,
    detail: account.code,
  }));

  return (
    <SettingsSection
      title="Inventory settings"
      description="The account a stock adjustment posts its offsetting entry to — a shrinkage or write-off account. A count or write-off is refused until one is nominated."
    >
      {settings.isError && (
        <ErrorBanner
          error={settings.error}
          onRetry={() => {
            void settings.refetch();
          }}
        />
      )}
      {reference.error != null && (
        <ErrorBanner
          error={reference.error}
          onRetry={() => {
            reference.refetch();
          }}
        />
      )}
      {update.isError && <ErrorBanner error={update.error} />}
      {update.isSuccess && !dirty && (
        <Notice tone="success">
          Saved. This moves future adjustments only — nothing already posted is restated.
        </Notice>
      )}

      <Field
        className="w-72"
        hint="Debited by shrinkage, credited by found stock. An expense account."
      >
        <FieldLabel>Shrinkage account</FieldLabel>
        <Combobox
          value={shrinkageAccountId}
          options={accountOptions}
          placeholder="Search expense accounts…"
          emptyMessage="No active expense accounts."
          onValueChange={setShrinkageAccountId}
        />
      </Field>

      <div>
        <Button
          variant="primary"
          disabled={!dirty || update.isPending}
          onClick={() => {
            update.mutate({
              inventoryShrinkageAccountId: shrinkageAccountId,
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
