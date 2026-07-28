import { describe, expect, it } from 'vitest';

import { bufferToUuid, uuidToBuffer } from '../../src/db';
import { toWireError } from '../../src/errors';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  discardInvoice,
  getCreditNote,
  getInvoice,
  listCreditNotes,
  listInvoices,
  updateInvoice,
  voidInvoice,
} from '../../src/modules/invoices';
import { newUuid, SYSTEM_ROLE_UUIDS } from '../db';
import type { Scene } from './support';
import {
  allocationIn,
  contactIn,
  contextFor,
  dimensionIn,
  readArState,
  scene,
  taxRateIn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * The AR document services against real MySQL (spec §11 — never SQLite, never
 * mocks).
 *
 * Everything goes through the exported service functions: the permission check, the
 * A7 miss, the pricing and the approval transaction all live at that boundary, and a
 * test reaching the repository would pass while the boundary was missing.
 *
 * Every call runs inside `withContext`, which is the shape production has —
 * `assertPostable` reads the ambient context rather than taking one, so an approval
 * test outside a scope proves nothing about the posting path.
 *
 * The concurrency claims — that approval is one transaction, and that two approvals
 * of one document yield one journal and one number — are in `approve-race.test.ts`,
 * because a sequential simulation of a race passes against code that has no locking
 * at all.
 */
const db = useServiceDatabase();

/** Two units at £100.00, taxed at 20% on top: net 20000, tax 4000, gross 24000. */
function exclusiveLine(s: Scene, overrides: Record<string, unknown> = {}) {
  return {
    description: 'Consulting',
    quantity: '2',
    unitAmount: '10000',
    accountId: s.income,
    taxRateId: s.vat,
    ...overrides,
  };
}

async function readJournalLines(journalId: string) {
  return db.app
    .selectFrom('journal_lines')
    .select(['line_number', 'account_id', 'contact_id', 'debit_minor', 'credit_minor', 'memo'])
    .where('journal_id', '=', uuidToBuffer(journalId))
    .orderBy('line_number')
    .execute();
}

async function wireErrorOf(body: () => Promise<unknown>): Promise<unknown> {
  return body().then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('creating and pricing a draft', () => {
  it('creates an empty draft with no number, no journal, and zero totals', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
      });

      expect(invoice).toMatchObject({
        documentNumber: null,
        journalId: null,
        voidJournalId: null,
        status: 'draft',
        // Defaulted to the issue date — due on receipt (D-40 needs something to age
        // from).
        dueDate: s.date,
        lines: [],
        totals: { net: '0', tax: '0', gross: '0' },
        settlement: { allocated: '0', outstanding: '0' },
      });
      expect(await getInvoice(invoice.id)).toEqual(invoice);
    });
  });

  it('prices a line at D-35’s two rounding points and totals the rounded lines', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        reference: 'PO-8842',
        lines: [exclusiveLine(s)],
      });

      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0]).toMatchObject({
        lineNumber: 1,
        quantity: '2',
        unitAmount: '10000',
        taxRatePercentage: '20',
        netAmount: '20000',
        taxAmount: '4000',
        grossAmount: '24000',
      });
      expect(invoice.totals).toEqual({ net: '20000', tax: '4000', gross: '24000' });
      expect(invoice.taxSummary).toEqual([
        { taxRateId: s.vat, taxRateName: 'VAT 20%', percentage: '20', net: '20000', tax: '4000' },
      ]);
      expect(invoice.reference).toBe('PO-8842');

      // The stored quantity is in **micros**, and this is asserted against the
      // column rather than through the round trip on purpose: the wire form uses
      // four decimals and the column six, so a wrong scale factor round-trips
      // perfectly through this service and is wrong for everything that reads the
      // column — aging, the AP mirror, any report. Found by mutation: setting the
      // factor to 1 passed every other test in this file.
      const [stored] = await db.app
        .selectFrom('ar_document_lines')
        .select(['quantity_micros', 'line_amount_minor', 'tax_amount_minor'])
        .where('document_id', '=', uuidToBuffer(invoice.id))
        .execute();
      expect(stored).toEqual({
        quantity_micros: 2_000_000n,
        line_amount_minor: 20000n,
        tax_amount_minor: 4000n,
      });
    });
  });

  it('extracts tax from inclusive prices, preserving the price on the page', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'inclusive',
        lines: [exclusiveLine(s, { unitAmount: '12000' })],
      });

      // The gross the user typed survives to the cent, which is the entire reason
      // someone enters prices inclusively.
      expect(invoice.totals).toEqual({ net: '20000', tax: '4000', gross: '24000' });
    });
  });

  it('sums the tax column per line, not by taxing the document total (D-35)', async () => {
    const s = await scene(db);
    const fivePercent = await taxRateIn(
      db,
      s.actor.orgId,
      'Local 5%',
      50_000,
      uuidToBuffer(s.taxLiability),
    );

    await withContext(s.actor.ctx, async () => {
      // Three lines of 10 minor units at 5%: each line's tax is half a cent, rounds
      // half-up to 1, and the document's tax is 3. Rounding the sum instead gives
      // 30 × 5% = 1.5 → 2, and the customer who adds the tax column would get 3.
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [1, 2, 3].map(() => ({
          description: 'Sundry',
          quantity: '1',
          unitAmount: '10',
          accountId: s.income,
          taxRateId: bufferToUuid(fivePercent),
        })),
      });

      expect(invoice.totals).toEqual({ net: '30', tax: '3', gross: '33' });
    });
  });

  it('carries a line’s dimension tags, resolved by the dimensions module (D-18)', async () => {
    const s = await scene(db);
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales', 'ops']);
    const sales = bufferToUuid(department.valueIds[0] ?? s.contactId);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s, { dimensionValueIds: [sales] })],
      });

      expect(invoice.lines[0]?.dimensionValueIds).toEqual([sales]);
    });
  });

  it('refuses a negative quantity — a line that takes value off is a credit note', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const error = await wireErrorOf(() =>
        createInvoice({
          contactId: s.contact,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [exclusiveLine(s, { quantity: '-2' })],
        }),
      );

      expect(error).toMatchObject({ code: 'validation_failed', status: 400 });
      expect(JSON.stringify(error)).toContain('lines.0.quantity');
    });
  });

  it('refuses an archived tax rate on a new line', async () => {
    const s = await scene(db);
    const retired = await taxRateIn(
      db,
      s.actor.orgId,
      'VAT 17.5%',
      175_000,
      uuidToBuffer(s.taxLiability),
      false,
    );

    await withContext(s.actor.ctx, async () => {
      const error = await wireErrorOf(() =>
        createInvoice({
          contactId: s.contact,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [exclusiveLine(s, { taxRateId: bufferToUuid(retired) })],
        }),
      );

      expect(error).toMatchObject({ code: 'validation_failed' });
      expect(JSON.stringify(error)).toContain('archived');
    });
  });

  /**
   * D-35's `applies_to`, enforced where the line first cites the rate (OB-066a).
   * A rate posts to one account, so an org reclaiming input tax holds a separate
   * purchases rate — putting it on an invoice would post output tax to the
   * input-tax account and be found when a return did not reconcile.
   */
  it('refuses a purchases-only tax rate on an AR line', async () => {
    const s = await scene(db);
    const inputTax = await taxRateIn(
      db,
      s.actor.orgId,
      'VAT 20% (purchases)',
      200_000,
      uuidToBuffer(s.taxLiability),
      true,
      'purchases',
    );

    await withContext(s.actor.ctx, async () => {
      const error = await wireErrorOf(() =>
        createInvoice({
          contactId: s.contact,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [exclusiveLine(s, { taxRateId: bufferToUuid(inputTax) })],
        }),
      );

      expect(error).toMatchObject({ code: 'validation_failed' });
      expect(JSON.stringify(error)).toContain('lines.0.taxRateId');
    });
  });

  /** The unrestricted rate is the ordinary case and must stay usable. */
  it('accepts a rate that applies to both', async () => {
    const s = await scene(db);
    const shared = await taxRateIn(
      db,
      s.actor.orgId,
      'VAT 20% (both)',
      200_000,
      uuidToBuffer(s.taxLiability),
      true,
      'both',
    );

    await withContext(s.actor.ctx, async () => {
      await expect(
        createInvoice({
          contactId: s.contact,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [exclusiveLine(s, { taxRateId: bufferToUuid(shared) })],
        }),
      ).resolves.toBeDefined();
    });
  });

  it('answers a cross-org id exactly as it answers an unknown one (A7)', async () => {
    const mine = await scene(db);
    const theirs = await scene(db);

    const foreign = await withContext(theirs.actor.ctx, () =>
      createInvoice({ contactId: theirs.contact, issueDate: theirs.date, taxMode: 'exclusive' }),
    );

    await withContext(mine.actor.ctx, async () => {
      const unknown = await wireErrorOf(() => getInvoice(newUuid()));
      const crossOrg = await wireErrorOf(() => getInvoice(foreign.id));
      const malformed = await wireErrorOf(() => getInvoice('not-a-uuid'));

      expect(unknown).toMatchObject({ code: 'not_found', status: 404 });
      // Byte-identical, not merely the same status: the body carries a resource
      // token and nothing else, so the two cases are the same line of code.
      expect(JSON.stringify(crossOrg)).toBe(JSON.stringify(unknown));
      expect(JSON.stringify(malformed)).toBe(JSON.stringify(unknown));
    });
  });

  it('keeps an invoice id and a credit note id apart', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
      });

      expect(await wireErrorOf(() => getCreditNote(invoice.id))).toMatchObject({
        code: 'not_found',
        details: { resource: 'credit_note' },
      });
    });
  });
});

describe('editing a draft', () => {
  it('replaces the whole line set and repriced totals follow', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      const updated = await updateInvoice(invoice.id, {
        memo: 'March retainer',
        lines: [
          exclusiveLine(s, { quantity: '1' }),
          exclusiveLine(s, {
            description: 'Expenses',
            quantity: '1',
            unitAmount: '5000',
            accountId: s.secondIncome,
            taxRateId: null,
          }),
        ],
      });

      expect(updated.memo).toBe('March retainer');
      expect(updated.totals).toEqual({ net: '15000', tax: '2000', gross: '17000' });
      // The untaxed group is its own row and carries no percentage — not the same
      // thing as a zero-rated line.
      expect(updated.taxSummary).toHaveLength(2);
      expect(updated.taxSummary[1]).toEqual({
        taxRateId: null,
        taxRateName: null,
        percentage: null,
        net: '5000',
        tax: '0',
      });
    });
  });

  it('reprices rather than converts when the tax mode changes, keeping the tags', async () => {
    const s = await scene(db);
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales']);
    const sales = bufferToUuid(department.valueIds[0] ?? s.contactId);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s, { unitAmount: '12000', dimensionValueIds: [sales] })],
      });
      expect(invoice.totals).toEqual({ net: '24000', tax: '4800', gross: '28800' });

      const updated = await updateInvoice(invoice.id, { taxMode: 'inclusive' });

      // The unit price the user typed is unchanged; what it *means* is not.
      expect(updated.lines[0]?.unitAmount).toBe('12000');
      expect(updated.totals).toEqual({ net: '20000', tax: '4000', gross: '24000' });
      // Repriced in place: same line id, same tags. A replace would have churned
      // both for a change to neither.
      expect(updated.lines[0]?.lineId).toBe(invoice.lines[0]?.lineId);
      expect(updated.lines[0]?.dimensionValueIds).toEqual([sales]);
    });
  });

  it('discards a draft outright — no number was ever reserved (D-16, D-36)', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      await discardInvoice(invoice.id);

      expect(await wireErrorOf(() => getInvoice(invoice.id))).toMatchObject({ code: 'not_found' });
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        documents: 0,
        documentLines: 0,
        // Nothing was taken from the counter, so the series is untouched.
        nextInvoiceNumber: null,
      });
    });
  });
});

describe('approving (D-38, C1, C9)', () => {
  it('allocates the number, posts a balanced journal, and records both', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      const approved = await approveInvoice(draft.id);

      expect(approved).toMatchObject({ documentNumber: '1', status: 'approved' });
      expect(approved.journalId).not.toBeNull();
      expect(approved.settlement).toEqual({ allocated: '0', outstanding: '24000' });

      const lines = await readJournalLines(approved.journalId ?? '');
      expect(lines).toHaveLength(3);
      // The receivable is the line that names the customer: a line naming a contact
      // states who the amount is *with*, and the amount with the customer is the
      // one they owe.
      expect(lines[0]).toMatchObject({
        account_id: uuidToBuffer(s.receivable),
        contact_id: s.contactId,
        debit_minor: 24000n,
        credit_minor: 0n,
      });
      expect(lines[1]).toMatchObject({
        account_id: uuidToBuffer(s.income),
        contact_id: null,
        credit_minor: 20000n,
      });
      expect(lines[2]).toMatchObject({
        account_id: uuidToBuffer(s.taxLiability),
        credit_minor: 4000n,
        memo: 'VAT 20%',
      });

      const debits = lines.reduce((total, line) => total + line.debit_minor, 0n);
      const credits = lines.reduce((total, line) => total + line.credit_minor, 0n);
      expect(debits).toBe(credits);
    });
  });

  it('posts identical amounts from inclusive and exclusive entry of one invoice (C5)', async () => {
    const s = await scene(db);

    const amountsOf = async (mode: 'exclusive' | 'inclusive', unitAmount: string) =>
      withContext(s.actor.ctx, async () => {
        const draft = await createInvoice({
          contactId: s.contact,
          issueDate: s.date,
          taxMode: mode,
          lines: [exclusiveLine(s, { unitAmount })],
        });
        const approved = await approveInvoice(draft.id);
        const lines = await readJournalLines(approved.journalId ?? '');
        return lines.map((line) => [
          bufferToUuid(line.account_id),
          line.debit_minor.toString(),
          line.credit_minor.toString(),
        ]);
      });

    // £200 of consulting plus 20%, entered both ways. The line extension is exact
    // in both, which is C5's stated precondition (D-35).
    expect(await amountsOf('inclusive', '12000')).toEqual(await amountsOf('exclusive', '10000'));
  });

  it('numbers each document type in its own gapless series (D-36)', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const first = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const second = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const note = await approveCreditNote(
        (
          await createCreditNote({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );

      expect([first.documentNumber, second.documentNumber]).toEqual(['1', '2']);
      // Its own series, because invoices and credit notes are separate series to
      // the people who read them.
      expect(note.documentNumber).toBe('1');
    });
  });

  it('refuses a second approval, and leaves the first one’s number alone', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });
      await approveInvoice(draft.id);

      expect(await wireErrorOf(() => approveInvoice(draft.id))).toMatchObject({
        code: 'precondition_failed',
        status: 412,
        details: { precondition: 'document_already_approved' },
      });
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        documentNumbers: ['1'],
        journals: 1,
        nextInvoiceNumber: '2',
      });
    });
  });

  it('refuses an empty document and a zero-total one', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const empty = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
      });
      expect(await wireErrorOf(() => approveInvoice(empty.id))).toMatchObject({
        code: 'validation_failed',
      });

      const free = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s, { unitAmount: '0', taxRateId: null })],
      });
      expect(await wireErrorOf(() => approveInvoice(free.id))).toMatchObject({
        code: 'validation_failed',
      });

      // Neither reached the counter: a refused approval consumes no number.
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        journals: 0,
        nextInvoiceNumber: null,
      });
    });
  });

  it('consumes no number when the posting is refused (rollback, not a gap)', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      // 2025 is outside the org's only fiscal period, and periods are never created
      // as a side effect of posting (D-17).
      const outside = await createInvoice({
        contactId: s.contact,
        issueDate: '2025-06-01',
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      expect(await wireErrorOf(() => approveInvoice(outside.id))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'period_missing' },
      });

      const state = await readArState(db.app, s.actor.orgId);
      expect(state).toMatchObject({ journals: 0, documentNumbers: [], nextInvoiceNumber: null });

      // And the number the next approval takes is 1 — the refused one left no gap.
      const good = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });
      expect((await approveInvoice(good.id)).documentNumber).toBe('1');
    });
  });

  it('carries the line’s tags onto the journal line it posts', async () => {
    const s = await scene(db);
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales']);
    const sales = department.valueIds[0] ?? s.contactId;

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s, { dimensionValueIds: [bufferToUuid(sales)] })],
      });
      const approved = await approveInvoice(draft.id);

      const tags = await db.app
        .selectFrom('journal_line_dimensions')
        .innerJoin('journal_lines', 'journal_lines.id', 'journal_line_dimensions.journal_line_id')
        .select(['journal_line_dimensions.dimension_value_id', 'journal_lines.account_id'])
        .where('journal_lines.journal_id', '=', uuidToBuffer(approved.journalId ?? ''))
        .execute();

      expect(tags).toHaveLength(1);
      expect(tags[0]?.dimension_value_id).toEqual(sales);
      // On the income line, not on the receivable — tagging is per line (D-18).
      expect(tags[0]?.account_id).toEqual(uuidToBuffer(s.income));
    });
  });

  it('will not edit or discard an approved document', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });
      await approveInvoice(draft.id);

      expect(await wireErrorOf(() => updateInvoice(draft.id, { memo: 'too late' }))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_approved' },
      });
      expect(await wireErrorOf(() => discardInvoice(draft.id))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_approved' },
      });
    });
  });

  it('posts a credit note as the exact mirror of an invoice (D-39)', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const note = await approveCreditNote(
        (
          await createCreditNote({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );

      const lines = await readJournalLines(note.journalId ?? '');
      // Positive lines and the type carries the direction: the receivable is
      // credited and income and tax debited.
      expect(lines[0]).toMatchObject({
        account_id: uuidToBuffer(s.receivable),
        credit_minor: 24000n,
        debit_minor: 0n,
      });
      expect(lines[1]).toMatchObject({ account_id: uuidToBuffer(s.income), debit_minor: 20000n });
      expect(lines[2]).toMatchObject({
        account_id: uuidToBuffer(s.taxLiability),
        debit_minor: 4000n,
      });
      // A credit note has no due date: nothing about it falls due.
      expect(note).not.toHaveProperty('dueDate');
    });
  });

  /**
   * The org that declined a chart template (D-23) and never nominated a control
   * account. Before OB-066a this org could not invoice at all and there was no
   * setting to fix; now the refusal names the setting.
   */
  it('refuses to approve when the org has nominated no receivables control account', async () => {
    const s = await scene(db);
    await db.app
      .updateTable('org_accounting_settings')
      .set({ receivable_control_account_id: null })
      .where('org_id', '=', s.actor.orgId)
      .execute();

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      expect(await wireErrorOf(() => approveInvoice(draft.id))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'receivable_control_account_not_set' },
      });
    });
  });

  /**
   * Nominated, then archived. A separate token because the fix is a different act:
   * nothing is missing from the settings, the chart changed underneath them.
   */
  it('refuses to approve when the nominated control account was deactivated', async () => {
    const s = await scene(db);
    await db.app
      .updateTable('accounts')
      .set({ is_active: 0 })
      .where('id', '=', uuidToBuffer(s.receivable))
      .execute();

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      expect(await wireErrorOf(() => approveInvoice(draft.id))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'receivable_control_account_unusable' },
      });
    });
  });
});

describe('voiding (D-16, D-38, C7)', () => {
  it('reverses the journal and leaves the document, its number, and both entries', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const approved = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );

      const voided = await voidInvoice(approved.id, { date: s.date, memo: 'Raised in error' });

      expect(voided).toMatchObject({ status: 'void', documentNumber: '1' });
      expect(voided.journalId).toBe(approved.journalId);
      expect(voided.voidJournalId).not.toBeNull();

      // Nothing was deleted: the document is still there and so are both journals.
      const state = await readArState(db.app, s.actor.orgId);
      expect(state).toMatchObject({ documents: 1, journals: 2, journalLines: 6 });

      const reversal = await readJournalLines(voided.voidJournalId ?? '');
      // Sides swapped, amounts untouched.
      expect(reversal[0]).toMatchObject({
        account_id: uuidToBuffer(s.receivable),
        debit_minor: 0n,
        credit_minor: 24000n,
      });
    });
  });

  it('refuses to void a draft and refuses to void twice', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });

      expect(await wireErrorOf(() => voidInvoice(draft.id, { date: s.date }))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_not_approved' },
      });

      await approveInvoice(draft.id);
      await voidInvoice(draft.id, { date: s.date });

      expect(await wireErrorOf(() => voidInvoice(draft.id, { date: s.date }))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_already_void' },
      });
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({ journals: 2 });
    });
  });

  it('refuses to void a document something has been allocated against (C2)', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const approved = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const note = await approveCreditNote(
        (
          await createCreditNote({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );

      await allocationIn(db, s.actor.orgId, {
        invoiceId: uuidToBuffer(approved.id),
        creditNoteId: uuidToBuffer(note.id),
        amountMinor: 24000n,
        allocatedOn: s.date,
        userId: s.actor.userId,
      });

      expect(await wireErrorOf(() => voidInvoice(approved.id, { date: s.date }))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_has_allocations' },
      });
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({ journals: 2 });
    });
  });
});

describe('status and settlement are derived, never stored (D-34, D-38)', () => {
  it('moves through approved, part_paid and paid as allocations arrive', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const note = await approveCreditNote(
        (
          await createCreditNote({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );

      await allocationIn(db, s.actor.orgId, {
        invoiceId: uuidToBuffer(invoice.id),
        creditNoteId: uuidToBuffer(note.id),
        amountMinor: 10000n,
        allocatedOn: s.date,
        userId: s.actor.userId,
      });

      const part = await getInvoice(invoice.id);
      expect(part.status).toBe('part_paid');
      expect(part.settlement).toEqual({ allocated: '10000', outstanding: '14000' });
      // Both ends are named, and the credit note is the source.
      expect(part.allocations).toHaveLength(1);
      expect(part.allocations[0]).toMatchObject({
        sourceType: 'credit_note',
        sourceId: note.id,
        sourceNumber: '1',
        targetType: 'invoice',
        targetId: invoice.id,
        targetNumber: '1',
        amount: '10000',
      });

      // The same rows read from the other end: the credit note has been applied.
      const applied = await getCreditNote(note.id);
      expect(applied.status).toBe('part_paid');
      expect(applied.settlement).toEqual({ allocated: '10000', outstanding: '14000' });

      await allocationIn(db, s.actor.orgId, {
        invoiceId: uuidToBuffer(invoice.id),
        creditNoteId: uuidToBuffer(note.id),
        amountMinor: 14000n,
        allocatedOn: s.date,
        userId: s.actor.userId,
      });

      expect((await getInvoice(invoice.id)).status).toBe('paid');
      expect((await getInvoice(invoice.id)).settlement).toEqual({
        allocated: '24000',
        outstanding: '0',
      });
      // A credit note fully applied reads `paid` too — the same fact, which is why
      // there is one enum and not two (C6).
      expect((await getCreditNote(note.id)).status).toBe('paid');
    });
  });
});

describe('listing (D-21)', () => {
  it('pages oldest first and filters on the computed status', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [exclusiveLine(s)],
      });
      const approved = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const voided = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      await voidInvoice(voided.id, { date: s.date });

      const all = await listInvoices({});
      expect(all.items.map((item) => item.id)).toEqual([draft.id, approved.id, voided.id]);
      expect(all.nextCursor).toBeNull();
      expect(all.items[1]).toMatchObject({
        documentNumber: '1',
        status: 'approved',
        totals: { net: '20000', tax: '4000', gross: '24000' },
        settlement: { allocated: '0', outstanding: '24000' },
      });

      // The filters read the same derivation the detail view does.
      expect((await listInvoices({ status: 'draft' })).items.map((i) => i.id)).toEqual([draft.id]);
      expect((await listInvoices({ status: 'approved' })).items.map((i) => i.id)).toEqual([
        approved.id,
      ]);
      expect((await listInvoices({ status: 'void' })).items.map((i) => i.id)).toEqual([voided.id]);

      // Keyset, one at a time.
      const first = await listInvoices({ limit: 1 });
      expect(first.items.map((i) => i.id)).toEqual([draft.id]);
      expect(first.nextCursor).not.toBeNull();
      const second = await listInvoices({ limit: 1, cursor: first.nextCursor ?? undefined });
      expect(second.items.map((i) => i.id)).toEqual([approved.id]);
    });
  });

  it('filters by contact, issue date, and due date', async () => {
    const s = await scene(db);
    const other = await contactFor(s);

    await withContext(s.actor.ctx, async () => {
      const early = await createInvoice({
        contactId: s.contact,
        issueDate: '2026-01-05',
        dueDate: '2026-02-05',
        taxMode: 'exclusive',
      });
      const late = await createInvoice({
        contactId: other,
        issueDate: '2026-06-05',
        dueDate: '2026-07-05',
        taxMode: 'exclusive',
      });

      expect((await listInvoices({ contactId: other })).items.map((i) => i.id)).toEqual([late.id]);
      expect((await listInvoices({ from: '2026-05-01' })).items.map((i) => i.id)).toEqual([
        late.id,
      ]);
      expect((await listInvoices({ to: '2026-05-01' })).items.map((i) => i.id)).toEqual([early.id]);
      expect((await listInvoices({ dueBefore: '2026-03-01' })).items.map((i) => i.id)).toEqual([
        early.id,
      ]);
    });
  });

  it('lists credit notes with something left to apply', async () => {
    const s = await scene(db);

    await withContext(s.actor.ctx, async () => {
      const invoice = await approveInvoice(
        (
          await createInvoice({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const spent = await approveCreditNote(
        (
          await createCreditNote({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );
      const available = await approveCreditNote(
        (
          await createCreditNote({
            contactId: s.contact,
            issueDate: s.date,
            taxMode: 'exclusive',
            lines: [exclusiveLine(s)],
          })
        ).id,
      );

      await allocationIn(db, s.actor.orgId, {
        invoiceId: uuidToBuffer(invoice.id),
        creditNoteId: uuidToBuffer(spent.id),
        amountMinor: 24000n,
        allocatedOn: s.date,
        userId: s.actor.userId,
      });

      const unapplied = await listCreditNotes({ unappliedOnly: true });
      expect(unapplied.items.map((item) => item.id)).toEqual([available.id]);
    });
  });
});

describe('authorization (spec §5)', () => {
  it('refuses a read-only caller, and refuses before it parses the body', async () => {
    const s = await scene(db, 'readOnly');

    await withContext(s.actor.ctx, async () => {
      // The body is nonsense. A `validation_failed` here would mean the parse ran
      // first, which tells an unauthorized caller the shape of an API they cannot
      // use.
      const error = await wireErrorOf(() =>
        createInvoice({ nonsense: true } as unknown as Parameters<typeof createInvoice>[0]),
      );

      expect(error).toMatchObject({
        code: 'permission_denied',
        status: 403,
        details: { permission: 'invoices.write' },
      });
    });
  });

  it('lets a read-only caller read', async () => {
    const owner = await scene(db);
    const invoice = await withContext(owner.actor.ctx, () =>
      createInvoice({ contactId: owner.contact, issueDate: owner.date, taxMode: 'exclusive' }),
    );

    const reader = await db.factories.user();
    await db.factories.orgMember({
      orgId: owner.actor.orgId,
      userId: reader.id,
      role: 'readOnly',
    });

    const ctx = contextFor(owner.actor.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, reader.uuid);

    await withContext(ctx, async () => {
      expect((await getInvoice(invoice.id)).id).toBe(invoice.id);
    });
  });
});

/** A second customer in the same org. */
async function contactFor(s: Scene): Promise<string> {
  return bufferToUuid(await contactIn(db, s.actor.orgId, 'Beta Ltd'));
}
