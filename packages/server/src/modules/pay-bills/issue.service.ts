import type {
  AllocationInput,
  IssueOutcome,
  IssuePendingPaymentRequest,
  IssuePendingPaymentsRequest,
  IssueResult,
} from '@openbooks/shared-types';
import {
  issuePendingPaymentRequestSchema,
  issuePendingPaymentsRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, tryUuidToBuffer } from '../../db';
import {
  InternalError,
  NotFoundError,
  OpenBooksError,
  PreconditionFailedError,
  assertFound,
  parseInput,
} from '../../errors';
import { getLogger } from '../../logging';
import { requirePermission } from '../permissions';

import type { AllocationSource } from '../payments/allocate';
import { applyAllocations } from '../payments/allocate';
import {
  allocatedFromDocument,
  allocatedToDocument,
  documentTotal,
  selectDocumentByIdForUpdate,
} from '../payments/allocations.repository';
import { requireRecordingUser } from '../payments/input';
import { recordPayment } from '../payments/payments.service';
import type { PostSettlementDiscountInput } from '../payments/settlement-discount';
import { postSettlementDiscount } from '../payments/settlement-discount';

import { allocateCheckNumber } from './check-register.repository';
import type { Check } from './check-output';
import { checkOutput } from './check-output';
import type { PendingPaymentIntentRow } from './queue.repository';
import {
  PENDING_PAYMENT_RESOURCE,
  orgScope,
  pendingPaymentIdBytes,
  selectBankAccountById,
  selectPendingPaymentByIdForUpdate,
  selectPendingPaymentIntents,
  selectPendingPaymentWithVendor,
  updatePendingPaymentRow,
} from './queue.repository';

/**
 * Issuing a pending payment: materialising it into a real `Payment` (OB-112;
 * ROADMAP D-65).
 *
 * ## One transaction per vendor, and why `recordPayment` may join it
 *
 * `issuePendingPayment` opens its own transaction and does everything for one
 * pending payment inside it: the check number (if any), `recordPayment` (the
 * journal and the `payAmount` allocations), the discount postings, the vendor-credit
 * applications, and the status flip. `recordPayment` calls `orgScope(ctx).transaction`
 * itself, but `TenantDatabase.transaction` joins an already-open ambient transaction
 * rather than opening a second one on a second connection (`transaction-scope.ts`) —
 * the same composition `withIdempotency` relies on. So nothing here special-cases
 * calling into `recordPayment` from inside a transaction; it is the ordinary way
 * every nested service call in this codebase composes.
 *
 * ## Atomic per payment, not per run (G2/D-63)
 *
 * `issuePendingPayments` loops the ids and calls `issuePendingPayment` once per id,
 * each in its own transaction, catching a per-vendor failure rather than letting it
 * abort the batch. One bad ACH detail leaves every other vendor issued and that one
 * `open` with its outcome recorded as `failed` — never a rollback of the batch.
 */

const RESOURCE = PENDING_PAYMENT_RESOURCE;

export async function issuePendingPayment(
  pendingPaymentId: string,
  input: IssuePendingPaymentRequest,
  ctx: RequestContext = getContext('issuePendingPayment()'),
): Promise<IssueOutcome> {
  await requirePermission(ctx, 'disbursements.issue');
  const request = parseInput(issuePendingPaymentRequestSchema, input);
  const author = requireRecordingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(pendingPaymentIdBytes(pendingPaymentId), RESOURCE);
    const pending = assertFound(await selectPendingPaymentByIdForUpdate(trx, id), RESOURCE);

    if (pending.status !== 'open') {
      throw new PreconditionFailedError(
        'pending_payment_not_open',
        `This pending payment is ${pending.status}, so it cannot be issued. Only an open pending ` +
          'payment is still pencil; one already issued has a real Payment behind it and ' +
          're-issuing it would pay the same bills twice.',
      );
    }

    const intents = await selectPendingPaymentIntents(trx, id);
    if (intents.length === 0) {
      // Unreachable in practice — `createPendingPaymentRequestSchema` requires
      // `intents.min(1)` and nothing here deletes the last one — but a payment with
      // no lines is a fault, not a request to refuse, if it is ever reached.
      throw new InternalError(
        'A pending payment was issued with no intents; buildPendingPayment refuses to create one.',
      );
    }

    const totalAmount = intents.reduce((total, intent) => total + intent.pay_amount_minor, 0n);
    const contactId = bufferToUuid(pending.contact_id);

    let checkNumber: bigint | null = null;
    let reference: string | null;

    if (pending.rail === 'check') {
      // Drawn inside this transaction, on `pending.bank_account_id`'s own register
      // (D-111) — rolled back with everything else if issue fails downstream, so
      // the gapless register never disagrees with what actually printed.
      checkNumber = await allocateCheckNumber(trx, pending.bank_account_id);
      reference = checkNumber.toString();
    } else {
      // The rail's own trace or confirmation, user- or integration-supplied
      // (D-110) — OpenBooks writes no NACHA file and no wire artifact, so this is
      // free text landing on `Payment.reference`, same as any other payment.
      reference = request.reference ?? null;
    }

    const allocations: AllocationInput[] = intents.map((intent) => ({
      targetType: 'bill',
      targetId: bufferToUuid(intent.bill_id),
      amount: intent.pay_amount_minor.toString(),
    }));

    // `recordPayment` credits a *ledger* account, so the bank account's nominated
    // chart account (D-46) is resolved here — `pending.bank_account_id` is a
    // `bank_accounts.id` (registration metadata), never the `accounts.id` the journal
    // touches. The FK guarantees the row exists, so a miss is a fault, not a refusal.
    const bankAccount =
      (await selectBankAccountById(trx, pending.bank_account_id)) ??
      raiseInternal('The pending payment names a bank account that does not exist.');

    // The journal, the payAmount allocations, and `payments_made.write` all live in
    // `recordPayment` — called, never re-implemented (the file header explains why
    // it may safely join this transaction).
    const payment = await recordPayment(
      {
        direction: 'made',
        contactId,
        date: request.date,
        amount: totalAmount.toString(),
        accountId: bufferToUuid(bankAccount.account_id),
        reference,
        memo: pending.memo,
        allocations,
      },
      ctx,
    );

    const paymentId =
      tryUuidToBuffer(payment.id) ??
      raiseInternal('recordPayment returned a payment id that is not a UUID.');

    for (const intent of intents) {
      if (intent.discount_amount_minor !== null && intent.discount_account_id !== null) {
        await postSettlementDiscount(
          trx,
          discountInput(intent, contactId, request.date, pending.memo),
          ctx,
          author,
        );
      }

      if (intent.applied_vendor_credit_id !== null) {
        await applyVendorCredit(
          trx,
          pending.contact_id,
          intent.applied_vendor_credit_id,
          intent.bill_id,
          request.date,
          author,
        );
      }
    }

    await updatePendingPaymentRow(trx, id, { status: 'issued', issuedPaymentId: paymentId });

    if (pending.rail === 'check' && checkNumber !== null) {
      const withVendor = await selectPendingPaymentWithVendor(trx, id);
      const payeeName = withVendor?.vendor_name ?? contactId;

      await emitCheckArtifact(
        id,
        pending.bank_account_id,
        checkNumber,
        payeeName,
        totalAmount,
        pending.memo,
        request.date,
      );
    }

    return {
      pendingPaymentId: bufferToUuid(id),
      status: 'issued',
      paymentId: payment.id,
      checkNumber: checkNumber === null ? null : checkNumber.toString(),
      error: null,
    };
  });
}

/**
 * Issues several pending payments in one call. **Atomic per payment, not per run**
 * (G2/D-63): each vendor is materialised in its own transaction via
 * `issuePendingPayment`, so a failure on one is caught here, recorded as a `failed`
 * outcome, and does not touch the others — none of which is rolled back, because
 * none of their transactions ever shared a connection with the failing one.
 */
export async function issuePendingPayments(
  input: IssuePendingPaymentsRequest,
  ctx: RequestContext = getContext('issuePendingPayments()'),
): Promise<IssueResult> {
  await requirePermission(ctx, 'disbursements.issue');
  const request = parseInput(issuePendingPaymentsRequestSchema, input);

  const outcomes: IssueOutcome[] = [];

  for (const pendingPaymentId of request.pendingPaymentIds) {
    try {
      outcomes.push(await issuePendingPayment(pendingPaymentId, { date: request.date }, ctx));
    } catch (error) {
      outcomes.push({
        pendingPaymentId,
        status: 'failed',
        paymentId: null,
        checkNumber: null,
        error: errorToken(error),
      });
    }
  }

  return { outcomes };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function discountInput(
  intent: PendingPaymentIntentRow,
  contactId: string,
  date: string,
  memo: string | null,
): PostSettlementDiscountInput {
  return {
    side: 'payable',
    targetType: 'bill',
    targetId: bufferToUuid(intent.bill_id),
    discountAccountId: bufferToUuid(
      intent.discount_account_id ?? raiseInternal('A discount intent carries no discount account.'),
    ),
    amount:
      intent.discount_amount_minor ??
      raiseInternal('A discount intent carries no discount amount.'),
    contactId,
    date,
    memo,
    source: 'payment',
  };
}

/**
 * Applies one vendor credit to one bill, at issue.
 *
 * `available` — the credit's own remaining balance — is exactly `allocateCreditDocument`'s
 * arithmetic in `payments/allocations.service.ts`: the credit's gross total minus what
 * has already been given from it, both read fresh under the row lock taken here.
 *
 * The *amount* applied is not on the wire: `pendingPaymentIntentInputSchema` carries
 * only the credit's id, not a figure, because a discount already has its own explicit
 * `discountAmount` and the credit does not. Read here as "clear whatever the bill still
 * owes once its own `payAmount` allocation (already posted by `recordPayment`, above)
 * and any discount (already posted, above) have landed" — the bill's current
 * outstanding, computed fresh at this point in the sequence. `applyAllocations`' own
 * checks are the backstop either way: `document_over_allocated` if this somehow
 * exceeds the bill, `source_over_allocated` if it exceeds what the credit has left.
 *
 * **Flagged for the orchestrator**: this reading is inferred, not pinned by the
 * OB-111/112 spec, which named the credit's own `available` computation explicitly
 * but not how much of it a bare `appliedVendorCreditId` (no amount) should consume.
 */
async function applyVendorCredit(
  trx: TenantDatabase,
  contactId: Buffer,
  vendorCreditId: Buffer,
  billId: Buffer,
  date: string,
  author: Buffer,
): Promise<void> {
  const credit = assertFound(
    await selectDocumentByIdForUpdate(trx, 'payable', vendorCreditId),
    'vendor_credit',
  );
  // A bill id in the vendor-credit-shaped id space is a miss, not a document of the
  // wrong kind — the id-space-disjoint convention `ap-documents.repository.ts` states.
  if (credit.document_type !== 'vendor_credit') throw new NotFoundError('vendor_credit');

  if (credit.journal_id === null) {
    throw new PreconditionFailedError(
      'document_not_approved',
      'This vendor credit is still a draft, so there is no credit to apply. Approving it is what ' +
        'posts the journal the credit comes from.',
    );
  }
  if (credit.void_journal_id !== null) {
    throw new PreconditionFailedError(
      'document_void',
      'This vendor credit has been voided: its journal is reversed, so the credit no longer ' +
        'exists.',
    );
  }

  const source: AllocationSource = {
    side: 'payable',
    kind: 'credit_document',
    id: vendorCreditId,
    contactId,
    available:
      (await documentTotal(trx, 'payable', vendorCreditId)) -
      (await allocatedFromDocument(trx, 'payable', vendorCreditId)),
    label: 'vendor credit',
  };

  const remaining =
    (await documentTotal(trx, 'payable', billId)) -
    (await allocatedToDocument(trx, 'payable', billId));
  if (remaining <= 0n) return;

  await applyAllocations(
    trx,
    source,
    [{ targetType: 'bill', targetId: bufferToUuid(billId), amount: remaining.toString() }],
    date,
    author,
  );
}

/**
 * Best-effort: the check number is already drawn from the register and, by the
 * time this runs, the payment is already posted (step order above). Failing the
 * whole issue over an artifact that is reproducible from this same data — while
 * the drawn number would not be reusable — would make the cure worse than the
 * disease, so a failure here is logged and swallowed rather than thrown (D-111).
 */
async function emitCheckArtifact(
  pendingPaymentId: Buffer,
  bankAccountId: Buffer,
  checkNumber: bigint,
  payeeName: string,
  amountMinor: bigint,
  memo: string | null,
  date: string,
): Promise<void> {
  const check: Check = {
    bankAccountId: bufferToUuid(bankAccountId),
    checkNumber,
    payeeName,
    amountMinor,
    memo,
    date,
  };

  try {
    await checkOutput().emit(check);
  } catch (error) {
    getLogger().error(
      {
        err: error,
        pendingPaymentId: bufferToUuid(pendingPaymentId),
        checkNumber: checkNumber.toString(),
      },
      'Failed to emit the check artifact for an issued pending payment. The check number is ' +
        'already drawn and the payment is already posted; the artifact can be regenerated later.',
    );
  }
}

function raiseInternal(message: string): never {
  throw new InternalError(message);
}

/** The refusal token an `IssueOutcome.error` reports for a failed vendor. */
function errorToken(error: unknown): string {
  if (error instanceof OpenBooksError) {
    const token =
      error.details?.['precondition'] ??
      error.details?.['resource'] ??
      error.details?.['permission'];
    return typeof token === 'string' ? token : error.clientMessage;
  }
  return 'unknown_error';
}
