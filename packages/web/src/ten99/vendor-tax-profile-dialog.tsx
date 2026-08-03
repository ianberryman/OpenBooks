import {
  TAX_CLASSIFICATIONS,
  TAX_ID_TYPES,
  TEN99_BOX_CODES,
  TEN99_FORM_TYPES,
} from '@openbooks/shared-types';
import type {
  TaxClassification,
  TaxIdType,
  Ten99BoxCode,
  Ten99FormType,
} from '@openbooks/shared-types';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { useId, useState } from 'react';

import { ApiError, newIdempotencyKey } from '../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
  TextInput,
  useFieldControl,
} from '../components';
import type { SelectOption } from '../components';
import { useUpsertVendorTaxProfile, useVendorTaxProfile } from './queries';

/**
 * Editing one vendor's 1099/W-9 profile (OB-228 Wave-1 Stream D).
 *
 * Controlled by `contactId` rather than mounted/unmounted, mirroring
 * `settings/dimensions.tsx`'s `AxisFormDialog`: the form state is seeded from the fetched
 * profile **the first time** the dialog opens for a given contact, not in an effect (an
 * effect firing on every render of a `useQuery` result would stomp an in-progress edit the
 * moment a background refetch resolves).
 *
 * ## The TIN is write-only, by construction, not by screen discipline
 *
 * `VendorTaxProfile.taxIdLast4` is all the read side ever returns (D-228-2) — this
 * component never has a full TIN to display, so there is no `value={fullTin}` to
 * accidentally wire up. The text field here is *only* a place to type a **replacement**;
 * leaving it blank sends no `taxId` at all (untouched on the wire), and the checkbox is
 * the one explicit way to send `taxId: null` and clear what is stored.
 */

const TAX_ID_TYPE_LABELS: Readonly<Record<TaxIdType, string>> = {
  ein: 'EIN',
  ssn: 'SSN',
  itin: 'ITIN',
};

const TAX_CLASSIFICATION_LABELS: Readonly<Record<TaxClassification, string>> = {
  individual: 'Individual / sole proprietor',
  c_corp: 'C corporation',
  s_corp: 'S corporation',
  partnership: 'Partnership',
  llc: 'LLC',
  other: 'Other',
};

const FORM_LABELS: Readonly<Record<Ten99FormType, string>> = {
  '1099_nec': '1099-NEC — nonemployee compensation',
  '1099_misc': '1099-MISC — rent / other income',
};

const BOX_LABELS: Readonly<Record<Ten99BoxCode, string>> = {
  nec_1: 'NEC Box 1',
  misc_1: 'MISC Box 1 (rents)',
  misc_3: 'MISC Box 3 (other income)',
};

const NONE_OPTION = '__none__';

const TAX_ID_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: NONE_OPTION, label: 'Not set' },
  ...TAX_ID_TYPES.map((value) => ({ value, label: TAX_ID_TYPE_LABELS[value] })),
];

const TAX_CLASSIFICATION_OPTIONS: readonly SelectOption[] = [
  { value: NONE_OPTION, label: 'Not set' },
  ...TAX_CLASSIFICATIONS.map((value) => ({ value, label: TAX_CLASSIFICATION_LABELS[value] })),
];

const FORM_OPTIONS: readonly SelectOption[] = TEN99_FORM_TYPES.map((value) => ({
  value,
  label: FORM_LABELS[value],
}));

const BOX_OPTIONS: readonly SelectOption[] = TEN99_BOX_CODES.map((value) => ({
  value,
  label: BOX_LABELS[value],
}));

export interface VendorTaxProfileDialogProps {
  /** `null` closes the dialog. Passing a contact id opens it and fetches that contact's
   * profile fresh — the worksheet row's own fields are a snapshot, not this form's seed. */
  readonly contactId: string | null;
  /** Shown in the title before the profile has loaded, and as a fallback afterwards. */
  readonly contactName: string;
  readonly onClose: () => void;
}

export function VendorTaxProfileDialog({
  contactId,
  contactName,
  onClose,
}: VendorTaxProfileDialogProps): ReactElement {
  const formId = useId();
  const open = contactId !== null;
  const profile = useVendorTaxProfile(contactId);
  const upsert = useUpsertVendorTaxProfile();

  const [isEligible, setIsEligible] = useState(true);
  const [taxId, setTaxId] = useState('');
  const [clearTaxId, setClearTaxId] = useState(false);
  const [taxIdType, setTaxIdType] = useState<TaxIdType | null>(null);
  const [taxClassification, setTaxClassification] = useState<TaxClassification | null>(null);
  const [defaultForm, setDefaultForm] = useState<Ten99FormType>('1099_nec');
  const [defaultBox, setDefaultBox] = useState<Ten99BoxCode>('nec_1');
  const [legalNameOverride, setLegalNameOverride] = useState('');
  const [w9ReceivedOn, setW9ReceivedOn] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);

  // A vendor with no 1099 profile yet 404s (getVendorTaxProfile → assertFound) — the ordinary
  // case now that this dialog is reachable from the contact card, not only from the worksheet
  // (which lists only vendors that already have one, OB-253). Treat that 404 as a first-time
  // setup: seed the form's defaults and show no error. The default query retry already skips
  // 4xx (query/client.ts#isRetryable), so there is no loading flash.
  const profileMissing = profile.error instanceof ApiError && profile.error.status === 404;
  const settled = open && (profile.data !== undefined || profileMissing);
  const seedKey = settled ? contactId : null;
  if (seedKey !== null && seedKey !== seeded) {
    setSeeded(seedKey);
    const data = profile.data;
    setIsEligible(data?.isEligible ?? true);
    setTaxId('');
    setClearTaxId(false);
    setTaxIdType(data?.taxIdType ?? null);
    setTaxClassification(data?.taxClassification ?? null);
    setDefaultForm(data?.defaultForm ?? '1099_nec');
    setDefaultBox(data?.defaultBox ?? 'nec_1');
    // The read side has no `legalNameOverride` — only the computed `legalName` — so this
    // starts blank (meaning "no change") rather than guessing whether the computed name
    // came from an override or the contact record. The placeholder shows what is in effect.
    setLegalNameOverride('');
    setW9ReceivedOn(data?.w9ReceivedOn ?? '');
  }
  if (seedKey === null && seeded !== null) setSeeded(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (contactId === null) return;

    upsert.mutate(
      {
        contactId,
        isEligible,
        taxIdType,
        taxClassification,
        defaultForm,
        defaultBox,
        w9ReceivedOn: w9ReceivedOn === '' ? null : w9ReceivedOn,
        // Blank omits rather than sends `null`: unlike `w9ReceivedOn`, this field never
        // starts seeded with the real stored override (the read side has no such field —
        // only the *computed* `legalName`, see the seeding comment above), so an untouched
        // blank field must mean "no change", not "clear it". A blank field the user typed
        // into deliberately is indistinguishable from one they never touched, which is the
        // one gap this dialog knowingly leaves for v1 (see the report to the orchestrator).
        ...(legalNameOverride.trim() === '' ? {} : { legalNameOverride: legalNameOverride.trim() }),
        ...(clearTaxId ? { taxId: null } : taxId.trim() === '' ? {} : { taxId: taxId.trim() }),
        idempotencyKey: newIdempotencyKey(),
      },
      { onSuccess: onClose },
    );
  }

  const title = profile.data?.contactName ?? contactName;
  const hasStoredTaxId = profile.data?.taxIdLast4 != null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={`1099 profile — ${title}`}
        description="What this vendor's W-9 says, and how their 1099 should be filed."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={upsert.isPending || profile.isPending}
            >
              {upsert.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {profile.error != null && !profileMissing && (
          <ErrorBanner error={profile.error} onRetry={() => void profile.refetch()} />
        )}

        {profile.isPending ? (
          <p className="text-text-subtle">Loading profile…</p>
        ) : (
          <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
            <CheckboxField
              label="Eligible for a 1099"
              checked={isEligible}
              onCheckedChange={setIsEligible}
            />

            <Field
              hint={
                hasStoredTaxId
                  ? `On file, ending ${profile.data?.taxIdLast4}. Leave blank to keep it.`
                  : 'No TIN on file yet. A 9-digit EIN or SSN, with or without dashes.'
              }
            >
              <FieldLabel>Taxpayer ID (TIN)</FieldLabel>
              <TextInput
                type="password"
                autoComplete="off"
                value={taxId}
                disabled={clearTaxId}
                placeholder={hasStoredTaxId ? '••-•••••••' : '12-3456789'}
                onChange={(event) => {
                  setTaxId(event.target.value);
                }}
              />
            </Field>

            {hasStoredTaxId && (
              <CheckboxField
                label="Clear the stored TIN"
                checked={clearTaxId}
                onCheckedChange={(checked) => {
                  setClearTaxId(checked);
                  if (checked) setTaxId('');
                }}
              />
            )}

            <div className="flex flex-wrap gap-3">
              <Field className="w-40">
                <FieldLabel>TIN type</FieldLabel>
                <Select
                  value={taxIdType ?? NONE_OPTION}
                  options={TAX_ID_TYPE_OPTIONS}
                  onValueChange={(value) => {
                    setTaxIdType(value === NONE_OPTION ? null : (value as TaxIdType));
                  }}
                />
              </Field>

              <Field className="w-64">
                <FieldLabel>Federal tax classification</FieldLabel>
                <Select
                  value={taxClassification ?? NONE_OPTION}
                  options={TAX_CLASSIFICATION_OPTIONS}
                  onValueChange={(value) => {
                    setTaxClassification(
                      value === NONE_OPTION ? null : (value as TaxClassification),
                    );
                  }}
                />
              </Field>
            </div>

            <div className="flex flex-wrap gap-3">
              <Field className="w-64" hint="Which form this vendor's payments default to.">
                <FieldLabel>Default form</FieldLabel>
                <Select
                  value={defaultForm}
                  options={FORM_OPTIONS}
                  onValueChange={(value) => {
                    setDefaultForm(value as Ten99FormType);
                  }}
                />
              </Field>

              <Field className="w-64">
                <FieldLabel>Default box</FieldLabel>
                <Select
                  value={defaultBox}
                  options={BOX_OPTIONS}
                  onValueChange={(value) => {
                    setDefaultBox(value as Ten99BoxCode);
                  }}
                />
              </Field>
            </div>

            <Field hint="Overrides the contact's name on the filed form. Leave blank to use it as-is.">
              <FieldLabel>Legal name override</FieldLabel>
              <TextInput
                value={legalNameOverride}
                placeholder={profile.data?.legalName}
                onChange={(event) => {
                  setLegalNameOverride(event.target.value);
                }}
              />
            </Field>

            <Field className="w-40">
              <FieldLabel>W-9 received</FieldLabel>
              <TextInput
                type="date"
                value={w9ReceivedOn}
                onChange={(event) => {
                  setW9ReceivedOn(event.target.value);
                }}
              />
            </Field>

            {upsert.isError && <ErrorBanner error={upsert.error} />}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * `src/components` has no checkbox (D-24 — a component arrives with the screen that needs
 * it); `screens/contacts/contact-form.tsx`'s `CheckboxField` is the exemplar this copies,
 * wired through `Field`/`useFieldControl` the same way so a label and an
 * `aria-describedby` are never invented a second way.
 */
function CheckboxField({
  label,
  checked,
  onCheckedChange,
}: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <Field className="gap-0">
      <div className="flex items-center gap-2">
        <CheckboxControl checked={checked} onCheckedChange={onCheckedChange} />
        <FieldLabel>{label}</FieldLabel>
      </div>
    </Field>
  );
}

function CheckboxControl({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <input
      {...control}
      type="checkbox"
      checked={checked}
      className="size-4 rounded-sm border border-border accent-accent"
      onChange={(event) => {
        onCheckedChange(event.target.checked);
      }}
    />
  );
}
