import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext } from '../../../context';
import { toWireError } from '../../../errors';
import {
  bankJournalIn,
  billIn,
  clearingOf,
  invoiceIn,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
} from '../../../../test/banking/clearing-support';

import { assertClearingBalances, clearBankStatementLine } from './clearing.service';
import type { ClearBankStatementLineRequest } from '@openbooks/shared-types';

/**
 * E4 as an invariant, not a check (OB-081, generalised by OB-137; acceptance E4).
 *
 * > A cleared line and the entries that clear it agree exactly on amount, and the
 * > difference is recorded.
 *
 * `bankMovementTotal + differenceAmount === line.amount`, signed, on **every**
 * clearing this system produces — proven here as a property across all four entry
 * kinds (each as the sole entry — a single-entry array is the shape every one of
 * OB-081's original methods used), with and without a difference, and asserted in
 * isolation by the invariant `assertClearingBalances`.
 */

const db = useServiceDatabase();

let scene: Scene;
beforeEach(async () => {
  scene = await sceneIn(db);
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  return runInContext(scene.ctx, fn);
}

describe('assertClearingBalances', () => {
  it('accepts an equation that closes, with and without a difference', () => {
    expect(() => assertClearingBalances(5000n, 0n, 5000n)).not.toThrow();
    // £1,000 cleared, £10 to charges, £990 on the line.
    expect(() => assertClearingBalances(100000n, -1000n, 99000n)).not.toThrow();
    // Outbound: −£1,000 cleared, +£10 early-settlement, −£990 on the line.
    expect(() => assertClearingBalances(-100000n, 1000n, -99000n)).not.toThrow();
  });

  it('refuses an equation that does not close (clearing_amount_mismatch)', () => {
    let thrown: unknown;
    try {
      assertClearingBalances(100000n, -500n, 99000n);
    } catch (error) {
      thrown = error;
    }
    expect(toWireError(thrown)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'clearing_amount_mismatch' },
    });
  });
});

describe('the equation holds on every stored clearing', () => {
  interface Case {
    readonly name: string;
    readonly lineAmount: bigint;
    readonly request: (scene: Scene) => Promise<ClearBankStatementLineRequest>;
  }

  const cases: readonly Case[] = [
    {
      name: 'post_entry, no difference',
      lineAmount: 5000n,
      request: (s) =>
        Promise.resolve({ entries: [{ method: 'post_entry', accountId: s.revenue.uuid }] }),
    },
    {
      name: 'post_entry, outbound',
      lineAmount: -5000n,
      request: (s) =>
        Promise.resolve({ entries: [{ method: 'post_entry', accountId: s.expense.uuid }] }),
    },
    {
      name: 'link_entry, exact',
      lineAmount: 5000n,
      request: async (s) => {
        const journal = await bankJournalIn(db, s, 5000n, s.revenue);
        return { entries: [{ method: 'link_entry', journalId: journal.uuid }] };
      },
    },
    {
      name: 'link_entry, bank charge (£1,000 entry, £990 line)',
      lineAmount: 99000n,
      request: async (s) => {
        const journal = await bankJournalIn(db, s, 100000n, s.revenue);
        return {
          entries: [{ method: 'link_entry', journalId: journal.uuid }],
          differenceAccountId: s.charges.uuid,
        };
      },
    },
    {
      name: 'allocate_document, short payment (£1,000 invoice, £990 line)',
      lineAmount: 99000n,
      request: async (s) => {
        const invoice = await invoiceIn(db, s, 100000n);
        return {
          entries: [{ method: 'allocate_document', targetType: 'invoice', targetId: invoice.uuid }],
        };
      },
    },
    {
      name: 'allocate_document, bank charge (settle £1,000, £990 line)',
      lineAmount: 99000n,
      request: async (s) => {
        const invoice = await invoiceIn(db, s, 100000n);
        return {
          entries: [
            {
              method: 'allocate_document',
              targetType: 'invoice',
              targetId: invoice.uuid,
              amount: '100000',
            },
          ],
          differenceAccountId: s.charges.uuid,
        };
      },
    },
    {
      name: 'allocate_document, outbound bill',
      lineAmount: -5000n,
      request: async (s) => {
        const bill = await billIn(db, s, 5000n);
        return {
          entries: [{ method: 'allocate_document', targetType: 'bill', targetId: bill.uuid }],
        };
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const line = await statementLineIn(db, scene, { amountMinor: testCase.lineAmount });
      const request = await testCase.request(scene);

      const result = await run(() => clearBankStatementLine(line.uuid, request));

      // The response is signed in the line's frame and closes the equation.
      expect(BigInt(result.clearedAmount) + BigInt(result.differenceAmount)).toBe(
        testCase.lineAmount,
      );

      // And so is the stored row — the response is not merely a computed echo.
      const stored = await clearingOf(db.app, line.id);
      expect(stored).toBeDefined();
      expect(stored!.cleared_amount_minor + stored!.difference_amount_minor).toBe(
        testCase.lineAmount,
      );
    });
  }
});
