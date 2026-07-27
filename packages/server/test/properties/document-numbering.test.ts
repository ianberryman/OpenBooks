import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  voidBill,
} from '../../src/modules/bills';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  voidInvoice,
} from '../../src/modules/invoices';

import type { DocumentKind } from './subledger-arbitraries';
import {
  createSubledgerScene,
  dateAfterEpoch,
  useSubledgerDatabase,
  withContext,
  type SubledgerScene,
} from './subledger-support';

/**
 * **Document numbers are gapless, per org and per type** (OB-071; M3 C9, D-36).
 *
 * D-36 gives the reason the property is worth this much machinery: the number is
 * what a customer, an auditor and a bank statement cite, and *a gap is
 * indistinguishable from a deleted document* — which is the one ambiguity an
 * append-only system must never have. It also gives the mechanism, and the mechanism
 * is the thing under test: a counter row taken `FOR UPDATE` inside the transaction,
 * **not** `AUTO_INCREMENT`, which leaves gaps on rollback.
 *
 * So the sequence generated below is deliberately punctuated with approvals that
 * fail *after the number has been taken*. `approveArDocument` allocates the number
 * and then calls `postJournal`; a document dated outside every open fiscal period
 * therefore reaches `assertPostable` with a number already drawn, and the whole
 * transaction rolls back. That is not a contrived injection — it is the ordinary
 * refusal a bookkeeper meets when they enter last year's bill (`period_missing`),
 * and under `AUTO_INCREMENT` every one of them would burn a number permanently.
 *
 * Three claims, and each has its own way of being wrong:
 *
 *  1. **Per type.** Invoices, credit notes, bills and vendor credits count
 *     separately, because they are separate series to the people who read them
 *     (D-36). A single shared counter satisfies "no gaps" globally and gives an org
 *     an invoice numbered 7 with nothing numbered 1 to 6.
 *  2. **Per org.** Two orgs approving alternately each start at 1 and each stay
 *     contiguous. A counter keyed on the type alone ties perfectly within one org
 *     and interleaves two.
 *  3. **Through a void.** A voided document keeps its number and stays visible
 *     (D-38, C7). A void that released the number would either duplicate it or leave
 *     the hole D-36 exists to rule out.
 *
 * The org is built the same way every other OB-071 property builds one, and the
 * numbers are read back from the documents themselves rather than from
 * `document_sequences`: the counter is the implementation, and the number a document
 * carries is the claim.
 */
const harness = useSubledgerDatabase();

const RUNS = 10;
const SHRINKING_BUDGET_MS = 180_000;

const KINDS: readonly DocumentKind[] = ['invoice', 'credit_note', 'bill', 'vendor_credit'];

/** No fiscal period covers it, so approval fails after the number has been taken. */
const UNPOSTABLE_DATE = '2019-06-01';

interface NumberingStep {
  readonly kind: DocumentKind;
  /** Approval refused by the period lock, with the number already drawn. */
  readonly fails: boolean;
  /** Approved, then voided. The number must survive (D-38). */
  readonly voided: boolean;
}

interface NumberingCase {
  readonly startMonth: number;
  readonly steps: readonly NumberingStep[];
}

const numberingCaseArb: fc.Arbitrary<NumberingCase> = fc.record({
  startMonth: fc.integer({ min: 2, max: 12 }),
  steps: fc.array(
    fc.record({
      kind: fc.constantFrom(...KINDS),
      fails: fc.oneof(
        { arbitrary: fc.constant(false), weight: 2 },
        { arbitrary: fc.constant(true), weight: 1 },
      ),
      voided: fc.oneof(
        { arbitrary: fc.constant(false), weight: 3 },
        { arbitrary: fc.constant(true), weight: 1 },
      ),
    }),
    { minLength: 6, maxLength: 12 },
  ),
});

describe('document numbers are gapless per org and per type (OB-071, C9, D-36)', () => {
  it(
    'issues 1..n per type, in two orgs at once, across rolled-back approvals and voids',
    async () => {
      let rolledBack = 0;
      let voided = 0;

      await fc.assert(
        fc.asyncProperty(numberingCaseArb, async (input) => {
          // Two orgs, and the steps are run alternately between them rather than one
          // org after the other. Sequentially, a counter keyed on `document_type`
          // alone would still hand each org 1, 2, 3 — the interleaving is what makes
          // the org half of "per org per type" observable.
          const orgs = [
            await createSubledgerScene(harness, { startMonth: input.startMonth, contacts: 1 }),
            await createSubledgerScene(harness, { startMonth: input.startMonth, contacts: 1 }),
          ];

          const issued = orgs.map(() => new Map<DocumentKind, string[]>());

          for (const [index, step] of input.steps.entries()) {
            for (const [orgIndex, scene] of orgs.entries()) {
              const id = await draft(
                scene,
                step.kind,
                step.fails ? UNPOSTABLE_DATE : dateAfterEpoch(index),
              );

              if (step.fails) {
                const error = await approve(scene, step.kind, id).then(
                  () => undefined,
                  (thrown: unknown) => thrown,
                );
                if (error === undefined) {
                  throw new Error(
                    `Approving a ${step.kind} dated ${UNPOSTABLE_DATE} succeeded. No fiscal ` +
                      'period covers it, so the refusal this step depends on has stopped ' +
                      'happening and the property below is no longer testing a rollback.',
                  );
                }
                // Named rather than merely "it threw": a refusal from
                // `assertApprovable` would happen *before* the number is drawn, and
                // the rollback this step exists to exercise would never occur.
                expect(toWireError(error)).toMatchObject({
                  code: 'precondition_failed',
                  status: 412,
                  details: { precondition: 'period_missing' },
                });
                if (orgIndex === 0) rolledBack += 1;
                continue;
              }

              const approved = await approve(scene, step.kind, id);
              const numbers = issued[orgIndex]?.get(step.kind) ?? [];
              numbers.push(approved.documentNumber ?? '');
              issued[orgIndex]?.set(step.kind, numbers);

              if (step.voided && (step.kind === 'invoice' || step.kind === 'bill')) {
                const after = await voidOf(scene, step.kind, id, dateAfterEpoch(index));
                // D-38: the document remains, with its number and its original
                // journal. A voided document that gave its number back would leave a
                // hole, and one that vanished would make the sequence a lie.
                expect(after.documentNumber).toBe(approved.documentNumber);
                if (orgIndex === 0) voided += 1;
              }
            }
          }

          for (const perOrg of issued) {
            for (const [kind, numbers] of perOrg) {
              // The whole claim in one line: the numbers this type issued, in the
              // order they were issued, are 1..n with nothing skipped and nothing
              // repeated. Compared as a list rather than as a set, so a counter that
              // handed out 1, 3, 2 fails as well as one that handed out 1, 2, 4.
              expect(numbers, kind).toEqual(
                Array.from({ length: numbers.length }, (_, index) => String(index + 1)),
              );
            }
          }
        }),
        { numRuns: RUNS },
      );

      // Without a rolled-back approval the whole point of D-36's counter is
      // untested: `AUTO_INCREMENT` is gapless too, right up until something fails.
      expect(rolledBack).toBeGreaterThan(0);
      expect(voided).toBeGreaterThan(0);
    },
    SHRINKING_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function draft(
  scene: SubledgerScene,
  kind: DocumentKind,
  issueDate: string,
): Promise<string> {
  const { ctx } = scene;
  const contactId = scene.contacts[0];
  if (contactId === undefined) throw new Error('The numbering scene has no contact.');

  const receivable = kind === 'invoice' || kind === 'credit_note';
  const body = {
    contactId,
    issueDate,
    taxMode: 'exclusive' as const,
    lines: [
      {
        description: 'Work',
        quantity: '1',
        unitAmount: '10000',
        accountId: receivable ? scene.accounts.income : scene.accounts.expense,
      },
    ],
  };

  const created = await withContext(ctx, () => {
    switch (kind) {
      case 'invoice':
        return createInvoice({ ...body, dueDate: issueDate }, ctx);
      case 'bill':
        return createBill({ ...body, dueDate: issueDate }, ctx);
      case 'credit_note':
        return createCreditNote(body, ctx);
      case 'vendor_credit':
        return createVendorCredit(body, ctx);
    }
  });

  return created.id;
}

interface Numbered {
  readonly documentNumber: string | null;
}

function approve(scene: SubledgerScene, kind: DocumentKind, id: string): Promise<Numbered> {
  return withContext(scene.ctx, () => approveIn(kind, id, scene.ctx));
}

function approveIn(kind: DocumentKind, id: string, ctx: RequestContext): Promise<Numbered> {
  switch (kind) {
    case 'invoice':
      return approveInvoice(id, ctx);
    case 'credit_note':
      return approveCreditNote(id, ctx);
    case 'bill':
      return approveBill(id, ctx);
    case 'vendor_credit':
      return approveVendorCredit(id, ctx);
  }
}

function voidOf(
  scene: SubledgerScene,
  kind: 'invoice' | 'bill',
  id: string,
  date: string,
): Promise<Numbered> {
  return withContext(scene.ctx, () =>
    kind === 'invoice' ? voidInvoice(id, { date }, scene.ctx) : voidBill(id, { date }, scene.ctx),
  );
}
