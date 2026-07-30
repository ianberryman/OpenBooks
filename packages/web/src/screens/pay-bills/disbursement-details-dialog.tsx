import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
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
} from '../../components';
import type { UpdateVendorDisbursementDetailsRequest, VendorDisbursementDetails } from './queries';
import {
  useIntentKey,
  useUpdateVendorDisbursementDetails,
  useVendorDisbursementDetails,
} from './queries';

/**
 * A vendor's ACH/wire coordinates (D-67, D-110) — the four `contacts` columns
 * `getVendorDisbursementDetails`'s own description names. Sensitive fields, and a plain
 * editable form is deliberately all this is: the user enters the vendor's real bank
 * coordinates, and nothing here validates a routing number against a real bank — that stays
 * the external processor's job once a disbursement is pulled from `GET /v1/disbursements`.
 */
export interface DisbursementDetailsDialogProps {
  /** `null` closes the dialog. */
  readonly contactId: string | null;
  readonly vendorName: string;
  readonly onOpenChange: (open: boolean) => void;
}

const RAIL_OPTIONS = [
  { value: 'check', label: 'Check' },
  { value: 'ach', label: 'ACH' },
  { value: 'wire', label: 'Wire' },
];

/** Radix `Select.Item` refuses an empty `value`, so "no preference" needs a real sentinel —
 * `recurring-invoices/line-row.tsx`'s `NONE`/`NO_TAX_RATE`, the same shape. */
const NO_PREFERENCE = 'none';

export function DisbursementDetailsDialog({
  contactId,
  vendorName,
  onOpenChange,
}: DisbursementDetailsDialogProps): ReactElement {
  return (
    <Dialog open={contactId !== null} onOpenChange={onOpenChange}>
      {contactId !== null && (
        <DisbursementDetailsLoader
          key={contactId}
          contactId={contactId}
          vendorName={vendorName}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

/**
 * Fetches before it edits. Unlike `template-form.tsx`, which initialises its form state from
 * a prop the list screen already held, disbursement details are not part of the vendor list
 * this dialog opens from (D-67 keeps them off `Contact`, gated separately) — so the fetch
 * happens here, and the form beneath mounts only once it resolves, the same way
 * `pay-bills.tsx` waits on `reference.data` before rendering `PayableBillsTable`.
 */
function DisbursementDetailsLoader({
  contactId,
  vendorName,
  onDone,
}: {
  readonly contactId: string;
  readonly vendorName: string;
  readonly onDone: () => void;
}): ReactElement {
  const details = useVendorDisbursementDetails(contactId);

  return (
    <DialogContent
      title={`${vendorName}'s disbursement details`}
      description="Where a check draws from and the coordinates an ACH or wire handoff needs. Sensitive — this is the vendor's real bank data."
      footer={
        details.data === undefined ? (
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
        ) : undefined
      }
    >
      {details.isError && (
        <ErrorBanner
          error={details.error}
          onRetry={() => {
            void details.refetch();
          }}
        />
      )}
      {details.isPending && <p className="text-text-subtle">Loading…</p>}
      {details.data !== undefined && (
        <DisbursementDetailsForm contactId={contactId} details={details.data} onDone={onDone} />
      )}
    </DialogContent>
  );
}

interface FormValues {
  readonly preferredPaymentRail: string;
  readonly achRoutingNumber: string;
  readonly achAccountNumber: string;
  readonly wireInstructions: string;
}

function valuesFrom(details: VendorDisbursementDetails): FormValues {
  return {
    preferredPaymentRail: details.preferredPaymentRail ?? NO_PREFERENCE,
    achRoutingNumber: details.achRoutingNumber ?? '',
    achAccountNumber: details.achAccountNumber ?? '',
    wireInstructions: details.wireInstructions ?? '',
  };
}

function DisbursementDetailsForm({
  contactId,
  details,
  onDone,
}: {
  readonly contactId: string;
  readonly details: VendorDisbursementDetails;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>(() => valuesFrom(details));
  const update = useUpdateVendorDisbursementDetails();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(update.error).fieldErrors;

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function submit(): void {
    const patch: UpdateVendorDisbursementDetailsRequest = {
      preferredPaymentRail:
        values.preferredPaymentRail === NO_PREFERENCE
          ? null
          : (values.preferredPaymentRail as 'check' | 'ach' | 'wire'),
      achRoutingNumber:
        values.achRoutingNumber.trim() === '' ? null : values.achRoutingNumber.trim(),
      achAccountNumber:
        values.achAccountNumber.trim() === '' ? null : values.achAccountNumber.trim(),
      wireInstructions:
        values.wireInstructions.trim() === '' ? null : values.wireInstructions.trim(),
    };

    update.mutate(
      {
        contactId,
        patch,
        idempotencyKey: intentKey(`disbursement-details:${contactId}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form
      id={formId}
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {update.isError && <ErrorBanner error={update.error} />}

      <Field
        error={fieldErrors['preferredPaymentRail']}
        hint="What the Pay Bills window pre-selects for this vendor. Any run can still choose a different rail."
      >
        <FieldLabel>Preferred rail</FieldLabel>
        <Select
          value={values.preferredPaymentRail}
          options={[{ value: NO_PREFERENCE, label: 'No preference' }, ...RAIL_OPTIONS]}
          disabled={update.isPending}
          onValueChange={(value) => {
            set('preferredPaymentRail', value);
          }}
        />
      </Field>

      <Field error={fieldErrors['achRoutingNumber']}>
        <FieldLabel>ACH routing number</FieldLabel>
        <TextInput
          value={values.achRoutingNumber}
          autoComplete="off"
          disabled={update.isPending}
          onChange={(event) => {
            set('achRoutingNumber', event.target.value);
          }}
        />
      </Field>

      <Field error={fieldErrors['achAccountNumber']}>
        <FieldLabel>ACH account number</FieldLabel>
        <TextInput
          value={values.achAccountNumber}
          autoComplete="off"
          disabled={update.isPending}
          onChange={(event) => {
            set('achAccountNumber', event.target.value);
          }}
        />
      </Field>

      <Field
        error={fieldErrors['wireInstructions']}
        hint="Free text — bank name, SWIFT/BIC, intermediary instructions, whatever the vendor gave."
      >
        <FieldLabel>Wire instructions</FieldLabel>
        <TextInput
          value={values.wireInstructions}
          autoComplete="off"
          disabled={update.isPending}
          onChange={(event) => {
            set('wireInstructions', event.target.value);
          }}
        />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <DialogClose asChild>
          <Button disabled={update.isPending}>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
