import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent, ReactElement } from 'react';
import { useId, useState } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Pill,
  ResponsiveTable,
  Select,
  TextInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, SettingsSection, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from './section';

/**
 * Payment terms (OB-136, OB-140; ROADMAP D-79, D-106, D-107).
 *
 * A term computes a document's due date from `netDays` and, when it carries one, an
 * early-pay discount and its deadline from `discountRatePpm`/`discountWindowDays` —
 * **simple** (net only) and **rich** (with a discount) both supported, never partially
 * rich (the server's own `chk_payment_terms_discount`). Assigning a term to a contact or a
 * document is that screen's own picker, not this one's — this section is the catalog a
 * picker offers from, mirroring `dimensions.tsx`'s list-plus-form shape for the reason
 * `recurring-invoices.tsx`'s header gives for its own template list: a small, bounded
 * catalog with create, edit and a one-way retirement, not a paged view.
 *
 * ## Why editing a discount cannot clear it back to a simple term
 *
 * `updatePaymentTermRequestSchema`'s own words: a term already referenced by a document
 * must not have its arithmetic change retroactively. So the edit form can add a discount to
 * a term that never had one (both fields supplied together) and can change the figures on
 * one that already has a discount, but there is no control here to remove one — the way
 * back is `deactivatePaymentTerm` plus a new, simple term, exactly as the ROADMAP's D-79
 * execution notes say.
 *
 * ## `discountRatePpm` is parts-per-million, and this form is the one place that is a percent
 *
 * `20000` is 2% (`tax_rates.rate_ppm`'s own convention, restated for terms). The wire never
 * carries a percentage — there is no per-jurisdiction display rule for a discount the way
 * there is for a published tax rate — so this form is where the conversion happens, both
 * ways, and nowhere else in the app repeats it.
 */

type PaymentTerm = components['schemas']['PaymentTerm'];
type CreatePaymentTermRequest = components['schemas']['CreatePaymentTermRequestInput'];
type UpdatePaymentTermRequest = components['schemas']['UpdatePaymentTermRequestInput'];

const PPM_PER_PERCENT = 10_000;

function ppmToPercentText(ppm: number | null): string {
  return ppm === null ? '' : String(ppm / PPM_PER_PERCENT);
}

/** `null` for an unparseable or empty string — the caller decides what that means, the
 *  same contract `tryToMinorUnits` keeps for money. */
function percentTextToPpm(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent < 0) return null;
  return Math.round(percent * PPM_PER_PERCENT);
}

type ActiveFilter = 'active' | 'all';

const FILTER_OPTIONS = [
  { value: 'active', label: 'Active only' },
  { value: 'all', label: 'Active and archived' },
];

type TermDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly term: PaymentTerm }
  | { readonly kind: 'deactivate'; readonly term: PaymentTerm };

const TERMS_QUERY_KEY = (includeInactive: boolean) =>
  ['settings', 'payment-terms', includeInactive] as const;

export function PaymentTermsSection(): ReactElement {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ActiveFilter>('active');
  const [dialog, setDialog] = useState<TermDialog | null>(null);

  const includeInactive = filter === 'all';
  const queryKey = TERMS_QUERY_KEY(includeInactive);

  const terms = useQuery({
    queryKey,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/payment-terms', {
          params: { query: { includeInactive: includeInactive ? 'true' : 'false' } },
        }),
      ),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['settings', 'payment-terms'] });
  };

  const create = useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreatePaymentTermRequest>) =>
      unwrap(
        await api.POST('/v1/payment-terms', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  const update = useMutation({
    mutationFn: async ({
      idempotencyKey,
      paymentTermId,
      ...body
    }: IdempotentVariables<{ paymentTermId: string } & UpdatePaymentTermRequest>) =>
      unwrap(
        await api.PATCH('/v1/payment-terms/{paymentTermId}', {
          body,
          params: { path: { paymentTermId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  const deactivate = useMutation({
    mutationFn: async ({
      idempotencyKey,
      paymentTermId,
    }: IdempotentVariables<{ paymentTermId: string }>) =>
      unwrap(
        await api.POST('/v1/payment-terms/{paymentTermId}/deactivate', {
          params: { path: { paymentTermId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  const items = terms.data?.paymentTerms ?? [];

  return (
    <SettingsSection
      title="Payment terms"
      description={
        <>
          Net days and, optionally, an early-pay discount (D-79) — Net 30, 2/10 Net 30, due on
          receipt. A contact&rsquo;s default and a document&rsquo;s own override both name one of
          these; this list is the catalog they pick from.
        </>
      }
      actions={
        <Button
          variant="primary"
          onClick={() => {
            create.reset();
            setDialog({ kind: 'create' });
          }}
        >
          New payment term
        </Button>
      }
    >
      {terms.isError && (
        <ErrorBanner
          error={terms.error}
          onRetry={() => {
            void terms.refetch();
          }}
        />
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-56">
          <FieldLabel>Show</FieldLabel>
          <Select
            value={filter}
            options={FILTER_OPTIONS}
            onValueChange={(value) => {
              setFilter(value === 'all' ? 'all' : 'active');
            }}
          />
        </Field>
      </div>

      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Payment terms</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Name
              </th>
              <th scope="col" className={TH_CLASSES}>
                Net days
              </th>
              <th scope="col" className={TH_CLASSES}>
                Early-pay discount
              </th>
              <th scope="col" className={TH_CLASSES}>
                Status
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <EmptyRow columns={5}>
                {terms.isPending
                  ? 'Loading…'
                  : 'No payment terms yet. Documents and contacts have none to default to until one exists.'}
              </EmptyRow>
            )}
            {items.map((term) => (
              <tr key={term.id}>
                <td className={TD_CLASSES}>{term.name}</td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{term.netDays}</td>
                <td className={TD_CLASSES}>
                  {term.discountRatePpm === null || term.discountWindowDays === null ? (
                    <span className="text-text-subtle">None — a simple term</span>
                  ) : (
                    <span className="font-mono">
                      {ppmToPercentText(term.discountRatePpm)}% within {term.discountWindowDays} day
                      {term.discountWindowDays === 1 ? '' : 's'}
                    </span>
                  )}
                </td>
                <td className={TD_CLASSES}>
                  <Pill tone={term.isActive ? 'positive' : 'muted'}>
                    {term.isActive ? 'Active' : 'Archived'}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      onClick={() => {
                        update.reset();
                        setDialog({ kind: 'edit', term });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!term.isActive}
                      aria-label={`Archive ${term.name}`}
                      onClick={() => {
                        deactivate.reset();
                        setDialog({ kind: 'deactivate', term });
                      }}
                    >
                      Archive
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      <TermFormDialog
        title="New payment term"
        description="A net-days figure and, optionally, a paired early-pay discount."
        open={dialog?.kind === 'create'}
        submitLabel="Create"
        pending={create.isPending}
        error={create.error}
        onClose={() => setDialog(null)}
        onSubmit={(values) => {
          create.mutate({ ...values, idempotencyKey: newIdempotencyKey() });
        }}
      />

      <TermFormDialog
        title="Edit payment term"
        description="A term already referenced by a document keeps its arithmetic — this changes future documents only. There is no control here to remove an existing discount; deactivate this term and create a simple replacement instead."
        open={dialog?.kind === 'edit'}
        submitLabel="Save"
        pending={update.isPending}
        error={update.error}
        initial={dialog?.kind === 'edit' ? dialog.term : undefined}
        onClose={() => setDialog(null)}
        onSubmit={(values) => {
          if (dialog?.kind !== 'edit') return;
          update.mutate({
            paymentTermId: dialog.term.id,
            ...values,
            idempotencyKey: newIdempotencyKey(),
          });
        }}
      />

      <Dialog
        open={dialog?.kind === 'deactivate'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog?.kind === 'deactivate' && (
          <DialogContent
            title="Archive this payment term?"
            description="It stays on every document and contact that already names it and is never offered for a new one. Not a delete — a term any document or contact still names could not be removed regardless."
            footer={
              <>
                <DialogClose asChild>
                  <Button disabled={deactivate.isPending}>Cancel</Button>
                </DialogClose>
                <Button
                  variant="danger"
                  disabled={deactivate.isPending}
                  onClick={() => {
                    deactivate.mutate({
                      paymentTermId: dialog.term.id,
                      idempotencyKey: newIdempotencyKey(),
                    });
                  }}
                >
                  {deactivate.isPending ? 'Archiving…' : 'Archive'}
                </Button>
              </>
            }
          >
            {deactivate.isError && <ErrorBanner error={deactivate.error} />}
          </DialogContent>
        )}
      </Dialog>
    </SettingsSection>
  );
}

interface TermFormValues {
  readonly name: string;
  readonly netDays: number;
  readonly discountRatePpm?: number;
  readonly discountWindowDays?: number;
}

interface TermFormDialogProps {
  readonly title: string;
  readonly description: string;
  readonly open: boolean;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly initial?: PaymentTerm | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (values: TermFormValues) => void;
}

function TermFormDialog({
  title,
  description,
  open,
  submitLabel,
  pending,
  error,
  initial,
  onClose,
  onSubmit,
}: TermFormDialogProps): ReactElement {
  const formId = useId();
  const [name, setName] = useState('');
  const [netDays, setNetDays] = useState('30');
  const [hasDiscount, setHasDiscount] = useState(false);
  const [discountPercent, setDiscountPercent] = useState('');
  const [discountWindowDays, setDiscountWindowDays] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seeded the first time this dialog opens for this row (or as a blank create form) —
  // `dimensions.tsx`'s `AxisFormDialog` pattern: an effect would also fire while the user is
  // typing and undo the edit.
  const seedKey = open ? (initial?.id ?? 'new') : null;
  if (seedKey !== null && seedKey !== seeded) {
    setSeeded(seedKey);
    setName(initial?.name ?? '');
    setNetDays(initial === undefined ? '30' : String(initial.netDays));
    const rich = initial?.discountRatePpm !== null && initial?.discountRatePpm !== undefined;
    setHasDiscount(rich);
    setDiscountPercent(ppmToPercentText(initial?.discountRatePpm ?? null));
    setDiscountWindowDays(
      initial === undefined || initial.discountWindowDays === null
        ? ''
        : String(initial.discountWindowDays),
    );
  }
  if (seedKey === null && seeded !== null) setSeeded(null);

  // Once a term already carries a discount, this form cannot remove it — only change the
  // figures (`updatePaymentTermRequestSchema`'s own restriction). The checkbox is locked on
  // rather than hidden, so the reason is visible rather than a control that quietly vanished.
  const discountLocked =
    initial?.discountRatePpm !== null && initial?.discountRatePpm !== undefined;

  const netDaysNumber = Number(netDays);
  const discountRatePpm = hasDiscount ? percentTextToPpm(discountPercent) : null;
  const discountWindowDaysNumber =
    hasDiscount && discountWindowDays.trim() !== '' ? Number(discountWindowDays) : null;

  const validNetDays = Number.isInteger(netDaysNumber) && netDaysNumber >= 0;
  const validDiscount =
    !hasDiscount ||
    (discountRatePpm !== null &&
      discountWindowDaysNumber !== null &&
      Number.isInteger(discountWindowDaysNumber) &&
      discountWindowDaysNumber >= 0);
  const complete = name.trim() !== '' && validNetDays && validDiscount;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!complete) return;
    onSubmit({
      name: name.trim(),
      netDays: netDaysNumber,
      ...(hasDiscount && discountRatePpm !== null && discountWindowDaysNumber !== null
        ? { discountRatePpm, discountWindowDays: discountWindowDaysNumber }
        : {}),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={title}
        description={description}
        footer={
          <>
            <DialogClose asChild>
              <Button disabled={pending}>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form={formId} disabled={pending || !complete}>
              {submitLabel}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
          <Field hint='Shown in every picker, e.g. "Net 30" or "2/10 Net 30". Unique within the org.'>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <Field hint="Days from issue to due. Zero is due on receipt.">
            <FieldLabel>Net days</FieldLabel>
            <TextInput
              type="number"
              min={0}
              value={netDays}
              onChange={(event) => {
                setNetDays(event.target.value);
              }}
            />
          </Field>

          <Field className="gap-0">
            <div className="flex items-center gap-2">
              <DiscountCheckbox
                checked={hasDiscount}
                disabled={discountLocked}
                onCheckedChange={setHasDiscount}
              />
              <FieldLabel>Includes an early-pay discount</FieldLabel>
            </div>
          </Field>
          {discountLocked && (
            <p className="text-xs text-text-subtle">
              This term already carries a discount a document may have used — its arithmetic cannot
              be changed back to a simple term here. Deactivate this term and create a simple
              replacement instead.
            </p>
          )}

          {hasDiscount && (
            <>
              <Field hint="20000 on the wire is 2% — typed here as a percentage, e.g. 2.">
                <FieldLabel>Discount rate (%)</FieldLabel>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={discountPercent}
                  onChange={(event) => {
                    setDiscountPercent(event.target.value);
                  }}
                />
              </Field>
              <Field hint="Days from issue in which the discount may still be taken.">
                <FieldLabel>Discount window (days)</FieldLabel>
                <TextInput
                  type="number"
                  min={0}
                  value={discountWindowDays}
                  onChange={(event) => {
                    setDiscountWindowDays(event.target.value);
                  }}
                />
              </Field>
            </>
          )}

          {error !== null && error !== undefined && <ErrorBanner error={error} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `contacts/contact-form.tsx`'s `CheckboxControl`, plus `disabled` — locked once a term
 *  already carries a discount, per `updatePaymentTermRequestSchema`'s own restriction. */
function DiscountCheckbox({
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
      className="size-4 rounded-sm border border-border accent-accent"
      onChange={(event) => {
        onCheckedChange(event.target.checked);
      }}
    />
  );
}
