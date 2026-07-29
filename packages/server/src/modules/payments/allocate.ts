import type { AllocationInput } from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import type { ValidationIssue } from '../../errors';
import { PreconditionFailedError, ValidationError, assertFound } from '../../errors';

import type { DocumentRow } from './allocations.repository';
import {
  DOCUMENT_RESOURCE,
  allocatedToDocument,
  documentIdBytes,
  documentTotal,
  insertAllocation,
  selectDocumentByIdForUpdate,
} from './allocations.repository';
import type { SubledgerSide } from '../settings';
import { amountProblem, minorUnits } from './input';

/**
 * The mechanism (OB-064; ROADMAP D-34, D-37, D-39).
 *
 * Everything that reduces what is outstanding goes through this function — a
 * payment, a credit note, a vendor credit — which is D-39 stated as code rather
 * than as a policy: "what is outstanding" has one definition regardless of what
 * reduced it, because there is one place that reduces it.
 *
 * It lives outside both services because both reach it. `recordPayment` applies
 * allocations in the same transaction that records the money (a payment settling
 * one invoice must be one idempotent write, `createPaymentRequestSchema` argues
 * why), and the allocate endpoints apply them later. A copy in each would be two
 * implementations of C3.
 *
 * ## No journal is posted here, and that is the point
 *
 * By the time this runs, both sides are already in the ledger: the payment's
 * journal debited the bank and credited the control account, or the credit note's
 * journal reduced revenue and the control account. An allocation says only *which*
 * document that posting relates to. A second journal here would double-count,
 * which is exactly how a subledger comes to disagree with its ledger (C2).
 *
 * ## The order of operations, and why the locks come before any insert
 *
 *   1. shape — the target types match the source's side, every amount is positive
 *   2. **every distinct target locked `FOR UPDATE`, in ascending id order**
 *   3. each target's state and outstanding amount, read under that lock
 *   4. the arithmetic, then the inserts
 *
 * Step 2 is C3 (see `selectDocumentByIdForUpdate`). Ascending id order is what
 * keeps two batches touching the same two invoices in opposite orders from
 * deadlocking: a total order over the locks a transaction takes cannot produce a
 * cycle. It is done before *any* insert so a batch either applies whole or not at
 * all — "applying two of the three and refusing the fourth for over-allocation
 * would leave the user to work out which half happened"
 * (`createAllocationsRequestSchema`).
 *
 * Step 4 subtracts in memory rather than re-reading after each insert, which is
 * exact precisely because the locks are held: nothing else can change either sum
 * for the life of the transaction, so an in-memory running total and a re-read
 * would give the same answer and one of them costs a round trip per line.
 */

/** What is being applied, resolved and locked by the caller. */
export interface AllocationSource {
  readonly side: SubledgerSide;
  /**
   * A payment, a credit note / vendor credit, or a discount journal. Decides which
   * column `insertAllocation` sets.
   *
   * `'discount'` is Cash application's addition (ROADMAP D-106): an early-pay
   * discount settles a document without a payment behind it — "a settlement whose
   * funding source is the discount account, not cash" — so `id` here is the
   * discount's own posted journal, not a `payments` row (which `recordPayment`
   * requires a bank account for) and not a real, numbered credit document (which a
   * discount is not). `bank_line_clearing_entries.entry_type = 'discount'`
   * (`modules/banking/clearing`) is the one caller of this kind today.
   */
  readonly kind: 'payment' | 'credit_document' | 'discount';
  readonly id: Buffer;
  /**
   * Whose money this is. An allocation may not cross contacts — see
   * `assertSameContact`.
   */
  readonly contactId: Buffer;
  /** Amount minus what has already been applied from it, read under its row lock. */
  readonly available: bigint;
  /** What it is called when it runs out. */
  readonly label: 'payment' | 'credit note' | 'vendor credit' | 'discount';
}

/**
 * Applies one source to one or more targets, or refuses and applies none.
 *
 * Returns the ids of the rows written, so the caller can read them back with both
 * ends named rather than assembling a response from what it believes it wrote.
 */
export async function applyAllocations(
  db: TenantDatabase,
  source: AllocationSource,
  inputs: readonly AllocationInput[],
  date: string,
  author: Buffer,
): Promise<readonly Buffer[]> {
  const requests = validateShape(inputs, source);

  const documents = await lockTargets(db, source, requests);

  let sourceRemaining = source.available;
  const targetRemaining = new Map<string, bigint>();

  for (const [key, document] of documents) {
    targetRemaining.set(
      key,
      (await documentTotal(db, source.side, document.id)) -
        (await allocatedToDocument(db, source.side, document.id)),
    );
  }

  const written: Buffer[] = [];

  for (const request of requests) {
    sourceRemaining -= request.amount;
    if (sourceRemaining < 0n) {
      throw sourceExhausted(source);
    }

    const key = request.targetId.toString('hex');
    const remaining = targetRemaining.get(key) ?? 0n;
    if (request.amount > remaining) {
      throw overAllocated(remaining, request.amount);
    }
    targetRemaining.set(key, remaining - request.amount);

    written.push(
      await insertAllocation(db, source.side, {
        targetId: request.targetId,
        paymentId: source.kind === 'payment' ? source.id : null,
        creditDocumentId: source.kind === 'credit_document' ? source.id : null,
        discountJournalId: source.kind === 'discount' ? source.id : null,
        amountMinor: request.amount,
        // D-40: the allocation carries its own date so aging as at a past date is
        // reproducible. Using today's allocations against a past date's documents
        // gives a report that cannot be reproduced tomorrow.
        allocatedOn: date,
        createdByUserId: author,
      }),
    );
  }

  return written;
}

interface AllocationRequest {
  readonly targetId: Buffer;
  readonly amount: bigint;
}

/**
 * Everything decidable from the request and the source's direction, reported in
 * one pass so a caller fixes a batch in one attempt rather than one line per try.
 *
 * A target type that does not match the source's side is a `ValidationError` and
 * not a refusal about state: a received payment settles invoices and a made one
 * settles bills (`paymentDirectionSchema`), so the mismatch is visible in the
 * request itself and naming the field is the useful answer. What the *row* turns
 * out to be — a credit note, a draft, another contact's — is state, and refused
 * as a precondition below.
 */
function validateShape(
  inputs: readonly AllocationInput[],
  source: AllocationSource,
): readonly AllocationRequest[] {
  const expected = source.side === 'receivable' ? 'invoice' : 'bill';
  const issues: ValidationIssue[] = [];
  const requests: AllocationRequest[] = [];

  inputs.forEach((input, index) => {
    const path = `allocations.${String(index)}`;

    if (input.targetType !== expected) {
      issues.push({
        path: `${path}.targetType`,
        message:
          `This ${source.label} settles ${expected === 'invoice' ? 'invoices' : 'bills'}, so it ` +
          `cannot be applied to a ${input.targetType}. Money received clears the receivables ` +
          'side and money paid clears the payables side; the two never cross.',
      });
    }

    const targetId = documentIdBytes(input.targetId);
    if (targetId === undefined) {
      // A malformed id is a validation failure naming the field, while an unknown
      // or another org's is the single 404 the lock below produces — the convention
      // `validateLines` states for the two reference fields on a journal line.
      issues.push({ path: `${path}.targetId`, message: 'Not a valid document id.' });
    }

    const problem = amountProblem(input.amount);
    if (problem !== undefined) {
      issues.push({ path: `${path}.amount`, message: problem });
    }

    if (targetId !== undefined && input.targetType === expected && problem === undefined) {
      requests.push({ targetId, amount: minorUnits(input.amount) });
    }
  });

  if (issues.length > 0) {
    throw new ValidationError('These allocations are not well formed.', issues);
  }

  return requests;
}

/**
 * Every distinct target, locked and checked, keyed by id.
 *
 * Ascending id order, which is the deadlock argument in the file header. Distinct,
 * because a batch naming one invoice twice is legitimate — two lines of a
 * remittance advice — and locking it twice in one transaction is a no-op while
 * *checking* it twice would let the second line see the first line's room.
 */
async function lockTargets(
  db: TenantDatabase,
  source: AllocationSource,
  requests: readonly AllocationRequest[],
): Promise<ReadonlyMap<string, DocumentRow>> {
  const ids = [...new Map(requests.map((r) => [r.targetId.toString('hex'), r.targetId])).values()];
  ids.sort((left, right) => Buffer.compare(left, right));

  const documents = new Map<string, DocumentRow>();

  for (const id of ids) {
    const document = assertFound(
      await selectDocumentByIdForUpdate(db, source.side, id),
      DOCUMENT_RESOURCE,
    );

    assertAllocatable(document, source);
    documents.set(id.toString('hex'), document);
  }

  return documents;
}

/**
 * What a target has to be before anything may be applied to it.
 *
 * All three refusals are about the row rather than the request, which is what
 * makes them preconditions: the caller sent a well-formed allocation and the
 * document's state forbids it.
 */
function assertAllocatable(document: DocumentRow, source: AllocationSource): void {
  const payable = source.side === 'receivable' ? 'invoice' : 'bill';

  if (document.document_type !== payable) {
    throw new PreconditionFailedError(
      'allocation_target_mismatch',
      `Only ${payable === 'invoice' ? 'an invoice' : 'a bill'} carries an amount outstanding, ` +
        `and this document is a ${document.document_type.replace('_', ' ')}. A credit reduces ` +
        'what is owed; it is not something that can be settled.',
    );
  }

  if (document.journal_id === null) {
    // A draft owes nothing: nothing has been told to the ledger, so there is no
    // control-account balance for an allocation to explain (D-38).
    throw new PreconditionFailedError(
      'document_not_approved',
      'This document is still a draft, so nothing is outstanding on it yet. Approve it first — ' +
        'approval is what posts the journal an allocation refers to.',
    );
  }

  if (document.void_journal_id !== null) {
    throw new PreconditionFailedError(
      'document_void',
      'This document has been voided: its journal is reversed and nothing is outstanding on it. ' +
        'A voided document stays visible with its number, and it cannot be settled.',
    );
  }

  assertSameContact(document, source);
}

/**
 * A contact's money settles that contact's documents, and nobody else's.
 *
 * Not a schema constraint — MySQL cannot compare a column against another table's
 * row — and not obviously required by any decision, so the reasoning is recorded
 * here. D-37 makes an unapplied payment "a credit balance **on a contact**", and
 * C4 is that the credit is *the contact's*. If one customer's payment could settle
 * another's invoice, that credit balance would be a number nobody could act on:
 * the statement sent to a customer would show an invoice paid by money the
 * business never received from them, and the two contacts' aging rows would each
 * be individually wrong while the total stayed right.
 *
 * The case it refuses that a business really has — a parent company paying a
 * subsidiary's invoices — is a real one, and the honest answer to it is a contact
 * relationship, which M3 does not have. Refusing is recoverable; a silently
 * cross-applied receipt is a reconciliation nobody can close.
 */
function assertSameContact(document: DocumentRow, source: AllocationSource): void {
  if (document.contact_id.equals(source.contactId)) return;

  throw new PreconditionFailedError(
    'allocation_contact_mismatch',
    `This ${source.label} belongs to a different contact from the document it is being applied ` +
      'to. An unapplied amount is a credit balance on the contact it came from (D-37), so it ' +
      'can only settle that contact’s documents.',
  );
}

/**
 * C3, in one place: allocations against one document may not exceed it.
 *
 * The amounts are named because they are the caller's own — every uniqueness and
 * visibility boundary in this system is `(org_id, …)`, so a figure from a document
 * this caller just read back discloses nothing. Without them the message would be
 * "too much" with no way to work out by how much.
 */
function overAllocated(outstanding: bigint, requested: bigint): PreconditionFailedError {
  return new PreconditionFailedError(
    'document_over_allocated',
    `This document has ${outstanding.toString()} minor units outstanding and the allocation is ` +
      `for ${requested.toString()}. Allocations against one document may not exceed it. ` +
      'Over-paying is fine and lands as credit on the contact; over-allocating is not.',
  );
}

/**
 * The other half of D-37's asymmetry, and it is not the same rule.
 *
 * Over-*paying* is allowed — a payment larger than everything it settles simply
 * leaves credit. What is refused here is applying more of a payment than the
 * payment was for, which would create money: a £100 receipt settling £300 of
 * invoices would clear a control-account balance the ledger never received.
 */
function sourceExhausted(source: AllocationSource): PreconditionFailedError {
  return new PreconditionFailedError(
    'source_over_allocated',
    `This ${source.label} has ${source.available.toString()} minor units left to apply, and ` +
      'these allocations come to more than that. Recording more money, or a further credit, is ' +
      'what makes more available — an allocation cannot apply what the source does not hold.',
  );
}
