import type { FormEvent, ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { newIdempotencyKey } from '../../api';
import {
  Button,
  Combobox,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  MoneyInput,
  Select,
  TextInput,
  Dialog,
} from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import type {
  CatalogDirection,
  CatalogItem,
  CatalogReferenceData,
  CreateCatalogItemRequest,
  UpdateCatalogItemRequest,
} from './catalog-queries';
import {
  useCatalogReferenceData,
  useCreateCatalogItem,
  useUpdateCatalogItem,
} from './catalog-queries';

/**
 * The one create/edit form for a catalog item (initiative Catalog, D-CAT-1…3), shared by the
 * Settings screen and by the inline "Create item" every line editor offers — `contacts/
 * contact-form.tsx`'s discipline: one form serving the management screen and every picker, not
 * a second cut-down one that drifts from it.
 *
 * ## Direction is a Select on the management screen and a fact everywhere else
 *
 * `direction` decides which side of the books an item seeds and is immutable once set
 * (D-CAT-1), so editing always shows it locked. Opening from a line editor also locks it: a
 * sales line can only take a sales item, so the direction is not a question there — it is
 * preset. Only "New item" on the Settings screen leaves it a live choice.
 *
 * ## Nothing here is required but a name and a direction
 *
 * The defaults are exactly that — defaults the line autofill reads and never binds to
 * (D-CAT-2). An item can be a reusable description on its own, so account, price and tax are
 * all optional and an empty field is sent as `null`.
 */
export interface CatalogItemDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null`/absent creates; an item edits it. */
  readonly item?: CatalogItem | null;
  /** Locks direction to this value — passed when a line editor opens the dialog. */
  readonly presetDirection?: CatalogDirection | undefined;
  /** Seeds the name field, e.g. the description a line-editor picker had typed. */
  readonly initialName?: string | undefined;
  /** The created or updated item, handed back so a caller can apply it to a line. */
  readonly onSaved?: ((item: CatalogItem) => void) | undefined;
}

const DIRECTION_OPTIONS: readonly SelectOption[] = [
  { value: 'sales', label: 'Sales — invoices, estimates' },
  { value: 'purchase', label: 'Purchase — bills, purchase orders, expenses' },
];

export function CatalogItemDialog({
  open,
  onOpenChange,
  item = null,
  presetDirection,
  initialName,
  onSaved,
}: CatalogItemDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the item, so a second "Edit" starts from that row's own values rather than
          whichever item the dialog last held (`estimate-form.tsx`'s pattern). */}
      {open && (
        <CatalogItemDialogBody
          key={item?.id ?? 'new'}
          item={item}
          presetDirection={presetDirection}
          initialName={initialName}
          onDone={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function CatalogItemDialogBody({
  item,
  presetDirection,
  initialName,
  onDone,
  onSaved,
}: {
  readonly item: CatalogItem | null;
  readonly presetDirection: CatalogDirection | undefined;
  readonly initialName: string | undefined;
  readonly onDone: () => void;
  readonly onSaved: ((item: CatalogItem) => void) | undefined;
}): ReactElement {
  const formId = useId();

  const editing = item !== null;
  const directionLocked = editing || presetDirection !== undefined;

  const [direction, setDirection] = useState<CatalogDirection>(
    item?.direction ?? presetDirection ?? 'sales',
  );
  const [name, setName] = useState(item?.name ?? initialName ?? '');
  const [code, setCode] = useState(item?.code ?? '');
  const [accountId, setAccountId] = useState<string | null>(item?.defaultAccountId ?? null);
  const [unitAmount, setUnitAmount] = useState<string | null>(item?.defaultUnitAmount ?? null);
  const [taxRateId, setTaxRateId] = useState<string | null>(item?.defaultTaxRateId ?? null);

  const reference = useCatalogReferenceData(direction);

  const create = useCreateCatalogItem();
  const update = useUpdateCatalogItem();
  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;

  const accountOptions = useMemo<ComboboxOption[]>(
    () => accountOptionsOf(reference.data, accountId),
    [reference.data, accountId],
  );
  const taxRateOptions = useMemo<ComboboxOption[]>(
    () => taxRateOptionsOf(reference.data, taxRateId),
    [reference.data, taxRateId],
  );

  const complete = name.trim() !== '';

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!complete || pending) return;

    const trimmedCode = code.trim();
    const shared = {
      name: name.trim(),
      code: trimmedCode === '' ? null : trimmedCode,
      defaultAccountId: accountId,
      defaultUnitAmount: unitAmount,
      defaultTaxRateId: taxRateId,
    };

    if (item === null) {
      const body: CreateCatalogItemRequest = { direction, ...shared };
      create.mutate(
        { ...body, idempotencyKey: newIdempotencyKey() },
        {
          onSuccess: (created) => {
            onSaved?.(created);
            onDone();
          },
        },
      );
      return;
    }

    const patch: UpdateCatalogItemRequest = shared;
    update.mutate(
      { catalogItemId: item.id, patch, idempotencyKey: newIdempotencyKey() },
      {
        onSuccess: (updated) => {
          onSaved?.(updated);
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent
      title={editing ? 'Edit item' : 'New item'}
      description="A reusable, priced item a document line can be selected from. It seeds the line's description, price, account and tax, and never binds it."
      className="max-w-xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} disabled={pending || !complete}>
            {pending ? 'Saving…' : editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-3">
        {error !== null && error !== undefined && <ErrorBanner error={error} />}

        <Field
          hint={
            directionLocked ? 'Immutable — a thing you both buy and sell is two items.' : undefined
          }
        >
          <FieldLabel>Direction</FieldLabel>
          <Select
            options={DIRECTION_OPTIONS}
            value={direction}
            disabled={directionLocked || pending}
            onValueChange={(value) => {
              const next = value === 'purchase' ? 'purchase' : 'sales';
              setDirection(next);
              // The account and rate lists are direction-specific, so a value chosen for the
              // old direction is no longer offered under the new one.
              setAccountId(null);
              setTaxRateId(null);
            }}
          />
        </Field>

        <Field>
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={name}
            disabled={pending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field hint="Optional. A short SKU or reference, matched on in the line picker.">
          <FieldLabel>Code</FieldLabel>
          <TextInput
            value={code}
            disabled={pending}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </Field>

        <Field
          hint={
            direction === 'sales'
              ? 'The income account a line credits.'
              : 'The expense account a line debits.'
          }
        >
          <FieldLabel>Default account</FieldLabel>
          <Combobox
            options={accountOptions}
            value={accountId}
            disabled={pending}
            placeholder="Search accounts…"
            emptyMessage="No accounts."
            onValueChange={setAccountId}
          />
        </Field>

        <Field hint="Optional. The unit price a line starts from.">
          <FieldLabel>Default price</FieldLabel>
          <MoneyInput value={unitAmount} disabled={pending} onValueChange={setUnitAmount} />
        </Field>

        <Field hint="Optional. The tax rate a line starts with.">
          <FieldLabel>Default tax rate</FieldLabel>
          <Combobox
            options={taxRateOptions}
            value={taxRateId}
            disabled={pending}
            placeholder="No tax"
            emptyMessage="No tax rates."
            onValueChange={setTaxRateId}
          />
        </Field>

        {reference.error != null && reference.error !== undefined && (
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

function accountOptionsOf(
  reference: CatalogReferenceData | null,
  selected: string | null,
): ComboboxOption[] {
  if (reference === null) return [];
  return reference.accounts.map((account) => ({
    value: account.id,
    label: account.name,
    detail: account.code,
    // Listed and disabled rather than hidden, so an item that already names an archived
    // account still shows which one — the only removal such an account allows.
    disabled: !account.isActive && account.id !== selected,
  }));
}

function taxRateOptionsOf(
  reference: CatalogReferenceData | null,
  selected: string | null,
): ComboboxOption[] {
  if (reference === null) return [];
  return reference.taxRates.map((rate) => ({
    value: rate.id,
    label: rate.name,
    detail: `${rate.percentage}%`,
    disabled: !rate.isActive && rate.id !== selected,
  }));
}
