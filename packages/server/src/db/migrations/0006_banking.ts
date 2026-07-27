import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Banking (M4): bank accounts, statement import, matching, and reconciliation.
 *
 * Its own file for the reason `0005_subledger` is its own file — a new subsystem
 * gets one, and `0999_app_grants` sorting last is what makes that possible at all.
 *
 * ## The bank account is not a second ledger
 *
 * [D-46] — a bank account is a ledger account plus import metadata. There is no
 * balance column on `bank_accounts` and no running balance on a statement line. The
 * balance a user sees is the ledger account's, computed from journal lines exactly
 * as every other balance in this system is; the statement's closing balance is a
 * *claim* from outside, recorded on a reconciliation session, and testing it against
 * the ledger is the whole of what reconciliation does. Storing both as peers is how a
 * banking module ends up disagreeing with its own general ledger, which is the same
 * argument [D-34] makes about an invoice's outstanding amount.
 *
 * ## What the bank said, and everything anyone concluded from it
 *
 * [D-42] splits this schema in two. `bank_statement_lines` is evidence: the app user
 * may insert and read it and holds no `UPDATE` or `DELETE` (E2), for the reason
 * `journals` is append-only — a corroborating record you can rewrite corroborates
 * nothing. Every decision the matching pipeline makes therefore lives in a row that
 * *references* a line and never in the line: proposals in `bank_match_proposals`,
 * the accepted match in `bank_line_clearings`. There is no `status`, no
 * `is_matched`, and no `journal_id` on a statement line, and their absence is the
 * design rather than an omission.
 *
 * Three tables here are append-only and they are append-only for three different
 * reasons, all of which are "this row is a record of something that happened":
 *
 *   bank_statement_lines           what the bank said            (D-42, E2)
 *   bank_statement_imports         that a file was uploaded      (D-42)
 *   reconciliation_session_events  who finalised or reopened     (E6)
 *
 * Everything else is working state and is mutable. The one that looks like it
 * should not be is `bank_line_clearings`, and its argument is `ar_allocations`':
 * see that table below.
 *
 * ## Money on a statement line is signed, which nothing else in this schema is
 *
 * `journal_lines` splits debit and credit, `payments` carries a direction, and every
 * amount in M1–M3 is non-negative. A statement line is the exception:
 * `amount_minor` is signed, positive into the account and negative out of it, and
 * there is no direction column beside it.
 *
 * The reason is E4. A clearing has to satisfy
 * `cleared_amount_minor + difference_amount_minor = line.amount_minor`, which is an
 * equation over amounts — and an equation whose terms each need a sign looked up
 * from a neighbouring enum is an equation with a conditional in it, which is where
 * the sign error goes. A bank statement is also the one input this system takes from
 * outside itself, and outside it the amount already has a sign. `inbound`/`outbound`
 * survives as a *condition* on `bank_rules` and as a list filter, where it selects
 * on the sign rather than duplicating it.
 *
 * ## Matching proposes, and proposals are disposable
 *
 * [D-43] — nothing here writes to the ledger. A `bank_match_proposals` row names a
 * candidate and where it came in the ranking, and accepting one is a separate human
 * act that posts a journal through the ordinary path with the ordinary actor
 * provenance. The corollary is that a proposal is cheap: the whole set for a line is
 * deleted and regenerated, and the ranking can be improved later without a
 * migration.
 *
 * There is no stored score anywhere in this file, and the absence is the decision
 * rather than an omission — `bank_match_proposals` below argues it.
 *
 * ## Two locks that must not become one
 *
 * [D-45], and E7 is the criterion. Nothing in this file references
 * `fiscal_periods`, and nothing in `0002_ledger` references a reconciliation
 * session. A bank reconciliation says "the bank agreed with us"; a period close says
 * "we are done changing this month". Coupling them means one account's unreconciled
 * straggler can freeze the whole ledger, or that closing a period silently asserts a
 * reconciliation nobody performed.
 *
 * ## A rule cannot reach a posted entry
 *
 * [D-44], and E8 is the criterion. `bank_rules` is referenced by
 * `bank_match_proposals` and by its own tag table, and by nothing else. No column in
 * `journals`, `journal_lines`, or `bank_line_clearings` names a rule, so there is no
 * path by which editing a rule could restate a coding that has already been posted —
 * the property [D-16] refuses for transactions arriving through a side door. The
 * absence is the enforcement; a rule id on a clearing would be enough to lose it.
 *
 * ## Composite tenant references can never be ON DELETE SET NULL
 *
 * Measured here, on MySQL 8.4, and general rather than local: a foreign key with a
 * SET NULL action requires *every* column in it to be nullable, so
 * `FOREIGN KEY (org_id, x) … ON DELETE SET NULL` is refused outright with "Column
 * 'org_id' cannot be NOT NULL: needed in a foreign key constraint … SET NULL".
 * Every tenant reference in this schema leads with a NOT NULL `org_id`
 * (`src/db/migrations/README.md`), so the only actions available anywhere are
 * CASCADE and RESTRICT. `fk_bmp_rule` below is where that bit, and it is worth
 * knowing before designing a table around a nullable back-reference.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // bank_accounts — a ledger account, plus what is needed to import a file into it
  // (ROADMAP D-46).
  //
  // The only financial column here is `account_id`, and it is a reference. An
  // `opening_balance_minor` or a `current_balance_minor` would be the second source
  // of truth D-46 exists to refuse, and the first thing to disagree with the trial
  // balance.
  //
  // `uq_bank_accounts_account` is the constraint that keeps that honest in the other
  // direction: two bank accounts pointing at one ledger account would give a single
  // account two statements, two reconciliations, and two different answers to "has
  // this cleared". One-to-one, enforced where it can be.
  //
  // The name is deliberately *not* unique. Two accounts called "Current" are a
  // user's problem to notice, and a unique key here would manufacture a refusal the
  // wire contract has no token for — which surfaces as a 500 rather than a message.
  //
  // `account_id` is not constrained to an asset account, for the reason
  // `tax_rates.tax_account_id` is not constrained to a liability one: MySQL cannot
  // express a CHECK that reads another table. A credit card is a liability account
  // and is a perfectly ordinary thing to import a statement into, so the service's
  // rule is narrower than "asset" anyway.
  //
  // `feed_source` has exactly one member today and is an ENUM rather than nothing at
  // all because D-41 is a decision about sequencing, not about capability: file
  // import ships first and the provider interface exists so a hosted feed slots in
  // behind it. The column is where that second member lands, and until it does,
  // every row saying 'file' is the honest statement that nothing else is supported.
  //
  // `external_account_id` and not the account number. What a user needs is enough to
  // tell two accounts apart and enough for a feed to key on later; a full account
  // number is a credential-shaped secret this system has no use for.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_accounts (
      id                  BINARY(16)   NOT NULL,
      org_id              BINARY(16)   NOT NULL,
      account_id          BINARY(16)   NOT NULL,
      name                VARCHAR(255) NOT NULL,
      institution_name    VARCHAR(255) NULL,
      external_account_id VARCHAR(64)  NULL,
      feed_source         ENUM('file') NOT NULL DEFAULT 'file',
      is_active           TINYINT(1)   NOT NULL DEFAULT 1,
      created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_accounts_org_id (org_id, id),
      UNIQUE KEY uq_bank_accounts_account (org_id, account_id),
      KEY idx_bank_accounts_org_active (org_id, is_active),
      KEY idx_bank_accounts_org_created (org_id, created_at, id),
      CONSTRAINT fk_bank_accounts_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_accounts_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_import_mappings — which column of this bank's CSV means what (OB-076).
  //
  // CSV only, and there is no `format` column saying so. A mapping names columns and
  // OFX has none, so a mapping for it would be a row that could only ever hold the
  // same values.
  //
  // ## Named columns rather than a JSON blob
  //
  // The temptation is one `JSON` column, on the grounds that CSV layouts are
  // open-ended. They are not: the set of things a mapping can name is exactly the
  // set of fields `bank_statement_lines` stores, because a field nothing can be
  // imported into is not worth mapping. That set is closed here, so it is spelled
  // out, and `chk_bim_convention` below is only expressible because it is.
  //
  // ## Columns are indexes, not header names
  //
  // A headerless file has no names to use, and a file whose header repeats "Date"
  // twice has names that do not identify anything. An index is unambiguous in both
  // cases; the header row, when there is one, is what the import preview shows so a
  // user can pick the right index without counting commas.
  //
  // ## The amount arrives in one of three conventions and the columns must agree
  //
  // 'signed' is one column where money out is negative; 'signed_reversed' is the
  // same column from a bank that publishes the opposite sign; 'debit_credit_columns'
  // is a paid-in and a paid-out column, both positive. `chk_bim_convention` ties the
  // convention to the columns, which removes the half-configured mapping — a debit
  // column with no credit column — that would otherwise import every outgoing
  // transaction and silently drop every incoming one.
  //
  // ## date_order is not optional and cannot be guessed
  //
  // 01/02/2026 is the 1st of February in London and the 2nd of January in New York.
  // A detector that guesses from the first rows is right until a statement contains
  // no day above twelve, at which point it mis-dates the whole file — and a
  // mis-dated line lands in the wrong reconciliation, where it is found a month
  // later by a reconciliation that will not balance. This is the same class of
  // failure the DATE-as-string codegen override exists to prevent
  // (`src/db/migrations/README.md`). The user states it once, on a mapping they
  // reuse.
  //
  // `delimiter` is CHAR(1) and holds the character itself. A tab is a tab, not the
  // two-character escape sequence that spells one — this is data, not source code.
  //
  // ## There is no default mapping on a bank account, and this index is why
  //
  // `bank_accounts` carries no `default_import_mapping_id` and the wire contract
  // carries no `defaultImportMappingId`. A column for it would need a foreign key
  // into this table, and this table already has one into `bank_accounts` — which
  // closes the `bank_accounts ⇄ bank_import_mappings` cycle that
  // `0005_subledger`'s `org_accounting_settings` header argues against at length.
  // Both of the usual escapes are shut here: an unenforced id is a dangling
  // reference by another name, and `ON DELETE SET NULL` is refused outright on any
  // composite tenant key in this schema (see the file header). Deleting the last
  // mapping would leave an account pointing at nothing, or refuse the delete to
  // protect a *preference*.
  //
  // OB-076 offers the most-recently-used mapping instead, which is what a default
  // was standing in for and needs no column: `updated_at` is in
  // `idx_bank_import_mappings_org_account`, so "this account's mappings, most
  // recently touched first" is an index read. **That index is load-bearing and is
  // not redundant with `uq_bank_import_mappings_account_name`** — the unique key
  // orders by `name`, which is the wrong order for this and the only order a
  // three-column prefix can give. Dropping it as duplicated coverage is the mistake
  // this paragraph exists to prevent.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_import_mappings (
      id                      BINARY(16)   NOT NULL,
      org_id                  BINARY(16)   NOT NULL,
      bank_account_id         BINARY(16)   NOT NULL,
      name                    VARCHAR(120) NOT NULL,
      has_header_row          TINYINT(1)   NOT NULL DEFAULT 1,
      delimiter               CHAR(1)      NOT NULL DEFAULT ',',
      date_order              ENUM('ymd','dmy','mdy') NOT NULL,
      amount_convention       ENUM('signed','signed_reversed','debit_credit_columns') NOT NULL,
      posted_date_column      SMALLINT UNSIGNED NOT NULL,
      description_column      SMALLINT UNSIGNED NOT NULL,
      amount_column           SMALLINT UNSIGNED NULL,
      debit_column            SMALLINT UNSIGNED NULL,
      credit_column           SMALLINT UNSIGNED NULL,
      value_date_column       SMALLINT UNSIGNED NULL,
      counterparty_column     SMALLINT UNSIGNED NULL,
      bank_reference_column   SMALLINT UNSIGNED NULL,
      created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                           ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_import_mappings_org_id (org_id, id),
      UNIQUE KEY uq_bank_import_mappings_account_name (org_id, bank_account_id, name),
      -- Load-bearing, not redundant: this is the most-recently-used read OB-076 uses
      -- in place of a default mapping on the account. See the block comment above.
      KEY idx_bank_import_mappings_org_account (org_id, bank_account_id, updated_at),
      CONSTRAINT fk_bank_import_mappings_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_import_mappings_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT chk_bim_convention CHECK (
        (amount_convention <> 'debit_credit_columns'
           AND amount_column IS NOT NULL AND debit_column IS NULL AND credit_column IS NULL) OR
        (amount_convention =  'debit_credit_columns'
           AND amount_column IS NULL AND debit_column IS NOT NULL AND credit_column IS NOT NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_statement_imports — one uploaded file (ROADMAP D-41, D-42, D-47, D-49).
  //
  // ## Mutable, because the import is asynchronous now (OB-078, [D-47])
  //
  // This table was append-only in wave 0 and is not any more, and the change is the
  // one wave 0's header said OB-078 would have to make. The one-transaction shape —
  // the import row and its lines committing together — was only available while
  // parsing happened inside the request. [D-47]/[D-49] moved parsing to the queue:
  // `startImport` writes this row with `status = 'queued'` and returns *before any
  // line exists*, and the worker fills in the counts and flips the status when it is
  // done. That is an UPDATE after insert, so the table is in `0999_app_grants`'s
  // `MUTABLE_TABLES` now rather than in `APPEND_ONLY_TABLES`.
  //
  // The evidence argument the old header made still holds where it mattered: a
  // *re-import* creates a new row, never rewrites an old one, so every upload is still
  // its own immutable-after-completion record and the counts remain the only witness
  // to a re-import. What the mutability buys is a single row that can answer "where is
  // my import?" through its whole lifecycle, which the async model requires and the
  // one-transaction shape could not give.
  //
  // ## The lifecycle, and the CHECK that pins it
  //
  //   queued      written by startImport; no counts, no lines yet
  //   processing  the worker has picked it up (a `processing` row surviving a restart
  //               is an interrupted import — see the re-run note below)
  //   complete    the worker deduped and inserted; `lines_read`/`lines_duplicate` set
  //   failed      the file could not be read; `failure_reason` set, no counts
  //
  // `lines_read` and `lines_duplicate` are therefore NULL until completion — the
  // counts are not known at queue time — and `chk_bsi_status` couples them to the
  // status so that a `queued` row carrying counts, or a `complete` row missing them,
  // is inexpressible. `failure_reason` is the `failed` state's and only its.
  //
  // ## Re-running an interrupted import is safe, and E1 is why ([D-49])
  //
  // The in-process queue does not survive a worker restart, so an import left
  // `queued` or `processing` by a crash is re-run — by the user re-uploading the same
  // file, which E1's line-level dedupe collapses to nothing new. The whole flow is
  // built to be safe to run twice: the worker skips an already-`complete` import, and
  // the line insert is idempotent on `(fingerprint, occurrence_index)`. So a
  // duplicated run changes no stored line and recomputes the same counts.
  //
  // ## The closing balance and the account identifier are both claims from outside
  //
  // Neither is derivable from the lines, which is why both are columns. They are on
  // OB-075's `bankStatementImport` wire contract already, and this table is where
  // that contract's fields come from.
  //
  // `closing_balance_minor` is the figure the file itself states — OFX gives one, a
  // bare CSV usually does not, hence nullable. [D-46]: it is *not* this account's
  // balance, which is the ledger account's and is computed from journal lines like
  // every other balance here. It is the claim from outside that reconciliation exists
  // to test against, kept so a session can be opened against the number the bank
  // actually printed rather than one somebody retyped. Signed and with no CHECK, for
  // `reconciliation_sessions`' reason: an overdrawn account closes negative.
  //
  // `external_account_id` is the bank's own identifier for the account, out of the
  // file — OFX's `ACCTID`, the reference a CSV export puts in its header. It exists
  // to catch the ordinary disaster of this feature: March's current account uploaded
  // into savings, which is silent, imports every line, matches none of them, and is
  // found weeks later by a reconciliation that will not balance.
  //
  // **A mismatch is surfaced, never refused.** The wire contract already commits to
  // this — `bankStatementImportPreviewSchema.externalAccountMatches` is "a warning,
  // never a refusal, because a bank that changes its identifier would otherwise lock
  // a business out of its own statements" — and the schema agrees with it here rather
  // than having the service decide twice. So there is no CHECK, no foreign key to
  // `bank_accounts.external_account_id`, and **no token for it** in
  // `BANKING_PRECONDITIONS`: a refusal that cannot be spoken cannot be added by
  // accident. The identifier is recorded on the row so that "which account did this
  // file say it was for" stays answerable after the upload, which is what makes the
  // warning worth anything.
  //
  // ## The counts are evidence, not an aggregate
  //
  // [D-34] refuses stored aggregates, and these are not one. `lines_read` is how
  // many rows the file held and `lines_duplicate` is how many of them were already
  // present — and neither is recoverable from the resulting rows, because a
  // duplicate leaves no row behind. A re-upload of last month's file inserts nothing
  // at all, and without this row there would be no record that it happened.
  //
  // The count that *is* derivable — how many lines this import created — is
  // deliberately not stored. It is `COUNT(*) WHERE import_id = ?`, and it is
  // `lines_read - lines_duplicate`, and a third copy could only disagree with the
  // other two.
  //
  // ## file_hash is what makes "you have already uploaded this" answerable
  //
  // SHA-256 of the uploaded bytes, hex, as `request_fingerprint` is in
  // `0003_idempotency`. It is not a uniqueness constraint: re-uploading the same
  // file is legitimate and E1 requires it to be harmless, so the answer is a warning
  // the user may dismiss rather than a refusal. Line-level dedupe is what actually
  // prevents the duplicates, below.
  //
  // `format` has no 'qfx' member. QFX is Quicken's OFX with a couple of proprietary
  // tags and OB-077 is one parser for both, so a second token would be a second name
  // for one format and every consumer would have to remember to accept both.
  //
  // `mapping_id` is RESTRICT, so a mapping that produced an import cannot be deleted
  // out from under the record of what it produced — the shape `fk_tax_rates_account`
  // takes. NULL for OFX, which needs no mapping, and for a one-off CSV mapping the
  // user chose not to save.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_statement_imports (
      id                    BINARY(16)   NOT NULL,
      org_id                BINARY(16)   NOT NULL,
      bank_account_id       BINARY(16)   NOT NULL,
      format                ENUM('csv','ofx') NOT NULL,
      filename              VARCHAR(255) NOT NULL,
      file_hash             CHAR(64)     NOT NULL,
      mapping_id            BINARY(16)   NULL,
      external_account_id   VARCHAR(64)  NULL,
      closing_balance_minor BIGINT       NULL,
      status                ENUM('queued','processing','complete','failed')
                                         NOT NULL DEFAULT 'queued',
      lines_read            INT UNSIGNED NULL,
      lines_duplicate       INT UNSIGNED NULL,
      failure_reason        VARCHAR(512) NULL,
      imported_by_user_id   BINARY(16)   NOT NULL,
      created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_statement_imports_org_id (org_id, id),
      KEY idx_bsi_org_account_created (org_id, bank_account_id, created_at, id),
      KEY idx_bsi_org_account_hash (org_id, bank_account_id, file_hash),
      -- The worker's recovery scan reads pending imports by status; leading with
      -- org_id keeps it a tenant-scoped read like every other in this schema.
      KEY idx_bsi_org_status (org_id, status),
      CONSTRAINT fk_bsi_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bsi_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_bsi_mapping
        FOREIGN KEY (org_id, mapping_id) REFERENCES bank_import_mappings (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_bsi_importer
        FOREIGN KEY (imported_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- Counts are nullable until completion, so the ordering CHECK tolerates NULLs.
      CONSTRAINT chk_bsi_counts CHECK (
        lines_read IS NULL OR lines_duplicate IS NULL OR lines_duplicate <= lines_read
      ),
      -- The lifecycle, as a constraint: counts exist exactly when complete, a reason
      -- exactly when failed, and a queued/processing row carries neither (OB-078).
      CONSTRAINT chk_bsi_status CHECK (
        (status = 'complete' AND lines_read IS NOT NULL AND lines_duplicate IS NOT NULL
                             AND failure_reason IS NULL) OR
        (status = 'failed'   AND failure_reason IS NOT NULL
                             AND lines_read IS NULL AND lines_duplicate IS NULL) OR
        (status IN ('queued','processing')
                             AND lines_read IS NULL AND lines_duplicate IS NULL
                             AND failure_reason IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_statement_lines — what the bank said (ROADMAP D-42, criteria E1 and E2).
  //
  // Append-only at the grant level: `0999_app_grants` lists this table in
  // APPEND_ONLY_TABLES beside `journals`, so the application holds `SELECT` and
  // `INSERT` and no `UPDATE` or `DELETE`. E2 is that grant, and the enforcement
  // matrix asserts it as the app user rather than as a superuser.
  //
  // `created_at` and no `updated_at`, which is how `journals` and `journal_lines`
  // are spelled and is the visible half of the same guarantee: there is no column
  // here whose value changes after insert, including the one MySQL would maintain
  // itself.
  //
  // `amount_minor` is signed and there is no direction column. The file header
  // argues it; the short version is that E4 is an equation over amounts.
  //
  // `posted_date` is the date the bank's own balance moved, and it is the date a
  // reconciliation counts a line under (D-45). `value_date` is when the money became
  // available, where the bank supplies both — never used for reconciliation, kept
  // because it is what the bank said.
  //
  // ## The fingerprint, the occurrence index, and the two coffees
  //
  // D-42 requires re-import to be idempotent (E1), and statements overlap at their
  // edges as a matter of course — a user re-uploading last month's file to catch a
  // straggler must not double the month. `fingerprint` is SHA-256 hex over the
  // fields the bank actually supplies: the posted date, the signed amount, the
  // description, and the bank's own reference where there is one.
  //
  // A fingerprint alone is not enough, and this is the case D-42 states explicitly so
  // that nobody has to rediscover it: two genuinely distinct transactions can be
  // identical in every supplied field. Two £4.50 coffees at the same shop on the same
  // day, from a bank that publishes no transaction id, produce one fingerprint and
  // must produce two rows. So the unique key is
  // `(org_id, bank_account_id, fingerprint, occurrence_index)`, where the occurrence
  // index counts *how many rows with this same fingerprint already exist* — 0 for
  // the first, 1 for the second.
  //
  // The index counts occurrences of the fingerprint and deliberately not position in
  // the file, which is what makes E1 hold "whatever the file's ordering": rows with
  // equal fingerprints are indistinguishable, so which of them is called the first is
  // arbitrary and the *count* is not. The import algorithm this key implies, stated
  // once here because getting it wrong is the whole of E1: for each distinct
  // fingerprint, if the file holds k occurrences and the account already holds n,
  // insert max(0, k - n) rows at indexes n … k-1. Re-importing the same file gives
  // k = n and inserts nothing; importing an overlapping file inserts only its
  // genuinely new rows; the second coffee survives because k = 2 while n = 0.
  //
  // The occurrence index is stored beside the fingerprint rather than folded into it,
  // so that the fingerprint stays a pure function of the bank's data and "how many of
  // these have I already got" is a `COUNT` on an index rather than a probe. The
  // *wire* fingerprint (`bankLineFingerprintSchema`) is opaque and is these two
  // together — two lines agreeing on both are the same transaction, which is exactly
  // what it promises.
  //
  // `bank_reference` is kept alongside even though it is already inside the
  // fingerprint. It is the handle a support conversation with the bank uses, and the
  // fingerprint is a hash, so it cannot be read back out of one.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_statement_lines (
      id               BINARY(16)   NOT NULL,
      org_id           BINARY(16)   NOT NULL,
      bank_account_id  BINARY(16)   NOT NULL,
      import_id        BINARY(16)   NOT NULL,
      posted_date      DATE         NOT NULL,
      value_date       DATE         NULL,
      description      VARCHAR(512) NOT NULL,
      counterparty     VARCHAR(255) NULL,
      amount_minor     BIGINT       NOT NULL,
      bank_reference   VARCHAR(255) NULL,
      fingerprint      CHAR(64)     NOT NULL,
      occurrence_index SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_statement_lines_org_id (org_id, id),
      UNIQUE KEY uq_bank_statement_lines_fingerprint
        (org_id, bank_account_id, fingerprint, occurrence_index),
      -- The matching screen reads an account's lines in bank order, and the import
      -- algorithm above counts existing occurrences of one fingerprint; the unique
      -- key serves the second. This serves the first, and \`id\` is in it so the
      -- keyset cursor D-21 mandates does not fall back to a filesort.
      KEY idx_bsl_org_account_date (org_id, bank_account_id, posted_date, id),
      KEY idx_bsl_org_import (org_id, import_id),
      CONSTRAINT fk_bsl_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bsl_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_bsl_import
        FOREIGN KEY (org_id, import_id) REFERENCES bank_statement_imports (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_rules — a deterministic lookup, not an engine (ROADMAP D-44).
  //
  // Conditions on the left, an outcome on the right, and nothing else: no chaining,
  // no scripting, no ordering-dependent side effects. Same line in, same proposal
  // out, every time. M6 owns the workflow engine, and a bank rule answers "what is
  // this line", which is classification rather than orchestration.
  //
  // ## Where a rule may and may not reach
  //
  // E8 — a rule change never restates a posted entry. The enforcement is structural
  // and consists of what is *not* here: nothing references `journals`,
  // `journal_lines`, or `bank_line_clearings`, and no clearing names the rule that
  // suggested it. A rule can only ever put a row in `bank_match_proposals`, which a
  // human then accepts or ignores (D-43). Adding a `bank_rule_id` to a clearing for
  // provenance would look harmless and would create exactly the backwards path D-44
  // refuses.
  //
  // ## Determinism needs a total order, and priority alone is not one
  //
  // Two rules can match one line. `priority` orders them, low first, and it is
  // deliberately not unique — forcing uniqueness would make inserting a rule between
  // two others renumber the list, and a renumber is an update to rows the user did
  // not touch. Ties break on `(created_at, id)`, which is total and stable, so
  // "first match wins" is a definite statement even when an org gives every rule the
  // same priority. `idx_bank_rules_org_match` is that order.
  //
  // ## The conditions
  //
  // `match_description_mode` is contains, equals, or starts_with, and there is no
  // regular expression among them: a regex is a program, and a rule nobody can read
  // is a coding decision nobody can audit. The mode and the text are meaningless
  // apart, so `chk_bank_rules_description` requires both or neither.
  //
  // `match_amount_min_minor` and `match_amount_max_minor` are inclusive bounds on
  // the line's **signed** amount, so an outbound rule bounded at -5000 and -100 reads
  // the way the number line does — and there is no positivity CHECK here, for the
  // same reason. Bounds rather than an exact amount because the useful case is a
  // range: a subscription that drifts by a few pence, a card fee under a pound. An
  // exact amount is the range with equal ends.
  //
  // `chk_bank_rules_has_condition` refuses a rule with no conditions at all. That
  // rule matches every line on the account and would out-rank every genuine proposal
  // on a statement — a footgun with no legitimate use, and the one mistake here that
  // is expressible as a constraint.
  //
  // ## The outcome
  //
  // `set_account_id` is NOT NULL: classification is what a rule is *for*, and a rule
  // that set only a contact would produce a proposal that still cannot be accepted
  // without the user answering the one question that matters. `set_contact_id` and
  // the tags in `bank_rule_dimensions` are the optional half.
  //
  // `bank_account_id` is nullable: NULL means every account in the org. Right for
  // "Tesco is groceries", wrong for a rule about one card's annual fee, and requiring
  // one copy per account would make editing a rule an n-way edit.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_rules (
      id                     BINARY(16)   NOT NULL,
      org_id                 BINARY(16)   NOT NULL,
      bank_account_id        BINARY(16)   NULL,
      name                   VARCHAR(120) NOT NULL,
      priority               SMALLINT UNSIGNED NOT NULL DEFAULT 100,
      match_description      VARCHAR(255) NULL,
      match_description_mode ENUM('contains','equals','starts_with') NULL,
      match_direction        ENUM('inbound','outbound') NULL,
      match_amount_min_minor BIGINT       NULL,
      match_amount_max_minor BIGINT       NULL,
      set_account_id         BINARY(16)   NOT NULL,
      set_contact_id         BINARY(16)   NULL,
      is_active              TINYINT(1)   NOT NULL DEFAULT 1,
      created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_rules_org_id (org_id, id),
      UNIQUE KEY uq_bank_rules_org_name (org_id, name),
      KEY idx_bank_rules_org_match (org_id, is_active, priority, created_at, id),
      KEY idx_bank_rules_org_account (org_id, bank_account_id),
      CONSTRAINT fk_bank_rules_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_rules_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_bank_rules_set_account
        FOREIGN KEY (org_id, set_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_bank_rules_set_contact
        FOREIGN KEY (org_id, set_contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_bank_rules_description CHECK (
        (match_description IS NULL) = (match_description_mode IS NULL)
      ),
      CONSTRAINT chk_bank_rules_amount_range CHECK (
        match_amount_min_minor IS NULL OR
        match_amount_max_minor IS NULL OR
        match_amount_max_minor >= match_amount_min_minor
      ),
      CONSTRAINT chk_bank_rules_has_condition CHECK (
        match_description      IS NOT NULL OR
        match_direction        IS NOT NULL OR
        match_amount_min_minor IS NOT NULL OR
        match_amount_max_minor IS NOT NULL
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_rule_dimensions — the tags a rule sets (D-18, D-44).
  //
  // A fifth tag table, for the reason there is a fourth: the parents differ and so do
  // their delete semantics. A `JSON` array of value ids would have been shorter and
  // would have given up the one thing that matters — the three-column foreign key
  // below, which makes a rule tagging another org's dimension value structurally
  // impossible rather than merely unlikely.
  //
  // Same `(org_id, parent, dimension)` primary key as the other four: a rule setting
  // two values on one axis would produce a proposal that double-counts in every
  // sliced report, which is B6 being false before the entry is even posted.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_rule_dimensions (
      org_id             BINARY(16)  NOT NULL,
      bank_rule_id       BINARY(16)  NOT NULL,
      dimension_id       BINARY(16)  NOT NULL,
      dimension_value_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, bank_rule_id, dimension_id),
      CONSTRAINT fk_brd_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_brd_rule
        FOREIGN KEY (org_id, bank_rule_id) REFERENCES bank_rules (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_brd_value
        FOREIGN KEY (org_id, dimension_id, dimension_value_id)
        REFERENCES dimension_values (org_id, dimension_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_match_proposals — ranked candidates, cheap and disposable (ROADMAP D-43).
  //
  // Four kinds of answer to "what is this line", and `proposal_type` says which,
  // with `chk_bmp_target` requiring exactly the matching target column and forbidding
  // the others:
  //
  //   journal      an entry already posted, which this line clears
  //   ar_document  an open invoice this receipt settles
  //   ap_document  an open bill this payment settles
  //   coding       a new entry, to this account and contact
  //
  // Four nullable columns and a CHECK rather than four tables, because a proposal is
  // read as one ranked list per line and splitting it across four tables would make
  // the ranking a four-way union. The CHECK is what keeps that from being a bag of
  // optional fields. The four map one-for-one onto the three clearing methods below:
  // 'journal' is accepted as `link_entry`, the two document kinds as
  // `allocate_document`, and 'coding' as `post_entry`, so a proposal whose kind has
  // no way to be accepted is unrepresentable.
  //
  // ## The ranking is stored; the score behind it is not
  //
  // This table held a `score` and does not any more, and the absence is the whole of
  // the decision. D-43 puts confidence "in the ordering of proposals, not in the
  // decision to write", and a persisted score is the field an auto-accept threshold
  // eventually gets built on: once a number is in a column, somebody adds a setting
  // that accepts everything above it, and the auto-poster D-43 refuses is back with a
  // slider in front of it. The schema should not make the wrong thing easy. D-43 also
  // names "the ranking can be improved later without a migration" as the point of
  // proposals being cheap and disposable, which a stored score undercuts — a column
  // is exactly the thing a later scorer would have to keep meaning the same by.
  //
  // So `rank` is what is written: 1 for the best candidate, ascending, comparable
  // only among proposals for the same line, and the same field the wire contract
  // publishes (`bankMatchProposalSchema`). A ranking function is free to change
  // wholesale because nothing downstream reads anything but the order.
  //
  // `rank` is a **reserved word** on MySQL 8 — it is a window function — so the
  // column and the index that names it are backquoted. Unquoted it is
  // `ERROR 1064 … near 'rank SMALLINT UNSIGNED NOT NULL'`, measured on 8.4.10. Kysely
  // quotes identifiers itself, so this is a fact about the raw DDL and about raw SQL
  // in tests, not about query builders.
  //
  // `idx_bmp_org_line_rank` is ascending, because best-first now means lowest-first,
  // and the descending index goes with the score that needed it. The old finding was
  // re-measured rather than carried over, and it did not carry over unchanged:
  // `SHOW INDEX` now reports collation `A` on all four columns where it reported `D`
  // on `score`. What carries over is the property that mattered.
  //
  // Measured on MySQL 8.4.10 against 3,000 proposals over 300 lines. `EXPLAIN` of the
  // read this table exists for — `WHERE org_id = ? AND statement_line_id = ?
  // ORDER BY rank, id LIMIT 5`:
  //
  //   key: idx_bmp_org_line_rank   ref: const,const   rows: 10
  //   Extra: Using where; Using index
  //
  // and the same query under `IGNORE INDEX (idx_bmp_org_line_rank)`, which is the
  // control that makes the first line mean anything:
  //
  //   key: fk_bmp_account          ref: const         rows: 1490
  //   Extra: Using index condition; Using where; Using filesort
  //
  // Ten rows read in index order, against 1,490 sorted. That is one line of one
  // statement; the matching screen shows a few hundred at a time (E10).
  //
  // `reason_code` is a token — 'exact_amount_and_date', 'rule', 'contact_name' — not
  // prose. D-43 requires the pipeline to explain itself, and the explanation is
  // rendered by the client from a stable vocabulary, exactly as a refusal token is.
  // Prose here would be an untranslatable string chosen by a service.
  //
  // ## Deleted wholesale, and that is why everything CASCADEs into it
  //
  // Regenerating a line's proposals is a delete and a re-insert, and every reference
  // out of this table CASCADEs: a proposal naming a deleted invoice, contact, or rule
  // is not a proposal. RESTRICT anywhere here would make a disposable row keep a real
  // one alive.
  //
  // `fk_bmp_rule` is the one that wanted to be `ON DELETE SET NULL` — blank the
  // provenance, keep the suggestion — and cannot be, for the reason recorded in the
  // file header: no composite `(org_id, …)` reference in this schema can ever be SET
  // NULL. The choice is CASCADE or RESTRICT, and for a disposable row it is CASCADE.
  //
  // `fk_bmp_journal` is the exception and RESTRICT there is deliberate: journals are
  // never deleted at all (spec §2.2), so the action can only fire on an org cascade,
  // where it would be masking a bug.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_match_proposals (
      id                BINARY(16)  NOT NULL,
      org_id            BINARY(16)  NOT NULL,
      statement_line_id BINARY(16)  NOT NULL,
      proposal_type     ENUM('journal','ar_document','ap_document','coding') NOT NULL,
      journal_id        BINARY(16)  NULL,
      ar_document_id    BINARY(16)  NULL,
      ap_document_id    BINARY(16)  NULL,
      account_id        BINARY(16)  NULL,
      contact_id        BINARY(16)  NULL,
      bank_rule_id      BINARY(16)  NULL,
      \`rank\`            SMALLINT UNSIGNED NOT NULL,
      reason_code       VARCHAR(64) NOT NULL,
      created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bmp_org_id (org_id, id),
      KEY idx_bmp_org_line_rank (org_id, statement_line_id, \`rank\`, id),
      KEY idx_bmp_org_journal (org_id, journal_id),
      KEY idx_bmp_org_ar_document (org_id, ar_document_id),
      KEY idx_bmp_org_ap_document (org_id, ap_document_id),
      KEY idx_bmp_org_rule (org_id, bank_rule_id),
      CONSTRAINT fk_bmp_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bmp_line
        FOREIGN KEY (org_id, statement_line_id) REFERENCES bank_statement_lines (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_bmp_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_bmp_ar_document
        FOREIGN KEY (org_id, ar_document_id) REFERENCES ar_documents (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_bmp_ap_document
        FOREIGN KEY (org_id, ap_document_id) REFERENCES ap_documents (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_bmp_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_bmp_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_bmp_rule
        FOREIGN KEY (org_id, bank_rule_id) REFERENCES bank_rules (org_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_bmp_target CHECK (
        (proposal_type = 'journal'
           AND journal_id IS NOT NULL
           AND ar_document_id IS NULL AND ap_document_id IS NULL AND account_id IS NULL) OR
        (proposal_type = 'ar_document'
           AND ar_document_id IS NOT NULL
           AND journal_id IS NULL AND ap_document_id IS NULL AND account_id IS NULL) OR
        (proposal_type = 'ap_document'
           AND ap_document_id IS NOT NULL
           AND journal_id IS NULL AND ar_document_id IS NULL AND account_id IS NULL) OR
        (proposal_type = 'coding'
           AND account_id IS NOT NULL
           AND journal_id IS NULL AND ar_document_id IS NULL AND ap_document_id IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // reconciliation_sessions — an assertion in progress (ROADMAP D-45).
  //
  // A bank account, an end date, and the closing balance the statement claims. Lines
  // are cleared until the computed book balance equals that figure, and finalising
  // records the assertion (E5).
  //
  // ## Its lock is not the period lock, and the schema says so by omission
  //
  // E7. There is no `period_id` here and no session id on `fiscal_periods`. The two
  // are different assertions on different cadences, and the coupling fails in both
  // directions: one account's unreconciled straggler freezing the whole ledger, or
  // closing a period silently asserting a reconciliation nobody performed. D-08
  // deferred the reopen flow in M1 saying spec Phase 3 was describing *this*; this is
  // it, and it is deliberately not that.
  //
  // ## state is stored, and it is the row the application locks
  //
  // D-38 derives status wherever it can, and this is the case where it cannot. The
  // events table below is a complete history, so `state` is in principle "the type of
  // the latest event" — but a concurrent clearing has to *test* the lock, and testing
  // it means taking a row `FOR UPDATE`. That is only possible because this table is
  // in the mutable grant list, and it is the same trick `journal_sequences` exists
  // for (D-14). A locking read over an ordered scan of an append-only event log is
  // not a thing MySQL will do.
  //
  // So `state` is the lock and the events are the record, and `chk_rs_finalised`
  // keeps them from drifting: finalised exactly when there is a `finalised_at`, the
  // shape `fiscal_periods` uses for its own close.
  //
  // ## At most one session open per bank account, enforced rather than remembered
  //
  // Two open reconciliations on one account is two people clearing the same lines
  // into different assertions, and `bank_account_has_open_session` is the refusal it
  // produces. MySQL has no partial unique index, so `open_marker` is a stored
  // generated column holding the bank account id while the session is open and NULL
  // once it is finalised — NULLs are distinct in a unique index, so any number of
  // finalised sessions coexist while a second open one collides. `claim_scope` in
  // `0003_idempotency` is the same device for the same reason.
  //
  // The constraint 0003 hit applies here and is why the foreign key on
  // `bank_account_id` is RESTRICT: MySQL refuses a foreign key *action* on a column a
  // STORED generated column reads (`ERROR 1215`), so CASCADE on that column would
  // make this table fail to create. `org_id` is not read by the expression, so its
  // CASCADE from `orgs` is unaffected. Verified on MySQL 8.4.
  //
  // Sessions must also not *overlap* on one account — `reconciliation_session_overlaps`
  // — and that is a comparison between date ranges on sibling rows, which no CHECK
  // can read. It lives in OB-082.
  //
  // ## The closing balance is signed
  //
  // No `CHECK (… > 0)`. An overdrawn account has a negative closing balance and a
  // credit card in credit has a positive one, and both are ordinary. This is a
  // *balance* rather than an amount, and balances have signs — as, here, does every
  // amount on a statement line.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE reconciliation_sessions (
      id                              BINARY(16)  NOT NULL,
      org_id                          BINARY(16)  NOT NULL,
      bank_account_id                 BINARY(16)  NOT NULL,
      end_date                        DATE        NOT NULL,
      statement_closing_balance_minor BIGINT      NOT NULL,
      state                           ENUM('in_progress','finalised')
                                                  NOT NULL DEFAULT 'in_progress',
      open_marker                     BINARY(16)  AS (IF(state = 'in_progress',
                                                         bank_account_id, NULL)) STORED,
      finalised_at                    DATETIME(3) NULL,
      created_by_user_id              BINARY(16)  NOT NULL,
      created_at                      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at                      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                                  ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_reconciliation_sessions_org_id (org_id, id),
      UNIQUE KEY uq_reconciliation_sessions_open (org_id, open_marker),
      KEY idx_rs_org_account_end (org_id, bank_account_id, end_date, id),
      KEY idx_rs_org_created (org_id, created_at, id),
      CONSTRAINT fk_rs_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_rs_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_rs_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_rs_finalised CHECK (
        (state = 'in_progress' AND finalised_at IS NULL) OR
        (state = 'finalised'   AND finalised_at IS NOT NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bank_line_clearings — the accepted match (criterion E4).
  //
  // One row per statement line that has been cleared, naming the journal that
  // cleared it. `uq_blc_line` is one clearing per line — `statement_line_already_cleared`
  // — and `uq_blc_journal` is one line per journal — `journal_already_cleared`.
  // Both matter to E5's arithmetic: two lines pointing at one entry would clear the
  // bank twice for a single movement of money. A batched deposit that settles three
  // invoices is one bank line, one receipt, one journal, and three rows in
  // `ar_allocations` — the split lives in the subledger, where it already has a
  // mechanism.
  //
  // `method` is how the line was accounted for and is the same three OB-081
  // implements: `post_entry` created a journal for it, `link_entry` pointed it at one
  // that already existed, `allocate_document` recorded a payment and applied it to an
  // invoice or a bill. `payment_id` is set on the third and NULL on the other two.
  //
  // `cleared_journal_id` is NOT NULL because there is no such thing as a cleared line
  // with no entry behind it.
  //
  // ## Deletable, for the reason `ar_allocations` is
  //
  // This looks like it should be append-only and it is not, and the argument is the
  // one 0005 makes about allocations: **a clearing posts no journal**. The journal
  // was posted separately, by a human, through the ordinary path (D-43, E3). A
  // clearing states which bank line that journal corresponds to, and removing one
  // restates no financial statement — it un-matches a line, which is an ordinary
  // correction of an analysis link and not a rewrite of the ledger. Modelling an
  // un-match as a reversing row instead would make every cleared-balance sum signed
  // amounts and every "is this line cleared" query reason about which rows cancel.
  //
  // What must not be deletable is a clearing inside a *finalised* session, and no
  // grant can express that: it is a rule about one column's value on another row.
  // It lives in OB-082 with the rest of the session lock, and E6's audit trail is in
  // `reconciliation_session_events`, which *is* append-only.
  //
  // ## The three amounts, and why the difference is stored
  //
  // E4 — a cleared line and the entry it clears agree exactly on amount, and the
  // difference is recorded. Both are signed, like the line, so the invariant is a
  // plain equation with no conditional in it:
  //
  //   cleared_amount_minor + difference_amount_minor = line.amount_minor
  //
  // The difference is stored rather than joined for the reason `ar_document_lines`
  // stores its rounded amounts: it is not a cache of an aggregate but the record of a
  // decision — "I accepted a shortfall of 200 here, to this account" — made at a
  // moment by the person named in `created_by_user_id`. No CHECK can verify the
  // equation, because one operand is a column on another table and MySQL has no CHECK
  // that reads one; that is OB-081's, and the property suite asserts it (OB-088).
  //
  // `difference_account_id` is where the difference posts — bank charges, a short
  // payment — and `chk_blc_difference_accounted` is `clearing_difference_unaccounted`
  // stated in the schema: a difference with nowhere to go is inexpressible.
  // `chk_blc_post_entry_exact` is the other half: a `post_entry` clearing created the
  // journal *for* the line, so it agrees by construction and a difference on one
  // would mean the entry was posted for an amount nobody asked for.
  //
  // ## No proposal id, deliberately
  //
  // Recording which proposal was accepted looks like free provenance and is a trap.
  // Proposals are disposable and are deleted wholesale (D-43), so the foreign key
  // would have to be RESTRICT — keeping a dead proposal alive forever to explain a
  // clearing — or SET NULL, which the file header records as impossible on a
  // composite tenant key anyway. Who accepted it and when is on this row; why is a
  // property of a ranking that no longer exists.
  //
  // `reconciliation_session_id` is NULL when the line was matched outside a session,
  // which is the ordinary case on the matching screen. While a session is open its
  // membership is the *query* — this bank account, line dated on or before `end_date`,
  // stamp still NULL — so a NULL here is included by date rather than excluded.
  //
  // ## Finalising freezes membership by writing this stamp — D-51, OB-082
  //
  // The stamp is how a finalised assertion stays reproducible. When a session
  // finalises, OB-082 writes its id onto exactly the clearings the query returned, so
  // the finalised set is a *stored fact* rather than a query that could answer
  // differently tomorrow. A statement line arriving late (imports are append-only but
  // not date-ordered) and cleared afterwards is left unstamped and is not part of the
  // assertion — it cannot silently change what the session recorded. Reopening
  // unstamps, which is the permission-gated, recorded way to re-gather membership (E6).
  //
  // This is [D-42](ROADMAP)'s argument applied to an assertion rather than a line: a
  // record whose meaning can be rewritten after the fact records nothing. The column
  // was designed nullable for exactly this write; `reconciliation_session_events`
  // records what was asserted and when, and the stamp records over what.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_line_clearings (
      id                        BINARY(16)  NOT NULL,
      org_id                    BINARY(16)  NOT NULL,
      statement_line_id         BINARY(16)  NOT NULL,
      method                    ENUM('post_entry','link_entry','allocate_document') NOT NULL,
      cleared_journal_id        BINARY(16)  NOT NULL,
      payment_id                BINARY(16)  NULL,
      reconciliation_session_id BINARY(16)  NULL,
      cleared_amount_minor      BIGINT      NOT NULL,
      difference_amount_minor   BIGINT      NOT NULL DEFAULT 0,
      difference_account_id     BINARY(16)  NULL,
      difference_journal_id     BINARY(16)  NULL,
      created_by_user_id        BINARY(16)  NOT NULL,
      created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                            ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_blc_org_id (org_id, id),
      UNIQUE KEY uq_blc_line (org_id, statement_line_id),
      UNIQUE KEY uq_blc_journal (org_id, cleared_journal_id),
      KEY idx_blc_org_session (org_id, reconciliation_session_id),
      KEY idx_blc_org_payment (org_id, payment_id),
      CONSTRAINT fk_blc_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_blc_line
        FOREIGN KEY (org_id, statement_line_id) REFERENCES bank_statement_lines (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_blc_journal
        FOREIGN KEY (org_id, cleared_journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_blc_difference_journal
        FOREIGN KEY (org_id, difference_journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_blc_difference_account
        FOREIGN KEY (org_id, difference_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_blc_payment
        FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_blc_session
        FOREIGN KEY (org_id, reconciliation_session_id)
        REFERENCES reconciliation_sessions (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_blc_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_blc_difference_accounted CHECK (
        (difference_amount_minor =  0 AND difference_account_id IS NULL) OR
        (difference_amount_minor <> 0 AND difference_account_id IS NOT NULL)
      ),
      CONSTRAINT chk_blc_post_entry_exact CHECK (
        method <> 'post_entry' OR difference_amount_minor = 0
      ),
      CONSTRAINT chk_blc_payment_method CHECK (
        method = 'allocate_document' OR payment_id IS NULL
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // reconciliation_session_events — who finalised, who reopened, and when
  // (criterion E6; ROADMAP D-45).
  //
  // Append-only, in `0999_app_grants`'s sense, and that is the entire content of E6.
  // An audit trail the application can edit or delete is not one — this is the
  // journals argument (spec §2.2) applied to a record of decisions rather than of
  // money, and it is why reopening is recorded here rather than as a column on the
  // session that the next reopen overwrites.
  //
  // `created_at` and no `updated_at`, as on `bank_statement_lines` and `journals`.
  //
  // `asserted_balance_minor` is on the finalise event rather than read back from the
  // session, because the session's `statement_closing_balance_minor` is mutable — a
  // user may correct a mistyped figure while the session is open, and reopening makes
  // it editable again. What was asserted at 14:02 on Tuesday is a fact about
  // Tuesday, so it is recorded on the event that made it.
  //
  // One column and not two, because E5 is that finalising *refuses* unless the book
  // balance equals the statement balance. Storing both would be storing a number
  // twice and inviting a reader to wonder which is authoritative when they differ,
  // which by construction they cannot.
  //
  // `chk_rse_balance` pairs the two: a finalise carries the figure it asserted, a
  // reopen carries none, and neither can be recorded in the other's shape. `reason`
  // is free text and is the reopen's — "bank restated a fee" is exactly what the next
  // reader needs and no vocabulary can enumerate.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE reconciliation_session_events (
      id                     BINARY(16)   NOT NULL,
      org_id                 BINARY(16)   NOT NULL,
      session_id             BINARY(16)   NOT NULL,
      event_type             ENUM('finalised','reopened') NOT NULL,
      asserted_balance_minor BIGINT       NULL,
      reason                 VARCHAR(512) NULL,
      created_by_user_id     BINARY(16)   NOT NULL,
      created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_rse_org_id (org_id, id),
      KEY idx_rse_org_session (org_id, session_id, created_at, id),
      CONSTRAINT fk_rse_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_rse_session
        FOREIGN KEY (org_id, session_id) REFERENCES reconciliation_sessions (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_rse_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_rse_balance CHECK (
        (event_type = 'finalised' AND asserted_balance_minor IS NOT NULL) OR
        (event_type = 'reopened'  AND asserted_balance_minor IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order: a table cannot be dropped while a foreign key points
  // at it.
  await sql`DROP TABLE IF EXISTS reconciliation_session_events`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_line_clearings`.execute(db);
  await sql`DROP TABLE IF EXISTS reconciliation_sessions`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_match_proposals`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_rule_dimensions`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_rules`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_statement_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_statement_imports`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_import_mappings`.execute(db);
  await sql`DROP TABLE IF EXISTS bank_accounts`.execute(db);
}
