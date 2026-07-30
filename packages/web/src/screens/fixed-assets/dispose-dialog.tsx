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
  TextInput,
} from '../../components';
import type { ComboboxOption } from '../../components';
import type { DisposeFixedAssetRequest, FixedAsset, FixedAssetReferenceData } from './queries';
import { useDisposeFixedAsset, useIntentKey } from './queries';

/**
 * Disposing a fixed asset (OB-166; D-116) — the one-way door, in its own confirmed dialog
 * for the reason `recurring-invoices/deactivate-dialog.tsx` keeps retirement off the list's
 * plain toggle: an irreversible action should not be one accidental click away from a
 * reversible one.
 *
 * ## What this dialog does not compute
 *
 * The gain or loss, the accumulated-depreciation line, and whether the asset-removal line
 * balances against them are all `disposeFixedAsset`'s own arithmetic (`fixed-assets.
 * service.ts`'s header spells out the four possible lines and why they always balance).
 * This form collects the three things only a person can supply — the date, what was
 * received, and which two accounts the difference posts to — and nothing here previews the
 * journal it will produce.
 *
 * `proceedsAccountId` is required only once `proceedsMinor` is greater than zero — the
 * server's own pairing rule (`DisposeFixedAssetRequest`'s description), mirrored here so the
 * field only appears, and only blocks submission, exactly when it will matter.
 */
export interface DisposeAssetDialogProps {
  readonly asset: FixedAsset | null;
  readonly reference: FixedAssetReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function DisposeAssetDialog({
  asset,
  reference,
  onOpenChange,
}: DisposeAssetDialogProps): ReactElement {
  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      {asset !== null && (
        <DisposeAssetForm
          key={asset.id}
          asset={asset}
          reference={reference}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

interface FormValues {
  readonly date: string;
  readonly proceedsMinor: string | null;
  readonly proceedsAccountId: string | null;
  readonly gainLossAccountId: string | null;
}

function blankValues(): FormValues {
  return {
    date: '',
    // Scrapped is the common case on this ticket's own wording ("`"0"` for a scrapped
    // asset") — a filled-in zero spares that case a trip back for a required field.
    proceedsMinor: '0',
    proceedsAccountId: null,
    gainLossAccountId: null,
  };
}

function DisposeAssetForm({
  asset,
  reference,
  onDone,
}: {
  readonly asset: FixedAsset;
  readonly reference: FixedAssetReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>(blankValues);

  const dispose = useDisposeFixedAsset();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(dispose.error).fieldErrors;

  const accountOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.accounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        disabled: !account.isActive,
      })),
    [reference.accounts],
  );

  const proceedsPositive =
    values.proceedsMinor !== null &&
    values.proceedsMinor.trim() !== '' &&
    values.proceedsMinor !== '0';

  const complete =
    values.date !== '' &&
    values.proceedsMinor !== null &&
    values.gainLossAccountId !== null &&
    (!proceedsPositive || values.proceedsAccountId !== null);

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function body(): DisposeFixedAssetRequest | null {
    if (values.date === '' || values.proceedsMinor === null || values.gainLossAccountId === null) {
      return null;
    }
    return {
      date: values.date,
      proceedsMinor: values.proceedsMinor,
      gainLossAccountId: values.gainLossAccountId,
      ...(values.proceedsAccountId === null ? {} : { proceedsAccountId: values.proceedsAccountId }),
    };
  }

  function submit(): void {
    const request = body();
    if (request === null) return;
    dispose.mutate(
      {
        fixedAssetId: asset.id,
        request,
        idempotencyKey: intentKey(`dispose:${asset.id}:${JSON.stringify(request)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={`Dispose of ${asset.name}?`}
      description="Recognises the gain or loss against proceeds and moves the asset to disposed. There is no path back from here — a full disposal only."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={dispose.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="danger"
            disabled={dispose.isPending || !complete}
          >
            {dispose.isPending ? 'Disposing…' : 'Dispose'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {dispose.isError && <ErrorBanner error={dispose.error} />}

        <Field error={fieldErrors['date']} hint="The date the disposal journal posts on.">
          <FieldLabel>Disposal date</FieldLabel>
          <TextInput
            type="date"
            value={values.date}
            disabled={dispose.isPending}
            onChange={(event) => {
              set('date', event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['proceedsMinor']}
          hint={'What was received for the asset, if anything. "0" for a scrapped asset.'}
        >
          <FieldLabel>Proceeds</FieldLabel>
          <MoneyInput
            value={values.proceedsMinor}
            disabled={dispose.isPending}
            onValueChange={(value) => {
              set('proceedsMinor', value);
            }}
          />
        </Field>

        {proceedsPositive && (
          <Field
            error={fieldErrors['proceedsAccountId']}
            hint="Debited for the proceeds received — cash, or a receivable."
          >
            <FieldLabel>Proceeds account</FieldLabel>
            <Combobox
              options={accountOptions}
              value={values.proceedsAccountId}
              disabled={dispose.isPending}
              placeholder="Search accounts…"
              onValueChange={(value) => {
                set('proceedsAccountId', value);
              }}
            />
          </Field>
        )}

        <Field
          error={fieldErrors['gainLossAccountId']}
          hint="Where the gain or loss on disposal posts. A disposal that breaks exactly even simply posts no line to it."
        >
          <FieldLabel>Gain / loss account</FieldLabel>
          <Combobox
            options={accountOptions}
            value={values.gainLossAccountId}
            disabled={dispose.isPending}
            placeholder="Search accounts…"
            onValueChange={(value) => {
              set('gainLossAccountId', value);
            }}
          />
        </Field>
      </form>
    </DialogContent>
  );
}
