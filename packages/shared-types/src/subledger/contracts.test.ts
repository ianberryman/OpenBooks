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

/**
 * `jsonSchemaTransformObject` copies every schema carrying an `id` out of zod's
 * global registry into `components.schemas` whether or not a route references it,
 * so an `id` publishes a component whether or not anything can reach it. Until
 * OB-067 that meant *no* M3 schema could carry one, and this file asserted the empty
 * set. The routes exist now, so the assertion inverts: the exact set below, and
 * nothing else.
 *
 * An exact list rather than a "has an id" spot check, because both directions of
 * drift matter and neither shows up anywhere else. An id added to a list query is
 * a component no operation references — a querystring is emitted as individual
 * `parameters` — and an id dropped from a response silently inlines a shape the
 * generated client had a name for, which is a breaking change to every consumer
 * that reads `openapi.json` and no change at all to any test of behaviour.
 */
const PUBLISHED_COMPONENT_IDS = [
  'Aging',
  'AgingAmounts',
  'AgingDocument',
  'AgingRow',
  'Allocation',
  'AllocationList',
  'AllocationRequest',
  'Bill',
  'BillPage',
  'BillSummary',
  'CreateAllocationsRequest',
  'CreateBillRequest',
  'CreateCreditNoteRequest',
  'CreateDraftFromCaptureRequest',
  'CreateInvoiceRequest',
  'CreatePaymentRequest',
  'CreateTaxRateRequest',
  'CreateVendorCreditRequest',
  'CreditNote',
  'CreditNotePage',
  'CreditNoteSummary',
  'DocumentCapture',
  'DocumentCapturePage',
  'DocumentLine',
  'DocumentLineRequest',
  'DocumentSettlement',
  'DocumentTaxSummaryRow',
  'DocumentTotals',
  'ExtractedCaptureLine',
  'Invoice',
  'InvoicePage',
  'InvoiceSummary',
  'Payment',
  'PaymentPage',
  'PaymentSummary',
  'Quantity',
  'TaxPercentage',
  'TaxRate',
  'TaxRatePage',
  'UpdateBillRequest',
  'UpdateCreditNoteRequest',
  'UpdateInvoiceRequest',
  'UpdatePaymentRequest',
  'UpdateTaxRateRequest',
  'UpdateVendorCreditRequest',
  'UploadCaptureRequest',
  'VendorCredit',
  'VendorCreditPage',
  'VendorCreditSummary',
  'VoidDocumentRequest',
];

describe('what M3 publishes as an OpenAPI component', () => {
  it('is exactly the set OB-067’s routes reference', () => {
    const ids = [...zodTypes(subledger), ...zodTypes(tax)]
      .map(([, schema]) => z.globalRegistry.get(schema)?.id)
      .filter((id): id is string => id !== undefined)
      .sort();

    expect(ids).toEqual(PUBLISHED_COMPONENT_IDS);
  });

  /**
   * The rule that outlives the ticket. `listAccountsQuerySchema` states the other
   * half of it — the shared query schema takes real booleans and the route coerces,
   * because `'false'` is truthy in every language an integrator might use — and the
   * consequence for this file is that the shape a route actually publishes is the
   * route's own, so an id here would name a component nothing references.
   */
  it('never gives a list query one', () => {
    const queries = [...zodTypes(subledger), ...zodTypes(tax)].filter(([name]) =>
      /^(list.*Query|agingQuery)Schema$/.test(name),
    );

    expect(queries.length).toBeGreaterThan(0);
    for (const [name, schema] of queries) {
      expect(z.globalRegistry.get(schema)?.id, `${name} must not be published`).toBeUndefined();
    }
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
