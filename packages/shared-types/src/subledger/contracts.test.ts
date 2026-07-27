import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as subledger from '../subledger';
import * as tax from '../tax';

import { documentLineInputSchema, quantitySchema, taxModeSchema } from './documents';
import { createInvoiceRequestSchema, listInvoicesQuerySchema } from './invoices';
import { createPaymentRequestSchema } from './payments';

/**
 * The M3 wire contracts (OB-061).
 *
 * Two things are worth a test rather than a comment. The first is the `id` rule,
 * which is invisible until `openapi.json` drifts and A10 fails the build in a
 * ticket that did not touch schemas. The second is that the scalar refusals — a
 * decimal in a money field, a fifth digit in a quantity — are actually wired to the
 * parsers that own them, rather than to a pattern that agrees with them today.
 */

const zodTypes = (module: Record<string, unknown>): [string, z.ZodType][] =>
  Object.entries(module).filter((entry): entry is [string, z.ZodType] => {
    const [, value] = entry;
    return value instanceof z.ZodType;
  });

describe('nothing published by M3 carries an `id` yet', () => {
  /**
   * `jsonSchemaTransformObject` copies every schema carrying an `id` out of zod's
   * global registry into `components.schemas` whether or not a route references it,
   * so an `id` added before OB-067's routes publishes an unreachable component and
   * fails A10. Every M2 module hit this; asserting it is cheaper than rediscovering
   * it, and the test is what OB-067 will delete in the same diff as it adds them.
   */
  it('leaves the zod registry empty for every subledger and tax schema', () => {
    const withIds = [...zodTypes(subledger), ...zodTypes(tax)]
      .filter(([, schema]) => z.globalRegistry.get(schema)?.id !== undefined)
      .map(([name]) => name);

    expect(withIds).toEqual([]);
  });
});

describe('the scalars refuse what their parsers refuse', () => {
  it('takes money as cents and nothing else (D-13)', () => {
    const line = {
      description: 'Consulting',
      quantity: '1',
      unitAmount: '150000',
      accountId: '00000000-0000-4000-8000-000000000001',
    };

    expect(documentLineInputSchema.safeParse(line).success).toBe(true);
    expect(documentLineInputSchema.safeParse({ ...line, unitAmount: '1500.00' }).success).toBe(
      false,
    );
    expect(documentLineInputSchema.safeParse({ ...line, unitAmount: 150000 }).success).toBe(false);
  });

  it('takes a quantity to four decimals, signed', () => {
    for (const value of ['1', '0.25', '-2', '0']) {
      expect(quantitySchema.safeParse(value).success).toBe(true);
    }
    for (const value of ['1.00001', '01', '1.', '1e3', '']) {
      expect(quantitySchema.safeParse(value).success).toBe(false);
    }
  });

  it('takes a tax rate as a percentage between 0 and 100', () => {
    for (const value of ['0', '20', '8.875', '100']) {
      expect(tax.taxPercentageSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ['101', '-5', '0.00001', '20%', '.5']) {
      expect(tax.taxPercentageSchema.safeParse(value).success).toBe(false);
    }
  });

  it('makes a document declare what its unit prices mean (D-35)', () => {
    expect(taxModeSchema.safeParse('inclusive').success).toBe(true);
    expect(taxModeSchema.safeParse('exclusive').success).toBe(true);
    // No third reading, and no default: a document whose mode was unstated would
    // have two totals and no way to choose between them.
    expect(taxModeSchema.safeParse('gross').success).toBe(false);
    expect(
      createInvoiceRequestSchema.safeParse({
        contactId: '00000000-0000-4000-8000-000000000001',
        issueDate: '2026-03-31',
      }).success,
    ).toBe(false);
  });
});

describe('the request shapes', () => {
  it('refuses a field a document does not have', () => {
    const invoice = {
      contactId: '00000000-0000-4000-8000-000000000001',
      issueDate: '2026-03-31',
      taxMode: 'exclusive',
    };

    expect(createInvoiceRequestSchema.safeParse(invoice).success).toBe(true);
    // `strictObject`, so a client sending what it thinks is a balance is told,
    // rather than having it silently dropped (D-34).
    expect(
      createInvoiceRequestSchema.safeParse({ ...invoice, amountOutstanding: '100' }).success,
    ).toBe(false);
    expect(createInvoiceRequestSchema.safeParse({ ...invoice, status: 'approved' }).success).toBe(
      false,
    );
  });

  it('lets a payment be recorded without saying what it settles (D-37)', () => {
    const payment = {
      direction: 'received',
      contactId: '00000000-0000-4000-8000-000000000001',
      date: '2026-03-31',
      amount: '50000',
      accountId: '00000000-0000-4000-8000-000000000002',
    };

    expect(createPaymentRequestSchema.safeParse(payment).success).toBe(true);
    expect(
      createPaymentRequestSchema.safeParse({
        ...payment,
        allocations: [
          {
            targetType: 'invoice',
            targetId: '00000000-0000-4000-8000-000000000003',
            amount: '20000',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('refuses a list range that ends before it starts', () => {
    expect(
      listInvoicesQuerySchema.safeParse({ from: '2026-01-01', to: '2026-03-31' }).success,
    ).toBe(true);
    expect(
      listInvoicesQuerySchema.safeParse({ from: '2026-03-31', to: '2026-01-01' }).success,
    ).toBe(false);
  });
});
