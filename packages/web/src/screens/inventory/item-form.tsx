import type { FormEvent, ReactElement } from 'react';
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
import { useCreateTrackedItem, useInventoryAccounts, useIntentKey } from './queries';
import type { CatalogItem, CreateCatalogItemRequest } from './queries';

/**
 * "New tracked item" (OB-224) — creates a `direction: 'inventory'` catalog item, the one
 * kind stock-tracked by perpetual weighted-average costing. `settings/catalog-item-
 * dialog.tsx`'s create-form idiom, narrowed to the fields an inventory item needs: an
 * inventory-asset account (what a receipt debits and a sale credits) and a COGS account
 * (what a sale debits), both required — `assertAccountUsable` refuses the item without them
 * — plus an optional starting cost and reorder point.
 *
 * Costing method is fixed at `weighted_average` (D-INV) — the only method this milestone
 * implements — so there is no control for it, only the literal sent on create.
 */
export interface ItemFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: ((item: CatalogItem) => void) | undefined;
}

export function ItemFormDialog({
  open,
  onOpenChange,
  onCreated,
}: ItemFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Rendered only while open, so a second opening always starts from a blank form. */}
      {open && (
        <ItemFormDialogBody
          onDone={() => {
            onOpenChange(false);
          }}
          onCreated={onCreated}
        />
      )}
    </Dialog>
  );
}

function ItemFormDialogBody({
  onDone,
  onCreated,
}: {
  readonly onDone: () => void;
  readonly onCreated: ((item: CatalogItem) => void) | undefined;
}): ReactElement {
  const formId = useId();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [assetAccountId, setAssetAccountId] = useState<string | null>(null);
  const [cogsAccountId, setCogsAccountId] = useState<string | null>(null);
  const [defaultCost, setDefaultCost] = useState<string | null>(null);
  const [reorderPoint, setReorderPoint] = useState('');

  const reference = useInventoryAccounts();
  const create = useCreateTrackedItem();
  const intentKey = useIntentKey();

  const assetOptions = useMemo<ComboboxOption[]>(
    () =>
      (reference.data?.assetTypeAccounts ?? []).map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
      })),
    [reference.data],
  );
  const cogsOptions = useMemo<ComboboxOption[]>(
    () =>
      (reference.data?.expenseTypeAccounts ?? []).map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
      })),
    [reference.data],
  );

  const error: unknown = create.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  const trimmedName = name.trim();
  const complete = trimmedName !== '' && assetAccountId !== null && cogsAccountId !== null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!complete || create.isPending || assetAccountId === null || cogsAccountId === null) return;

    const trimmedCode = code.trim();
    const trimmedReorder = reorderPoint.trim();

    const body: CreateCatalogItemRequest = {
      direction: 'inventory',
      itemType: 'inventory',
      name: trimmedName,
      code: trimmedCode === '' ? null : trimmedCode,
      inventoryAssetAccountId: assetAccountId,
      cogsAccountId,
      costingMethod: 'weighted_average',
      defaultCost,
      reorderPoint: trimmedReorder === '' ? null : trimmedReorder,
    };

    create.mutate(
      { ...body, idempotencyKey: intentKey(`create-tracked-item:${JSON.stringify(body)}`) },
      {
        onSuccess: (created) => {
          onCreated?.(created);
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent
      title="New tracked item"
      description="A stock-tracked catalog item. A receipt (a bill) adds to on-hand at cost; a sale draws COGS at the running weighted-average."
      className="max-w-xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={create.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={create.isPending || !complete}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-3">
        {error !== undefined && error !== null && <ErrorBanner error={error} />}

        <Field error={fieldErrors['name']}>
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={name}
            disabled={create.isPending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field hint="Optional. A short SKU or reference." error={fieldErrors['code']}>
          <FieldLabel>Code</FieldLabel>
          <TextInput
            value={code}
            disabled={create.isPending}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </Field>

        <Field
          hint="Debited on receipt, credited at cost on sale. An asset account."
          error={fieldErrors['inventoryAssetAccountId']}
        >
          <FieldLabel>Inventory asset account</FieldLabel>
          <Combobox
            options={assetOptions}
            value={assetAccountId}
            disabled={create.isPending}
            placeholder="Search asset accounts…"
            emptyMessage="No active asset accounts."
            onValueChange={setAssetAccountId}
          />
        </Field>

        <Field
          hint="Debited on sale for the item's cost of goods sold. An expense account."
          error={fieldErrors['cogsAccountId']}
        >
          <FieldLabel>COGS account</FieldLabel>
          <Combobox
            options={cogsOptions}
            value={cogsAccountId}
            disabled={create.isPending}
            placeholder="Search expense accounts…"
            emptyMessage="No active expense accounts."
            onValueChange={setCogsAccountId}
          />
        </Field>

        <Field
          hint="Optional. Values a starting quantity entered by adjustment."
          error={fieldErrors['defaultCost']}
        >
          <FieldLabel>Default cost</FieldLabel>
          <MoneyInput
            value={defaultCost}
            disabled={create.isPending}
            onValueChange={setDefaultCost}
          />
        </Field>

        <Field
          hint="Optional. On-hand at or below this quantity shows up as a reorder alert."
          error={fieldErrors['reorderPoint']}
        >
          <FieldLabel>Reorder point</FieldLabel>
          <TextInput
            inputMode="decimal"
            placeholder="e.g. 10"
            value={reorderPoint}
            disabled={create.isPending}
            onChange={(event) => {
              setReorderPoint(event.target.value);
            }}
          />
        </Field>

        {reference.error != null && (
          <ErrorBanner
            error={reference.error}
            onRetry={() => {
              reference.refetch();
            }}
          />
        )}
      </form>
    </DialogContent>
  );
}
