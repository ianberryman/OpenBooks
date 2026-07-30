import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { APP_DB_USER, MIGRATOR_DB_USER } from './bootstrap';
import { SYSTEM_ROLE_UUIDS } from './factories';
import { useTestDatabase } from './harness';

/**
 * The harness proving itself.
 *
 * Everything in OB-025 and OB-026 is a claim about a real MySQL 8, the real
 * migration path, and the *restricted* application identity (spec §11). If any of
 * those three is quietly not what it appears, those suites still pass and mean
 * nothing — which is the failure ROADMAP names as a live risk. This file is the
 * check on all three.
 */
describe('test database harness', () => {
  const db = useTestDatabase();

  describe('migrations', () => {
    it('applied the full registered set via the real migrator', async () => {
      const { rows } = await sql<{ name: string }>`
        SELECT name FROM kysely_migration ORDER BY name
      `.execute(db.migrator);

      // Ordered by name, which is also the order they ran in. `0999_app_grants` is
      // last on purpose: MySQL refuses a table-level GRANT on a table that does not
      // exist yet, so every table it names is created in one of the five above it.
      // `0004` is skipped and stays skipped — it is the number the grants migration
      // held before OB-060 renumbered it, and reusing it would make one prefix mean
      // two migrations in this project's history.
      expect(rows.map((row) => row.name)).toEqual([
        '0001_tenancy',
        '0002_ledger',
        '0003_idempotency',
        '0005_subledger',
        '0006_banking',
        '0007_invoice_delivery',
        '0008_recurring_dunning',
        '0009_bill_capture',
        '0010_platform',
        '0011_payment_processing',
        '0012_cash_application',
        '0013_pay_bills',
        '0014_fixed_assets',
        '0015_procure_to_pay',
        '0016_budgets',
        '0999_app_grants',
      ]);
    });

    /**
     * The structural half of OB-060, which the list above only demonstrates.
     *
     * Asserting that the applied names happen to end in `0999_app_grants` says
     * nothing about the next migration somebody adds. This says what the rename
     * bought: the grants migration sorts last against the whole registry, so a table
     * created by any other migration is created before the GRANT that names it.
     * Reading `MIGRATIONS` rather than the database is deliberate — the failure
     * should arrive when the registry gains a badly-numbered entry, not after
     * someone has migrated with it.
     */
    it('keeps the grants migration sorting last in the registry', () => {
      const names = Object.keys(MIGRATIONS).sort();
      expect(names.at(-1)).toBe('0999_app_grants');
    });

    it('created the ledger tables with their CHECK constraints', async () => {
      const { rows } = await sql<{ constraint_name: string }>`
        SELECT CONSTRAINT_NAME AS constraint_name
        FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ${db.info.database}
      `.execute(db.migrator);

      const names = rows.map((row) => row.constraint_name);
      expect(names).toContain('chk_journal_lines_one_sided');
      expect(names).toContain('chk_journals_invocation_mode');
      expect(names).toContain('chk_fiscal_periods_closed_consistency');
      // M4's equivalents. `chk_bmp_target` is the one that makes
      // `bank_match_proposals`' four nullable target columns a tagged union rather
      // than a bag of optional fields; `chk_rs_finalised` is the session lock's
      // state and timestamp kept in step, as `fiscal_periods` does for its close.
      expect(names).toContain('chk_bmp_target');
      expect(names).toContain('chk_rs_finalised');
    });
  });

  describe('seeds', () => {
    it('has the fixed 69-permission catalog', async () => {
      const row = await db.app
        .selectFrom('permissions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();

      // 56 since PB (D-109) added pending_payments.read/write and disbursements.issue;
      // 60 since L (D-117) added recurring_journals.read/write and fixed_assets.read/write;
      // 67 since M added purchase_orders.read/write, estimates.read/write and
      // expenses.read/write/approve.
      // 69 since N (Budgets) added budgets.read/write.
      expect(Number(row.count)).toBe(69);
    });

    it('has the six system roles at their reserved ids', async () => {
      const rows = await db.app
        .selectFrom('roles')
        .select(['id', 'code'])
        .where('is_system', '=', 1)
        .orderBy('code')
        .execute();

      expect(rows.map((row) => row.code)).toEqual([
        'ap_only',
        'approver',
        'ar_only',
        'bookkeeper',
        'owner',
        'read_only',
      ]);

      const owner = rows.find((row) => row.code === 'owner');
      const { rows: expected } = await sql<{ id: Buffer }>`
        SELECT UUID_TO_BIN(${SYSTEM_ROLE_UUIDS.owner}, 0) AS id
      `.execute(db.app);
      expect(owner!.id.equals(expected[0]!.id)).toBe(true);
    });

    it('survives the between-test reset', async () => {
      await db.reset();

      const row = await db.app
        .selectFrom('role_permissions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();

      expect(Number(row.count)).toBeGreaterThan(48);
    });
  });

  describe('isolation', () => {
    it('starts every test with no org rows', async () => {
      const rows = await db.app.selectFrom('orgs').select('id').execute();
      expect(rows).toEqual([]);
    });

    // Paired with the test above: whichever runs second would see the other's org
    // if the reset were not happening.
    it('does not leak rows into the next test', async () => {
      await db.factories.org();
      const rows = await db.app.selectFrom('orgs').select('id').execute();
      expect(rows).toHaveLength(1);
    });

    it('clears journals, which the app user itself cannot delete', async () => {
      await db.factories.journal();
      await db.reset();

      const rows = await db.app.selectFrom('journals').select('id').execute();
      expect(rows).toEqual([]);
    });
  });

  describe('factories', () => {
    it('builds a valid balanced journal from no arguments', async () => {
      const journal = await db.factories.journal();

      const lines = await db.app
        .selectFrom('journal_lines')
        .selectAll()
        .where('journal_id', '=', journal.id)
        .orderBy('line_number')
        .execute();

      expect(lines).toHaveLength(2);
      const debits = lines.reduce((total, line) => total + line.debit_minor, 0n);
      const credits = lines.reduce((total, line) => total + line.credit_minor, 0n);
      expect(debits).toBe(credits);
      expect(debits).toBeGreaterThan(0n);

      // Money and journal_lines.id are BIGINT, and the driver's typeCast returns
      // every BIGINT as a bigint — uniformly, not "number when it fits". The
      // generated types say so; this asserts the runtime agrees.
      expect(typeof lines[0]!.debit_minor).toBe('bigint');
      expect(typeof lines[0]!.id).toBe('bigint');

      // DATE is read as a string: constructing a Date from a calendar date invents
      // a moment, which is how an entry_date lands in the wrong fiscal period.
      const row = await db.app
        .selectFrom('journals')
        .select(['entry_date', 'org_id', 'invocation_mode', 'source'])
        .where('id', '=', journal.id)
        .executeTakeFirstOrThrow();
      expect(typeof row.entry_date).toBe('string');
      expect(row.source).toBe('manual');
      expect(row.invocation_mode).toBeNull();

      // Spec §11: journal_lines.org_id matches its parent. The composite foreign key
      // makes the violation inexpressible; this confirms the factory is exercising
      // that path rather than sidestepping it.
      for (const line of lines) {
        expect(line.org_id.equals(row.org_id)).toBe(true);
      }
    });

    it('places the default entry date inside the period', async () => {
      const journal = await db.factories.journal();
      const period = await db.app
        .selectFrom('fiscal_periods')
        .select(['start_date', 'end_date'])
        .where('id', '=', journal.periodId)
        .executeTakeFirstOrThrow();

      expect(journal.entryDate >= period.start_date).toBe(true);
      expect(journal.entryDate <= period.end_date).toBe(true);
    });

    it('sets invocation_mode for agent actors and refuses it for others', async () => {
      const agent = await db.factories.journal({ actorType: 'agent' });
      const row = await db.app
        .selectFrom('journals')
        .select('invocation_mode')
        .where('id', '=', agent.id)
        .executeTakeFirstOrThrow();
      expect(row.invocation_mode).toBe('interactive');

      await expect(
        db.factories.journal({ actorType: 'user', invocationMode: 'scheduled' }),
      ).rejects.toThrow(/only permitted for actor_type 'agent'/);
    });

    it('refuses to build an unbalanced or one-sided journal', async () => {
      const ledger = await db.factories.ledger();

      await expect(
        db.factories.journal({
          orgId: ledger.org.id,
          periodId: ledger.period.id,
          lines: [
            { accountId: ledger.debitAccount.id, debitMinor: 500n },
            { accountId: ledger.creditAccount.id, creditMinor: 400n },
          ],
        }),
      ).rejects.toThrow(/Unbalanced journal/);

      await expect(
        db.factories.journal({
          orgId: ledger.org.id,
          periodId: ledger.period.id,
          lines: [
            { accountId: ledger.debitAccount.id, debitMinor: 500n, creditMinor: 500n },
            { accountId: ledger.creditAccount.id, creditMinor: 500n },
          ],
        }),
      ).rejects.toThrow(/exactly one side must be positive/);
    });

    it('builds a closed period consistently with its CHECK constraint', async () => {
      const period = await db.factories.fiscalPeriod({ status: 'closed' });
      const row = await db.app
        .selectFrom('fiscal_periods')
        .select(['status', 'closed_at'])
        .where('id', '=', period.id)
        .executeTakeFirstOrThrow();

      expect(row.status).toBe('closed');
      expect(row.closed_at).not.toBeNull();
    });

    it('links a member to a seeded system role', async () => {
      const member = await db.factories.orgMember({ role: 'bookkeeper' });
      const row = await db.app
        .selectFrom('org_members')
        .innerJoin('roles', 'roles.id', 'org_members.role_id')
        .select('roles.code')
        .where('org_members.org_id', '=', member.orgId)
        .executeTakeFirstOrThrow();

      expect(row.code).toBe('bookkeeper');
    });
  });

  /**
   * Gate A6. Spec §11 requires this tested as the app user, not a superuser, which
   * is the entire reason the container provisions two identities from the Compose
   * init scripts. The CURRENT_USER assertion is what makes the rest of this block a
   * statement about production.
   */
  describe('the app user is genuinely restricted', () => {
    it('is connected as openbooks_app, not root', async () => {
      const connection = await db.openAppConnection();
      try {
        const { rows } = await sql<{ user: string }>`SELECT CURRENT_USER() AS user`.execute(
          connection.db,
        );
        expect(rows[0]!.user).toBe(`${APP_DB_USER}@%`);
      } finally {
        await connection.close();
      }
    });

    it('holds no UPDATE or DELETE grant on the journal tables', async () => {
      const connection = await db.openAppConnection();
      try {
        // A user may always read its own grants, which is why this is asserted from
        // the app connection. 0999_app_grants deliberately does not self-check:
        // information_schema privilege views are filtered by the querying user, so
        // the migrator cannot see the app user's grants at all.
        // The single column is named after the user ("Grants for openbooks_app@%"),
        // so it is read positionally.
        const { rows } = await sql<Record<string, string>>`SHOW GRANTS FOR CURRENT_USER()`.execute(
          connection.db,
        );
        const grants = rows.map((row) => Object.values(row)[0] ?? '');

        for (const table of ['journals', 'journal_lines']) {
          const onTable = grants.filter((grant) => grant.includes(`\`${table}\``));
          expect(onTable.some((grant) => /\bUPDATE\b|\bDELETE\b/.test(grant))).toBe(false);
        }
        expect(grants.some((grant) => /^GRANT SELECT, INSERT ON `openbooks`/.test(grant))).toBe(
          true,
        );
      } finally {
        await connection.close();
      }
    });

    it('is refused UPDATE on journals', async () => {
      const journal = await db.factories.journal();
      const connection = await db.openAppConnection();

      try {
        await expect(
          sql`UPDATE journals SET memo = 'rewritten' WHERE id = ${journal.id}`.execute(
            connection.db,
          ),
        ).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 });
      } finally {
        await connection.close();
      }
    });

    it('is refused DELETE on journals and journal_lines', async () => {
      const journal = await db.factories.journal();
      const connection = await db.openAppConnection();

      try {
        await expect(
          sql`DELETE FROM journal_lines WHERE journal_id = ${journal.id}`.execute(connection.db),
        ).rejects.toMatchObject({ errno: 1142 });
        await expect(
          sql`DELETE FROM journals WHERE id = ${journal.id}`.execute(connection.db),
        ).rejects.toMatchObject({ errno: 1142 });
      } finally {
        await connection.close();
      }
    });

    it('may still INSERT into journals, so the denial is the grant and not a dead connection', async () => {
      const ledger = await db.factories.ledger();
      const connection = await db.openAppConnection();

      try {
        const rows = await connection.db
          .selectFrom('journals')
          .select('id')
          .where('org_id', '=', ledger.org.id)
          .execute();
        expect(rows).toEqual([]);

        // Appending to the ledger is allowed; rewriting it is not. Corrections are
        // reversing entries (spec §2.2, ROADMAP D-02).
        // sequence_number is NOT NULL with no default, deliberately: it is
        // allocated from journal_sequences by the posting path (ROADMAP D-14), and
        // a default would let a journal exist without a reference. A literal is
        // fine here — this test is about the grant, not about allocation.
        await expect(
          sql`
            INSERT INTO journals
              (id, org_id, sequence_number, period_id, entry_date, actor_type, actor_id)
            VALUES (
              UUID_TO_BIN(UUID(), 0), ${ledger.org.id}, 9001, ${ledger.period.id},
              ${ledger.period.startDate}, 'user', ${ledger.user.id}
            )
          `.execute(connection.db),
        ).resolves.toBeDefined();
      } finally {
        await connection.close();
      }
    });

    it('can UPDATE a mutable table, so the restriction is per table', async () => {
      const org = await db.factories.org();
      const connection = await db.openAppConnection();

      try {
        const result = await connection.db
          .updateTable('orgs')
          .set({ name: 'Renamed' })
          .where('id', '=', org.id)
          .executeTakeFirst();

        expect(result.numUpdatedRows).toBe(1n);
      } finally {
        await connection.close();
      }
    });

    /**
     * A consequence of the grant split that is easy to hit and hard to guess.
     *
     * MySQL requires `SELECT` *plus* one of `UPDATE`, `DELETE`, or `LOCK TABLES` for
     * a locking read. The app user holds none of those on the journal tables, so
     * `SELECT ... FOR UPDATE` on `journals` is refused with the same ER_TABLEACCESS_
     * DENIED_ERROR as a write — while `FOR SHARE` is fine, and `FOR UPDATE` on
     * `fiscal_periods` is fine because that table is in the mutable allowlist.
     *
     * This is pinned here because OB-020 takes the period-lock check under a lock:
     * locking `fiscal_periods` works, locking a journal row does not, and finding
     * that out from a 1142 inside the posting path would read as a missing grant
     * rather than as an intended property.
     */
    it('cannot take an exclusive row lock on journals, but can on fiscal_periods', async () => {
      const journal = await db.factories.journal();
      const connection = await db.openAppConnection();

      try {
        await expect(
          sql`SELECT id FROM journals WHERE id = ${journal.id} FOR UPDATE`.execute(connection.db),
        ).rejects.toMatchObject({ errno: 1142 });

        await expect(
          sql`SELECT id FROM journals WHERE id = ${journal.id} FOR SHARE`.execute(connection.db),
        ).resolves.toBeDefined();

        await expect(
          sql`SELECT id FROM fiscal_periods WHERE id = ${journal.periodId} FOR UPDATE`.execute(
            connection.db,
          ),
        ).resolves.toBeDefined();
      } finally {
        await connection.close();
      }
    });

    it('is refused UPDATE where the migrator is not, so the schema is not the thing stopping it', async () => {
      const journal = await db.factories.journal();

      await expect(
        sql`UPDATE journals SET memo = 'migrator can' WHERE id = ${journal.id}`.execute(
          db.migrator,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('connection handles', () => {
    it('exposes the migrator as a distinct identity', async () => {
      const { rows } = await sql<{ user: string }>`SELECT CURRENT_USER() AS user`.execute(
        db.migrator,
      );
      expect(rows[0]!.user).toBe(`${MIGRATOR_DB_USER}@%`);
    });

    it('gives each openAppConnection its own server connection', async () => {
      const first = await db.openAppConnection();
      const second = await db.openAppConnection();

      try {
        const ids = await Promise.all(
          [first, second].map(async (connection) => {
            const { rows } = await sql<{ id: number }>`SELECT CONNECTION_ID() AS id`.execute(
              connection.db,
            );
            return rows[0]!.id;
          }),
        );

        expect(ids[0]).not.toBe(ids[1]);
      } finally {
        await first.close();
        await second.close();
      }
    });

    it('sees another connection committed rows, which transaction-per-test isolation would hide', async () => {
      const org = await db.factories.org();
      const connection = await db.openAppConnection();

      try {
        const rows = await connection.db
          .selectFrom('orgs')
          .select('id')
          .where('id', '=', org.id)
          .execute();
        expect(rows).toHaveLength(1);
      } finally {
        await connection.close();
      }
    });
  });
});
