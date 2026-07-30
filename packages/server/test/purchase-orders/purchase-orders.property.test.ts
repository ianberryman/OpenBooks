import type { CreatePurchaseOrderRequest } from '@openbooks/shared-types';
import { quantityFromUnits, quantityToString } from '@openbooks/shared-types/tax';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import { approveBill } from '../../src/modules/bills';
import {
  approvePurchaseOrder,
  convertPurchaseOrderToBill,
  createPurchaseOrder,
  getPurchaseOrder,
} from '../../src/modules/purchase-orders';
import type { AccountFixture, TestDatabase } from '../db';
import { bufferToUuid, newUuidBuffer } from '../db';
import { sceneIn, useServiceDatabase, withContext } from './support';

/**
 * Property suite for initiative M's procure-to-pay pre-documents (OB-178).
 *
 * Three invariants, each proven against **random** line sets rather than a fixed
 * example, following the project's mutation-testing culture: an example suite that
 * always posts one line of £1,500 cannot catch a convert that swaps two lines'
 * accounts, drops the third of four, or reorders them — it would still see "one
 * line, right total" and pass. `purchase-orders.service.test.ts` already covers
 * the fixed-example lifecycle; this file covers the shape space around it.
 *
 * 1. **Convert carries every line, exactly** (M1, M2). Every generated line's
 *    `description`, `quantity`, `unitAmount`, `accountId` and `taxRateId` survive
 *    into the draft bill unchanged, in the same order — the round trip
 *    `resolvePurchaseOrderLines` → `linesAsInput` → `resolveLines` (again, inside
 *    `createBill`) is required to be lossless for this to hold.
 * 2. **Convert is once-only** (M3, D-M4). A second `convertPurchaseOrderToBill`
 *    always throws `purchase_order_already_converted` and inserts no second
 *    `ap_documents` row; converting before approval always throws
 *    `purchase_order_not_approved`.
 * 3. **Numbering is gapless and distinct, per series** (M6). Approving N
 *    randomly-created purchase orders (some deliberately empty, which fail
 *    `assertHasValue` *after* the number would have been claimed) allocates
 *    exactly `1..k` for the `k` that succeed, with a failed approve consuming
 *    nothing — the same `FOR UPDATE`-counter-then-rollback mechanism
 *    `test/properties/document-numbering.test.ts` proves for AP/AR documents,
 *    restated for a table that posts no journal at all.
 */
const db = useServiceDatabase();

const ACCOUNT_POOL_SIZE = 3;
const TAX_RATE_POOL_SIZE = 2;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Safe, non-empty after `.trim()` — `lineDescriptionSchema` trims before checking length. */
const DESCRIPTION_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_'.split(
  '',
);

const descriptionArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...DESCRIPTION_CHARS), { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join('').trim())
  .filter((value) => value.length > 0);

/**
 * A canonical quantity string, already in the form `quantityToString` would
 * produce — generating the wire form directly through the same primitive the
 * service uses means a round-trip mismatch can only be a real bug, never an
 * artifact of two different ways of spelling the same quantity. Bounded to at
 * least one whole unit so `quantity × unitAmount` never rounds to zero and trips
 * `assertHasValue` for reasons unrelated to what this property is testing.
 */
const quantityArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, fraction]) =>
    quantityToString(quantityFromUnits(BigInt(whole) * 10_000n + BigInt(fraction))),
  );

/** Cents, canonical (`String(n)` has no leading zero for a positive integer). */
const unitAmountArb: fc.Arbitrary<string> = fc
  .integer({ min: 100, max: 5_000_000 })
  .map((cents) => String(cents));

interface LineSpec {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly accountIndex: number;
  readonly taxRateIndex: number | null;
}

const lineSpecArb: fc.Arbitrary<LineSpec> = fc.record({
  description: descriptionArb,
  quantity: quantityArb,
  unitAmount: unitAmountArb,
  accountIndex: fc.integer({ min: 0, max: ACCOUNT_POOL_SIZE - 1 }),
  taxRateIndex: fc.option(fc.integer({ min: 0, max: TAX_RATE_POOL_SIZE - 1 }), { nil: null }),
});

interface Scenario {
  readonly taxMode: 'exclusive' | 'inclusive';
  readonly lines: readonly LineSpec[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  taxMode: fc.constantFrom('exclusive' as const, 'inclusive' as const),
  lines: fc.array(lineSpecArb, { minLength: 1, maxLength: 5 }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

async function billCount(testDb: TestDatabase, orgId: Buffer): Promise<number> {
  const rows = await testDb.app
    .selectFrom('ap_documents')
    .select('id')
    .where('org_id', '=', orgId)
    .where('document_type', '=', 'bill')
    .execute();
  return rows.length;
}

async function taxRateIn(
  testDb: TestDatabase,
  orgId: Buffer,
  name: string,
  ratePpm: number,
  taxAccountId: Buffer,
  appliesTo: 'purchases' | 'both',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await testDb.app
    .insertInto('tax_rates')
    .values({
      id,
      org_id: orgId,
      name,
      rate_ppm: ratePpm,
      tax_account_id: taxAccountId,
      applies_to: appliesTo,
      is_active: 1,
    })
    .execute();
  return id;
}

interface Pool {
  readonly accounts: readonly AccountFixture[];
  readonly taxRateIds: readonly Buffer[];
}

/** A fresh chart of accounts and tax rates to choose lines from, in a fresh org. */
async function poolIn(orgId: Buffer): Promise<Pool> {
  const accounts = await Promise.all(
    Array.from({ length: ACCOUNT_POOL_SIZE }, () =>
      db.factories.account({ orgId, type: 'expense', normalBalance: 'debit' }),
    ),
  );
  const taxAccount = await db.factories.account({
    orgId,
    type: 'liability',
    normalBalance: 'credit',
  });
  const taxRateIds = await Promise.all([
    taxRateIn(db, orgId, 'Rate A', 100_000, taxAccount.id, 'purchases'),
    taxRateIn(db, orgId, 'Rate B', 200_000, taxAccount.id, 'both'),
  ]);
  return { accounts, taxRateIds };
}

function requestLinesOf(
  scenario: Scenario,
  pool: Pool,
): readonly {
  description: string;
  quantity: string;
  unitAmount: string;
  accountId: string;
  taxRateId?: string;
}[] {
  return scenario.lines.map((line) => {
    const account = pool.accounts[line.accountIndex];
    if (account === undefined) throw new Error('Generated accountIndex out of range.');
    const taxRateId =
      line.taxRateIndex === null
        ? undefined
        : bufferToUuid(pool.taxRateIds[line.taxRateIndex] ?? newUuidBuffer());
    return {
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      accountId: account.uuid,
      ...(taxRateId === undefined ? {} : { taxRateId }),
    };
  });
}

// ---------------------------------------------------------------------------
// 1 + 2: convert carries every line, exactly once
// ---------------------------------------------------------------------------

describe('converting a purchase order (OB-178 property)', () => {
  it('carries every line into the draft bill unchanged, and converts at most once', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // A fresh org per generated case (not one shared scene): purchase orders
        // and their chart are org-scoped, and a fresh org keeps each run —
        // including whatever fast-check's shrinker replays — independent of
        // what an earlier run left behind.
        const scene = await sceneIn(db);
        const pool = await poolIn(scene.orgId);
        const requestLines = requestLinesOf(scenario, pool);

        const request: CreatePurchaseOrderRequest = {
          contactId: scene.vendorUuid,
          issueDate: scene.date,
          taxMode: scenario.taxMode,
          lines: [...requestLines],
        };

        const po = await withContext(scene.ctx, () => createPurchaseOrder(request, scene.ctx));

        // Convert before approve always refuses (D-M6).
        const early = await wireErrorOf(
          withContext(scene.ctx, () => convertPurchaseOrderToBill(po.id, scene.ctx)),
        );
        expect(early).toMatchObject({
          code: 'precondition_failed',
          details: { precondition: 'purchase_order_not_approved' },
        });

        await withContext(scene.ctx, () => approvePurchaseOrder(po.id, scene.ctx));

        const before = await billCount(db, scene.orgId);
        const bill = await withContext(scene.ctx, () =>
          convertPurchaseOrderToBill(po.id, scene.ctx),
        );
        expect(await billCount(db, scene.orgId)).toBe(before + 1);

        // Property 1: every line, in order, with every priced-line field intact.
        expect(bill.lines).toHaveLength(requestLines.length);
        for (const [index, expected] of requestLines.entries()) {
          const actual = bill.lines[index];
          if (actual === undefined) throw new Error(`Bill is missing line ${String(index)}.`);
          expect(actual.description, `line ${String(index)} description`).toBe(
            expected.description,
          );
          expect(actual.quantity, `line ${String(index)} quantity`).toBe(expected.quantity);
          expect(actual.unitAmount, `line ${String(index)} unitAmount`).toBe(expected.unitAmount);
          expect(actual.accountId, `line ${String(index)} accountId`).toBe(expected.accountId);
          expect(actual.taxRateId, `line ${String(index)} taxRateId`).toBe(
            expected.taxRateId ?? null,
          );
        }

        // Property 2: a second convert always refuses and creates no second bill.
        const again = await wireErrorOf(
          withContext(scene.ctx, () => convertPurchaseOrderToBill(po.id, scene.ctx)),
        );
        expect(again).toMatchObject({
          code: 'precondition_failed',
          details: { precondition: 'purchase_order_already_converted' },
        });
        expect(await billCount(db, scene.orgId)).toBe(before + 1);
      }),
      { numRuns: 25 },
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 3: numbering is gapless, distinct, and independent of the bill series
// ---------------------------------------------------------------------------

interface NumberingStep {
  /** An approvable PO has at least one line; an empty one fails `assertHasValue`. */
  readonly hasLines: boolean;
}

const numberingCaseArb: fc.Arbitrary<readonly NumberingStep[]> = fc.array(
  fc.record({ hasLines: fc.boolean() }),
  { minLength: 3, maxLength: 10 },
);

describe('approving purchase orders (OB-178 property, M6)', () => {
  it('allocates 1..k for the k that succeed, and a failed approve (no lines) consumes no number', async () => {
    let sawFailure = false;

    await fc.assert(
      fc.asyncProperty(numberingCaseArb, async (steps) => {
        const scene = await sceneIn(db);
        const numbers: string[] = [];

        for (const step of steps) {
          const request: CreatePurchaseOrderRequest = {
            contactId: scene.vendorUuid,
            issueDate: scene.date,
            taxMode: 'exclusive',
            lines: step.hasLines
              ? [
                  {
                    description: 'Line',
                    quantity: '1',
                    unitAmount: '100',
                    accountId: scene.expenseUuid,
                  },
                ]
              : [],
          };
          const po = await withContext(scene.ctx, () => createPurchaseOrder(request, scene.ctx));

          if (step.hasLines) {
            const approved = await withContext(scene.ctx, () =>
              approvePurchaseOrder(po.id, scene.ctx),
            );
            if (approved.documentNumber === null) {
              throw new Error('An approved purchase order has no documentNumber.');
            }
            numbers.push(approved.documentNumber);
          } else {
            sawFailure = true;
            const error = await wireErrorOf(
              withContext(scene.ctx, () => approvePurchaseOrder(po.id, scene.ctx)),
            );
            expect(error).toMatchObject({ code: 'validation_failed' });

            // The claim-then-rollback mechanism (D-14, D-36): the counter increment
            // happened inside the same transaction as the refused approval, so it
            // rolled back with it, and this purchase order stays a numberless draft.
            const reread = await withContext(scene.ctx, () => getPurchaseOrder(po.id, scene.ctx));
            expect(reread.documentNumber).toBeNull();
            expect(reread.status).toBe('draft');
          }
        }

        // The whole claim in one line: numbers issued, in issuance order, are
        // 1..k with nothing skipped and nothing repeated — compared as a list so
        // a counter that handed out 1, 3, 2 fails as well as one that handed out
        // 1, 2, 4.
        expect(numbers).toEqual(
          Array.from({ length: numbers.length }, (_, index) => String(index + 1)),
        );
      }),
      { numRuns: 20 },
    );

    // Without a generated empty-PO case the rollback half of D-36's counter is
    // untested: a plain `AUTO_INCREMENT` would satisfy "gapless" too, right up
    // until something failed after claiming a number.
    expect(sawFailure).toBe(true);
  }, 180_000);

  it('is a series independent of the bill series it feeds — the two may coincide', async () => {
    const scene = await sceneIn(db);
    const po = await withContext(scene.ctx, () =>
      createPurchaseOrder(
        {
          contactId: scene.vendorUuid,
          issueDate: scene.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '150000',
              accountId: scene.expenseUuid,
            },
          ],
        },
        scene.ctx,
      ),
    );

    const approvedPo = await withContext(scene.ctx, () => approvePurchaseOrder(po.id, scene.ctx));
    // First purchase order this org has ever approved.
    expect(approvedPo.documentNumber).toBe('1');

    const bill = await withContext(scene.ctx, () => convertPurchaseOrderToBill(po.id, scene.ctx));
    const approvedBill = await withContext(scene.ctx, () => approveBill(bill.id, scene.ctx));

    // The first bill this org has ever approved lands on the same label, "1" —
    // unremarkable only because `document_sequences` keys on `(org_id,
    // document_type)` (0005_subledger): a purchase order and a bill are different
    // rows in different tables, so nothing about one's counter constrains the
    // other's, and a PO numbered 1 coexisting with a bill numbered 1 is exactly
    // what "independent series" means, not a collision.
    expect(approvedBill.documentNumber).toBe('1');
  });
});
