import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import {
  Button,
  Combobox,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  Select,
} from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import { Amount, isZeroAmount } from './amounts';
import { CheckboxField, DateField } from './controls';
import { PaymentDetail } from './payment-detail';
import { RecordPaymentDialog } from './record-payment-dialog';
import type { PaymentDirection, PaymentFilters, PaymentStatus, PaymentSummary } from './queries';
import { NO_PAYMENT_FILTERS, useContactOptions, usePaymentList } from './queries';

/**
 * The payments list, in both directions (OB-070; ROADMAP D-21, D-37).
 *
 * One list with a direction filter rather than a receipts screen and a disbursements
 * screen, because everything about the two is identical — the same allocation mechanism,
 * the same void, the same credit-on-the-contact behaviour — and two screens would duplicate
 * all of it to express one bit. It is also the reason the server modelled one resource with
 * a `direction`.
 *
 * The column that earns its place is **on account**: `settlement.outstanding`, which on a
 * payment reads as the credit still available (D-37). Putting it in the list rather than
 * only on the detail panel is what makes "who is holding money we have not applied" a
 * question the screen answers by being looked at, and the `unallocatedOnly` filter turns
 * the same question into a request the server answers.
 */

const DIRECTION_OPTIONS = [
  { value: 'any', label: 'Received and made' },
  { value: 'received', label: 'Received' },
  { value: 'made', label: 'Made' },
];

const STATUS_OPTIONS = [
  { value: 'any', label: 'Recorded and void' },
  { value: 'recorded', label: 'Recorded' },
  { value: 'void', label: 'Void' },
];

const ANY = 'any';

/**
 * Narrowed rather than cast. `Select` hands back a `string`, and a cast would let a
 * relabelled option reach the querystring as a value the server does not accept — which
 * arrives as a `validation_failed` on a filter change, with nothing on screen to explain it.
 */
function toDirection(value: string): PaymentDirection | null {
  if (value === 'received') return 'received';
  return value === 'made' ? 'made' : null;
}

function toStatus(value: string): PaymentStatus | null {
  if (value === 'recorded') return 'recorded';
  return value === 'void' ? 'void' : null;
}

export function PaymentsView(): ReactElement {
  const isCompact = useIsCompact();
  const [filters, setFilters] = useState<PaymentFilters>(NO_PAYMENT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const contacts = useContactOptions();
  const list = usePaymentList(filters);

  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const contactNames = useMemo(
    () => new Map(contacts.map((contact) => [contact.id, contact.displayName])),
    [contacts],
  );

  function filter<K extends keyof PaymentFilters>(key: K, value: PaymentFilters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-form text-text-muted">
          Money that moved, in both directions. What each payment settles is recorded separately,
          and it does not have to be decided today.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setRecording(true);
          }}
        >
          Record payment
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-52">
          <FieldLabel>Direction</FieldLabel>
          <Select
            value={filters.direction ?? ANY}
            options={DIRECTION_OPTIONS}
            onValueChange={(value) => {
              filter('direction', toDirection(value));
            }}
          />
        </Field>

        <Field className="w-48">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={filters.status ?? ANY}
            options={STATUS_OPTIONS}
            onValueChange={(value) => {
              filter('status', toStatus(value));
            }}
          />
        </Field>

        <Field className="w-56">
          <FieldLabel>Contact</FieldLabel>
          <Combobox
            value={filters.contactId}
            options={[
              { value: ANY, label: 'Every contact' },
              ...contacts.map((contact) => ({ value: contact.id, label: contact.displayName })),
            ]}
            placeholder="Every contact"
            onValueChange={(value) => {
              filter('contactId', value === ANY || value === null ? null : value);
            }}
          />
        </Field>

        <DateField
          label="From"
          className="w-40"
          value={filters.from}
          onChange={(from) => {
            filter('from', from);
          }}
        />
        <DateField
          label="To"
          className="w-40"
          value={filters.to}
          onChange={(to) => {
            filter('to', to);
          }}
        />

        <CheckboxField
          label="Only ones with credit left"
          hint="D-37's credit balance, asked for directly."
          checked={filters.unallocatedOnly}
          onCheckedChange={(checked) => {
            filter('unallocatedOnly', checked);
          }}
        />
      </div>

      {selected !== null && (
        <PaymentDetail
          /* Keyed on the payment, so opening a second one starts from that payment's own
             state rather than from the previous panel's half-filled allocation form. */
          key={selected}
          paymentId={selected}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}

      {list.isPending && <p className="text-text-muted">Loading payments…</p>}

      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {list.isSuccess && rows.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          No payments match these filters.
        </p>
      )}

      {rows.length > 0 &&
        (isCompact ? (
          <PaymentCards
            payments={rows}
            contactNames={contactNames}
            onOpen={(paymentId) => {
              setSelected(paymentId);
            }}
          />
        ) : (
          <ResponsiveTable>
            <table className="w-full border-collapse text-base">
              <caption className="sr-only">
                Payments, oldest first by when they were recorded
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-sm text-text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Contact
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Reference
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Applied
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    On account
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((payment) => (
                  <PaymentRow
                    key={payment.id}
                    payment={payment}
                    contactName={contactNames.get(payment.contactId) ?? '—'}
                    onOpen={() => {
                      setSelected(payment.id);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        ))}

      {/* The button exists only when the server handed back a cursor. Presence is the only
          signal that more exists — a full page does not imply another (D-21). */}
      {list.hasNextPage && (
        <div>
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <RecordPaymentDialog
        open={recording}
        onOpenChange={setRecording}
        onRecorded={(paymentId) => {
          // Opened rather than merely listed: the panel is where the credit the receipt
          // just created is stated, and that is the fact the person who recorded it needs.
          setSelected(paymentId);
        }}
      />
    </div>
  );
}

function PaymentRow({
  payment,
  contactName,
  onOpen,
}: {
  readonly payment: PaymentSummary;
  readonly contactName: string;
  readonly onOpen: () => void;
}): ReactElement {
  const credit = payment.settlement.outstanding;

  return (
    <tr className="border-b border-border align-top">
      <td className="py-2 pr-3 font-mono text-sm text-text-muted">{payment.date}</td>
      <td className="py-2 pr-3">
        <span className="text-text">{contactName}</span>
        <span className="block text-xs text-text-subtle">
          {payment.direction === 'received' ? 'Received' : 'Made'}
          {payment.status === 'void' ? ' · voided' : ''}
        </span>
      </td>
      <td className="py-2 pr-3 text-sm text-text-muted">{payment.reference ?? '—'}</td>
      <td className="py-2 pr-3 text-right">
        <Amount value={payment.amount} />
      </td>
      <td className="py-2 pr-3 text-right">
        <Amount value={payment.settlement.allocated} />
      </td>
      <td className="py-2 pr-3 text-right">
        <Amount value={credit} />
        {!isZeroAmount(credit) && payment.status !== 'void' && (
          <span className="block text-xs text-text-subtle">credit on this contact</span>
        )}
      </td>
      <td className="py-2 text-right">
        <Button
          size="sm"
          aria-label={`Open the ${payment.date} payment for ${contactName}`}
          onClick={onOpen}
        >
          Open
        </Button>
      </td>
    </tr>
  );
}

/** The card presentation of the same rows `PaymentRow` draws (D-123's polish tier) — each
 * card shows exactly the fields the row's cells show, in the same order. */
function PaymentCards({
  payments,
  contactNames,
  onOpen,
}: {
  readonly payments: readonly PaymentSummary[];
  readonly contactNames: ReadonlyMap<string, string>;
  readonly onOpen: (paymentId: string) => void;
}): ReactElement {
  return (
    <ul
      className="flex flex-col gap-3"
      aria-label="Payments, oldest first by when they were recorded"
    >
      {payments.map((payment) => (
        <PaymentCard
          key={payment.id}
          payment={payment}
          contactName={contactNames.get(payment.contactId) ?? '—'}
          onOpen={() => {
            onOpen(payment.id);
          }}
        />
      ))}
    </ul>
  );
}

function PaymentCard({
  payment,
  contactName,
  onOpen,
}: {
  readonly payment: PaymentSummary;
  readonly contactName: string;
  readonly onOpen: () => void;
}): ReactElement {
  const credit = payment.settlement.outstanding;

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-text">{contactName}</p>
          <p className="text-xs text-text-subtle">
            {payment.direction === 'received' ? 'Received' : 'Made'}
            {payment.status === 'void' ? ' · voided' : ''}
          </p>
        </div>
        <span className="font-mono text-xs text-text-muted">{payment.date}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-text-subtle">Reference</dt>
          <dd className="text-text-muted">{payment.reference ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-subtle">Amount</dt>
          <dd>
            <Amount value={payment.amount} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-subtle">Applied</dt>
          <dd>
            <Amount value={payment.settlement.allocated} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-subtle">On account</dt>
          <dd>
            <Amount value={credit} />
            {!isZeroAmount(credit) && payment.status !== 'void' && (
              <span className="block text-xs text-text-subtle">credit on this contact</span>
            )}
          </dd>
        </div>
      </dl>

      <Button
        className="min-h-[44px]"
        aria-label={`Open the ${payment.date} payment for ${contactName}`}
        onClick={onOpen}
      >
        Open
      </Button>
    </li>
  );
}
