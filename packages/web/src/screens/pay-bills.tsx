import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, ErrorBanner, Field, FieldLabel } from '../components';
import { todayCalendarDate as todayDate } from './pay-bills/amounts';
import { DisbursementDetailsDialog } from './pay-bills/disbursement-details-dialog';
import {
  BLANK_DRAFT,
  BLANK_VENDOR_SETTINGS,
  buildPayments,
  groupByVendor,
  incompleteVendorIds,
} from './pay-bills/draft';
import type { BillDraft, VendorSettings } from './pay-bills/draft';
import { PayableBillsTable } from './pay-bills/payable-bills-table';
import {
  useBankAccountOptions,
  useIntentKey,
  usePayBills,
  usePayableBills,
} from './pay-bills/queries';
import { VendorPaymentGroup } from './pay-bills/vendor-payment-group';

/**
 * The Pay Bills window (OB-116; ROADMAP D-63…D-68, D-79, D-109, D-110).
 *
 * ## What "building" is, and what it is not
 *
 * `POST /v1/pay-bills` posts no journal (D-64): a pending payment is pencil. Selecting bills
 * here and pressing "Build payments" reserves each named bill's `committed` — which is why
 * every other selection on this screen sees `availableToPay` shrink the moment a build
 * succeeds (D-68) — and queues one `PendingPayment` per vendor on the Disbursements screen.
 * Nothing is disbursed and no check is printed until that screen's own "Issue".
 *
 * ## Why selection is per bill and configuration is per vendor
 *
 * `CreatePendingPaymentRequest.intents[]` is where a discount and a vendor credit live,
 * because both are facts about one bill. `bankAccountId` and `rail` sit one level up, because
 * a `PendingPayment` carries one contact and one disbursement (D-63) — every bill selected
 * for the same vendor in the same build shares both, which is what `VendorPaymentGroup`
 * below is for.
 */
export function PayBillsScreen(): ReactElement {
  const [paymentDate] = useState(() => todayDate());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, BillDraft>>(new Map());
  const [vendorSettings, setVendorSettings] = useState<ReadonlyMap<string, VendorSettings>>(
    new Map(),
  );
  const [editingDetailsFor, setEditingDetailsFor] = useState<{
    readonly contactId: string;
    readonly vendorName: string;
  } | null>(null);
  const [built, setBuilt] = useState(0);

  const payableBills = usePayableBills();
  const bankAccounts = useBankAccountOptions();
  const payBills = usePayBills();
  const intentKey = useIntentKey();

  const bills = payableBills.data ?? [];

  function changeDraft(billId: string, patch: Partial<BillDraft>): void {
    setDrafts((current) => {
      const next = new Map(current);
      next.set(billId, { ...(next.get(billId) ?? BLANK_DRAFT), ...patch });
      return next;
    });
    setBuilt(0);
  }

  function changeVendorSettings(contactId: string, patch: Partial<VendorSettings>): void {
    setVendorSettings((current) => {
      const next = new Map(current);
      next.set(contactId, { ...(next.get(contactId) ?? BLANK_VENDOR_SETTINGS), ...patch });
      return next;
    });
  }

  const vendorGroups = useMemo(() => groupByVendor(bills, drafts), [bills, drafts]);
  const incomplete = useMemo(
    () => incompleteVendorIds(bills, drafts, vendorSettings),
    [bills, drafts, vendorSettings],
  );
  const payments = useMemo(
    () => buildPayments(bills, drafts, vendorSettings),
    [bills, drafts, vendorSettings],
  );

  // A vendor group counts toward "ready" only once its bills all resolved to real intents
  // (a pay amount typed, D-13) *and* it has a bank account — `payments.length` covers both,
  // since `buildPayments` drops any vendor short of either rather than sending it half-formed.
  const ready = vendorGroups.size > 0 && payments.length === vendorGroups.size;

  function submit(): void {
    if (!ready) return;
    payBills.mutate(
      { payments, idempotencyKey: intentKey(JSON.stringify(payments)) },
      {
        onSuccess: (built_) => {
          setDrafts(new Map());
          setBuilt(built_.length);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Pay bills</h1>
          <p className="max-w-form text-text-muted">
            Select what to pay, apply a discount or a vendor credit, choose a bank account and a
            rail per vendor, and build the pending-payment queue. Nothing is disbursed here —
            issuing happens on the{' '}
            <Link
              to="/disbursements"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              Disbursements
            </Link>{' '}
            screen.
          </p>
        </div>
        <Field className="w-44">
          <FieldLabel>Payment date</FieldLabel>
          <p className="font-mono tabular-nums text-text">{paymentDate}</p>
        </Field>
      </div>

      {built > 0 && (
        <p
          role="status"
          className="rounded-lg border border-success-border bg-success-soft p-3 text-sm text-success-text"
        >
          Built {built} {built === 1 ? 'payment' : 'payments'} onto the{' '}
          <Link to="/disbursements" className="font-medium underline-offset-2 hover:underline">
            Disbursements
          </Link>{' '}
          queue.
        </p>
      )}

      {payableBills.isError && (
        <ErrorBanner
          error={payableBills.error}
          onRetry={() => {
            void payableBills.refetch();
          }}
        />
      )}

      {payBills.isError && <ErrorBanner error={payBills.error} />}

      <PayableBillsTable
        bills={bills}
        drafts={drafts}
        paymentDate={paymentDate}
        disabled={payBills.isPending}
        loading={payableBills.isPending}
        onChange={changeDraft}
      />

      {vendorGroups.size > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-text">Building</h2>
          {[...vendorGroups.entries()].map(([contactId, vendorBills]) => (
            <VendorPaymentGroup
              key={contactId}
              contactId={contactId}
              vendorName={vendorBills[0]?.vendorName ?? ''}
              bills={vendorBills}
              drafts={drafts}
              settings={vendorSettings.get(contactId) ?? BLANK_VENDOR_SETTINGS}
              bankAccounts={bankAccounts}
              disabled={payBills.isPending}
              incomplete={incomplete.has(contactId)}
              onChange={(patch) => {
                changeVendorSettings(contactId, patch);
              }}
              onEditDisbursementDetails={() => {
                setEditingDetailsFor({ contactId, vendorName: vendorBills[0]?.vendorName ?? '' });
              }}
            />
          ))}

          <div>
            <Button variant="primary" disabled={!ready || payBills.isPending} onClick={submit}>
              {payBills.isPending ? 'Building…' : 'Build payments'}
            </Button>
          </div>
        </div>
      )}

      <DisbursementDetailsDialog
        contactId={editingDetailsFor?.contactId ?? null}
        vendorName={editingDetailsFor?.vendorName ?? ''}
        onOpenChange={(open) => {
          if (!open) setEditingDetailsFor(null);
        }}
      />
    </div>
  );
}
