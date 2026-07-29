import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * The ledger kernel and everything that hangs off it (spec §7). The least clever
 * code in the system, by design (spec §2.6).
 *
 * Everything financial in OpenBooks resolves to rows in `journals` and
 * `journal_lines`. No module holds financial state independently (spec §2.1), so
 * this schema is the one that has to be right.
 *
 * ## Why M2's tables are in here rather than in migrations of their own
 *
 * Contacts, dimensions, and drafts arrived with M2 and were briefly three separate
 * migrations. They are here because pre-release a schema change belongs in the
 * migration that created the table rather than in a new one (ROADMAP D-15) — and
 * because of a constraint that made the alternative actively fragile at the time:
 * **MySQL refuses a table-level `GRANT` on a table that does not exist**
 * (`ERROR 1146`, measured on 8.4). The grants migration names every mutable table one
 * at a time, so every migration creating a table it grants must sort ahead of it, and
 * while the grants file was numbered `0004` the only ways to add a table in a new file
 * were to renumber it on every wave or to number around it (`0003a`, `0003b`,
 * `0003c`, …) — and the second accumulates forever.
 *
 * OB-060 removed that constraint at the root rather than working around it again: the
 * grants migration is now `0999_app_grants`, the ceiling of the four-digit numbering
 * convention, so nothing following the convention can sort after it. A new subsystem
 * is therefore a new migration — see `0005_subledger`, which is where M3's AR/AP
 * tables live and where M2's would have gone had the number been fixed sooner.
 *
 * These tables stay here because they *are* the ledger. Moving them now would be
 * churn for its own sake, and D-15 says a change to one of them belongs in this file
 * until first release.
 *
 * ## Two structural guarantees worth reading the DDL for
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
 *    narrowed to match in `0999_app_grants`.
 *
 * Table order below is dictated by foreign keys: InnoDB resolves a referenced table
 * at `CREATE TABLE` time, so a parent is declared before its children. That is why
 * `contacts` and the dimension tables sit between `accounts` and `journal_lines`
 * rather than at the end where they were written.
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
  // `parent_account_id` was unused until OB-035 gave it rules. The composite
  // foreign key is what makes a cross-org parent unrepresentable; it says nothing
  // about cycles, which a self-referencing key permits (`a → b → a`), so those are
  // refused in `modules/accounts/hierarchy.ts` and cannot be refused here.
  //
  // `idx_accounts_org_parent` is named explicitly rather than left to the index
  // InnoDB creates for `fk_accounts_parent`. Both the cycle walk and the depth
  // check read children by parent, so the index is load-bearing for the service
  // and not only for the constraint — and an implicitly created index is one an
  // `ALTER` can drop without any statement in this file changing.
  //
  // There is deliberately no covering index for the account list's keyset
  // ordering: since D-27 that ordering is `(code, id)`, and
  // `uq_accounts_org_code` already is it — a secondary index leaf carries the
  // primary key, so `(org_id, code)` scans in `(org_id, code, id)` order.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE accounts (
      id                BINARY(16)   NOT NULL,
      org_id            BINARY(16)   NOT NULL,
      code              VARCHAR(32)  NOT NULL,
      name              VARCHAR(255) NOT NULL,
      type              ENUM('asset','liability','equity','revenue','expense') NOT NULL,
      normal_balance    ENUM('debit','credit') NOT NULL,
      -- How the cash-basis transform (D-87, OB-154) treats activity on this account.
      -- 'cash' means a journal touching it is a cash event whose P&L legs are recognised
      -- at the journal's own date; 'accrual' marks a pure-accrual holding account (prepaid,
      -- accrued, deferred, deposits) whose no-cash movement is excluded from a cash-basis
      -- P&L. NULL is unclassified: the transform infers from bank_accounts and flags for the
      -- setup nudge (K3/K4). A hint the user sets, not derived from the account type, since
      -- the same type covers both (a bank is an asset, so is a prepaid).
      cash_basis_role   ENUM('cash','accrual') NULL,
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
      KEY idx_accounts_org_parent (org_id, parent_account_id),
      CONSTRAINT fk_accounts_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_accounts_parent
        FOREIGN KEY (org_id, parent_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // contacts — customers and vendors, as one table (OB-032).
  //
  // The same legal entity is routinely both. A supplier who also buys from you, a
  // landlord you invoice for a shared service, an accountant who is a client —
  // none of these are unusual, and two tables force the org to hold that entity
  // twice, with two names to keep in step and two rows an M3 report has to know
  // are the same party. The cost of the alternative is not paid at M2, which is
  // why it is worth stating: it is paid at M3, when a vendor credit and a customer
  // refund turn out to need the *same* row, and by then the two tables hold
  // customer data.
  //
  // There is no `CHECK (is_customer = 1 OR is_vendor = 1)`. The flags say which
  // subledgers a contact takes part in, and those subledgers are M3; a line tagged
  // with a contact is stating who the amount is with, which is independent of both
  // — an employee expense reimbursement names a party who is neither. Requiring a
  // flag now would be a rule invented before the thing it governs exists, which is
  // the mistake `parent_account_id` avoided in M1. Same reasoning as storing
  // `normal_balance` without constraining it against `type`.
  //
  // `code` is nullable and unique per org where present. MySQL treats NULLs as
  // distinct in a unique index, so an org that does not number its contacts is not
  // forced to invent numbers, while one that does cannot issue the same number
  // twice. The account chart's `code` is NOT NULL because a chart without codes is
  // not a chart; a contact list without them is the common case.
  //
  // Deliberately no address, no tax id, and no payment terms. Those are what an
  // invoice needs (M3), and pre-release adding them costs nothing later (D-15), so
  // the only thing an early column buys is a column nobody has decided the meaning
  // of.
  //
  // ## default_payment_term_id — added in place for Cash application (D-15, D-79)
  //
  // The column that paragraph said M3 did not need yet. It names the term a new
  // document defaults to for this contact — Net 30, 2/10 Net 30 — overridable per
  // document (`ar_documents.payment_term_id` / `ap_documents.payment_term_id`,
  // `0005_subledger`). It cannot carry its foreign key here: `payment_terms` is
  // created in `0012_cash_application`, which runs *after* this migration, and
  // MySQL refuses a `FOREIGN KEY` to a table that does not exist yet. The column is
  // declared nullable here so the row shape is right from the start, and `0012`
  // adds the composite `(org_id, id)` constraint once `payment_terms` exists — the
  // same split `0002_ledger`/`0999_app_grants` uses for every table the grants
  // migration cannot yet see.
  //
  // ## Vendor disbursement details — added in place for Pay Bills (D-15, D-67)
  //
  // `preferred_payment_rail` seeds the rail a new pending payment defaults to for
  // this vendor (D-110), overridable in the queue. The other three are the account
  // details an external ACH/wire integration needs, and they are *sensitive*: they
  // are the vendor's real bank coordinates, never seeded (populating them is the
  // user's), and flagged for log redaction (`logging/redact.ts`). They are plain
  // nullable strings rather than encrypted-at-rest in v1 because they are account
  // numbers, not API-key secrets — an encryption-at-rest follow-up is noted in the
  // ROADMAP. No foreign key, so unlike `default_payment_term_id` no composite
  // constraint is deferred to `0013_pay_bills`; the enum and the strings stand alone.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE contacts (
      id                     BINARY(16)   NOT NULL,
      org_id                 BINARY(16)   NOT NULL,
      code                   VARCHAR(32)  NULL,
      display_name           VARCHAR(255) NOT NULL,
      legal_name             VARCHAR(255) NULL,
      email                  VARCHAR(320) NULL,
      phone                  VARCHAR(64)  NULL,
      is_customer            TINYINT(1)   NOT NULL DEFAULT 0,
      is_vendor              TINYINT(1)   NOT NULL DEFAULT 0,
      notes                  VARCHAR(512) NULL,
      is_active              TINYINT(1)   NOT NULL DEFAULT 1,
      default_payment_term_id BINARY(16)  NULL,
      preferred_payment_rail ENUM('check','ach','wire') NULL,
      ach_routing_number     VARCHAR(34)  NULL,
      ach_account_number     VARCHAR(34)  NULL,
      wire_instructions      VARCHAR(1024) NULL,
      created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_contacts_org_id (org_id, id),
      UNIQUE KEY uq_contacts_org_code (org_id, code),
      -- The list ordering OB-036 will page over (D-21). Both columns are written
      -- once, unlike \`display_name\`, so a cursor into it is stable while contacts
      -- are being renamed — the failure D-27 removed from the account list by
      -- making \`code\` immutable, avoided here by not sorting on a mutable column
      -- in the first place.
      KEY idx_contacts_org_created (org_id, created_at, id),
      KEY idx_contacts_org_name (org_id, display_name),
      KEY idx_contacts_org_customer (org_id, is_customer),
      KEY idx_contacts_org_vendor (org_id, is_vendor),
      KEY idx_contacts_org_default_term (org_id, default_payment_term_id),
      CONSTRAINT fk_contacts_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // dimensions — one row per user-defined reporting axis (ROADMAP D-18).
  //
  // D-18 chose unlimited axes over QBO's fixed Class + Location and Xero's two
  // tracking categories. The alternatives cannot express "this org tracks
  // department, project, funding source, and vehicle", and an accounting system
  // that makes the fourth axis a schema change is one its users work around with
  // account-code conventions.
  //
  // `is_active` rather than deletion once an axis is in use: an axis whose values
  // journal lines carry cannot be removed without restating every sliced report
  // that was ever run (OB-037). The foreign keys below make that structural — an
  // axis with tagged values cannot be deleted at all — so the flag is what the
  // service reaches for instead.
  //
  // There is no bound here on how many axes an org creates, and thirty of them
  // make the general ledger pathological (D-18). The schema cannot express that
  // bound: MySQL has no per-partition row limit, and a CHECK cannot count rows in
  // another table. It belongs in the dimensions service (OB-037), chosen and
  // written down.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE dimensions (
      id          BINARY(16)   NOT NULL,
      org_id      BINARY(16)   NOT NULL,
      code        VARCHAR(32)  NOT NULL,
      name        VARCHAR(120) NOT NULL,
      description VARCHAR(512) NULL,
      is_active   TINYINT(1)   NOT NULL DEFAULT 1,
      created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_dimensions_org_id (org_id, id),
      UNIQUE KEY uq_dimensions_org_code (org_id, code),
      KEY idx_dimensions_org_active (org_id, is_active),
      CONSTRAINT fk_dimensions_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // dimension_values — the values on an axis.
  //
  // `uq_dimension_values_org_dimension_id` looks redundant next to the primary key
  // and is not: it is the key the tag tables reference, and it is what makes a tag
  // whose `dimension_id` disagrees with its value's axis inexpressible. Without it
  // the tag's denormalized `dimension_id` — which the uniqueness key below
  // requires as a column — would be an application-maintained invariant, and a tag
  // filed under the wrong axis silently moves money between slices. Same reasoning
  // as the composite tenancy keys: remove the risk rather than document it.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE dimension_values (
      id           BINARY(16)   NOT NULL,
      org_id       BINARY(16)   NOT NULL,
      dimension_id BINARY(16)   NOT NULL,
      code         VARCHAR(32)  NOT NULL,
      name         VARCHAR(120) NOT NULL,
      is_active    TINYINT(1)   NOT NULL DEFAULT 1,
      created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_dimension_values_org_id (org_id, id),
      UNIQUE KEY uq_dimension_values_org_dimension_id (org_id, dimension_id, id),
      UNIQUE KEY uq_dimension_values_dimension_code (org_id, dimension_id, code),
      KEY idx_dimension_values_org_dimension_active (org_id, dimension_id, is_active),
      CONSTRAINT fk_dimension_values_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      -- RESTRICT, not CASCADE: deleting an axis would otherwise take its values with
      -- it without the caller naming them, and the values are what reports are
      -- grouped by. The service deletes values explicitly or archives the axis.
      CONSTRAINT fk_dimension_values_dimension
        FOREIGN KEY (org_id, dimension_id) REFERENCES dimensions (org_id, id)
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
  //
  // `sequence_number` is the human-readable reference accountants and auditors
  // ask for — the UUID is not one (ROADMAP D-14). Gapless and monotonic per org,
  // allocated from `journal_sequences` below. It is NOT NULL from the start: added
  // later it would mean backfilling every journal and inventing numbers for
  // history.
  //
  // `idx_journals_org_date` carries `sequence_number` as its third column because
  // that is the journal list's keyset ordering (D-21), and the row-value
  // comparison `(entry_date, sequence_number) > (?, ?)` is a single range scan
  // only over an index holding both. Without it the list sorts within the
  // org-scoped range on every page — harmless at M2 volumes and not harmless at
  // the volume a ledger reaches, which is why the column is added while the table
  // is still small.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journals (
      id                  BINARY(16)   NOT NULL,
      org_id              BINARY(16)   NOT NULL,
      sequence_number     BIGINT UNSIGNED NOT NULL,
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
      UNIQUE KEY uq_journals_org_sequence (org_id, sequence_number),
      UNIQUE KEY uq_journals_org_reverses (org_id, reverses_journal_id),
      KEY idx_journals_org_date (org_id, entry_date, sequence_number),
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
  //
  // `uq_journal_lines_org_id` exists because this table became a parent for the
  // first time when dimension tags arrived. Every other tenant table here carries
  // `UNIQUE (org_id, id)` so children can reference it compositely; this one never
  // had a child, so it never got the key — and without it the tag table's
  // composite foreign key cannot be created at all (errno 1822: no index in the
  // referenced table).
  //
  // `contact_id` is nullable, and that is the whole point rather than a
  // concession: most lines name no contact, and a line that does is stating who
  // the amount is with — not that the amount is receivable or payable. That
  // distinction is the subledger's, and the subledger is M3.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_lines (
      id            BIGINT       NOT NULL AUTO_INCREMENT,
      org_id        BINARY(16)   NOT NULL,
      journal_id    BINARY(16)   NOT NULL,
      line_number   SMALLINT UNSIGNED NOT NULL,
      account_id    BINARY(16)   NOT NULL,
      contact_id    BINARY(16)   NULL,
      debit_minor   BIGINT       NOT NULL DEFAULT 0,
      credit_minor  BIGINT       NOT NULL DEFAULT 0,
      memo          VARCHAR(512) NULL,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_journal_lines_org_id (org_id, id),
      UNIQUE KEY uq_journal_lines_journal_line (org_id, journal_id, line_number),
      KEY idx_journal_lines_org_account (org_id, account_id),
      KEY idx_journal_lines_org_journal (org_id, journal_id),
      KEY idx_journal_lines_org_contact (org_id, contact_id),
      CONSTRAINT fk_journal_lines_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_journal_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      -- RESTRICT, matching the account key. A contact a journal line names is part
      -- of what an entry says, so deleting it would change what a posted line
      -- means — the same argument \`deleteAccount\` makes, and the reason a
      -- referenced contact is deactivated rather than removed.
      CONSTRAINT fk_journal_lines_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT chk_journal_lines_one_sided CHECK (
        (debit_minor > 0 AND credit_minor = 0) OR
        (debit_minor = 0 AND credit_minor > 0)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journal_line_dimensions — the tags themselves.
  //
  // No `id` of its own: the row *is* the fact "this line carries this value on
  // this axis", and its identity is the primary key. A surrogate key would permit
  // the duplicate the key exists to forbid.
  //
  // ## The key that makes acceptance B6 true
  //
  // `(org_id, journal_line_id, dimension_id)`. Without it a line can carry two
  // values on one axis, and then a report sliced by that axis counts the line
  // twice — so "every report unsliced equals its slices plus unassigned" is false,
  // and the report is where you would find out. It is the PRIMARY KEY rather than
  // a secondary unique index because it is also the access path the general ledger
  // uses (tags for a set of lines), so the clustered index carries the rows the
  // join wants.
  //
  // ## Mutable, unlike the line it tags
  //
  // This table is in `0999_app_grants`'s mutable list even though `journal_lines`
  // is append-only, and the asymmetry is deliberate. A tag names which slice of the
  // business an amount belongs to; it is an analysis dimension laid over the
  // ledger, not a term of the entry. Nothing in the trial balance, the P&L, or the
  // balance sheet moves when one changes — only how a sliced report divides a total
  // that stays the same. Refusing an edit would mean the only way to fix a
  // mis-tagged line is to reverse and repost a journal that was financially
  // correct, and manufacturing two entries to correct a label is a worse record of
  // what happened than the edit is.
  //
  // `idx_jld_org_dimension_value` is the index D-18 predicted would have to be
  // designed rather than inherited from the tenancy pattern. The primary key
  // answers "what tags does this line carry"; it cannot answer "which lines carry
  // this axis", which is every sliced report. One index rather than two: a report
  // grouping by an axis reads the prefix, and a report filtered to a single value
  // reads axis + value, because the service always knows which axis a value
  // belongs to. `journal_line_id` is the trailing column so the join back to the
  // line is covered.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_line_dimensions (
      org_id             BINARY(16)  NOT NULL,
      journal_line_id    BIGINT      NOT NULL,
      dimension_id       BINARY(16)  NOT NULL,
      dimension_value_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, journal_line_id, dimension_id),
      KEY idx_jld_org_dimension_value (org_id, dimension_id, dimension_value_id, journal_line_id),
      CONSTRAINT fk_jld_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_jld_line
        FOREIGN KEY (org_id, journal_line_id) REFERENCES journal_lines (org_id, id)
        ON DELETE RESTRICT,
      -- Three columns, so the value's axis and the tag's axis are the same fact
      -- rather than two that can disagree.
      CONSTRAINT fk_jld_value
        FOREIGN KEY (org_id, dimension_id, dimension_value_id)
        REFERENCES dimension_values (org_id, dimension_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journal_sequences — one counter row per org, allocating
  // `journals.sequence_number` (ROADMAP D-14).
  //
  // A counter table rather than the two obvious alternatives, and the first
  // reason is not a preference:
  //
  //   MAX(sequence_number) + 1 needs a locking read to be safe under
  //   concurrency, and the application user *cannot* take one on `journals`.
  //   MySQL requires SELECT plus one of UPDATE/DELETE/LOCK TABLES for
  //   `FOR UPDATE`, and withholding exactly those is how journal immutability is
  //   enforced (see 0999_app_grants). So the lock has to live on a table the app
  //   may write, which is this one.
  //
  //   AUTO_INCREMENT leaves gaps on rollback, and a gap in a journal sequence is
  //   indistinguishable from a deleted entry — precisely the ambiguity an
  //   append-only ledger exists to remove.
  //
  // Taking this row FOR UPDATE serializes posting within an org. That is a real
  // throughput ceiling and it is the correct trade for a gapless sequence; if it
  // ever binds, the answer is a per-org queue, not a sequence with holes.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_sequences (
      org_id      BINARY(16)      NOT NULL,
      next_value  BIGINT UNSIGNED NOT NULL DEFAULT 1,
      updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id),
      CONSTRAINT fk_journal_sequences_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journal_drafts — the first mutable ledger-adjacent tables (ROADMAP D-19).
  //
  // A draft cannot be a status column on `journals`, and not for style reasons:
  // no journal column's value changes after insert, and the app user holds no
  // `UPDATE` grant on the table at all (gate A6). Anything editable has to live
  // elsewhere.
  //
  // A draft is not a weaker journal. It is not in the trial balance, not in any
  // report, and no invariant test applies to it: it has not happened yet. That is
  // what answers the UX complaint under D-16 — a typo noticed ten seconds after
  // entry should not produce three journal entries — without making the ledger
  // mutable.
  //
  // **No sequence number, deliberately.** `journals.sequence_number` is allocated
  // from the counter row at post time (D-14). A draft that reserved one and was
  // then discarded would leave a gap, and a gap in a journal sequence is
  // indistinguishable from a deleted entry. There is no column for it here and
  // there must not be one.
  //
  // **No period, deliberately.** A draft carries `entry_date` and no `period_id`.
  // The period is resolved from the date by the posting path, which also holds the
  // period-lock check (gate A4); a `period_id` stored on the draft would be a
  // second copy of that derivation made at the wrong moment — a draft written in an
  // open period and posted after it closed would carry a stale, and by then wrong,
  // answer.
  //
  // Provenance is a single `created_by_user_id`, not the actor triple `journals`
  // carries. The journal records who *posted*, which is the fact an auditor asks
  // about, and the posting path sets it from the caller.
  //
  // ON DELETE CASCADE from `users`, where `fiscal_periods.closed_by_user_id` uses
  // SET NULL: closing a period is a fact that outlives the person who did it, and
  // a draft is not a fact at all.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_drafts (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      entry_date         DATE         NULL,
      memo               VARCHAR(512) NULL,
      reference          VARCHAR(120) NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_journal_drafts_org_id (org_id, id),
      -- (created_at, id) is the keyset ordering D-21 gives everything that is not
      -- the journal list; a draft has no sequence number to order on and its
      -- entry_date is nullable, so neither of the journal list's columns is total.
      KEY idx_journal_drafts_org_created (org_id, created_at, id),
      KEY idx_journal_drafts_org_author (org_id, created_by_user_id),
      CONSTRAINT fk_journal_drafts_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_journal_drafts_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journal_draft_lines
  //
  // `chk_journal_lines_one_sided` has no counterpart here, and its absence is the
  // whole design: a half-entered line with neither side filled, or a set of lines
  // that does not balance, is an ordinary state for a form in progress. Enforcing
  // the ledger's invariants on a draft would mean the user could not save one
  // until it was already correct, which is the friction drafts exist to remove.
  //
  // Non-negativity *is* enforced, because a negative amount is not incompleteness.
  // Money is unsigned minor units on both columns in this system (spec §12,
  // D-13); a draft holding -500 in `debit_minor` encodes a sign convention the
  // ledger does not have, and the only thing standing between it and the ledger
  // would be the post-time validator remembering to look.
  //
  // `contact_id` mirrors `journal_lines`, and `uq_journal_draft_lines_org_id`
  // exists so the tag table below can reference this one compositely. Both are
  // here because a draft has to be able to hold everything the journal-entry form
  // collects (OB-051): a draft that silently dropped the contact and the dimension
  // tags a user entered would lose them at post, which makes the draft a worse
  // record of the user's intent than no draft at all.
  //
  // ON DELETE CASCADE from the draft: discarding a draft is one statement, and the
  // lines have no meaning without their header. This is the one place in the
  // schema where a cascade deletes rows the caller did not name, and it is safe
  // precisely because nothing here is a posting.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_draft_lines (
      id           BIGINT       NOT NULL AUTO_INCREMENT,
      org_id       BINARY(16)   NOT NULL,
      draft_id     BINARY(16)   NOT NULL,
      line_number  SMALLINT UNSIGNED NOT NULL,
      account_id   BINARY(16)   NULL,
      contact_id   BINARY(16)   NULL,
      debit_minor  BIGINT       NOT NULL DEFAULT 0,
      credit_minor BIGINT       NOT NULL DEFAULT 0,
      memo         VARCHAR(512) NULL,
      created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_journal_draft_lines_org_id (org_id, id),
      UNIQUE KEY uq_journal_draft_lines_draft_line (org_id, draft_id, line_number),
      KEY idx_journal_draft_lines_org_account (org_id, account_id),
      KEY idx_journal_draft_lines_org_contact (org_id, contact_id),
      CONSTRAINT fk_journal_draft_lines_draft
        FOREIGN KEY (org_id, draft_id) REFERENCES journal_drafts (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_journal_draft_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_journal_draft_lines_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT chk_journal_draft_lines_non_negative CHECK (
        debit_minor >= 0 AND credit_minor >= 0
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // journal_draft_line_dimensions — the draft's counterpart to
  // `journal_line_dimensions`.
  //
  // A separate table rather than a nullable `journal_line_id`/`draft_line_id` pair
  // on one, because the two reference different parents with different delete
  // semantics: a tag on a posted line is RESTRICT (the line outlives the tag), and
  // a tag on a draft line CASCADEs (discarding a draft takes everything with it).
  // Expressing both in one table would mean two nullable foreign keys and a CHECK
  // asserting exactly one is set — an invariant the schema would state and the
  // application would have to remember, which is the trade this schema declines
  // everywhere else.
  //
  // The same `(org_id, line, dimension)` primary key, for the same reason: a draft
  // that could hold two values on one axis would produce a journal that cannot be
  // tagged from it, and the failure would surface at post rather than at entry.
  //
  // No report reads this table, so it carries no counterpart to
  // `idx_jld_org_dimension_value` — a draft is in no report by construction.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE journal_draft_line_dimensions (
      org_id             BINARY(16)  NOT NULL,
      draft_line_id      BIGINT      NOT NULL,
      dimension_id       BINARY(16)  NOT NULL,
      dimension_value_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, draft_line_id, dimension_id),
      CONSTRAINT fk_jdld_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_jdld_line
        FOREIGN KEY (org_id, draft_line_id) REFERENCES journal_draft_lines (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_jdld_value
        FOREIGN KEY (org_id, dimension_id, dimension_value_id)
        REFERENCES dimension_values (org_id, dimension_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order: a table cannot be dropped while a foreign key points
  // at it.
  await sql`DROP TABLE IF EXISTS journal_draft_line_dimensions`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_draft_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_drafts`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_sequences`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_line_dimensions`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS journals`.execute(db);
  await sql`DROP TABLE IF EXISTS fiscal_periods`.execute(db);
  await sql`DROP TABLE IF EXISTS dimension_values`.execute(db);
  await sql`DROP TABLE IF EXISTS dimensions`.execute(db);
  await sql`DROP TABLE IF EXISTS contacts`.execute(db);
  await sql`DROP TABLE IF EXISTS accounts`.execute(db);
}
