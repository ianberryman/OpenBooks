import { sql, type RawBuilder } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * The subledger schema (OB-060, ROADMAP D-34 through D-40).
 *
 * Every assertion here is about something the *database* refuses or something the
 * database does not have, because that is what the ticket bought. Two kinds of claim
 * are being made and they need different tests:
 *
 *  - **Absence.** D-34 says a subledger holds no balance and D-38 says no status.
 *    Those are claims about columns that must not exist, and the only way to assert
 *    one is to read the live schema and find nothing — a test written against the
 *    columns that *do* exist would pass unchanged the day someone adds
 *    `outstanding_minor`. `the schema holds no balance and no status` is the guard,
 *    and it is the single most load-bearing test in this file.
 *
 *  - **Impossibility.** A document approved without a number, a credit note
 *    allocated against itself, a line pointing at another org's account. Each of
 *    these is a rule the services will also enforce, and each is asserted here so
 *    that the service is the second line of defence rather than the only one.
 *
 * Everything runs as the **app** user. A CHECK constraint holds against a superuser
 * too, so that part would be equally true either way — but the grant-dependent
 * halves (the locking reads below) are only meaningful as the identity the
 * application actually runs as (spec §11, §12).
 */
const db = useTestDatabase();

/** mysql2 errnos, named because a bare number in an expectation reads as noise. */
const DUPLICATE_KEY = 1062;
const NO_REFERENCED_ROW = 1452;
const ROW_IS_REFERENCED = 1451;
const CHECK_VIOLATED = 3819;

interface Party {
  readonly orgId: Buffer;
  readonly userId: Buffer;
  readonly periodId: Buffer;
  readonly contactId: Buffer;
  readonly incomeAccountId: Buffer;
  readonly taxAccountId: Buffer;
  readonly taxRateId: Buffer;
}

let codeSequence = 0;

/** An org with everything a document needs to exist, and nothing it does not. */
async function party(): Promise<Party> {
  const seq = (codeSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  // One period per org, reused by every journal below. `factories.journal` creates
  // its own otherwise, and the second would collide on `uq_fiscal_periods_org_start`
  // — a fixture failure that reads like a schema failure.
  const period = await db.factories.fiscalPeriod({ orgId: org.id });
  const [income, tax] = await Promise.all([
    db.factories.account({ orgId: org.id, type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.id, type: 'liability', normalBalance: 'credit' }),
  ]);

  const contactId = newUuidBuffer();
  await sql`
    INSERT INTO contacts (id, org_id, display_name, is_customer, is_vendor)
    VALUES (${contactId}, ${org.id}, ${`Party ${seq}`}, 1, 1)
  `.execute(db.app);

  const taxRateId = newUuidBuffer();
  await sql`
    INSERT INTO tax_rates (id, org_id, name, rate_ppm, tax_account_id)
    VALUES (${taxRateId}, ${org.id}, ${`VAT ${seq}`}, ${200_000}, ${tax.id})
  `.execute(db.app);

  return {
    orgId: org.id,
    userId: user.id,
    periodId: period.id,
    contactId,
    incomeAccountId: income.id,
    taxAccountId: tax.id,
    taxRateId,
  };
}

/** A posted journal in `p`'s org and period, for a document to point at. */
async function journalFor(p: Party): Promise<Buffer> {
  const journal = await db.factories.journal({ orgId: p.orgId, periodId: p.periodId });
  return journal.id;
}

interface DocumentOverrides {
  readonly id?: Buffer;
  readonly documentType?: string;
  readonly sequenceNumber?: number | null;
  readonly dueDate?: string | null;
  readonly journalId?: Buffer | null;
  readonly voidJournalId?: Buffer | null;
  readonly contactId?: Buffer;
}

function insertArDocument(p: Party, overrides: DocumentOverrides = {}): RawBuilder<unknown> {
  return sql`
    INSERT INTO ar_documents (
      id, org_id, document_type, sequence_number, contact_id, issue_date, due_date,
      tax_mode, journal_id, void_journal_id, created_by_user_id
    ) VALUES (
      ${overrides.id ?? newUuidBuffer()},
      ${p.orgId},
      ${overrides.documentType ?? 'invoice'},
      ${overrides.sequenceNumber ?? null},
      ${overrides.contactId ?? p.contactId},
      ${'2026-03-01'},
      ${overrides.dueDate === undefined ? '2026-03-31' : overrides.dueDate},
      ${'exclusive'},
      ${overrides.journalId ?? null},
      ${overrides.voidJournalId ?? null},
      ${p.userId}
    )
  `;
}

interface LineOverrides {
  readonly documentId?: Buffer;
  readonly quantityMicros?: number;
  readonly unitAmountMinor?: number;
  readonly lineAmountMinor?: number;
  readonly taxAmountMinor?: number;
  readonly taxRateId?: Buffer | null;
  readonly accountId?: Buffer;
  readonly lineNumber?: number;
}

function insertArLine(
  p: Party,
  documentId: Buffer,
  overrides: LineOverrides = {},
): RawBuilder<unknown> {
  return sql`
    INSERT INTO ar_document_lines (
      org_id, document_id, line_number, description, quantity_micros, unit_amount_minor,
      account_id, tax_rate_id, line_amount_minor, tax_amount_minor
    ) VALUES (
      ${p.orgId},
      ${overrides.documentId ?? documentId},
      ${overrides.lineNumber ?? 1},
      ${'Consulting'},
      ${overrides.quantityMicros ?? 1_000_000},
      ${overrides.unitAmountMinor ?? 100_00},
      ${overrides.accountId ?? p.incomeAccountId},
      ${overrides.taxRateId === undefined ? null : overrides.taxRateId},
      ${overrides.lineAmountMinor ?? 100_00},
      ${overrides.taxAmountMinor ?? 0}
    )
  `;
}

/** The errno a statement was refused with, or `'permitted'`. */
async function refusal(statement: RawBuilder<unknown>): Promise<number | 'permitted'> {
  try {
    await statement.execute(db.app);
    return 'permitted';
  } catch (error) {
    const errno = (error as { readonly errno?: unknown }).errno;
    // Anything that is not an errno is a bug in the statement, not a refusal, and
    // must not be reported as one — a typo would otherwise read as a constraint.
    if (typeof errno !== 'number') throw error;
    return errno;
  }
}

async function lastLineId(documentId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ id: bigint }>`
    SELECT id FROM ar_document_lines WHERE document_id = ${documentId} ORDER BY id DESC LIMIT 1
  `.execute(db.app);
  return rows[0]!.id;
}

async function axis(orgId: Buffer): Promise<{ dimensionId: Buffer; valueId: Buffer }> {
  const dimensionId = newUuidBuffer();
  const valueId = newUuidBuffer();
  const seq = (codeSequence += 1);

  await sql`
    INSERT INTO dimensions (id, org_id, code, name)
    VALUES (${dimensionId}, ${orgId}, ${`AX${seq}`}, ${'Department'})
  `.execute(db.app);
  await sql`
    INSERT INTO dimension_values (id, org_id, dimension_id, code, name)
    VALUES (${valueId}, ${orgId}, ${dimensionId}, ${'ONE'}, ${'One'})
  `.execute(db.app);

  return { dimensionId, valueId };
}

/**
 * The absence test, and the reason this file exists at all.
 *
 * D-34 and D-38 are stated as prohibitions — no stored balance, no stored status —
 * and a prohibition cannot be asserted by exercising what is there. This reads the
 * live schema and fails naming the column, which is what makes the decision
 * enforceable by someone who has not read it.
 *
 * The pattern is deliberately broad rather than an exact list. `paid_minor`,
 * `amount_outstanding`, `is_paid` and `status` are all the same mistake wearing
 * different names, and a list of forbidden literals would catch only the ones
 * somebody thought of.
 */
describe('the subledger holds no balance and no status', () => {
  const FORBIDDEN = /balance|outstanding|status|paid|settled|remaining|total/u;

  const TABLES = [
    'ar_documents',
    'ar_document_lines',
    'ap_documents',
    'ap_document_lines',
    'payments',
    'ar_allocations',
    'ap_allocations',
  ] as const;

  it.each(TABLES)('%s carries no derived-state column', async (table) => {
    const { rows } = await sql<{ column_name: string }>`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${db.info.database} AND TABLE_NAME = ${table}
    `.execute(db.migrator);

    // Non-empty check first: a typo'd table name would otherwise make this vacuous.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.column_name).filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});

/**
 * D-38's lifecycle, stored as the facts that caused it rather than as an enum.
 *
 * draft = no journal, approved = a journal, void = a reversing journal. The CHECK
 * constraints below are what make those three the only reachable states — without
 * them "approved" would be an application convention, and a document could claim a
 * number the ledger had never been told about.
 */
describe('ar_documents: approval is a journal, not a status', () => {
  it('refuses a number without a journal', async () => {
    const p = await party();
    expect(await refusal(insertArDocument(p, { sequenceNumber: 1 }))).toBe(CHECK_VIOLATED);
  });

  it('refuses a journal without a number', async () => {
    const p = await party();
    const journalId = await journalFor(p);
    expect(await refusal(insertArDocument(p, { journalId }))).toBe(CHECK_VIOLATED);
  });

  it('accepts the two together', async () => {
    const p = await party();
    const journalId = await journalFor(p);
    expect(await refusal(insertArDocument(p, { journalId, sequenceNumber: 1 }))).toBe('permitted');
  });

  it('refuses a void on a document that was never approved', async () => {
    const p = await party();
    const journalId = await journalFor(p);
    expect(await refusal(insertArDocument(p, { voidJournalId: journalId }))).toBe(CHECK_VIOLATED);
  });

  it('refuses an approved invoice with no due date', async () => {
    const p = await party();
    const journalId = await journalFor(p);
    expect(
      await refusal(insertArDocument(p, { journalId, sequenceNumber: 1, dueDate: null })),
    ).toBe(CHECK_VIOLATED);
  });

  /**
   * A credit note is chased by nobody, so it needs no due date — D-40 buckets by days
   * past due, and there is no such thing for a document that is allocated rather than
   * paid. Asserted rather than left implicit because the CHECK is written as an
   * exemption and an exemption that is never exercised is an untested branch.
   */
  it('lets an approved credit note have no due date', async () => {
    const p = await party();
    const journalId = await journalFor(p);
    expect(
      await refusal(
        insertArDocument(p, {
          documentType: 'credit_note',
          journalId,
          sequenceNumber: 1,
          dueDate: null,
        }),
      ),
    ).toBe('permitted');
  });

  /**
   * D-19's argument, applied to documents: a draft that had reserved a number and was
   * then discarded would leave a gap, and a gap is indistinguishable from a deleted
   * document. So the number is NULL until approval, and MySQL's treatment of NULL as
   * distinct in a unique index is what lets any number of drafts coexist.
   */
  it('lets unnumbered drafts coexist', async () => {
    const p = await party();
    for (let n = 0; n < 3; n += 1) {
      expect(await refusal(insertArDocument(p))).toBe('permitted');
    }
  });

  it('refuses two approved invoices sharing a number', async () => {
    const p = await party();
    const first = await journalFor(p);
    const second = await journalFor(p);

    await insertArDocument(p, { journalId: first, sequenceNumber: 7 }).execute(db.app);
    expect(await refusal(insertArDocument(p, { journalId: second, sequenceNumber: 7 }))).toBe(
      DUPLICATE_KEY,
    );
  });

  /** D-36: invoices and credit notes are separate series to the people who read them. */
  it('numbers invoices and credit notes independently', async () => {
    const p = await party();
    const first = await journalFor(p);
    const second = await journalFor(p);

    await insertArDocument(p, { journalId: first, sequenceNumber: 7 }).execute(db.app);
    expect(
      await refusal(
        insertArDocument(p, {
          documentType: 'credit_note',
          journalId: second,
          sequenceNumber: 7,
          dueDate: null,
        }),
      ),
    ).toBe('permitted');
  });

  /**
   * Two documents claiming one journal would post the revenue once and recognise it
   * twice, and the subledger would disagree with the ledger by exactly one invoice —
   * which is the divergence spec §11 names. The unique key is the same device
   * `uq_journals_org_reverses` is for reversals.
   */
  it('refuses two documents claiming the same journal', async () => {
    const p = await party();
    const journalId = await journalFor(p);

    await insertArDocument(p, { journalId, sequenceNumber: 1 }).execute(db.app);
    expect(await refusal(insertArDocument(p, { journalId, sequenceNumber: 2 }))).toBe(
      DUPLICATE_KEY,
    );
  });
});

describe('a cross-org reference cannot be expressed', () => {
  it('refuses a document naming another org’s contact', async () => {
    const [mine, theirs] = await Promise.all([party(), party()]);
    expect(await refusal(insertArDocument(mine, { contactId: theirs.contactId }))).toBe(
      NO_REFERENCED_ROW,
    );
  });

  it('refuses a line on another org’s document', async () => {
    const [mine, theirs] = await Promise.all([party(), party()]);
    const theirDocument = newUuidBuffer();
    await insertArDocument(theirs, { id: theirDocument }).execute(db.app);

    expect(await refusal(insertArLine(mine, theirDocument))).toBe(NO_REFERENCED_ROW);
  });

  it('refuses a line posting to another org’s account', async () => {
    const [mine, theirs] = await Promise.all([party(), party()]);
    const document = newUuidBuffer();
    await insertArDocument(mine, { id: document }).execute(db.app);

    expect(await refusal(insertArLine(mine, document, { accountId: theirs.incomeAccountId }))).toBe(
      NO_REFERENCED_ROW,
    );
  });

  it('refuses a line carrying another org’s tax rate', async () => {
    const [mine, theirs] = await Promise.all([party(), party()]);
    const document = newUuidBuffer();
    await insertArDocument(mine, { id: document }).execute(db.app);

    expect(
      await refusal(
        insertArLine(mine, document, { taxRateId: theirs.taxRateId, taxAmountMinor: 20_00 }),
      ),
    ).toBe(NO_REFERENCED_ROW);
  });
});

describe('ar_document_lines', () => {
  it('refuses a zero or negative quantity', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);

    expect(await refusal(insertArLine(p, document, { quantityMicros: 0 }))).toBe(CHECK_VIOLATED);
    expect(await refusal(insertArLine(p, document, { quantityMicros: -1_000_000 }))).toBe(
      CHECK_VIOLATED,
    );
  });

  /**
   * A negative line is a credit note (D-39), not a discount on an invoice. Allowing
   * one would make an invoice's total signed, and every over-allocation check and
   * aging bucket would then need to reason about the sign.
   */
  it('refuses a negative amount on any of the three money columns', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);

    expect(await refusal(insertArLine(p, document, { unitAmountMinor: -1 }))).toBe(CHECK_VIOLATED);
    expect(await refusal(insertArLine(p, document, { lineAmountMinor: -1 }))).toBe(CHECK_VIOLATED);
    expect(
      await refusal(insertArLine(p, document, { taxRateId: p.taxRateId, taxAmountMinor: -1 })),
    ).toBe(CHECK_VIOLATED);
  });

  /**
   * Tax with no rate to attribute it to would make the tax account's balance
   * unexplainable from the documents that produced it — which is C2's failure mode
   * arriving through the one account nobody reconciles by hand.
   */
  it('refuses a tax amount with no rate', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);

    expect(await refusal(insertArLine(p, document, { taxAmountMinor: 20_00 }))).toBe(
      CHECK_VIOLATED,
    );
    expect(
      await refusal(insertArLine(p, document, { taxRateId: p.taxRateId, taxAmountMinor: 20_00 })),
    ).toBe('permitted');
  });

  /**
   * D-35 says rates archive rather than delete once used, and this is the half the
   * schema makes structural: the RESTRICT means a rate a posted line cites cannot be
   * removed at all, so archiving is not a convention the service has to remember.
   */
  it('refuses to delete a tax rate a line cites, and permits archiving it', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);
    await insertArLine(p, document, { taxRateId: p.taxRateId, taxAmountMinor: 20_00 }).execute(
      db.app,
    );

    expect(await refusal(sql`DELETE FROM tax_rates WHERE id = ${p.taxRateId}`)).toBe(
      ROW_IS_REFERENCED,
    );
    expect(await refusal(sql`UPDATE tax_rates SET is_active = 0 WHERE id = ${p.taxRateId}`)).toBe(
      'permitted',
    );
  });

  /**
   * Discarding a draft is one statement. The cascade reaches the tags too, which is
   * the one place it matters: a tag left behind would reference a line that no longer
   * exists, and the RESTRICT on `dimension_values` would then block deleting the axis
   * for a reason nobody could see.
   */
  it('takes its lines and their tags with it when a draft is discarded', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);
    await insertArLine(p, document).execute(db.app);

    const lineId = await lastLineId(document);
    const { dimensionId, valueId } = await axis(p.orgId);
    await sql`
      INSERT INTO ar_document_line_dimensions
        (org_id, document_line_id, dimension_id, dimension_value_id)
      VALUES (${p.orgId}, ${lineId}, ${dimensionId}, ${valueId})
    `.execute(db.app);

    await sql`DELETE FROM ar_documents WHERE id = ${document}`.execute(db.app);

    // `line_count`, not `lines`: LINES is a reserved word in MySQL (LOAD DATA … LINES
    // TERMINATED BY) and an alias of that name is a syntax error.
    const { rows } = await sql<{ line_count: number; tag_count: number }>`
      SELECT
        (SELECT COUNT(*) FROM ar_document_lines WHERE document_id = ${document}) AS line_count,
        (SELECT COUNT(*) FROM ar_document_line_dimensions WHERE document_line_id = ${lineId})
          AS tag_count
    `.execute(db.app);

    expect({ lines: Number(rows[0]!.line_count), tags: Number(rows[0]!.tag_count) }).toEqual({
      lines: 0,
      tags: 0,
    });
  });
});

/**
 * D-18's tags on a document line. Same two guarantees as `journal_line_dimensions`,
 * and they matter here for the same reason: a document line posts to a journal line,
 * so a document that could carry two values on one axis would produce a journal that
 * cannot be tagged from it — and the failure would surface at approval rather than at
 * entry.
 */
describe('ar_document_line_dimensions', () => {
  it('refuses a second value on the same axis', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);
    await insertArLine(p, document).execute(db.app);
    const lineId = await lastLineId(document);

    const { dimensionId, valueId } = await axis(p.orgId);
    const other = newUuidBuffer();
    await sql`
      INSERT INTO dimension_values (id, org_id, dimension_id, code, name)
      VALUES (${other}, ${p.orgId}, ${dimensionId}, ${'TWO'}, ${'Two'})
    `.execute(db.app);

    const tag = (value: Buffer): RawBuilder<unknown> => sql`
      INSERT INTO ar_document_line_dimensions
        (org_id, document_line_id, dimension_id, dimension_value_id)
      VALUES (${p.orgId}, ${lineId}, ${dimensionId}, ${value})
    `;

    expect(await refusal(tag(valueId))).toBe('permitted');
    expect(await refusal(tag(other))).toBe(DUPLICATE_KEY);
  });

  it('refuses a value filed under the wrong axis', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);
    await insertArLine(p, document).execute(db.app);
    const lineId = await lastLineId(document);

    const [first, second] = await Promise.all([axis(p.orgId), axis(p.orgId)]);

    expect(
      await refusal(sql`
        INSERT INTO ar_document_line_dimensions
          (org_id, document_line_id, dimension_id, dimension_value_id)
        VALUES (${p.orgId}, ${lineId}, ${first.dimensionId}, ${second.valueId})
      `),
    ).toBe(NO_REFERENCED_ROW);
  });
});

/**
 * Allocation is the single mechanism by which anything reduces an invoice (D-39), so
 * the shape of an allocation row is what "outstanding" is defined against. Each test
 * here is a way the row could be malformed such that the definition stops being a
 * function of the data.
 */
describe('ar_allocations', () => {
  interface Allocatable {
    readonly party: Party;
    readonly invoiceId: Buffer;
    readonly paymentId: Buffer;
    readonly creditNoteId: Buffer;
  }

  async function allocatable(): Promise<Allocatable> {
    const p = await party();
    const invoiceId = newUuidBuffer();
    const creditNoteId = newUuidBuffer();
    const paymentId = newUuidBuffer();

    const invoiceJournal = await journalFor(p);
    const creditJournal = await journalFor(p);
    const paymentJournal = await journalFor(p);

    await insertArDocument(p, {
      id: invoiceId,
      journalId: invoiceJournal,
      sequenceNumber: 1,
    }).execute(db.app);
    await insertArDocument(p, {
      id: creditNoteId,
      documentType: 'credit_note',
      journalId: creditJournal,
      sequenceNumber: 1,
      dueDate: null,
    }).execute(db.app);

    await sql`
      INSERT INTO payments (
        id, org_id, direction, sequence_number, contact_id, payment_date, amount_minor,
        bank_account_id, journal_id, created_by_user_id
      ) VALUES (
        ${paymentId}, ${p.orgId}, ${'received'}, ${1}, ${p.contactId}, ${'2026-03-15'},
        ${100_00}, ${p.incomeAccountId}, ${paymentJournal}, ${p.userId}
      )
    `.execute(db.app);

    return { party: p, invoiceId, paymentId, creditNoteId };
  }

  function allocate(
    a: Allocatable,
    source: { payment?: Buffer | null; creditNote?: Buffer | null; amount?: number },
  ): RawBuilder<unknown> {
    return sql`
      INSERT INTO ar_allocations (
        id, org_id, invoice_id, payment_id, credit_note_id, amount_minor, allocated_on,
        created_by_user_id
      ) VALUES (
        ${newUuidBuffer()}, ${a.party.orgId}, ${a.invoiceId}, ${source.payment ?? null},
        ${source.creditNote ?? null}, ${source.amount ?? 50_00}, ${'2026-03-20'},
        ${a.party.userId}
      )
    `;
  }

  it('accepts a payment or a credit note as the source', async () => {
    const a = await allocatable();
    expect(await refusal(allocate(a, { payment: a.paymentId }))).toBe('permitted');
    expect(await refusal(allocate(a, { creditNote: a.creditNoteId }))).toBe('permitted');
  });

  it('refuses an allocation with no source', async () => {
    const a = await allocatable();
    expect(await refusal(allocate(a, {}))).toBe(CHECK_VIOLATED);
  });

  /**
   * Two sources on one row would make the allocated amount count against both, so
   * `SUM(amount_minor)` per payment and per credit note would each include it — and
   * the two subtotals would no longer add up to the invoice's reduction.
   */
  it('refuses an allocation with two sources', async () => {
    const a = await allocatable();
    expect(await refusal(allocate(a, { payment: a.paymentId, creditNote: a.creditNoteId }))).toBe(
      CHECK_VIOLATED,
    );
  });

  it('refuses an invoice allocated against itself', async () => {
    const a = await allocatable();
    expect(await refusal(allocate(a, { creditNote: a.invoiceId }))).toBe(CHECK_VIOLATED);
  });

  it('refuses a zero or negative amount', async () => {
    const a = await allocatable();
    expect(await refusal(allocate(a, { payment: a.paymentId, amount: 0 }))).toBe(CHECK_VIOLATED);
    expect(await refusal(allocate(a, { payment: a.paymentId, amount: -1 }))).toBe(CHECK_VIOLATED);
  });

  /**
   * Deleting an allocated document would silently restate what a customer owes, and
   * the RESTRICT is what makes that a database error rather than a service rule. The
   * allocation itself *is* deletable — it posts no journal, so unallocating restates
   * no financial statement — which is the asymmetry this pair asserts.
   */
  it('pins the invoice it names, and is itself removable', async () => {
    const a = await allocatable();
    await allocate(a, { payment: a.paymentId }).execute(db.app);

    expect(await refusal(sql`DELETE FROM ar_documents WHERE id = ${a.invoiceId}`)).toBe(
      ROW_IS_REFERENCED,
    );
    expect(await refusal(sql`DELETE FROM ar_allocations WHERE invoice_id = ${a.invoiceId}`)).toBe(
      'permitted',
    );
    expect(await refusal(sql`DELETE FROM ar_documents WHERE id = ${a.invoiceId}`)).toBe(
      'permitted',
    );
  });
});

/**
 * D-36's counter, and the reason it is a counter.
 *
 * The gaplessness claim is a claim about two transactions contending for one row, and
 * a sequential simulation of that race passes against code with no locking at all
 * (see `test/enforcement/support.ts`). So the second claimant is started while the
 * first is parked mid-transaction and asserted *not to have settled* — which is only
 * true if it is genuinely blocked on the row lock.
 */
describe('document_sequences', () => {
  /** Long enough that a lock acquisition on a local container is not mistaken for a block. */
  const CONTENTION_WAIT_MS = 750;
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('serializes two claimants on the same counter and issues no gap', async () => {
    const p = await party();
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    // The counter row is created *before* the race, and that is the whole design of
    // this test rather than a shortcut.
    //
    // The obvious version claims with `INSERT … ON DUPLICATE KEY UPDATE` followed by
    // `SELECT … FOR UPDATE`, which is what the services will run. Measured, it passes
    // with the `FOR UPDATE` deleted: the upsert is itself a write, so it takes the
    // row's exclusive lock first and the second claimant is already blocked by the
    // time it reads. The test would then have been asserting the upsert's lock while
    // claiming to assert the `FOR UPDATE`, and would not have failed if a service
    // dropped it on a counter row that already existed — which is every claim after
    // the first, i.e. all of them in practice.
    //
    // Starting from an existing row removes the upsert from the race, so `FOR UPDATE`
    // is the only thing that can serialize the two claimants. Deleting it makes both
    // read 1 and this test fail on the values, which is the property a test of a lock
    // has to have.
    await sql`
      INSERT INTO document_sequences (org_id, document_type, next_value)
      VALUES (${p.orgId}, ${'invoice'}, 1)
    `.execute(db.app);

    try {
      // `FOR UPDATE` works here only because `document_sequences` is in the mutable
      // grant list — the app user cannot take one on `journals` at all (D-14), which
      // is why the counter is a table of its own.
      const claim = async (connection: typeof first): Promise<bigint> =>
        connection.db.transaction().execute(async (trx) => {
          const { rows } = await sql<{ next_value: bigint }>`
            SELECT next_value FROM document_sequences
            WHERE org_id = ${p.orgId} AND document_type = ${'invoice'}
            FOR UPDATE
          `.execute(trx);

          const claimed = rows[0]!.next_value;
          await sql`
            UPDATE document_sequences SET next_value = ${claimed + 1n}
            WHERE org_id = ${p.orgId} AND document_type = ${'invoice'}
          `.execute(trx);

          // Held open so the other claimant has something to block on.
          await delay(CONTENTION_WAIT_MS);
          return claimed;
        });

      const a = claim(first);
      let bSettled = false;
      // Started after `a` has certainly taken the lock, and watched rather than
      // awaited: "has not settled" is the assertion, and awaiting it would make the
      // test pass by definition.
      await delay(CONTENTION_WAIT_MS / 3);
      const b = claim(second).finally(() => {
        bSettled = true;
      });

      expect(bSettled).toBe(false);
      expect([await a, await b].map(String)).toEqual(['1', '2']);
    } finally {
      await first.close();
      await second.close();
    }
  });

  /**
   * D-36: invoices, credit notes, bills and vendor credits are separate series to the
   * people who read them. The composite primary key is what makes that true, and it
   * also narrows the lock — issuing an invoice number does not serialize against
   * issuing a bill number.
   */
  it('counts each document type separately', async () => {
    const p = await party();
    for (const type of ['invoice', 'bill', 'payment_received'] as const) {
      await sql`
        INSERT INTO document_sequences (org_id, document_type, next_value)
        VALUES (${p.orgId}, ${type}, 1)
      `.execute(db.app);
    }

    const { rows } = await sql<{ document_type: string; next_value: bigint }>`
      SELECT document_type, next_value FROM document_sequences
      WHERE org_id = ${p.orgId}
    `.execute(db.app);

    // Sorted here rather than in SQL: ORDER BY on an ENUM orders by the declaration
    // ordinal, not alphabetically, which would make this assertion depend on the
    // order the type list happens to be written in.
    const counters = rows
      .map((row) => [row.document_type, String(row.next_value)])
      .sort((a, b) => a[0]!.localeCompare(b[0]!));

    expect(counters).toEqual([
      ['bill', '1'],
      ['invoice', '1'],
      ['payment_received', '1'],
    ]);
  });
});

/**
 * The grant-level consequence of D-34, asserted rather than assumed.
 *
 * `test/enforcement/grants.test.ts` proves the privilege matrix for every table. This
 * proves the thing the matrix implies but does not state: that a locking read on a
 * document is available to the app user, which is what lets the allocation service
 * refuse an over-allocation (C3). The ledger's tables cannot do this — MySQL requires
 * UPDATE/DELETE alongside SELECT for `FOR UPDATE`, and withholding those is how
 * journal immutability is enforced (D-14).
 */
describe('a document row can be locked by the app user', () => {
  it('permits SELECT … FOR UPDATE on ar_documents', async () => {
    const p = await party();
    const document = newUuidBuffer();
    await insertArDocument(p, { id: document }).execute(db.app);

    const connection = await db.openAppConnection();
    try {
      const outcome = await connection.db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ id: Buffer }>`
          SELECT id FROM ar_documents WHERE org_id = ${p.orgId} AND id = ${document} FOR UPDATE
        `.execute(trx);
        return rows.length;
      });
      expect(outcome).toBe(1);
    } finally {
      await connection.close();
    }
  });
});

/**
 * `org_accounting_settings` (OB-066a), and the two properties that made it a table
 * rather than two columns on `orgs`.
 *
 * The composite foreign key is the whole argument. `orgs` has no `org_id`, so the
 * only reference it could carry is a single-column one that another org's account
 * satisfies — the shape the tenancy pattern exists to forbid. Here it is
 * `(org_id, id)` and the database says so.
 */
describe('org_accounting_settings', () => {
  it('refuses a nomination naming another org’s account', async () => {
    const [mine, theirs] = await Promise.all([party(), party()]);
    const foreign = await db.factories.account({
      orgId: theirs.orgId,
      type: 'asset',
      normalBalance: 'debit',
    });

    await expect(
      db.app
        .insertInto('org_accounting_settings')
        .values({ org_id: mine.orgId, receivable_control_account_id: foreign.id })
        .execute(),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });
  });

  /**
   * RESTRICT, so a nominated account cannot be deleted out from under the org
   * posting to it. The service layer never sees this — `deleteAccount` already
   * refuses an account with postings — and it is the backstop for the account that
   * was nominated before anything was ever posted.
   */
  it('pins the account it names', async () => {
    const p = await party();
    const account = await db.factories.account({
      orgId: p.orgId,
      type: 'asset',
      normalBalance: 'debit',
    });
    await db.app
      .insertInto('org_accounting_settings')
      .values({ org_id: p.orgId, receivable_control_account_id: account.id })
      .execute();

    await expect(
      db.app.deleteFrom('accounts').where('id', '=', account.id).execute(),
    ).rejects.toMatchObject({ errno: ROW_IS_REFERENCED });
  });

  /** Both sides separately nullable: an org that only invoices needs one of them. */
  it('accepts a row nominating one side only', async () => {
    const p = await party();
    const account = await db.factories.account({
      orgId: p.orgId,
      type: 'asset',
      normalBalance: 'debit',
    });

    await expect(
      db.app
        .insertInto('org_accounting_settings')
        .values({ org_id: p.orgId, receivable_control_account_id: account.id })
        .execute(),
    ).resolves.toBeDefined();
  });

  /** One row per org, which is what makes the settings repository's upsert safe. */
  it('refuses a second row for the same org', async () => {
    const p = await party();
    await db.app.insertInto('org_accounting_settings').values({ org_id: p.orgId }).execute();

    await expect(
      db.app.insertInto('org_accounting_settings').values({ org_id: p.orgId }).execute(),
    ).rejects.toMatchObject({ errno: DUPLICATE_KEY });
  });
});

/**
 * The two columns OB-066a added to tables that already existed.
 *
 * Both are asserted against `information_schema` rather than by exercising them,
 * because what is being claimed is a property of the schema: `applies_to` defaults
 * to `both` — the value every row meant while the column did not exist — and
 * `payments` carries the index its keyset needs. A behavioural test of the latter
 * would pass on a filesort, which is the thing it exists to rule out.
 */
describe('the columns and indexes OB-066a added', () => {
  it('defaults tax_rates.applies_to to both', async () => {
    const { rows } = await sql<{ column_default: string | null; column_type: string }>`
      SELECT COLUMN_DEFAULT AS column_default, COLUMN_TYPE AS column_type
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND TABLE_NAME = 'tax_rates' AND COLUMN_NAME = 'applies_to'
    `.execute(db.migrator);

    expect(rows[0]?.column_default).toBe('both');
    expect(rows[0]?.column_type).toBe("enum('sales','purchases','both')");
  });

  /**
   * `paymentPageSchema` mandates `(created_at, id)` (D-21), and without this index
   * every page is a filesort. Asserted as the index's exact column order, because
   * an index on `(org_id, created_at)` alone would satisfy a laxer test and would
   * still leave the tiebreak unsorted.
   */
  it('gives payments the keyset index its contract requires', async () => {
    const { rows } = await sql<{ column_name: string }>`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND TABLE_NAME = 'payments' AND INDEX_NAME = 'idx_payments_org_created'
      ORDER BY SEQ_IN_INDEX
    `.execute(db.migrator);

    expect(rows.map((row) => row.column_name)).toEqual(['org_id', 'created_at', 'id']);
  });
});
