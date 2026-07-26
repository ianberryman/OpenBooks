import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * The ledger kernel (spec §7). The least clever code in the system, by design
 * (spec §2.6).
 *
 * Everything financial in OpenBooks resolves to rows in `journals` and
 * `journal_lines`. No module holds financial state independently (spec §2.1), so
 * this schema is the one that has to be right.
 *
 * Two structural guarantees are worth reading the DDL for:
 *
 * 1. **Cross-org references cannot be expressed.** Child rows reference parents
 *    through `(org_id, id)` composite keys, so a journal line belonging to org A
 *    cannot point at an account or journal belonging to org B. The foreign key
 *    has nothing to point at. This is what makes the denormalized
 *    `journal_lines.org_id` safe rather than a correctness risk.
 *
 * 2. **Journals are append-only, enforced by the database.** There is no column
 *    on `journals` or `journal_lines` whose value changes after insert — a
 *    reversal is a new journal carrying `reverses_journal_id`, never a mutation
 *    of the original (spec §2.2, ROADMAP D-02). The app user's grants are
 *    narrowed to match in `0004_app_grants`.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // accounts
  //
  // `normal_balance` is stored rather than derived from `type`. Deriving it
  // would be tidier and is right for most accounts, but contra accounts are
  // real — accumulated depreciation is an asset with a credit normal balance,
  // as is an allowance for doubtful accounts. Storing it keeps those
  // expressible. Deliberately NOT constrained against `type` for that reason.
  //
  // `parent_account_id` ships unused. Chart-of-accounts hierarchy and templates
  // are M2 (ROADMAP OB-018), but adding the column later would mean altering a
  // table that by then holds every customer's chart of accounts.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE accounts (
      id                BINARY(16)   NOT NULL,
      org_id            BINARY(16)   NOT NULL,
      code              VARCHAR(32)  NOT NULL,
      name              VARCHAR(255) NOT NULL,
      type              ENUM('asset','liability','equity','revenue','expense') NOT NULL,
      normal_balance    ENUM('debit','credit') NOT NULL,
      parent_account_id BINARY(16)   NULL,
      description       VARCHAR(512) NULL,
      is_active         TINYINT(1)   NOT NULL DEFAULT 1,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_accounts_org_id (org_id, id),
      UNIQUE KEY uq_accounts_org_code (org_id, code),
      KEY idx_accounts_org_type (org_id, type),
      KEY idx_accounts_org_active (org_id, is_active),
      CONSTRAINT fk_accounts_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_accounts_parent
        FOREIGN KEY (org_id, parent_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // fiscal_periods
  //
  // `open` / `closed` only in M1 (ROADMAP D-08). Posting into a closed period is
  // rejected — that is acceptance criterion A4.
  //
  // Period non-overlap is NOT enforceable as a MySQL constraint (no exclusion
  // constraints, no range types). It is enforced in the periods service and
  // asserted by test. The unique key on (org_id, start_date) catches the most
  // common duplicate but does not catch a genuine overlap.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE fiscal_periods (
      id                BINARY(16)   NOT NULL,
      org_id            BINARY(16)   NOT NULL,
      name              VARCHAR(120) NOT NULL,
      start_date        DATE         NOT NULL,
      end_date          DATE         NOT NULL,
      status            ENUM('open','closed') NOT NULL DEFAULT 'open',
      closed_at         DATETIME(3)  NULL,
      closed_by_user_id BINARY(16)   NULL,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_fiscal_periods_org_id (org_id, id),
      UNIQUE KEY uq_fiscal_periods_org_start (org_id, start_date),
      KEY idx_fiscal_periods_org_range (org_id, start_date, end_date),
      KEY idx_fiscal_periods_org_status (org_id, status),
      CONSTRAINT fk_fiscal_periods_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_fiscal_periods_closer
        FOREIGN KEY (closed_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
      CONSTRAINT chk_fiscal_periods_range CHECK (end_date >= start_date),
      CONSTRAINT chk_fiscal_periods_closed_consistency CHECK (
        (status = 'open'   AND closed_at IS NULL) OR
        (status = 'closed' AND closed_at IS NOT NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journals
  //
  // Actor provenance is NOT NULL for type and id (spec §6): every posting records
  // who or what created it. `invocation_mode` is null for users and automations
  // and set for agents, which is the distinction that decides whether a posting
  // needed review.
  //
  // `reverses_journal_id` is the whole of the correction model. It is on the
  // reversing journal, set at insert, and the original is never touched
  // (ROADMAP D-02). `uq_journals_org_reverses` makes double-reversal of the same
  // journal impossible at the schema level — without it, two concurrent reversal
  // requests could both succeed and net the account to the wrong balance.
  //
  // `source` records which subsystem produced the posting. In M1 everything is
  // 'manual'; M3 adds invoice/bill/payment origins. Kept as a short VARCHAR
  // rather than an ENUM so a new origin does not require an ALTER on the
  // largest table in the system.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journals (
      id                  BINARY(16)   NOT NULL,
      org_id              BINARY(16)   NOT NULL,
      period_id           BINARY(16)   NOT NULL,
      entry_date          DATE         NOT NULL,
      memo                VARCHAR(512) NULL,
      reference           VARCHAR(120) NULL,
      source              VARCHAR(32)  NOT NULL DEFAULT 'manual',
      actor_type          ENUM('user','automation','agent') NOT NULL,
      actor_id            BINARY(16)   NOT NULL,
      invocation_mode     ENUM('interactive','scheduled') NULL,
      reverses_journal_id BINARY(16)   NULL,
      created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_journals_org_id (org_id, id),
      UNIQUE KEY uq_journals_org_reverses (org_id, reverses_journal_id),
      KEY idx_journals_org_date (org_id, entry_date),
      KEY idx_journals_org_period (org_id, period_id),
      KEY idx_journals_org_actor (org_id, actor_type, actor_id),
      KEY idx_journals_org_created (org_id, created_at),
      CONSTRAINT fk_journals_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_journals_period
        FOREIGN KEY (org_id, period_id) REFERENCES fiscal_periods (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_journals_reverses
        FOREIGN KEY (org_id, reverses_journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT chk_journals_invocation_mode CHECK (
        (actor_type = 'agent' AND invocation_mode IS NOT NULL) OR
        (actor_type <> 'agent' AND invocation_mode IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journal_lines
  //
  // `id` is BIGINT AUTO_INCREMENT: internal, high-volume, never client-facing
  // alone (spec §4). A line is addressed as (journal_id, line_number).
  //
  // Amounts are BIGINT minor units (spec §12). Never DECIMAL, never a float.
  //
  // chk_journal_lines_one_sided is the "no one-sided lines" invariant from
  // spec §11, expressed in the schema: exactly one of debit/credit is positive
  // and the other is zero. This simultaneously forbids negative amounts and
  // zero-value lines. Representing a credit as a negative debit would be the
  // other valid modelling choice; this one is chosen because it makes the
  // trial balance a plain SUM of two columns with no sign handling, and because
  // an accountant reading the table sees debits and credits where they expect
  // them.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_lines (
      id            BIGINT       NOT NULL AUTO_INCREMENT,
      org_id        BINARY(16)   NOT NULL,
      journal_id    BINARY(16)   NOT NULL,
      line_number   SMALLINT UNSIGNED NOT NULL,
      account_id    BINARY(16)   NOT NULL,
      debit_minor   BIGINT       NOT NULL DEFAULT 0,
      credit_minor  BIGINT       NOT NULL DEFAULT 0,
      memo          VARCHAR(512) NULL,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_journal_lines_journal_line (org_id, journal_id, line_number),
      KEY idx_journal_lines_org_account (org_id, account_id),
      KEY idx_journal_lines_org_journal (org_id, journal_id),
      CONSTRAINT fk_journal_lines_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_journal_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT chk_journal_lines_one_sided CHECK (
        (debit_minor > 0 AND credit_minor = 0) OR
        (debit_minor = 0 AND credit_minor > 0)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS journal_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS journals`.execute(db);
  await sql`DROP TABLE IF EXISTS fiscal_periods`.execute(db);
  await sql`DROP TABLE IF EXISTS accounts`.execute(db);
}
