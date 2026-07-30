import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  MoneyInput,
  Select,
  TextInput,
} from '../../components';
import type { ComboboxOption } from '../../components';
import {
  blankFormState,
  formIsComplete,
  stateFromAsset,
  toCreateRequest,
  toUpdateRequest,
} from './asset-state';
import type { AssetFormState } from './asset-state';
import type { DepreciationAccounts, FixedAsset, FixedAssetReferenceData } from './queries';
import { useCreateFixedAsset, useIntentKey, useUpdateFixedAsset } from './queries';
import { METHOD_EXPLANATIONS, METHOD_OPTIONS, isMethod } from './vocabulary';

/**
 * The one form for registering and editing a fixed asset (OB-163, OB-167; D-113…D-116).
 *
 * ## The schedule is never a field on this form
 *
 * Registration computes the whole depreciation schedule from five fields — cost, salvage,
 * method, useful life and in-service date — and nothing else (`CreateFixedAssetRequest`'s
 * own words). This form collects exactly those five and the account wiring; it never
 * collects or previews a schedule row, which is a separate fetch
 * (`useFixedAssetSchedule`, `schedule-view.tsx`) made only after the asset exists.
 *
 * ## Why an edit can be refused after everything here looks valid
 *
 * Once at least one period has posted, the server refuses a change to any of the five
 * scheduling inputs — `fixed_asset_has_posted_depreciation` — rather than silently
 * re-forecasting periods that already posted under the old numbers (ROADMAP: no mid-life
 * re-forecast in v1). This form does not try to predict that in advance by disabling
 * fields; it makes the call and lets `ErrorBanner` present the refusal, the same
 * client-is-a-convenience stance `reconciliation/session-detail.tsx`'s finalise button
 * takes toward its own server-recomputed figure.
 */

export interface AssetFormDialogProps {
  /** `null` registers; an asset edits it. */
  readonly asset: FixedAsset | null;
  readonly reference: FixedAssetReferenceData;
  readonly depreciationAccounts: DepreciationAccounts | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function AssetFormDialog({
  asset,
  reference,
  depreciationAccounts,
  open,
  onOpenChange,
}: AssetFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the asset, so a second "Edit" starts from that row's own values rather
          than from whichever asset the dialog last held. */}
      {open && (
        <AssetFormContent
          key={asset?.id ?? 'new'}
          asset={asset}
          reference={reference}
          depreciationAccounts={depreciationAccounts}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function AssetFormContent({
  asset,
  reference,
  depreciationAccounts,
  onDone,
}: {
  readonly asset: FixedAsset | null;
  readonly reference: FixedAssetReferenceData;
  readonly depreciationAccounts: DepreciationAccounts | null;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [state, setState] = useState<AssetFormState>(() =>
    asset === null ? blankFormState(depreciationAccounts) : stateFromAsset(asset),
  );

  const create = useCreateFixedAsset();
  const update = useUpdateFixedAsset();
  const intentKey = useIntentKey();

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  function edit(next: Partial<AssetFormState>): void {
    setState((current) => ({ ...current, ...next }));
  }

  const assetAccountOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.accounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        disabled: !account.isActive,
      })),
    [reference.accounts],
  );

  const accumulatedOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.assetTypeAccounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        disabled: !account.isActive,
      })),
    [reference.assetTypeAccounts],
  );

  const expenseOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.expenseTypeAccounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        disabled: !account.isActive,
      })),
    [reference.expenseTypeAccounts],
  );

  const complete = formIsComplete(state);

  function submit(): void {
    if (!complete) return;

    if (asset === null) {
      const body = toCreateRequest(state);
      create.mutate(
        { ...body, idempotencyKey: intentKey(`create:${JSON.stringify(body)}`) },
        { onSuccess: onDone },
      );
      return;
    }

    const patch = toUpdateRequest(state);
    update.mutate(
      {
        fixedAssetId: asset.id,
        patch,
        idempotencyKey: intentKey(`update:${asset.id}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={asset === null ? 'Register fixed asset' : 'Edit fixed asset'}
      description="Cost, salvage, method, life and in-service date — the whole depreciation schedule is computed from these and nothing else."
      className="max-w-2xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending || !complete}>
            {pending ? 'Saving…' : asset === null ? 'Register' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error !== undefined && error !== null && <ErrorBanner error={error} />}

        <div className="flex flex-wrap gap-4">
          <Field
            className="min-w-64 flex-1"
            error={fieldErrors['name']}
            hint="What this asset is called in the register — a label, not an accounting code."
          >
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={state.name}
              disabled={pending}
              placeholder="e.g. Delivery van"
              onChange={(event) => {
                edit({ name: event.target.value });
              }}
            />
          </Field>

          <Field className="min-w-64 flex-1" error={fieldErrors['description']} hint="Optional.">
            <FieldLabel>Description</FieldLabel>
            <TextInput
              value={state.description}
              disabled={pending}
              onChange={(event) => {
                edit({ description: event.target.value });
              }}
            />
          </Field>
        </div>

        <Field
          error={fieldErrors['assetAccountId']}
          hint="The ledger account this asset's cost sits on."
        >
          <FieldLabel>Asset account</FieldLabel>
          <Combobox
            options={assetAccountOptions}
            value={state.assetAccountId}
            disabled={pending}
            placeholder="Search accounts…"
            onValueChange={(value) => {
              edit({ assetAccountId: value });
            }}
          />
        </Field>

        <div className="flex flex-wrap gap-4">
          <Field
            className="min-w-64 flex-1"
            error={fieldErrors['accumulatedDepreciationAccountId']}
            hint="Credited period after period. Left unset, falls back to the org default; unset with no default is refused."
          >
            <FieldLabel>Accumulated depreciation account</FieldLabel>
            <Combobox
              options={accumulatedOptions}
              value={state.accumulatedDepreciationAccountId}
              disabled={pending}
              placeholder="Search asset accounts…"
              emptyMessage="No active asset accounts."
              onValueChange={(value) => {
                edit({ accumulatedDepreciationAccountId: value });
              }}
            />
          </Field>

          <Field
            className="min-w-64 flex-1"
            error={fieldErrors['depreciationExpenseAccountId']}
            hint="Debited each posted period. Left unset, falls back to the org default."
          >
            <FieldLabel>Depreciation expense account</FieldLabel>
            <Combobox
              options={expenseOptions}
              value={state.depreciationExpenseAccountId}
              disabled={pending}
              placeholder="Search expense accounts…"
              emptyMessage="No active expense accounts."
              onValueChange={(value) => {
                edit({ depreciationExpenseAccountId: value });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field
            className="w-48"
            error={fieldErrors['acquisitionCostMinor']}
            hint="What the asset cost. Must exceed the salvage value."
          >
            <FieldLabel>Acquisition cost</FieldLabel>
            <MoneyInput
              value={state.acquisitionCostMinor}
              disabled={pending}
              onValueChange={(value) => {
                edit({ acquisitionCostMinor: value });
              }}
            />
          </Field>

          <Field
            className="w-48"
            error={fieldErrors['salvageValueMinor']}
            hint="The residual value the schedule never depreciates below."
          >
            <FieldLabel>Salvage value</FieldLabel>
            <MoneyInput
              value={state.salvageValueMinor}
              disabled={pending}
              onValueChange={(value) => {
                edit({ salvageValueMinor: value });
              }}
            />
          </Field>

          <Field
            className="w-48"
            error={fieldErrors['inServiceDate']}
            hint="Depreciation begins here — period 0 of the schedule is dated to it."
          >
            <FieldLabel>In-service date</FieldLabel>
            <TextInput
              type="date"
              value={state.inServiceDate}
              disabled={pending}
              onChange={(event) => {
                edit({ inServiceDate: event.target.value });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <Field className="w-56" hint={METHOD_EXPLANATIONS[state.method]}>
            <FieldLabel>Method</FieldLabel>
            <Select
              options={METHOD_OPTIONS}
              value={state.method}
              disabled={pending}
              onValueChange={(value) => {
                if (isMethod(value)) edit({ method: value });
              }}
            />
          </Field>

          <Field
            className="w-40"
            error={fieldErrors['usefulLifeMonths']}
            hint="Monthly periods the schedule runs."
          >
            <FieldLabel>Useful life (months)</FieldLabel>
            <TextInput
              type="number"
              min={1}
              inputMode="numeric"
              value={state.usefulLifeMonths}
              disabled={pending}
              onChange={(event) => {
                edit({ usefulLifeMonths: event.target.value });
              }}
            />
          </Field>

          {state.method === 'declining_balance' && (
            <Field
              className="w-40"
              error={fieldErrors['decliningRatePpm']}
              hint="Of remaining book value, each period."
            >
              <FieldLabel>Declining rate (%)</FieldLabel>
              <TextInput
                inputMode="decimal"
                value={state.decliningRatePercent ?? ''}
                disabled={pending}
                placeholder="e.g. 20"
                onChange={(event) => {
                  edit({ decliningRatePercent: event.target.value });
                }}
              />
            </Field>
          )}
        </div>
      </form>
    </DialogContent>
  );
}
