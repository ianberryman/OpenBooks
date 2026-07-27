import type { CreateBillRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  approveBill,
  createBill,
  discardBill,
  getBill,
  listBills,
  updateBill,
  voidBill,
} from '../../src/modules/bills';
import { bufferToUuid, newUuid, uuidToBuffer } from '../db';
import type { ApScene } from './support';
import {
  accountBalance,
  dimensionIn,
  sceneIn,
  taxRateIn,
  useServiceDatabase,
  vendorIn,
  withContext,
} from './support';

/**
 * The bill lifecycle (OB-063; ROADMAP D-34, D-36, D-38, D-39).
 *
 * Everything here runs against real MySQL through the real service, as the app
 * user (spec §11 — never SQLite, never mocks). The concurrency claims are in
 * `approve-race.test.ts`, which needs two connections; the direction of the
 * journal is in `direction.test.ts`, which is the one assertion a balanced-but-
 * inverted posting can fail.
 */
const db = useServiceDatabase();

let s: ApScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

/** A bill for 1 × £1,500.00 at 20% exclusive: net 150000, tax 30000, gross 180000. */
function simpleBill(overrides: Partial<CreateBillRequest> = {}): CreateBillRequest {
  return {
    contactId: s.vendorUuid,
    issueDate: s.date,
    dueDate: '2026-02-15',
    taxMode: 'exclusive',
    lines: [
      {
        description: 'Paper',
        quantity: '1',
        unitAmount: '150000',
        accountId: s.expenseUuid,
        taxRateId: s.taxRateUuid,
      },
    ],
    ...overrides,
  };
}

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('a draft bill', () => {
  it('is created with no number and no journal (D-36, D-38)', async () => {
    const bill = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));

    expect(bill).toMatchObject({
      documentNumber: null,
      journalId: null,
      voidJournalId: null,
      status: 'draft',
      reference: null,
    });
    // D-34: a draft has told the ledger nothing, so it owes nothing. The
    // subledger's outstanding has to equal the control account at every date, and
    // the control account has never heard of this document.
    expect(bill.settlement).toEqual({ allocated: '0', outstanding: '0' });
  });

  it('prices each line once and totals the rounded lines (D-35)', async () => {
    const bill = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));

    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({
      netAmount: '150000',
      taxAmount: '30000',
      grossAmount: '180000',
      taxRatePercentage: '20',
      quantity: '1',
      lineNumber: 1,
    });
    expect(bill.totals).toEqual({ net: '150000', tax: '30000', gross: '180000' });
  });

  it('totals to the sum of rounded lines, never the rounded sum (D-35)', async () => {
    // Three lines of 10 cents at 5%: each line's tax is 0.5 cents and rounds
    // half-up to 1, so the document's tax is 3. Rounding the sum instead gives
    // 30 × 5% = 1.5 → 2, and a vendor who adds the tax column would get 3.
    const taxRateId = await taxRateAt(50_000);
    const bill = await withContext(s.ctx, () =>
      createBill(
        simpleBill({
          lines: [1, 2, 3].map((n) => ({
            description: `Line ${String(n)}`,
            quantity: '1',
            unitAmount: '10',
            accountId: s.expenseUuid,
            taxRateId,
          })),
        }),
        s.ctx,
      ),
    );

    expect(bill.totals).toEqual({ net: '30', tax: '3', gross: '33' });
  });

  /**
   * The mirror of the AR check (OB-066a; D-35). A rate posts to one account, so an
   * org reclaiming input tax holds a separate sales rate — putting it on a bill
   * would post reclaimable input tax to the output-tax account and be found when a
   * return did not reconcile.
   */
  it('refuses a sales-only tax rate on an AP line', async () => {
    const outputTax = bufferToUuid(
      await taxRateIn(db, s.orgId, 'VAT 20% (sales)', 200_000, s.taxAccountId, true, 'sales'),
    );

    const error = await wireErrorOf(
      withContext(s.ctx, () =>
        createBill(
          simpleBill({
            lines: [
              {
                description: 'Paper',
                quantity: '1',
                unitAmount: '150000',
                accountId: s.expenseUuid,
                taxRateId: outputTax,
              },
            ],
          }),
          s.ctx,
        ),
      ),
    );

    expect(error).toMatchObject({ code: 'validation_failed' });
    expect(JSON.stringify(error)).toContain('lines.0.taxRateId');
  });

  /** A purchases-restricted rate is exactly what a bill is for. */
  it('accepts a purchases-only tax rate on an AP line', async () => {
    const inputTax = bufferToUuid(
      await taxRateIn(db, s.orgId, 'VAT 20% (input)', 200_000, s.taxAccountId, true, 'purchases'),
    );

    await expect(
      withContext(s.ctx, () =>
        createBill(
          simpleBill({
            lines: [
              {
                description: 'Paper',
                quantity: '1',
                unitAmount: '150000',
                accountId: s.expenseUuid,
                taxRateId: inputTax,
              },
            ],
          }),
          s.ctx,
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('groups its tax summary by rate, with an untaxed group (D-35)', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        simpleBill({
          lines: [
            {
              description: 'Taxed',
              quantity: '1',
              unitAmount: '150000',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
            {
              description: 'Out of scope',
              quantity: '1',
              unitAmount: '5000',
              accountId: s.expenseUuid,
            },
          ],
        }),
        s.ctx,
      ),
    );

    expect(bill.taxSummary).toEqual(
      expect.arrayContaining([
        {
          taxRateId: s.taxRateUuid,
          taxRateName: expect.any(String),
          percentage: '20',
          net: '150000',
          tax: '30000',
        },
        // Null is the untaxed group, which a return reports separately from a
        // zero-rated one.
        { taxRateId: null, taxRateName: null, percentage: null, net: '5000', tax: '0' },
      ]),
    );
  });

  it('carries the line dimension tags it was given (D-18)', async () => {
    const dimension = await dimensionIn(db, s.orgId, 'dept', ['ops']);
    const bill = await withContext(s.ctx, () =>
      createBill(
        simpleBill({
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '150000',
              accountId: s.expenseUuid,
              dimensionValueIds: [...dimension.valueUuids],
            },
          ],
        }),
        s.ctx,
      ),
    );

    expect(bill.lines[0]?.dimensionValueIds).toEqual(dimension.valueUuids);
  });

  it('is edited and re-priced, and its lines are replaced wholesale', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));

    const updated = await withContext(s.ctx, () =>
      updateBill(
        created.id,
        {
          memo: 'Q1 stationery',
          lines: [
            {
              description: 'Card',
              quantity: '2',
              unitAmount: '10000',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        },
        s.ctx,
      ),
    );

    expect(updated.memo).toBe('Q1 stationery');
    expect(updated.lines).toHaveLength(1);
    expect(updated.totals).toEqual({ net: '20000', tax: '4000', gross: '24000' });
  });

  it('re-prices its existing lines when only the tax mode changes', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    expect(created.totals.gross).toBe('180000');

    // The same `unitAmount`, read the other way: 150000 now *includes* the tax.
    // Leaving the stored amounts alone would give a document whose own columns no
    // longer add up the way the page does.
    const updated = await withContext(s.ctx, () =>
      updateBill(created.id, { taxMode: 'inclusive' }, s.ctx),
    );

    expect(updated.totals).toEqual({ net: '125000', tax: '25000', gross: '150000' });
  });

  it('is discarded outright, because it never reached the ledger (D-16)', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await withContext(s.ctx, () => discardBill(created.id, s.ctx));

    expect(await wireErrorOf(withContext(s.ctx, () => getBill(created.id, s.ctx)))).toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});

describe('approving a bill', () => {
  it('numbers it, posts one journal, and both arrive together (D-38)', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    const approved = await withContext(s.ctx, () => approveBill(created.id, s.ctx));

    expect(approved.documentNumber).toBe('1');
    expect(approved.journalId).not.toBeNull();
    expect(approved.status).toBe('approved');
    // Nothing has been applied, so the whole gross is outstanding — computed on
    // read, stored nowhere (D-34).
    expect(approved.settlement).toEqual({ allocated: '0', outstanding: '180000' });

    const journals = await db.app
      .selectFrom('journals')
      .select(['id', 'entry_date', 'memo'])
      .where('org_id', '=', s.orgId)
      .execute();
    expect(journals).toHaveLength(1);
    // The document's own issue date, never a date on the request: an approval that
    // could name its own date would post a bill into a period other than the one
    // it is printed for.
    expect(journals[0]?.entry_date).toBe(s.date);
  });

  it('numbers gaplessly per org per type (D-36, C9)', async () => {
    const numbers: string[] = [];
    for (const _ of [1, 2, 3]) {
      const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
      const approved = await withContext(s.ctx, () => approveBill(created.id, s.ctx));
      numbers.push(approved.documentNumber ?? '');
    }

    expect(numbers).toEqual(['1', '2', '3']);
  });

  it('leaves the series gapless when an approval is refused', async () => {
    const first = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await withContext(s.ctx, () => approveBill(first.id, s.ctx));

    // Refused after the counter has been claimed inside the transaction — the
    // rollback is what makes the number reusable. `AUTO_INCREMENT` could not do
    // this, which is D-14's argument.
    const unpostable = await withContext(s.ctx, () =>
      createBill(simpleBill({ issueDate: '2027-06-01', dueDate: '2027-06-01' }), s.ctx),
    );
    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(unpostable.id, s.ctx))),
    ).toBeDefined();

    const third = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    const approved = await withContext(s.ctx, () => approveBill(third.id, s.ctx));
    expect(approved.documentNumber).toBe('2');
  });

  it('refuses a second approval', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await withContext(s.ctx, () => approveBill(created.id, s.ctx));

    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(created.id, s.ctx))),
    ).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'document_already_approved' },
    });
  });

  it('refuses an edit or a discard afterwards (D-38)', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await withContext(s.ctx, () => approveBill(created.id, s.ctx));

    expect(
      await wireErrorOf(withContext(s.ctx, () => updateBill(created.id, { memo: 'no' }, s.ctx))),
    ).toMatchObject({ details: { precondition: 'document_approved' } });
    expect(
      await wireErrorOf(withContext(s.ctx, () => discardBill(created.id, s.ctx))),
    ).toMatchObject({ details: { precondition: 'document_approved' } });
  });

  it('refuses a bill with no value', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill({ lines: [] }), s.ctx));

    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(created.id, s.ctx))),
    ).toMatchObject({ code: 'validation_failed' });
  });

  it('refuses when the org has nominated no payables control account', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await db.app
      .updateTable('org_accounting_settings')
      .set({ payable_control_account_id: null })
      .where('org_id', '=', s.orgId)
      .execute();

    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(created.id, s.ctx))),
    ).toMatchObject({ details: { precondition: 'payable_control_account_not_set' } });
  });

  it('refuses when the nominated payables control account was deactivated', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    // Deactivated rather than deleted: `fk_oas_payable` and the ledger's own
    // RESTRICTs make a nominated account undeletable, and deactivation is the real
    // shape of "this org no longer posts there".
    await db.app
      .updateTable('accounts')
      .set({ is_active: 0 })
      .where('id', '=', s.payableId)
      .execute();

    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(created.id, s.ctx))),
    ).toMatchObject({ details: { precondition: 'payable_control_account_unusable' } });
  });

  it('refuses a bill whose vendor was deactivated (postJournal owns that rule)', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await db.app
      .updateTable('contacts')
      .set({ is_active: 0 })
      .where('id', '=', s.vendorId)
      .execute();

    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(created.id, s.ctx))),
    ).toMatchObject({ details: { precondition: 'contact_inactive' } });
  });
});

describe('inclusive and exclusive entry of the same bill (C5, D-35)', () => {
  it('post identical journals', async () => {
    const exclusive = await withContext(s.ctx, () =>
      createBill(
        simpleBill({
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '150000',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        }),
        s.ctx,
      ),
    );
    const inclusive = await withContext(s.ctx, () =>
      createBill(
        simpleBill({
          taxMode: 'inclusive',
          lines: [
            {
              description: 'Paper',
              // The same economic bill: 150000 net plus 20% is 180000 gross.
              quantity: '1',
              unitAmount: '180000',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        }),
        s.ctx,
      ),
    );

    expect(inclusive.totals).toEqual(exclusive.totals);

    const a = await withContext(s.ctx, () => approveBill(exclusive.id, s.ctx));
    const b = await withContext(s.ctx, () => approveBill(inclusive.id, s.ctx));

    expect(await journalShape(b.journalId)).toEqual(await journalShape(a.journalId));
  });
});

describe('voiding a bill (D-16, D-38, C7)', () => {
  it('posts a reversal and leaves the bill and its number visible', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    const approved = await withContext(s.ctx, () => approveBill(created.id, s.ctx));

    const voided = await withContext(s.ctx, () =>
      voidBill(created.id, { date: s.date, memo: 'Duplicate' }, s.ctx),
    );

    expect(voided).toMatchObject({
      status: 'void',
      documentNumber: approved.documentNumber,
      journalId: approved.journalId,
    });
    expect(voided.voidJournalId).not.toBeNull();
    // Nothing is deleted: the document, its journal and the reversal all remain.
    expect(
      await db.app.selectFrom('journals').selectAll().where('org_id', '=', s.orgId).execute(),
    ).toHaveLength(2);
    // The reversal nets the control account back to zero, which is what makes a
    // void invisible to the balance sheet and visible in the ledger.
    expect(await accountBalance(db.app, s.orgId, s.payableId)).toBe(0n);
    // And it is D-34's rule for a void: nothing is owed on it any more.
    expect(voided.settlement.outstanding).toBe('0');
  });

  it('refuses to void a draft, and refuses to void twice', async () => {
    const draft = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    expect(
      await wireErrorOf(withContext(s.ctx, () => voidBill(draft.id, { date: s.date }, s.ctx))),
    ).toMatchObject({ details: { precondition: 'document_not_approved' } });

    await withContext(s.ctx, () => approveBill(draft.id, s.ctx));
    await withContext(s.ctx, () => voidBill(draft.id, { date: s.date }, s.ctx));

    expect(
      await wireErrorOf(withContext(s.ctx, () => voidBill(draft.id, { date: s.date }, s.ctx))),
    ).toMatchObject({ details: { precondition: 'document_already_void' } });
  });
});

describe('input the schema allows and the column refuses', () => {
  it('refuses a negative quantity with a validation failure, not a 500', async () => {
    // `quantitySchema` accepts a negative quantity — a discount line on an
    // invoice — and `chk_ap_document_lines_quantity` refuses one. Without the
    // service check the answer would be errno 3819 surfacing as an internal
    // error, which is the shape D-13 fixed for an over-large money string.
    expect(
      await wireErrorOf(
        withContext(s.ctx, () =>
          createBill(
            simpleBill({
              lines: [
                {
                  description: 'Return',
                  quantity: '-1',
                  unitAmount: '150000',
                  accountId: s.expenseUuid,
                },
              ],
            }),
            s.ctx,
          ),
        ),
      ),
    ).toMatchObject({ code: 'validation_failed', status: 400 });
  });

  it('refuses a negative unit amount the same way', async () => {
    expect(
      await wireErrorOf(
        withContext(s.ctx, () =>
          createBill(
            simpleBill({
              lines: [
                {
                  description: 'Rebate',
                  quantity: '1',
                  unitAmount: '-150000',
                  accountId: s.expenseUuid,
                },
              ],
            }),
            s.ctx,
          ),
        ),
      ),
    ).toMatchObject({ code: 'validation_failed', status: 400 });
  });

  it('round-trips a fractional quantity through the micros column', async () => {
    // `quantity_micros` is scaled by 1e6 and `Quantity` by 1e4. The conversion is
    // exact, and this is the assertion that would catch it being dropped.
    const bill = await withContext(s.ctx, () =>
      createBill(
        simpleBill({
          lines: [
            {
              description: 'Consulting',
              quantity: '2.5',
              unitAmount: '10000',
              accountId: s.expenseUuid,
            },
          ],
        }),
        s.ctx,
      ),
    );

    expect(bill.lines[0]?.quantity).toBe('2.5');
    expect(bill.lines[0]?.netAmount).toBe('25000');
  });
});

describe('who a bill may be raised against', () => {
  it('refuses a contact that is not marked as a vendor', async () => {
    const customer = await vendorIn(db, s.orgId, 'Customer only', { isVendor: false });

    expect(
      await wireErrorOf(
        withContext(s.ctx, () =>
          createBill(simpleBill({ contactId: bufferToUuid(customer) }), s.ctx),
        ),
      ),
    ).toMatchObject({ details: { precondition: 'contact_is_not_a_vendor' } });
  });

  it('reports another org’s vendor as a miss, not a refusal (A7)', async () => {
    const other = await sceneIn(db);

    expect(
      await wireErrorOf(
        withContext(s.ctx, () => createBill(simpleBill({ contactId: other.vendorUuid }), s.ctx)),
      ),
    ).toMatchObject({ code: 'not_found', status: 404, details: { resource: 'contact' } });
  });

  it('reports another org’s bill as a miss with a byte-identical body (A7)', async () => {
    const other = await sceneIn(db);
    const theirs = await withContext(other.ctx, () =>
      createBill(
        {
          contactId: other.vendorUuid,
          issueDate: other.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '100', accountId: other.expenseUuid },
          ],
        },
        other.ctx,
      ),
    );

    const crossOrg = await wireErrorOf(withContext(s.ctx, () => getBill(theirs.id, s.ctx)));
    const nonexistent = await wireErrorOf(withContext(s.ctx, () => getBill(newUuid(), s.ctx)));

    expect(crossOrg).toEqual(nonexistent);
    expect(crossOrg).toMatchObject({ code: 'not_found', details: { resource: 'bill' } });
  });
});

describe('the bill list', () => {
  it('pages by (created_at, id) and filters by status, vendor and reference', async () => {
    const draft = await withContext(s.ctx, () =>
      createBill(simpleBill({ reference: 'INV-1001' }), s.ctx),
    );
    const approvedDraft = await withContext(s.ctx, () =>
      createBill(simpleBill({ reference: 'INV-1002' }), s.ctx),
    );
    await withContext(s.ctx, () => approveBill(approvedDraft.id, s.ctx));

    const all = await withContext(s.ctx, () => listBills({}, s.ctx));
    expect(all.items.map((item) => item.id)).toEqual([draft.id, approvedDraft.id]);

    const drafts = await withContext(s.ctx, () => listBills({ status: 'draft' }, s.ctx));
    expect(drafts.items.map((item) => item.id)).toEqual([draft.id]);

    // The reference filter is on the bill list and no other document's, because
    // "have we already entered this vendor invoice" is the AP question (D-36).
    const byReference = await withContext(s.ctx, () => listBills({ reference: 'INV-1002' }, s.ctx));
    expect(byReference.items.map((item) => item.id)).toEqual([approvedDraft.id]);

    const firstPage = await withContext(s.ctx, () => listBills({ limit: 1 }, s.ctx));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await withContext(s.ctx, () =>
      listBills({ limit: 1, cursor: firstPage.nextCursor ?? '' }, s.ctx),
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([approvedDraft.id]);
  });

  it('shows a voided bill rather than hiding it (C7)', async () => {
    const created = await withContext(s.ctx, () => createBill(simpleBill(), s.ctx));
    await withContext(s.ctx, () => approveBill(created.id, s.ctx));
    await withContext(s.ctx, () => voidBill(created.id, { date: s.date }, s.ctx));

    const voided = await withContext(s.ctx, () => listBills({ status: 'void' }, s.ctx));
    expect(voided.items).toMatchObject([{ id: created.id, documentNumber: '1', status: 'void' }]);
  });

  it('never shows another org’s bills (A7)', async () => {
    const other = await sceneIn(db);
    await withContext(other.ctx, () =>
      createBill(
        {
          contactId: other.vendorUuid,
          issueDate: other.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '100', accountId: other.expenseUuid },
          ],
        },
        other.ctx,
      ),
    );

    expect((await withContext(s.ctx, () => listBills({}, s.ctx))).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

async function taxRateAt(ratePpm: number): Promise<string> {
  return bufferToUuid(
    await taxRateIn(db, s.orgId, `rate-${String(ratePpm)}`, ratePpm, s.taxAccountId),
  );
}

/** A journal reduced to what C5 asserts is identical: the account, side and amount of every line. */
async function journalShape(
  journalId: string | null,
): Promise<readonly { account: string; side: string; amount: string }[]> {
  if (journalId === null) throw new Error('A journal id was expected.');

  const lines = await db.app
    .selectFrom('journal_lines')
    .select(['account_id', 'debit_minor', 'credit_minor'])
    .where('journal_id', '=', uuidToBuffer(journalId))
    .orderBy('line_number')
    .execute();

  return lines.map((line) => ({
    account: bufferToUuid(line.account_id),
    side: line.debit_minor > 0n ? 'debit' : 'credit',
    amount: (line.debit_minor > 0n ? line.debit_minor : line.credit_minor).toString(),
  }));
}
