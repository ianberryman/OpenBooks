import type { ChangeEvent, ReactElement, ReactNode } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  CONTROL_CLASSES,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import { VendorTaxProfileDialog } from '../../ten99/vendor-tax-profile-dialog';
import type { Contact, CreateContactRequest, UpdateContactRequest } from './queries';
import { useCreateContact, useIntentKey, useUpdateContact } from './queries';

/**
 * The one form for creating and editing a contact.
 *
 * ## The form does not ask what kind of contact this is
 *
 * `isCustomer` and `isVendor` are two independent checkboxes, both allowed to be off, and
 * there is no "type" control anywhere on this screen. The same legal entity is routinely
 * both — one contact with both flags, which is why the server holds one table and not two
 * — and a party named on a journal line need take part in no subledger at all, an employee
 * expense reimbursement being the ordinary case. The server states this by having no
 * `CHECK (is_customer OR is_vendor)` (migration `0002_ledger`); a radio group here would
 * put the constraint back at the only layer the user meets.
 *
 * ## `code` is an ordinary editable field, and that is deliberate (D-28)
 *
 * An account's code is immutable and a contact's is not. Nothing cites a contact code —
 * `journal_lines` references the contact by row — and a contact the ledger names can never
 * be deleted, so an immutable code would be permanent from the first posting rather than
 * fixable by delete-and-recreate the way an account's is. Codes also usually arrive from
 * whatever system the org migrated off, where renumbering after an import is ordinary. The
 * field's hint says so, because the surprising thing is the *account* screen, not this one.
 */
export interface ContactFormDialogProps {
  /** `null` creates; a contact edits it. */
  readonly contact: Contact | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Inline-create seeds (used when `contact` is null): the name the user had typed into a
   * picker, and which role to pre-check so a "new vendor" from the bill form arrives a
   * vendor. `onCreated` hands the new contact back so the picker can select it. These let
   * one form serve both the Contacts screen and every entity picker (D-24 — one form, not a
   * second cut-down one that drifts from it).
   */
  readonly initialDisplayName?: string;
  readonly initialIsCustomer?: boolean;
  readonly initialIsVendor?: boolean;
  readonly initialIsEmployee?: boolean;
  readonly onCreated?: (contact: Contact) => void;
}

interface FormValues {
  code: string;
  displayName: string;
  legalName: string;
  email: string;
  phone: string;
  notes: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isCustomer: boolean;
  isVendor: boolean;
  isEmployee: boolean;
}

const EMPTY_VALUES: FormValues = {
  code: '',
  displayName: '',
  legalName: '',
  email: '',
  phone: '',
  notes: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  isCustomer: false,
  isVendor: false,
  isEmployee: false,
};

function valuesOf(contact: Contact | null): FormValues {
  if (contact === null) return EMPTY_VALUES;
  return {
    code: contact.code ?? '',
    displayName: contact.displayName,
    legalName: contact.legalName ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    notes: contact.notes ?? '',
    addressLine1: contact.addressLine1 ?? '',
    addressLine2: contact.addressLine2 ?? '',
    city: contact.city ?? '',
    region: contact.region ?? '',
    postalCode: contact.postalCode ?? '',
    country: contact.country ?? '',
    isCustomer: contact.isCustomer,
    isVendor: contact.isVendor,
    isEmployee: contact.isEmployee,
  };
}

/** An empty box means "no value": the API models that as `null`, never as `''`. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toCreateRequest(values: FormValues): CreateContactRequest {
  return {
    displayName: values.displayName.trim(),
    code: orNull(values.code),
    legalName: orNull(values.legalName),
    email: orNull(values.email),
    phone: orNull(values.phone),
    notes: orNull(values.notes),
    addressLine1: orNull(values.addressLine1),
    addressLine2: orNull(values.addressLine2),
    city: orNull(values.city),
    region: orNull(values.region),
    postalCode: orNull(values.postalCode),
    country: orNull(values.country),
    isCustomer: values.isCustomer,
    isVendor: values.isVendor,
    isEmployee: values.isEmployee,
  };
}

/**
 * Only what changed.
 *
 * `updateContactRequestSchema` refuses a patch in which every field is absent, and an
 * unchanged field resent is a write with a new `updatedAt` and nothing else to show for
 * it. Computing the difference here means "Save" on an untouched form is a no-op rather
 * than either a validation failure or a spurious revision.
 */
function toPatch(values: FormValues, contact: Contact): UpdateContactRequest {
  const patch: Record<string, string | boolean | null> = {};
  const next = toCreateRequest(values);

  if (next.displayName !== contact.displayName) patch['displayName'] = next.displayName;
  if ((next.code ?? null) !== contact.code) patch['code'] = next.code ?? null;
  if ((next.legalName ?? null) !== contact.legalName) patch['legalName'] = next.legalName ?? null;
  if ((next.email ?? null) !== contact.email) patch['email'] = next.email ?? null;
  if ((next.phone ?? null) !== contact.phone) patch['phone'] = next.phone ?? null;
  if ((next.notes ?? null) !== contact.notes) patch['notes'] = next.notes ?? null;
  if ((next.addressLine1 ?? null) !== contact.addressLine1) {
    patch['addressLine1'] = next.addressLine1 ?? null;
  }
  if ((next.addressLine2 ?? null) !== contact.addressLine2) {
    patch['addressLine2'] = next.addressLine2 ?? null;
  }
  if ((next.city ?? null) !== contact.city) patch['city'] = next.city ?? null;
  if ((next.region ?? null) !== contact.region) patch['region'] = next.region ?? null;
  if ((next.postalCode ?? null) !== contact.postalCode) {
    patch['postalCode'] = next.postalCode ?? null;
  }
  if ((next.country ?? null) !== contact.country) patch['country'] = next.country ?? null;
  if (values.isCustomer !== contact.isCustomer) patch['isCustomer'] = values.isCustomer;
  if (values.isVendor !== contact.isVendor) patch['isVendor'] = values.isVendor;
  if (values.isEmployee !== contact.isEmployee) patch['isEmployee'] = values.isEmployee;

  return patch;
}

export function ContactFormDialog({
  contact,
  open,
  onOpenChange,
  initialDisplayName,
  initialIsCustomer,
  initialIsVendor,
  initialIsEmployee,
  onCreated,
}: ContactFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the contact so a second "Edit" starts from that row's values rather than
          from the previous one's — the state below is initialised, not synchronised. The
          key also carries the seed name, so re-opening the create form for a different typed
          value re-seeds it. */}
      {open && (
        <ContactFormContent
          key={contact?.id ?? `new:${initialDisplayName ?? ''}`}
          contact={contact}
          seed={{
            displayName: initialDisplayName ?? '',
            isCustomer: initialIsCustomer ?? false,
            isVendor: initialIsVendor ?? false,
            isEmployee: initialIsEmployee ?? false,
          }}
          onCreated={onCreated}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

interface CreateSeed {
  readonly displayName: string;
  readonly isCustomer: boolean;
  readonly isVendor: boolean;
  readonly isEmployee: boolean;
}

function ContactFormContent({
  contact,
  seed,
  onCreated,
  onDone,
}: {
  readonly contact: Contact | null;
  readonly seed: CreateSeed;
  readonly onCreated?: ((contact: Contact) => void) | undefined;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>(() =>
    contact === null ? { ...EMPTY_VALUES, ...seed } : valuesOf(contact),
  );
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [open1099, setOpen1099] = useState(false);

  const create = useCreateContact();
  const update = useUpdateContact();
  const intentKey = useIntentKey();

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function submit(): void {
    /**
     * The only check made here. Everything else — the email format, the lengths, the
     * uniqueness of `code` — is checked by the schema the server shares with every other
     * client, and a second copy of those rules in this file would be a second contract
     * that disagrees with the first the day either moves. `displayName` is duplicated
     * because it is the one rule a user hits by pressing Save on an empty form, where a
     * round trip to be told the obvious is worse than the duplication.
     */
    if (values.displayName.trim() === '') {
      setNameError('Enter a name.');
      return;
    }
    setNameError(undefined);

    if (contact === null) {
      const body = toCreateRequest(values);
      create.mutate(
        { ...body, idempotencyKey: intentKey(`create:${JSON.stringify(body)}`) },
        {
          onSuccess: (created) => {
            onCreated?.(created);
            onDone();
          },
        },
      );
      return;
    }

    const patch = toPatch(values, contact);
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }

    update.mutate(
      {
        contactId: contact.id,
        patch,
        idempotencyKey: intentKey(`update:${contact.id}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={contact === null ? 'New contact' : 'Edit contact'}
      description="A contact can be a customer, a vendor, both, or neither."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <>
        <form
          id={formId}
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {error !== undefined && error !== null && <ErrorBanner error={error} />}

          <Field error={nameError ?? fieldErrors['displayName']}>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={values.displayName}
              aria-required
              autoComplete="off"
              onChange={(event) => {
                set('displayName', event.target.value);
              }}
            />
          </Field>

          <Field
            error={fieldErrors['code']}
            hint="Optional, and editable later — unlike an account code, nothing in the ledger cites it."
          >
            <FieldLabel>Code</FieldLabel>
            <TextInput
              value={values.code}
              autoComplete="off"
              onChange={(event) => {
                set('code', event.target.value);
              }}
            />
          </Field>

          <Field
            error={fieldErrors['legalName']}
            hint="The registered name, when it differs from the one above."
          >
            <FieldLabel>Legal name</FieldLabel>
            <TextInput
              value={values.legalName}
              autoComplete="off"
              onChange={(event) => {
                set('legalName', event.target.value);
              }}
            />
          </Field>

          <Field error={fieldErrors['email']}>
            <FieldLabel>Email</FieldLabel>
            <TextInput
              type="email"
              value={values.email}
              autoComplete="off"
              onChange={(event) => {
                set('email', event.target.value);
              }}
            />
          </Field>

          <Field error={fieldErrors['phone']}>
            <FieldLabel>Phone</FieldLabel>
            <TextInput
              value={values.phone}
              autoComplete="off"
              onChange={(event) => {
                set('phone', event.target.value);
              }}
            />
          </Field>

          {/* A fieldset for the same reason the Roles group below is one: the six address
              fields describe one thing and should be announced together. */}
          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium text-text">Address</legend>

            <Field error={fieldErrors['addressLine1']}>
              <FieldLabel>Address line 1</FieldLabel>
              <TextInput
                value={values.addressLine1}
                autoComplete="off"
                onChange={(event) => {
                  set('addressLine1', event.target.value);
                }}
              />
            </Field>

            <Field error={fieldErrors['addressLine2']}>
              <FieldLabel>Address line 2</FieldLabel>
              <TextInput
                value={values.addressLine2}
                autoComplete="off"
                onChange={(event) => {
                  set('addressLine2', event.target.value);
                }}
              />
            </Field>

            <Field error={fieldErrors['city']}>
              <FieldLabel>City</FieldLabel>
              <TextInput
                value={values.city}
                autoComplete="off"
                onChange={(event) => {
                  set('city', event.target.value);
                }}
              />
            </Field>

            <Field error={fieldErrors['region']}>
              <FieldLabel>State / region</FieldLabel>
              <TextInput
                value={values.region}
                autoComplete="off"
                onChange={(event) => {
                  set('region', event.target.value);
                }}
              />
            </Field>

            <Field error={fieldErrors['postalCode']}>
              <FieldLabel>Postal code</FieldLabel>
              <TextInput
                value={values.postalCode}
                autoComplete="off"
                onChange={(event) => {
                  set('postalCode', event.target.value);
                }}
              />
            </Field>

            <Field error={fieldErrors['country']}>
              <FieldLabel>Country</FieldLabel>
              <TextInput
                value={values.country}
                autoComplete="off"
                onChange={(event) => {
                  set('country', event.target.value);
                }}
              />
            </Field>
          </fieldset>

          {/* A fieldset, so the two flags are announced as one group and the sentence below
              is read as belonging to both rather than to whichever one focus landed on. */}
          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium text-text">Roles</legend>
            <p className="text-xs text-text-subtle">
              Independent, and any combination — including none. A contact that is none of these is
              still named on journal lines without taking part in any subledger. Employee is what an
              expense may be reimbursed to.
            </p>
            <CheckboxField
              label="Customer"
              checked={values.isCustomer}
              onCheckedChange={(next) => {
                set('isCustomer', next);
              }}
            />
            <CheckboxField
              label="Vendor"
              checked={values.isVendor}
              onCheckedChange={(next) => {
                set('isVendor', next);
              }}
            />
            <CheckboxField
              label="Employee"
              checked={values.isEmployee}
              onCheckedChange={(next) => {
                set('isEmployee', next);
              }}
            />
          </fieldset>

          {values.isVendor && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium text-text">1099 reporting</legend>
              {contact === null ? (
                <p className="text-xs text-text-subtle">
                  Save this vendor first, then set up their 1099 eligibility, TIN, and W-9 details.
                </p>
              ) : (
                <>
                  <p className="text-xs text-text-subtle">
                    Mark this vendor 1099-eligible and record their TIN and W-9 details. Eligible
                    vendors appear on the 1099 Center worksheet.
                  </p>
                  <div>
                    <Button type="button" onClick={() => setOpen1099(true)}>
                      Set up 1099 profile
                    </Button>
                  </div>
                </>
              )}
            </fieldset>
          )}

          <Field error={fieldErrors['notes']}>
            <FieldLabel>Notes</FieldLabel>
            <TextArea
              value={values.notes}
              onChange={(event) => {
                set('notes', event.target.value);
              }}
            />
          </Field>
        </form>
        <VendorTaxProfileDialog
          contactId={open1099 && contact !== null ? contact.id : null}
          contactName={contact?.displayName ?? ''}
          onClose={() => setOpen1099(false)}
        />
      </>
    </DialogContent>
  );
}

/**
 * A checkbox and a multi-line box, wired through `Field` rather than around it.
 *
 * `src/components` has no checkbox and no textarea, and this screen is not the place to
 * decide what the application's are (D-24 — a component arrives with the screen that needs
 * it, and two screens need these). What these two do *not* do is invent a second way to
 * label a control or report an error against one: both take their id and their
 * `aria-describedby` from `useFieldControl`, so a `Field` above them behaves exactly as it
 * does around a `TextInput`, and the shared `CONTROL_CLASSES` keeps the text box one
 * appearance rather than two.
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

function TextArea({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <textarea
      {...control}
      value={value}
      rows={3}
      className={cx(CONTROL_CLASSES, 'border-border h-auto py-1.5')}
      onChange={onChange}
    />
  );
}
