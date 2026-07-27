import { sql, type RawBuilder } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * The banking schema (OB-074, ROADMAP D-41 through D-46).
 *
 * Three kinds of claim, and they need different tests:
 *
 *  - **The grant.** E2 says a statement line is never modified after import, and
 *    that is a privilege rather than a constraint — so it is asserted as the *app*
 *    user, against a real row, and it mirrors gate A6's block for `journals` in
 *    `test/db/harness.test.ts`. This is the criterion the ticket owns.
 *
 *  - **Impossibility.** A duplicate line, a proposal whose type and target disagree,
 *    a second open session on one account, a rule with no conditions. Each of these
 *    is also a rule some service will enforce, and each is asserted here so the
 *    service is the second line of defence rather than the only one.
 *
 *  - **Absence.** E7 and E8 are claims about references that must not exist — a
 *    reconciliation session coupled to a fiscal period, a rule reachable from a
 *    posted entry — and the only way to assert one is to read the live schema and
 *    find nothing. A test written against the columns that *do* exist would pass
 *    unchanged the day somebody adds the coupling.
 */
const db = useTestDatabase();

/** mysql2 errnos, named because a bare number in an expectation reads as noise. */
const ACCESS_DENIED = 1142;
const DUPLICATE_KEY = 1062;
const NO_REFERENCED_ROW = 1452;
const ROW_IS_REFERENCED = 1451;
const CHECK_VIOLATED = 3819;

interface Scene {
  readonly orgId: Buffer;
  readonly userId: Buffer;
  readonly periodId: Buffer;
  readonly bankAccountId: Buffer;
  readonly ledgerAccountId: Buffer;
  readonly expenseAccountId: Buffer;
  readonly contactId: Buffer;
  readonly importId: Buffer;
}

let sceneSequence = 0;

/** An org with a bank account and one import to hang statement lines off. */
async function scene(): Promise<Scene> {
  const seq = (sceneSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  // One period per org, reused by every journal below: `factories.journal` creates
  // its own otherwise and the second collides on `uq_fiscal_periods_org_start`, a
  // fixture failure that reads like a schema failure.
  const period = await db.factories.fiscalPeriod({ orgId: org.id });
  const [cash, expense] = await Promise.all([
    db.factories.account({ orgId: org.id, type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, type: 'expense', normalBalance: 'debit' }),
  ]);

  const contactId = newUuidBuffer();
  await sql`
    INSERT INTO contacts (id, org_id, display_name, is_vendor)
    VALUES (${contactId}, ${org.id}, ${`Vendor ${seq}`}, 1)
  `.execute(db.app);

  const bankAccountId = newUuidBuffer();
  await sql`
    INSERT INTO bank_accounts (id, org_id, account_id, name)
    VALUES (${bankAccountId}, ${org.id}, ${cash.id}, ${`Current account ${seq}`})
  `.execute(db.app);

  const importId = newUuidBuffer();
  await sql`
    INSERT INTO bank_statement_imports
      (id, org_id, bank_account_id, format, filename, file_hash,
       lines_read, lines_duplicate, imported_by_user_id)
    VALUES (
      ${importId}, ${org.id}, ${bankAccountId}, 'csv', 'january.csv',
      ${'a'.repeat(64)}, 2, 0, ${user.id}
    )
  `.execute(db.app);

  return {
    orgId: org.id,
    userId: user.id,
    periodId: period.id,
    bankAccountId,
    ledgerAccountId: cash.id,
    expenseAccountId: expense.id,
    contactId,
    importId,
  };
}

interface LineOverrides {
  readonly id?: Buffer;
  readonly bankAccountId?: Buffer;
  readonly importId?: Buffer;
  readonly amountMinor?: number;
  readonly fingerprint?: string;
  readonly occurrenceIndex?: number;
}

/** The £4.50 coffee, going out — so a negative amount, because a line is signed. */
function insertLine(s: Scene, overrides: LineOverrides = {}): RawBuilder<unknown> {
  return sql`
    INSERT INTO bank_statement_lines
      (id, org_id, bank_account_id, import_id, posted_date, description,
       amount_minor, fingerprint, occurrence_index)
    VALUES (
      ${overrides.id ?? newUuidBuffer()},
      ${s.orgId},
      ${overrides.bankAccountId ?? s.bankAccountId},
      ${overrides.importId ?? s.importId},
      ${'2026-03-04'},
      ${'COFFEE SHOP'},
      ${overrides.amountMinor ?? -450},
      ${overrides.fingerprint ?? 'c'.repeat(64)},
      ${overrides.occurrenceIndex ?? 0}
    )
  `;
}

/** The errno a statement failed with, or `null` if it succeeded. */
async function errnoOf(statement: Promise<unknown>): Promise<number | null> {
  try {
    await statement;
    return null;
  } catch (error) {
    const errno = (error as { readonly errno?: unknown }).errno;
    if (typeof errno !== 'number') throw error;
    return errno;
  }
}

/**
 * Criterion E2, and the reason this ticket exists (ROADMAP D-42).
 *
 * Asserted as `openbooks_app` on a genuine row, exactly as gate A6 asserts it for
 * `journals`. The privilege matrix in `test/enforcement/grants.test.ts` covers the
 * same ground table-driven and with no-op statements; this covers it the way the
 * application will actually hit it, so a refusal here cannot be an artifact of a
 * `WHERE 1 = 0` probe.
 */
describe('a statement line is never modified after import (E2)', () => {
  it('is refused UPDATE on bank_statement_lines', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);

    const connection = await db.openAppConnection();
    try {
      await expect(
        sql`
          UPDATE bank_statement_lines SET description = 'rewritten' WHERE id = ${lineId}
        `.execute(connection.db),
      ).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR', errno: ACCESS_DENIED });
    } finally {
      await connection.close();
    }
  });

  it('is refused DELETE on bank_statement_lines', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);

    const connection = await db.openAppConnection();
    try {
      await expect(
        sql`DELETE FROM bank_statement_lines WHERE id = ${lineId}`.execute(connection.db),
      ).rejects.toMatchObject({ errno: ACCESS_DENIED });
    } finally {
      await connection.close();
    }
  });

  it('may still INSERT and SELECT, so the denial is the grant and not a dead connection', async () => {
    const s = await scene();
    const connection = await db.openAppConnection();

    try {
      await expect(insertLine(s).execute(connection.db)).resolves.toBeDefined();
      const rows = await connection.db
        .selectFrom('bank_statement_lines')
        .select('id')
        .where('org_id', '=', s.orgId)
        .execute();
      expect(rows).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it('is refused UPDATE where the migrator is not, so the schema is not the thing stopping it', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);

    await expect(
      sql`
        UPDATE bank_statement_lines SET description = 'migrator can' WHERE id = ${lineId}
      `.execute(db.migrator),
    ).resolves.toBeDefined();
  });

  /**
   * The consequence of the grant split that D-14 records for `journals` and that
   * applies here for the same reason: MySQL requires SELECT *plus* UPDATE, DELETE or
   * LOCK TABLES for a locking read, so the app user cannot take one on a statement
   * line. Pinned because the import path is the obvious place to reach for
   * `FOR UPDATE` while deduping, and finding this out from a 1142 in OB-078 would
   * read as a missing grant rather than as an intended property. `FOR SHARE` is fine.
   */
  it('cannot take an exclusive row lock on a statement line', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);

    const connection = await db.openAppConnection();
    try {
      await expect(
        sql`SELECT id FROM bank_statement_lines WHERE id = ${lineId} FOR UPDATE`.execute(
          connection.db,
        ),
      ).rejects.toMatchObject({ errno: ACCESS_DENIED });
      await expect(
        sql`SELECT id FROM bank_statement_lines WHERE id = ${lineId} FOR SHARE`.execute(
          connection.db,
        ),
      ).resolves.toBeDefined();
    } finally {
      await connection.close();
    }
  });

  it('refuses UPDATE and DELETE on the import record and the session event log too', async () => {
    const s = await scene();
    const connection = await db.openAppConnection();

    try {
      expect(
        await errnoOf(
          sql`
            UPDATE bank_statement_imports SET filename = 'x' WHERE id = ${s.importId}
          `.execute(connection.db),
        ),
      ).toBe(ACCESS_DENIED);
      expect(
        await errnoOf(
          sql`DELETE FROM bank_statement_imports WHERE id = ${s.importId}`.execute(connection.db),
        ),
      ).toBe(ACCESS_DENIED);
      expect(
        await errnoOf(
          sql`DELETE FROM reconciliation_session_events WHERE 1 = 0`.execute(connection.db),
        ),
      ).toBe(ACCESS_DENIED);
    } finally {
      await connection.close();
    }
  });
});

/**
 * Criterion E1 (ROADMAP D-42). The unique key is
 * `(org_id, bank_account_id, fingerprint, occurrence_index)`, and each test here is
 * one of the four things that key has to get right at once.
 */
describe('re-import produces no duplicates, and the two coffees both survive (E1)', () => {
  it('refuses a second line with the same fingerprint at the same occurrence', async () => {
    const s = await scene();
    await insertLine(s).execute(db.app);

    expect(await errnoOf(insertLine(s).execute(db.app))).toBe(DUPLICATE_KEY);
  });

  /**
   * The hard case D-42 states so nobody rediscovers it: two genuinely distinct
   * transactions identical in every field the bank supplies. Both must exist.
   */
  it('admits a second line with the same fingerprint at the next occurrence', async () => {
    const s = await scene();
    await insertLine(s, { occurrenceIndex: 0 }).execute(db.app);
    await insertLine(s, { occurrenceIndex: 1 }).execute(db.app);

    const rows = await db.app
      .selectFrom('bank_statement_lines')
      .select(['occurrence_index'])
      .where('org_id', '=', s.orgId)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((row) => row.occurrence_index)).toEqual([0, 1]);
  });

  it('scopes the key to the bank account, so one payment in two accounts is two lines', async () => {
    const s = await scene();
    const other = newUuidBuffer();
    await sql`
      INSERT INTO bank_accounts (id, org_id, account_id, name)
      VALUES (${other}, ${s.orgId}, ${s.expenseAccountId}, 'Second account')
    `.execute(db.app);

    await insertLine(s).execute(db.app);
    await expect(insertLine(s, { bankAccountId: other }).execute(db.app)).resolves.toBeDefined();
  });

  it('scopes the key to the org, so two tenants banking at one bank do not collide', async () => {
    const a = await scene();
    const b = await scene();
    await insertLine(a).execute(db.app);
    await expect(insertLine(b).execute(db.app)).resolves.toBeDefined();
  });

  it('refuses a line whose bank account belongs to another org', async () => {
    const a = await scene();
    const b = await scene();
    // The composite foreign key has nothing to point at: `(a.orgId, b.bankAccountId)`
    // is not a row in `bank_accounts (org_id, id)`. Tenancy is structural here, not
    // checked (see src/db/migrations/README.md).
    expect(await errnoOf(insertLine(a, { bankAccountId: b.bankAccountId }).execute(db.app))).toBe(
      NO_REFERENCED_ROW,
    );
  });

  /**
   * The one money column in this system that is signed, and the one with no CHECK
   * on it. A bank line arrives with a sign already on it; E4's equation is over
   * amounts; and a zero-amount line is a thing some banks actually emit for a
   * reversal pair, so refusing one would refuse a statement the bank considers
   * valid. See the header of `0006_banking`.
   */
  it('stores the amount signed, with no positivity constraint and no direction column', async () => {
    const s = await scene();
    await insertLine(s, { amountMinor: -450, occurrenceIndex: 0 }).execute(db.app);
    await insertLine(s, { amountMinor: 12_000, occurrenceIndex: 1 }).execute(db.app);
    await insertLine(s, { amountMinor: 0, occurrenceIndex: 2 }).execute(db.app);

    const rows = await db.app
      .selectFrom('bank_statement_lines')
      .select(['amount_minor'])
      .where('org_id', '=', s.orgId)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((row) => row.amount_minor)).toEqual([-450n, 12_000n, 0n]);
    expect(typeof rows[0]?.amount_minor).toBe('bigint');

    const { rows: direction } = await sql<{ column_name: string }>`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND TABLE_NAME = 'bank_statement_lines'
        AND COLUMN_NAME = 'direction'
    `.execute(db.migrator);
    expect(direction).toEqual([]);
  });

  it('keeps the import that created a line alive', async () => {
    const s = await scene();
    await insertLine(s).execute(db.app);
    // RESTRICT, and the app user has no DELETE on `bank_statement_imports` anyway —
    // this is the migrator, so the refusal is the constraint rather than the grant.
    expect(
      await errnoOf(
        sql`DELETE FROM bank_statement_imports WHERE id = ${s.importId}`.execute(db.migrator),
      ),
    ).toBe(ROW_IS_REFERENCED);
  });
});

/**
 * ROADMAP D-46. The claim is about a column that must not exist, so it is asserted
 * by reading the live schema — a test written against the columns that do exist
 * would pass unchanged the day someone adds `current_balance_minor`.
 */
describe('a bank account is a ledger account, not a second balance (D-46)', () => {
  it('holds no balance column anywhere in the banking schema outside a reconciliation', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND TABLE_NAME LIKE 'bank\\_%'
        AND COLUMN_NAME LIKE '%balance%'
    `.execute(db.migrator);

    // The only balances in M4 are the statement's *claim* on a reconciliation
    // session and the figure a finalise event asserted. Neither is on a bank
    // account, and a bank account's balance is its ledger account's, computed from
    // journal lines like every other balance in this system.
    expect(rows).toEqual([]);
  });

  it('refuses two bank accounts pointing at one ledger account', async () => {
    const s = await scene();
    expect(
      await errnoOf(
        sql`
          INSERT INTO bank_accounts (id, org_id, account_id, name)
          VALUES (${newUuidBuffer()}, ${s.orgId}, ${s.ledgerAccountId}, 'Duplicate')
        `.execute(db.app),
      ),
    ).toBe(DUPLICATE_KEY);
  });
});

/**
 * Criterion E7 and criterion E8. Both are statements about references that are not
 * there, read out of `information_schema` rather than argued from the source.
 */
describe('the two absences the milestone rests on', () => {
  it('couples no banking table to a fiscal period (E7)', async () => {
    // D-45: a bank reconciliation says "the bank agreed with us" and a period close
    // says "we are done changing this month". A reference either way is the coupling
    // that lets one account's straggler freeze the ledger, or lets closing a period
    // silently assert a reconciliation nobody performed. Both directions are checked,
    // because either one alone would leave the other half free to arrive later.
    const { rows: outbound } = await sql<{ table_name: string }>`
      SELECT TABLE_NAME AS table_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND REFERENCED_TABLE_NAME = 'fiscal_periods'
        AND (TABLE_NAME LIKE 'bank\\_%' OR TABLE_NAME LIKE 'reconciliation\\_%')
    `.execute(db.migrator);
    expect(outbound).toEqual([]);

    const { rows: inbound } = await sql<{ table_name: string }>`
      SELECT TABLE_NAME AS table_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND REFERENCED_TABLE_NAME LIKE 'reconciliation\\_%'
        AND TABLE_NAME NOT LIKE 'reconciliation\\_%'
        AND TABLE_NAME NOT LIKE 'bank\\_%'
    `.execute(db.migrator);
    expect(inbound).toEqual([]);
  });

  it('makes a bank rule reachable only from a proposal (E8)', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT DISTINCT TABLE_NAME AS table_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND REFERENCED_TABLE_NAME = 'bank_rules'
    `.execute(db.migrator);

    // D-44: rules act on proposals only. A `bank_rule_id` on `bank_line_clearings`
    // or on a journal would look like harmless provenance and would be the backwards
    // path that lets editing a rule restate last quarter's coding.
    expect(rows.map((row) => row.table_name).sort()).toEqual([
      'bank_match_proposals',
      'bank_rule_dimensions',
    ]);
  });
});

describe('a proposal names exactly one target (D-43)', () => {
  interface ProposalTargets {
    readonly lineId: Buffer;
    readonly journalId?: Buffer;
    readonly accountId?: Buffer;
  }

  async function insertProposal(
    s: Scene,
    type: string,
    targets: ProposalTargets,
  ): Promise<number | null> {
    return errnoOf(
      sql`
        INSERT INTO bank_match_proposals
          (id, org_id, statement_line_id, proposal_type, journal_id, ar_document_id,
           ap_document_id, account_id, score, reason_code)
        VALUES (
          ${newUuidBuffer()}, ${s.orgId}, ${targets.lineId}, ${type},
          ${targets.journalId ?? null}, ${null}, ${null}, ${targets.accountId ?? null},
          500, 'exact_amount_and_date'
        )
      `.execute(db.app),
    );
  }

  it('accepts a coding proposal with an account and nothing else', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);

    expect(await insertProposal(s, 'coding', { lineId, accountId: s.expenseAccountId })).toBeNull();
  });

  it('refuses a coding proposal carrying a journal', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    const journal = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });

    expect(
      await insertProposal(s, 'coding', {
        lineId,
        accountId: s.expenseAccountId,
        journalId: journal.id,
      }),
    ).toBe(CHECK_VIOLATED);
  });

  it('refuses a journal proposal with no journal', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);

    expect(await insertProposal(s, 'journal', { lineId })).toBe(CHECK_VIOLATED);
  });

  it('lets a proposal be deleted, because a proposal is disposable', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    await insertProposal(s, 'coding', { lineId, accountId: s.expenseAccountId });

    const result = await db.app
      .deleteFrom('bank_match_proposals')
      .where('org_id', '=', s.orgId)
      .executeTakeFirst();
    expect(result.numDeletedRows).toBe(1n);
  });
});

describe('a rule is a lookup, not an engine (D-44)', () => {
  interface RuleOverrides {
    readonly description?: string;
    readonly mode?: string;
    readonly min?: number;
    readonly max?: number;
  }

  function insertRule(s: Scene, overrides: RuleOverrides): RawBuilder<unknown> {
    return sql`
      INSERT INTO bank_rules
        (id, org_id, name, match_description, match_description_mode,
         match_amount_min_minor, match_amount_max_minor, set_account_id)
      VALUES (
        ${newUuidBuffer()}, ${s.orgId}, ${`Rule ${newUuidBuffer().toString('hex')}`},
        ${overrides.description ?? null}, ${overrides.mode ?? null},
        ${overrides.min ?? null}, ${overrides.max ?? null}, ${s.expenseAccountId}
      )
    `;
  }

  it('refuses a rule with no conditions, which would match every line', async () => {
    const s = await scene();
    expect(await errnoOf(insertRule(s, {}).execute(db.app))).toBe(CHECK_VIOLATED);
  });

  it('refuses a description with no match mode, and a mode with no description', async () => {
    const s = await scene();
    expect(await errnoOf(insertRule(s, { description: 'TESCO' }).execute(db.app))).toBe(
      CHECK_VIOLATED,
    );
    expect(await errnoOf(insertRule(s, { mode: 'contains', min: -500 }).execute(db.app))).toBe(
      CHECK_VIOLATED,
    );
  });

  it('refuses an amount range that runs backwards', async () => {
    const s = await scene();
    expect(await errnoOf(insertRule(s, { min: 900, max: 100 }).execute(db.app))).toBe(
      CHECK_VIOLATED,
    );
  });

  it('accepts a negative range, because the bound is on the signed amount', async () => {
    const s = await scene();
    // An outbound rule reads the way the number line does: -5000 to -100.
    expect(await errnoOf(insertRule(s, { min: -5000, max: -100 }).execute(db.app))).toBeNull();
  });

  it('accepts the degenerate range, which is how an exact amount is spelled', async () => {
    const s = await scene();
    expect(await errnoOf(insertRule(s, { min: -450, max: -450 }).execute(db.app))).toBeNull();
  });
});

describe('an import mapping matches its amount convention (OB-076)', () => {
  interface MappingOverrides {
    readonly convention?: string;
    readonly amount?: number;
    readonly debit?: number;
    readonly credit?: number;
  }

  function insertMapping(s: Scene, overrides: MappingOverrides): RawBuilder<unknown> {
    return sql`
      INSERT INTO bank_import_mappings
        (id, org_id, bank_account_id, name, date_order, amount_convention,
         posted_date_column, description_column, amount_column, debit_column, credit_column)
      VALUES (
        ${newUuidBuffer()}, ${s.orgId}, ${s.bankAccountId},
        ${`Mapping ${newUuidBuffer().toString('hex')}`}, 'dmy',
        ${overrides.convention ?? 'signed'}, 0, 1,
        ${overrides.amount ?? null}, ${overrides.debit ?? null}, ${overrides.credit ?? null}
      )
    `;
  }

  it('accepts a single signed amount column', async () => {
    const s = await scene();
    expect(await errnoOf(insertMapping(s, { amount: 2 }).execute(db.app))).toBeNull();
  });

  it('accepts the reversed-sign convention with the same single column', async () => {
    const s = await scene();
    expect(
      await errnoOf(insertMapping(s, { convention: 'signed_reversed', amount: 2 }).execute(db.app)),
    ).toBeNull();
  });

  it('accepts a paid-in and paid-out pair', async () => {
    const s = await scene();
    expect(
      await errnoOf(
        insertMapping(s, { convention: 'debit_credit_columns', debit: 2, credit: 3 }).execute(
          db.app,
        ),
      ),
    ).toBeNull();
  });

  it('refuses the half-configured mapping that would drop every incoming line', async () => {
    const s = await scene();
    expect(
      await errnoOf(
        insertMapping(s, { convention: 'debit_credit_columns', debit: 2 }).execute(db.app),
      ),
    ).toBe(CHECK_VIOLATED);
  });

  it('refuses columns that disagree with the convention', async () => {
    const s = await scene();
    expect(
      await errnoOf(
        insertMapping(s, { convention: 'signed', debit: 2, credit: 3 }).execute(db.app),
      ),
    ).toBe(CHECK_VIOLATED);
    expect(
      await errnoOf(
        insertMapping(s, { convention: 'debit_credit_columns', amount: 2 }).execute(db.app),
      ),
    ).toBe(CHECK_VIOLATED);
  });
});

describe('a reconciliation session is a lock, and its history is not (D-45, E6)', () => {
  function insertSession(
    s: Scene,
    columns: { readonly state?: string; readonly finalisedAt?: string | null } = {},
  ): RawBuilder<unknown> {
    return sql`
      INSERT INTO reconciliation_sessions
        (id, org_id, bank_account_id, end_date, statement_closing_balance_minor,
         state, finalised_at, created_by_user_id)
      VALUES (
        ${newUuidBuffer()}, ${s.orgId}, ${s.bankAccountId}, '2026-03-31', ${125_000},
        ${columns.state ?? 'in_progress'}, ${columns.finalisedAt ?? null}, ${s.userId}
      )
    `;
  }

  it('refuses a second open session on one bank account', async () => {
    const s = await scene();
    await insertSession(s).execute(db.app);
    expect(await errnoOf(insertSession(s).execute(db.app))).toBe(DUPLICATE_KEY);
  });

  it('admits any number of finalised sessions on one bank account', async () => {
    const s = await scene();
    const finalised = { state: 'finalised', finalisedAt: '2026-04-01 09:00:00.000' };
    await insertSession(s, finalised).execute(db.app);
    // NULLs are distinct in a unique index, which is the whole reason `open_marker`
    // is NULL once a session closes. Three finalised sessions and one open one.
    expect(await errnoOf(insertSession(s, finalised).execute(db.app))).toBeNull();
    expect(await errnoOf(insertSession(s, finalised).execute(db.app))).toBeNull();
    expect(await errnoOf(insertSession(s).execute(db.app))).toBeNull();
  });

  it('refuses a finalised session with no finalised_at', async () => {
    const s = await scene();
    expect(await errnoOf(insertSession(s, { state: 'finalised' }).execute(db.app))).toBe(
      CHECK_VIOLATED,
    );
  });

  it('lets the app user take an exclusive lock on a session, which is why state is stored', async () => {
    const s = await scene();
    await insertSession(s).execute(db.app);
    const connection = await db.openAppConnection();

    try {
      // The `journal_sequences` trick (D-14): the lock has to be testable under
      // contention, and MySQL needs UPDATE, DELETE or LOCK TABLES for a locking
      // read. `bank_statement_lines` above cannot do this; this table must.
      await expect(
        sql`
          SELECT id FROM reconciliation_sessions WHERE org_id = ${s.orgId} FOR UPDATE
        `.execute(connection.db),
      ).resolves.toBeDefined();
    } finally {
      await connection.close();
    }
  });

  it('requires an asserted balance on a finalise and refuses one on a reopen', async () => {
    const s = await scene();
    const sessionId = newUuidBuffer();
    await sql`
      INSERT INTO reconciliation_sessions
        (id, org_id, bank_account_id, end_date, statement_closing_balance_minor,
         state, finalised_at, created_by_user_id)
      VALUES (
        ${sessionId}, ${s.orgId}, ${s.bankAccountId}, '2026-03-31', ${125_000},
        'finalised', '2026-04-01 09:00:00.000', ${s.userId}
      )
    `.execute(db.app);

    const event = (type: string, balance: number | null): RawBuilder<unknown> => sql`
      INSERT INTO reconciliation_session_events
        (id, org_id, session_id, event_type, asserted_balance_minor, created_by_user_id)
      VALUES (${newUuidBuffer()}, ${s.orgId}, ${sessionId}, ${type}, ${balance}, ${s.userId})
    `;

    expect(await errnoOf(event('finalised', 125_000).execute(db.app))).toBeNull();
    expect(await errnoOf(event('finalised', null).execute(db.app))).toBe(CHECK_VIOLATED);
    expect(await errnoOf(event('reopened', null).execute(db.app))).toBeNull();
    expect(await errnoOf(event('reopened', 125_000).execute(db.app))).toBe(CHECK_VIOLATED);
  });
});

/**
 * Criterion E4, and the one place this schema deliberately departs from what it
 * looks like it should do.
 */
describe('a clearing links a line to what cleared it (E4)', () => {
  interface ClearOverrides {
    readonly cleared: number;
    readonly difference?: number;
    readonly method?: string;
    readonly differenceAccountId?: Buffer;
  }

  async function clear(
    s: Scene,
    lineId: Buffer,
    journalId: Buffer,
    overrides: ClearOverrides,
  ): Promise<number | null> {
    return errnoOf(
      sql`
        INSERT INTO bank_line_clearings
          (id, org_id, statement_line_id, method, cleared_journal_id,
           cleared_amount_minor, difference_amount_minor, difference_account_id,
           created_by_user_id)
        VALUES (
          ${newUuidBuffer()}, ${s.orgId}, ${lineId}, ${overrides.method ?? 'link_entry'},
          ${journalId}, ${overrides.cleared}, ${overrides.difference ?? 0},
          ${overrides.differenceAccountId ?? null}, ${s.userId}
        )
      `.execute(db.app),
    );
  }

  it('clears a line once and refuses a second clearing of it', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    // Sequential rather than concurrent: `factories.journal` allocates from
    // `journal_sequences` under `FOR UPDATE`, so two at once on a pooled handle
    // contend for the counter, which is a race this test is not about.
    const first = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });
    const second = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });

    expect(await clear(s, lineId, first.id, { cleared: -450 })).toBeNull();
    expect(await clear(s, lineId, second.id, { cleared: -450 })).toBe(DUPLICATE_KEY);
  });

  it('refuses one journal clearing two lines', async () => {
    const s = await scene();
    const [a, b] = [newUuidBuffer(), newUuidBuffer()];
    await insertLine(s, { id: a, occurrenceIndex: 0 }).execute(db.app);
    await insertLine(s, { id: b, occurrenceIndex: 1 }).execute(db.app);
    const journal = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });

    expect(await clear(s, a, journal.id, { cleared: -450 })).toBeNull();
    expect(await clear(s, b, journal.id, { cleared: -450 })).toBe(DUPLICATE_KEY);
  });

  it('records a signed difference against the account it posts to, which is E4', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    const journal = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });

    // A -450 line cleared by a -430 entry: the -20 is the bank charge the person
    // named in created_by_user_id accepted, recorded where they accepted it and
    // pointed at the account it posts to. `cleared + difference = line.amount` is
    // the invariant, and the schema cannot check it — the other operand is on
    // another table — so OB-081 owns it and OB-088 asserts it.
    expect(
      await clear(s, lineId, journal.id, {
        cleared: -430,
        difference: -20,
        differenceAccountId: s.expenseAccountId,
      }),
    ).toBeNull();

    const row = await db.app
      .selectFrom('bank_line_clearings')
      .select(['cleared_amount_minor', 'difference_amount_minor'])
      .where('org_id', '=', s.orgId)
      .executeTakeFirstOrThrow();
    expect(row.cleared_amount_minor).toBe(-430n);
    expect(row.difference_amount_minor).toBe(-20n);
    expect(typeof row.difference_amount_minor).toBe('bigint');
  });

  it('refuses a difference with nowhere to post it', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    const journal = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });

    // `clearing_difference_unaccounted`, stated in the schema.
    expect(await clear(s, lineId, journal.id, { cleared: -430, difference: -20 })).toBe(
      CHECK_VIOLATED,
    );
  });

  it('refuses any difference at all on a post_entry clearing', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    const journal = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });

    // The entry was created *for* the line, so it agrees by construction; a
    // difference on one would mean it was posted for an amount nobody asked for.
    expect(
      await clear(s, lineId, journal.id, {
        method: 'post_entry',
        cleared: -430,
        difference: -20,
        differenceAccountId: s.expenseAccountId,
      }),
    ).toBe(CHECK_VIOLATED);
  });

  /**
   * The departure. A clearing looks like it should be append-only beside the
   * statement line it references, and it is not, for the reason `ar_allocations` is
   * not: it posts no journal. Un-matching a line restates no financial statement,
   * and the journal it named is still in `journals` where nothing may touch it.
   */
  it('may be deleted, for the reason an allocation may be', async () => {
    const s = await scene();
    const lineId = newUuidBuffer();
    await insertLine(s, { id: lineId }).execute(db.app);
    const journal = await db.factories.journal({ orgId: s.orgId, periodId: s.periodId });
    await clear(s, lineId, journal.id, { cleared: -450 });

    const result = await db.app
      .deleteFrom('bank_line_clearings')
      .where('org_id', '=', s.orgId)
      .executeTakeFirst();
    expect(result.numDeletedRows).toBe(1n);

    // And the line it referenced is untouched, which is the point of the split.
    const rows = await db.app
      .selectFrom('bank_statement_lines')
      .select('id')
      .where('org_id', '=', s.orgId)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
