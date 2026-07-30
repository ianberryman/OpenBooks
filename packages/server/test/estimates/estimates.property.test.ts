import type { CreateEstimateRequest } from '@openbooks/shared-types';
import { quantityFromUnits, quantityToString } from '@openbooks/shared-types/tax';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  approveEstimate,
  convertEstimateToInvoice,
  createEstimate,
  getEstimate,
} from '../../src/modules/estimates';
import { approveInvoice } from '../../src/modules/invoices';
import type { AccountFixture, TestDatabase } from '../db';
import { bufferToUuid, newUuidBuffer } from '../db';
import { sceneIn, useServiceDatabase, withContext } from './support';

/**
 * Property suite for initiative M's procure-to-pay pre-documents (OB-178), AR
 * side — the mirror of `test/purchase-orders/purchase-orders.property.test.ts`.
 * See that file's header for the full case each of the three properties makes;
 * restated once here rather than pointed at, so this suite still says what it
 * proves if the PO one is ever edited.
 *
 * 1. **Convert carries every line, exactly** (M1, M2): every generated line's
 *    `description`, `quantity`, `unitAmount`, `accountId` and `taxRateId` survive
 *    into the draft invoice unchanged, in the same order.
 * 2. **Convert is once-only** (M3, D-M4): a second `convertEstimateToInvoice`
 *    always throws `estimate_already_converted` and inserts no second
 *    `ar_documents` row; converting before approval always throws
 *    `estimate_not_approved`.
 * 3. **Numbering is gapless and distinct, per series** (M6): approving N
 *    randomly-created estimates (some deliberately empty, which fail before a
 *    number would otherwise be usable) allocates exactly `1..k`, and the
 *    estimate series is independent of the invoice series it feeds.
 */
const db = useServiceDatabase();

const ACCOUNT_POOL_SIZE = 3;
const TAX_RATE_POOL_SIZE = 2;

// ---------------------------------------------------------------------------
// Arbitraries — identical shape to the PO suite's own, restated AR-side
// ---------------------------------------------------------------------------

const DESCRIPTION_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_'.split(
  '',
);

const descriptionArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...DESCRIPTION_CHARS), { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join('').trim())
  .filter((value) => value.length > 0);

const quantityArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, fraction]) =>
    quantityToString(quantityFromUnits(BigInt(whole) * 10_000n + BigInt(fraction))),
  );

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

async function invoiceCount(testDb: TestDatabase, orgId: Buffer): Promise<number> {
  const rows = await testDb.app
    .selectFrom('ar_documents')
    .select('id')
    .where('org_id', '=', orgId)
    .where('document_type', '=', 'invoice')
    .execute();
  return rows.length;
}

async function taxRateIn(
  testDb: TestDatabase,
  orgId: Buffer,
  name: string,
  ratePpm: number,
  taxAccountId: Buffer,
  appliesTo: 'sales' | 'both',
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
      db.factories.account({ orgId, type: 'revenue', normalBalance: 'credit' }),
    ),
  );
  const taxAccount = await db.factories.account({
    orgId,
    type: 'liability',
    normalBalance: 'credit',
  });
  const taxRateIds = await Promise.all([
    taxRateIn(db, orgId, 'Rate A', 100_000, taxAccount.id, 'sales'),
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

describe('converting an estimate (OB-178 property)', () => {
  it('carries every line into the draft invoice unchanged, and converts at most once', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // A fresh org per generated case, `purchase-orders.property.test.ts`'s
        // own reason: estimates and their chart are org-scoped, so this keeps
        // every run — including a shrinking replay — independent of the last.
        const scene = await sceneIn(db);
        const pool = await poolIn(scene.orgId);
        const requestLines = requestLinesOf(scenario, pool);

        const request: CreateEstimateRequest = {
          contactId: scene.customerUuid,
          issueDate: scene.date,
          taxMode: scenario.taxMode,
          lines: [...requestLines],
        };

        const estimate = await withContext(scene.ctx, () => createEstimate(request, scene.ctx));

        // Convert before approve always refuses (D-M6).
        const early = await wireErrorOf(
          withContext(scene.ctx, () => convertEstimateToInvoice(estimate.id, scene.ctx)),
        );
        expect(early).toMatchObject({
          code: 'precondition_failed',
          details: { precondition: 'estimate_not_approved' },
        });

        await withContext(scene.ctx, () => approveEstimate(estimate.id, scene.ctx));

        const before = await invoiceCount(db, scene.orgId);
        const invoice = await withContext(scene.ctx, () =>
          convertEstimateToInvoice(estimate.id, scene.ctx),
        );
        expect(await invoiceCount(db, scene.orgId)).toBe(before + 1);

        // Property 1: every line, in order, with every priced-line field intact.
        expect(invoice.lines).toHaveLength(requestLines.length);
        for (const [index, expected] of requestLines.entries()) {
          const actual = invoice.lines[index];
          if (actual === undefined) throw new Error(`Invoice is missing line ${String(index)}.`);
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

        // Property 2: a second convert always refuses and creates no second invoice.
        const again = await wireErrorOf(
          withContext(scene.ctx, () => convertEstimateToInvoice(estimate.id, scene.ctx)),
        );
        expect(again).toMatchObject({
          code: 'precondition_failed',
          details: { precondition: 'estimate_already_converted' },
        });
        expect(await invoiceCount(db, scene.orgId)).toBe(before + 1);
      }),
      { numRuns: 25 },
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 3: numbering is gapless, distinct, and independent of the invoice series
// ---------------------------------------------------------------------------

interface NumberingStep {
  /** An approvable estimate has at least one line; an empty one fails to approve. */
  readonly hasLines: boolean;
}

const numberingCaseArb: fc.Arbitrary<readonly NumberingStep[]> = fc.array(
  fc.record({ hasLines: fc.boolean() }),
  { minLength: 3, maxLength: 10 },
);

describe('approving estimates (OB-178 property, M6)', () => {
  it('allocates 1..k for the k that succeed, and a failed approve (no lines) consumes no number', async () => {
    let sawFailure = false;

    await fc.assert(
      fc.asyncProperty(numberingCaseArb, async (steps) => {
        const scene = await sceneIn(db);
        const numbers: string[] = [];

        for (const step of steps) {
          const request: CreateEstimateRequest = {
            contactId: scene.customerUuid,
            issueDate: scene.date,
            taxMode: 'exclusive',
            lines: step.hasLines
              ? [
                  {
                    description: 'Consulting',
                    quantity: '1',
                    unitAmount: '100',
                    accountId: scene.incomeUuid,
                  },
                ]
              : [],
          };
          const estimate = await withContext(scene.ctx, () => createEstimate(request, scene.ctx));

          if (step.hasLines) {
            const approved = await withContext(scene.ctx, () =>
              approveEstimate(estimate.id, scene.ctx),
            );
            if (approved.documentNumber === null) {
              throw new Error('An approved estimate has no documentNumber.');
            }
            numbers.push(approved.documentNumber);
          } else {
            sawFailure = true;
            const error = await wireErrorOf(
              withContext(scene.ctx, () => approveEstimate(estimate.id, scene.ctx)),
            );
            expect(error).toMatchObject({ code: 'validation_failed' });

            // Claim-then-rollback (D-14, D-36): `claimEstimateNumber` runs inside
            // the same transaction as the refused approval and rolls back with
            // it, so this estimate stays a numberless draft rather than burning
            // a number in a series that has to stay gapless.
            const reread = await withContext(scene.ctx, () => getEstimate(estimate.id, scene.ctx));
            expect(reread.documentNumber).toBeNull();
            expect(reread.status).toBe('draft');
          }
        }

        expect(numbers).toEqual(
          Array.from({ length: numbers.length }, (_, index) => String(index + 1)),
        );
      }),
      { numRuns: 20 },
    );

    expect(sawFailure).toBe(true);
  }, 180_000);

  it('is a series independent of the invoice series it feeds — the two may coincide', async () => {
    const scene = await sceneIn(db);
    const estimate = await withContext(scene.ctx, () =>
      createEstimate(
        {
          contactId: scene.customerUuid,
          issueDate: scene.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '150000',
              accountId: scene.incomeUuid,
            },
          ],
        },
        scene.ctx,
      ),
    );

    const approvedEstimate = await withContext(scene.ctx, () =>
      approveEstimate(estimate.id, scene.ctx),
    );
    // First estimate this org has ever approved.
    expect(approvedEstimate.documentNumber).toBe('1');

    const invoice = await withContext(scene.ctx, () =>
      convertEstimateToInvoice(estimate.id, scene.ctx),
    );
    const approvedInvoice = await withContext(scene.ctx, () =>
      approveInvoice(invoice.id, scene.ctx),
    );

    // The first invoice this org has ever approved lands on the same label, "1" —
    // unremarkable only because `document_sequences` keys on `(org_id,
    // document_type)` (0005_subledger): an estimate and an invoice are different
    // rows in different tables, so nothing about one's counter constrains the
    // other's, and an estimate numbered 1 coexisting with an invoice numbered 1
    // is exactly what "independent series" means, not a collision.
    expect(approvedInvoice.documentNumber).toBe('1');
  });
});
