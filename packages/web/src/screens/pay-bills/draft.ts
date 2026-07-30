import { isZeroAmount } from './amounts';
import type {
  CreatePendingPaymentRequest,
  PayableBill,
  PendingPaymentIntentInput,
  Rail,
} from './queries';

/**
 * The Pay Bills window's own working state — never sent as typed, always turned into a
 * `CreatePendingPaymentRequest` by `buildPayments` below.
 *
 * ## Why a discount and a credit are drafted per bill and a bank account/rail per vendor
 *
 * `CreatePendingPaymentRequest.intents[]` carries `discountAmount`/`discountAccountId`/
 * `appliedVendorCreditId` per line, because a discount window and a spendable credit are
 * both facts about one bill. `bankAccountId` and `rail` sit one level up, on the request
 * itself, because a `PendingPayment` carries one contact and one disbursement (D-63) — two
 * bills for the same vendor in the same build always share both.
 */
export interface BillDraft {
  readonly selected: boolean;
  /** Minor units (D-13). `null` while unselected or not yet typed. */
  readonly payAmount: string | null;
  readonly discountAmount: string | null;
  readonly discountAccountId: string | null;
  readonly appliedVendorCreditId: string | null;
}

export const BLANK_DRAFT: BillDraft = {
  selected: false,
  payAmount: null,
  discountAmount: null,
  discountAccountId: null,
  appliedVendorCreditId: null,
};

export interface VendorSettings {
  readonly bankAccountId: string | null;
  readonly rail: Rail;
  readonly memo: string;
}

export const BLANK_VENDOR_SETTINGS: VendorSettings = {
  bankAccountId: null,
  rail: 'check',
  memo: '',
};

/** One selected bill, ready to become an intent — or not, when its amount is still empty. */
export function intentFor(bill: PayableBill, draft: BillDraft): PendingPaymentIntentInput | null {
  if (draft.payAmount === null) return null;

  return {
    billId: bill.billId,
    payAmount: draft.payAmount,
    // Both or neither, mirroring `chk_payment_terms_discount`'s own pairing one layer up:
    // an amount with no account to post it to is not a discount this screen can send.
    ...(draft.discountAmount !== null &&
    !isZeroAmount(draft.discountAmount) &&
    draft.discountAccountId !== null
      ? { discountAmount: draft.discountAmount, discountAccountId: draft.discountAccountId }
      : {}),
    ...(draft.appliedVendorCreditId !== null
      ? { appliedVendorCreditId: draft.appliedVendorCreditId }
      : {}),
  };
}

/** The selected bills, grouped by the vendor a build's `intents[]` will share. */
export function groupByVendor(
  bills: readonly PayableBill[],
  drafts: ReadonlyMap<string, BillDraft>,
): ReadonlyMap<string, readonly PayableBill[]> {
  const byVendor = new Map<string, PayableBill[]>();
  for (const bill of bills) {
    if (drafts.get(bill.billId)?.selected !== true) continue;
    const existing = byVendor.get(bill.contactId);
    if (existing === undefined) byVendor.set(bill.contactId, [bill]);
    else existing.push(bill);
  }
  return byVendor;
}

/**
 * One `CreatePendingPaymentRequest` per vendor with a complete draft — a bank account chosen
 * and every selected bill carrying a pay amount. A vendor missing either is left out rather
 * than sent half-formed; the screen surfaces which one via `incompleteVendorIds` below so
 * "Build payments" can stay disabled instead of silently dropping a vendor's bills.
 */
export function buildPayments(
  bills: readonly PayableBill[],
  drafts: ReadonlyMap<string, BillDraft>,
  vendorSettings: ReadonlyMap<string, VendorSettings>,
): readonly CreatePendingPaymentRequest[] {
  const payments: CreatePendingPaymentRequest[] = [];

  for (const [contactId, vendorBills] of groupByVendor(bills, drafts)) {
    const settings = vendorSettings.get(contactId) ?? BLANK_VENDOR_SETTINGS;
    if (settings.bankAccountId === null) continue;

    const intents = vendorBills
      .map((bill) => intentFor(bill, drafts.get(bill.billId) ?? BLANK_DRAFT))
      .filter((intent): intent is PendingPaymentIntentInput => intent !== null);
    if (intents.length !== vendorBills.length) continue;

    payments.push({
      contactId,
      bankAccountId: settings.bankAccountId,
      rail: settings.rail,
      intents,
      ...(settings.memo.trim() === '' ? {} : { memo: settings.memo.trim() }),
    });
  }

  return payments;
}

/** The vendors with bills selected but no bank account chosen yet — what keeps "Build
 * payments" disabled beyond "nothing is selected". */
export function incompleteVendorIds(
  bills: readonly PayableBill[],
  drafts: ReadonlyMap<string, BillDraft>,
  vendorSettings: ReadonlyMap<string, VendorSettings>,
): ReadonlySet<string> {
  const incomplete = new Set<string>();
  for (const contactId of groupByVendor(bills, drafts).keys()) {
    if ((vendorSettings.get(contactId) ?? BLANK_VENDOR_SETTINGS).bankAccountId === null) {
      incomplete.add(contactId);
    }
  }
  return incomplete;
}
