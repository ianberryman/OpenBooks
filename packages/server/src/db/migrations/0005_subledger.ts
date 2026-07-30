import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * The AR/AP subledger (M3): tax rates, customer and vendor documents, payments,
 * and the allocations that tie them together.
 *
 * ## Why this is a migration of its own, which M2's tables were not
 *
 * `0002_ledger` explains at length why contacts, dimensions and drafts were folded
 * into it: MySQL refuses a table-level `GRANT` on a table that does not exist
 * (`ERROR 1146`, measured on 8.4), the grants migration was numbered `0004`, and the
 * only ways to create a table after it were to renumber it every wave or to number
 * around it (`0003a`, `0003b`, …). OB-060 fixed the cause instead: the grants
 * migration is `0999_app_grants`, the ceiling of the four-digit numbering
 * convention, so nothing that follows the convention can sort after it. This file is
 * the first thing that fix buys.
 *
 * It is a separate file rather than eleven more tables in `0002_ledger` because the
 * subledger is not a change to the ledger. Nothing here alters how a journal is
 * posted; these tables describe *what a posting was about* and get their financial
 * truth from the ledger, never the other way round.
 *
 * ## The property every table here is shaped by: no balance, no status
 *
 * [D-34] — an invoice does not carry what is outstanding on it, and there is no
 * `outstanding_minor` column anywhere below. Outstanding is the document's total
 * minus the allocations against it, computed on read, exactly as the trial balance
 * is computed from journal lines rather than from a cache (spec §2.1, §2.6). The
 * moment a document carries its own balance there are two answers to "what does this
 * customer owe" — the subledger's and the ledger's — and spec §11 names their
 * agreement as an invariant precisely because that divergence is unfalsifiable when
 * the subledger is the thing being asked.
 *
 * [D-38] applies the same argument to status: part-paid and paid are derived from
 * allocations and are not stored. What *is* stored is the part that no allocation can
 * imply — whether the document has been approved, and whether it has been voided —
 * and it is stored as the two facts that caused it rather than as an enum:
 *
 *   draft      journal_id IS NULL
 *   approved   journal_id IS NOT NULL AND void_journal_id IS NULL
 *   void       void_journal_id IS NOT NULL
 *
 * A `status` column would be a third copy of a fact the journal columns already
 * carry, and the first thing to drift when a void is posted and the update after it
 * fails. Deriving it also makes the lifecycle unforgeable: "approved" cannot be set
 * without a journal to point at, so the ledger has necessarily been told.
 *
 * ## Rounding results are recorded; aggregates never are
 *
 * The one place this schema stores arithmetic is on a document line, which carries
 * both its extended net amount and its tax amount. That is not a cached total: it is
 * where [D-35]'s single rounding point lands — "tax is computed per line, rounded
 * once per line, and the invoice total is the sum of rounded lines, never the rounded
 * sum". Recording the rounded result is what makes an approved document reproduce the
 * journal it posted even if the rate row is later edited, and it is what lets C5
 * assert that tax-inclusive and tax-exclusive entry of the same economic invoice post
 * *identical* journals.
 *
 * No header total is stored, for the D-34 reason. A total is an aggregate; a rounded
 * line amount is a decision.
 *
 * ## Everything here is mutable, and that is the grant-level statement of D-34
 *
 * All eleven tables are in `0999_app_grants`'s `MUTABLE_TABLES` and none is in
 * `APPEND_ONLY_TABLES`. That is not a relaxation of the immutability guarantee — it
 * is what the guarantee means once D-34 is taken seriously. A document holds no
 * financial state, so editing one restates no financial statement; every irreversible
 * fact it produces is a row in `journals`, which the app user still cannot `UPDATE`
 * or `DELETE`. Void is a reversing journal (D-38, D-16), not a deletion, and the
 * document and its reversal both remain visible.
 *
 * The consequence worth knowing is a good one: because these tables are mutable, the
 * app user *can* take a locking read on them, which the ledger tables famously
 * cannot (D-14). Refusing an over-allocation (C3) needs exactly that — the document
 * row taken `FOR UPDATE` while its allocations are summed.
 *
 * ## Cash application's in-place additions (D-15, D-79, D-106)
 *
 * Four columns and a widened CHECK, added directly to the tables above rather than
 * appended in a later migration, per D-15's pre-release convention: `ar_documents`/
 * `ap_documents.payment_term_id` (the term a document was raised under, overriding
 * the contact's default); `org_accounting_settings.discount_given_account_id` /
 * `.discount_received_account_id` (where an early-pay discount posts, alongside the
 * two control accounts they sit beside); and `ar_allocations`/
 * `ap_allocations.discount_journal_id`, a third allocation source alongside a
 * payment and a credit document — D-106 models a discount as a settlement funded by
 * the discount journal rather than by cash, so it needed a column of its own rather
 * than an ill-fitting reuse of the other two. See each table's own comment.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // org_accounting_settings — where an org nominates its control accounts
  // (OB-066a; ROADMAP D-23, D-34, D-40).
  //
  // An approved invoice debits *the* receivables control account and an approved
  // bill credits *the* payables one; C2 and C8 are statements about those two
  // accounts specifically. Nothing else in this file names them, and until this
  // table existed three services each resolved the account by the code the shipped
  // chart template happens to use (`1100`, `2010`) and refused loudly otherwise.
  // That is unusable as a permanent answer because D-23 makes chart templates
  // opt-in and unenforced: an org that declined the template, or renumbered its
  // chart, has no `1100`, and AR then fails a precondition on every approval with
  // no setting anywhere to correct.
  //
  // ## Why a table rather than two columns on `orgs`
  //
  // `orgs` already carries `fiscal_year_start_month`, so a per-org accounting
  // setting has precedent there — and that precedent does not extend to this one,
  // because a fiscal-year start is a bounded scalar and a control account is a
  // *reference into tenant data*.
  //
  // Every tenant reference in this schema is a composite `(org_id, id)` foreign
  // key, which is what makes another org's id structurally unusable rather than
  // merely unlikely (see `src/db/migrations/README.md`). That key is inexpressible
  // on `orgs`: `orgs` has no `org_id` column, so the only available form is
  // `FOREIGN KEY (receivable_control_account_id) REFERENCES accounts (id)` — a
  // single-column reference that another org's account satisfies, which is the one
  // shape the tenancy pattern exists to forbid. It would also close a foreign-key
  // cycle, `orgs` → `accounts` → `orgs`, in which the `ON DELETE CASCADE` every
  // tenant table hangs off `orgs` runs into a `RESTRICT` pointing back at it.
  //
  // A table with `org_id NOT NULL` avoids both, and it is reachable only through
  // `tenantDb(orgId)` by construction (`src/db/tenant-tables.ts` derives the tenant
  // set from the schema), so "which account did *this* org nominate" has no
  // unscoped spelling.
  //
  // ## The row is absent until something nominates, and both columns are nullable
  //
  // Absent means "not nominated", which is the state every org is in on the day it
  // is created and the state an org that declined a chart template stays in. It is
  // not an error until something needs the account, and then it is a refusal that
  // names the setting rather than an account code somebody guessed. The columns are
  // separately nullable because the two sides are separately usable: an org that
  // only invoices never needs a payables control account, and requiring one to
  // record the other would invent a prerequisite.
  //
  // ## Changing a nomination restates nothing, and that is structural
  //
  // A posted journal names the account it was posted to, by id, and no column in
  // `journals` or `journal_lines` can be updated (spec §12). So repointing this
  // setting moves *future* postings and cannot reach past ones — there is no code
  // path that could rewrite them and no grant that would permit one. The
  // consequence a reader needs is the other direction: while documents posted to
  // the old account are still outstanding, the subledger ties to the two accounts
  // together rather than to the new one alone. That is stated in
  // `modules/settings/index.ts`, where the operation that permits the change lives.
  //
  // RESTRICT on both, so a nominated account cannot be deleted out from under the
  // orgs that post to it — the same shape `fk_ar_document_lines_account` takes, and
  // `deleteAccount` already refuses an account with postings for the related reason.
  // ---------------------------------------------------------------------------
  // ## discount_given_account_id / discount_received_account_id — added in place
  // for Cash application (D-15, D-79, D-106)
  //
  // The early-pay discount is real P&L (D-66) and posts to an account the org
  // nominates, exactly as the two control accounts above are nominated rather than
  // guessed from a chart-template code (D-23). `discount_given_account_id` is the
  // expense side of a discount this org gives a customer for paying early;
  // `discount_received_account_id` is the income side of a discount a vendor gives
  // this org — the AP mirror. Both are added here rather than in `0012` because,
  // unlike `payment_terms`, their target — `accounts` — already exists in this
  // migration's own predecessor (`0002_ledger`), so the composite foreign key needs
  // no later `ALTER TABLE`. Nullable and separately so, following
  // `receivable_control_account_id` / `payable_control_account_id`'s own reasoning
  // immediately above: an org that only invoices never gives a vendor discount, and
  // requiring one nomination to record the other would invent a prerequisite. Not
  // constrained to `expense`/`income` types for the reason `tax_account_id` is not
  // constrained to a liability one — MySQL cannot express a CHECK that reads
  // another table.
  await sql`
    CREATE TABLE org_accounting_settings (
      org_id                        BINARY(16)  NOT NULL,
      receivable_control_account_id BINARY(16)  NULL,
      payable_control_account_id    BINARY(16)  NULL,
      discount_given_account_id     BINARY(16)  NULL,
      discount_received_account_id  BINARY(16)  NULL,
      -- The org's default fixed-asset depreciation accounts (L, D-115), added in place
      -- (D-15) for the discount pair's reason exactly: they nominate control accounts,
      -- their target (accounts) already exists in this migration's predecessor, and an
      -- org that registers no asset need name neither — so both are nullable and
      -- separately so. The expense account is where a period's charge lands (an
      -- expense); the accumulated account is where it accrues — an ordinary asset
      -- account carrying a credit balance, no contra flag (D-115). Each asset may
      -- override these; unset, registration defaults from here.
      depreciation_expense_account_id      BINARY(16)  NULL,
      accumulated_depreciation_account_id  BINARY(16)  NULL,
      -- The basis a report renders on unless the request overrides it (K1, D-87).
      -- Defaults to 'accrual': the ledger is accrual-capable and every M2 report was
      -- accrual (D-22), so an org sees no change until it opts into cash. NOT NULL: there
      -- is always a default basis, even on the lazily-created settings row.
      default_reporting_basis       ENUM('accrual','cash') NOT NULL DEFAULT 'accrual',
      created_at                    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at                    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                                ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id),
      -- Declared rather than left to InnoDB's automatic index for a composite
      -- foreign key, so the covering index is visible where the constraint is.
      KEY idx_oas_receivable (org_id, receivable_control_account_id),
      KEY idx_oas_payable (org_id, payable_control_account_id),
      KEY idx_oas_discount_given (org_id, discount_given_account_id),
      KEY idx_oas_discount_received (org_id, discount_received_account_id),
      KEY idx_oas_depreciation_expense (org_id, depreciation_expense_account_id),
      KEY idx_oas_accumulated_depreciation (org_id, accumulated_depreciation_account_id),
      CONSTRAINT fk_oas_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_oas_receivable
        FOREIGN KEY (org_id, receivable_control_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_oas_payable
        FOREIGN KEY (org_id, payable_control_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_oas_discount_given
        FOREIGN KEY (org_id, discount_given_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_oas_discount_received
        FOREIGN KEY (org_id, discount_received_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_oas_depreciation_expense
        FOREIGN KEY (org_id, depreciation_expense_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_oas_accumulated_depreciation
        FOREIGN KEY (org_id, accumulated_depreciation_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // tax_rates — the per-org rate list (ROADMAP D-35).
  //
  // A rate is a name, a percentage, and the liability account tax posts to. One
  // rate per line, and the document declares whether its unit prices already
  // include it. Compound rates, multi-component rates (GST+PST), and jurisdiction
  // rules are deliberately out: they are a subsystem, not a feature, and scoping
  // them here would make M3 a tax milestone with invoicing attached.
  //
  // ## The percentage is an integer, in parts per million
  //
  // `rate_ppm` is a fraction of the taxable amount scaled by 1,000,000: 20% is
  // 200000, and 8.875% — a real US combined rate, and the reason basis points are
  // not enough — is 88750. One ppm is 0.0001 of a percentage point, which covers
  // every published rate we could find.
  //
  // An integer rather than `DECIMAL(9,6)` for the same reason money is an integer
  // (spec §12, D-13): the whole system's arithmetic is exact integer arithmetic,
  // the driver already returns every integer column as a number or a `bigint`, and
  // a `DECIMAL` would arrive as a string that some caller eventually parses as a
  // float. Tax on a line is `round(base * rate_ppm / 1_000_000)`, which is one
  // multiplication and one documented rounding — nothing in it can be inexact
  // before the rounding step.
  //
  // No upper bound is asserted. 100% is not a natural ceiling — excise rates above
  // it exist — and a rule invented before the thing it governs is the mistake
  // `parent_account_id` avoided in M1 and `normal_balance` avoids by not being
  // constrained against `type`. `INT UNSIGNED` already forbids a negative rate,
  // which is the constraint that has a meaning.
  //
  // `tax_account_id` is not constrained to a liability account, because MySQL
  // cannot express a CHECK that reads another table. The tax rates service (OB-066)
  // enforces it.
  //
  // ## applies_to, and why it defaults to 'both'
  //
  // Which documents may carry the rate. A rate posts to *one* account, so an org
  // that reclaims input VAT holds a sales rate and a purchases rate rather than one
  // rate with two accounts, and this column is what keeps a bill's rate picker from
  // offering the sales one (D-35, `taxRateSchema.appliesTo`). Enforced where a
  // document line cites a rate — `resolveLines` in both document services — because
  // that is the moment a wrong rate becomes a wrong posting; a rate already on an
  // approved document is never re-checked, for the reason the archived-rate check
  // is not either.
  //
  // ENUM and not two booleans: `sales`/`purchases`/`both` is a closed set of three,
  // and a pair of flags admits a fourth state (neither) that means a rate nothing
  // may use. Default `'both'` because that is what every row meant while the column
  // did not exist — the ordinary sales-tax regime where nothing is reclaimed — so
  // the default is a restatement of the prior meaning rather than a policy choice.
  //
  // `is_active` rather than deletion once a rate is in use: a posted document's
  // lines reference the rate, and the RESTRICT below makes removal structurally
  // impossible from the first line that cites it — the same shape `dimensions`
  // takes for the same reason (OB-037).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE tax_rates (
      id             BINARY(16)   NOT NULL,
      org_id         BINARY(16)   NOT NULL,
      name           VARCHAR(120) NOT NULL,
      rate_ppm       INT UNSIGNED NOT NULL,
      tax_account_id BINARY(16)   NOT NULL,
      applies_to     ENUM('sales','purchases','both') NOT NULL DEFAULT 'both',
      is_active      TINYINT(1)   NOT NULL DEFAULT 1,
      created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_tax_rates_org_id (org_id, id),
      UNIQUE KEY uq_tax_rates_org_name (org_id, name),
      KEY idx_tax_rates_org_active (org_id, is_active),
      CONSTRAINT fk_tax_rates_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_tax_rates_account
        FOREIGN KEY (org_id, tax_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // document_sequences — the gapless per-org, per-type counters (ROADMAP D-36).
  //
  // `journal_sequences` is the pattern and D-14 is the argument: the number is what
  // a customer, an auditor, and a bank statement cite, and a gap in it is
  // indistinguishable from a deleted document — precisely the ambiguity an
  // append-only system exists to remove. `AUTO_INCREMENT` leaves gaps on rollback,
  // so the counter is a row taken `FOR UPDATE` inside the issuing transaction.
  //
  // The primary key is `(org_id, document_type)` rather than `(org_id)`, which is
  // the one way this differs from `journal_sequences`: invoices, credit notes, bills
  // and vendor credits are separate series to the people who read them (D-36), so
  // they count separately. That also narrows the lock — issuing an invoice number
  // does not serialize against issuing a bill number.
  //
  // Payments are here too, one series per direction, and D-36 does not require it:
  // it enumerates the four document types. They are included because the alternative
  // is D-14's backfill problem — a payment reference added after the table holds rows
  // means inventing numbers for history — and because a receipt with no number is not
  // something a customer can quote back. Received and paid are separate series for
  // the same reason invoices and bills are: they are read by different people about
  // different events.
  //
  // ENUM rather than the VARCHAR `journals.source` uses. That column's reasoning was
  // that a new origin must not require an ALTER on the largest table in the system;
  // this table holds a handful of rows per org, so the enumeration is worth having in
  // the schema where a typo cannot open a phantom series.
  //
  // `'purchase_order'`/`'estimate'` are appended in place (D-15) by
  // `0015_procure_to_pay`: POs and estimates carry their own numbering (D-92) for
  // D-36's own reason — a customer or vendor cites the number back — even though
  // neither posts a journal. Two more series, not two more tables.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE document_sequences (
      org_id        BINARY(16) NOT NULL,
      document_type ENUM('invoice','credit_note','bill','vendor_credit',
                         'payment_received','payment_paid',
                         'purchase_order','estimate') NOT NULL,
      next_value    BIGINT UNSIGNED NOT NULL DEFAULT 1,
      updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, document_type),
      CONSTRAINT fk_document_sequences_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ar_documents — invoices and credit notes (ROADMAP D-38, D-39).
  //
  // One table for both types, unlike the `journals` / `journal_drafts` split, and
  // the difference is worth stating because it looks inconsistent. D-19 gave drafts
  // their own tables for a mechanical reason: the app user holds no `UPDATE` on
  // `journals` at all, so an editable journal was inexpressible. No such constraint
  // applies here — a document holds no financial state (D-34), so one mutable table
  // can carry a document through its whole lifecycle.
  //
  // A credit note is a row here rather than an invoice with negative lines (D-39).
  // Modelling it as a negative invoice would be less code and worse books: aging
  // would need to special-case the sign, a credit note could accidentally be paid,
  // and the document the customer receives would be an invoice claiming they owe
  // minus two hundred. Every amount in this subsystem is therefore non-negative and
  // the *type* carries the direction.
  //
  // ## sequence_number is NULL until approval, and that is D-19's argument
  //
  // A draft is discardable. A draft that had reserved a number and was then
  // discarded would leave a gap, and a gap is indistinguishable from a deleted
  // document (D-14, D-36). So the number is allocated from `document_sequences` at
  // approval, in the same transaction that posts the journal, and is NULL before
  // then. MySQL treats NULLs as distinct in a unique index, so any number of drafts
  // coexist under `uq_ar_documents_org_type_sequence` while approved documents
  // cannot collide.
  //
  // `chk_ar_documents_approved` ties the two together: a number without a journal,
  // or a journal without a number, is inexpressible. Approval is one transaction or
  // it did not happen.
  //
  // ## journal_id and void_journal_id are the lifecycle
  //
  // See the file header. `uq_ar_documents_journal` makes a journal reachable from at
  // most one document, so two concurrent approvals of the same invoice cannot both
  // succeed and post the revenue twice — the same job `uq_journals_org_reverses`
  // does for reversals. `uq_ar_documents_void_journal` does it for voids.
  //
  // `source` on the posted journal is 'invoice' or 'credit_note'. `journals.source`
  // is a VARCHAR precisely so M3 needs no ALTER on the largest table in the system.
  //
  // ## due_date, and why aging measures from it
  //
  // D-40 buckets by days past *due*, not days since issue, because that is what
  // "overdue" means to the person chasing it. A credit note has no due date — it is
  // allocated, not chased — so the column is nullable and the CHECK requires one only
  // on an approved invoice. A draft invoice being filled in has neither yet.
  //
  // `reference` is the free-text half of D-36: the customer's purchase-order number
  // on an invoice. Distinct from `sequence_number`, which is ours.
  //
  // `created_by_user_id` is RESTRICT where `journal_drafts` CASCADEs. A draft is not
  // a fact and dies with its author's account; an approved invoice is one, and who
  // raised it is part of the record.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ar_documents (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      document_type      ENUM('invoice','credit_note') NOT NULL,
      sequence_number    BIGINT UNSIGNED NULL,
      contact_id         BINARY(16)   NOT NULL,
      issue_date         DATE         NOT NULL,
      due_date           DATE         NULL,
      tax_mode           ENUM('inclusive','exclusive') NOT NULL,
      reference          VARCHAR(120) NULL,
      memo               VARCHAR(512) NULL,
      -- Cash application (D-15, D-79), added in place: the term this invoice was
      -- raised under, overriding the contact's default (contacts.default_payment_term_id,
      -- 0002_ledger) -- NULL means the contact's default applied, or that no term
      -- was ever nominated. No foreign key here for 0002_ledger's own reason:
      -- payment_terms does not exist until 0012_cash_application, which adds the
      -- composite constraint once it does.
      payment_term_id    BINARY(16)   NULL,
      journal_id         BINARY(16)   NULL,
      void_journal_id    BINARY(16)   NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ar_documents_org_id (org_id, id),
      UNIQUE KEY uq_ar_documents_org_type_sequence (org_id, document_type, sequence_number),
      UNIQUE KEY uq_ar_documents_journal (org_id, journal_id),
      UNIQUE KEY uq_ar_documents_void_journal (org_id, void_journal_id),
      -- Aging (D-40) reads a contact's documents by due date as at a cut-off, and
      -- the outstanding-AR total reads them by type and issue date. Both are the
      -- indexes D-34 said an aggregation-over-documents design would have to be
      -- given rather than inherit from the tenancy pattern.
      KEY idx_ar_documents_org_contact_due (org_id, contact_id, due_date),
      KEY idx_ar_documents_org_type_issue (org_id, document_type, issue_date),
      KEY idx_ar_documents_org_created (org_id, created_at, id),
      KEY idx_ar_documents_org_payment_term (org_id, payment_term_id),
      CONSTRAINT fk_ar_documents_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ar_documents_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ar_documents_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ar_documents_void_journal
        FOREIGN KEY (org_id, void_journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ar_documents_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_ar_documents_approved CHECK (
        (journal_id IS NULL) = (sequence_number IS NULL)
      ),
      CONSTRAINT chk_ar_documents_void_after_approval CHECK (
        void_journal_id IS NULL OR journal_id IS NOT NULL
      ),
      CONSTRAINT chk_ar_documents_invoice_due CHECK (
        document_type <> 'invoice' OR journal_id IS NULL OR due_date IS NOT NULL
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ar_document_lines
  //
  // `id` is BIGINT AUTO_INCREMENT for the reason `journal_lines.id` is: internal,
  // high-volume, never client-facing alone (spec §4). A line is addressed as
  // (document_id, line_number).
  //
  // ## Quantities are integers too, and they are not money
  //
  // `quantity_micros` is the quantity scaled by 1,000,000 — 2.5 hours is 2500000.
  // Six decimal places covers a unit of measure divided to the second (1/3600 of an
  // hour is 0.000278) and every packaging fraction we could think of.
  //
  // The alternatives were `DECIMAL(18,6)` and a float, and both are refused for the
  // reasons spec §12 refuses them for money. A float cannot represent 0.1 and would
  // put an inexact factor into the one multiplication the invoice total depends on.
  // `DECIMAL` is exact in the database but arrives from mysql2 as a string, so the
  // exactness would last exactly as long as it took someone to write `Number(qty)` —
  // and `openbooks/no-float-money` is type-aware on money and would not see it. An
  // integer keeps the guarantee inside the type system: the driver returns every
  // BIGINT as a `bigint`, so a quantity cannot silently become a double anywhere
  // between the column and the arithmetic.
  //
  // It is deliberately *not* a money type. `unit_amount_minor` is minor units of
  // currency; `quantity_micros` is a count. They share a representation and nothing
  // else, and the extended amount is
  // `round(quantity_micros * unit_amount_minor / 1_000_000)`.
  //
  // ## Why the computed amounts are stored
  //
  // `line_amount_minor` and `tax_amount_minor` are the results of the two roundings
  // D-35 permits, recorded where they happened. They are not a cache of a balance:
  // they are the numbers the journal was posted from and the numbers the customer
  // can verify by adding up the page. Recomputing them on read would make an
  // approved document's total depend on a `tax_rates` row that is still editable,
  // so a rate corrected in March would silently restate January's invoices — and the
  // ledger, which was posted once, would no longer agree.
  //
  // No header total is stored (D-34). The document's total is the sum of these, and
  // outstanding is that sum minus allocations.
  //
  // `chk_ar_document_lines_tax_needs_rate` is the invariant that keeps the two
  // columns honest: tax without a rate to attribute it to cannot be posted anywhere,
  // and would make the tax account's balance unexplainable from the documents.
  //
  // ON DELETE CASCADE from the document, matching `journal_draft_lines`: discarding
  // a draft is one statement and the lines have no meaning without their header. The
  // schema cannot stop the *approved* document being deleted — MySQL has no CHECK
  // over another table's rows and this project runs no triggers — so that rule lives
  // in the AR service (OB-062) and is asserted by the property suite (OB-071).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ar_document_lines (
      id                BIGINT       NOT NULL AUTO_INCREMENT,
      org_id            BINARY(16)   NOT NULL,
      document_id       BINARY(16)   NOT NULL,
      line_number       SMALLINT UNSIGNED NOT NULL,
      description       VARCHAR(512) NULL,
      quantity_micros   BIGINT       NOT NULL,
      unit_amount_minor BIGINT       NOT NULL,
      account_id        BINARY(16)   NOT NULL,
      tax_rate_id       BINARY(16)   NULL,
      line_amount_minor BIGINT       NOT NULL,
      tax_amount_minor  BIGINT       NOT NULL DEFAULT 0,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      -- So the tag table below can reference this one compositely, exactly as
      -- \`uq_journal_lines_org_id\` exists for \`journal_line_dimensions\`.
      UNIQUE KEY uq_ar_document_lines_org_id (org_id, id),
      UNIQUE KEY uq_ar_document_lines_document_line (org_id, document_id, line_number),
      KEY idx_ar_document_lines_org_document (org_id, document_id),
      KEY idx_ar_document_lines_org_account (org_id, account_id),
      KEY idx_ar_document_lines_org_tax_rate (org_id, tax_rate_id),
      CONSTRAINT fk_ar_document_lines_document
        FOREIGN KEY (org_id, document_id) REFERENCES ar_documents (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_ar_document_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ar_document_lines_tax_rate
        FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_ar_document_lines_quantity CHECK (quantity_micros > 0),
      CONSTRAINT chk_ar_document_lines_amounts CHECK (
        unit_amount_minor >= 0 AND line_amount_minor >= 0 AND tax_amount_minor >= 0
      ),
      CONSTRAINT chk_ar_document_lines_tax_needs_rate CHECK (
        tax_rate_id IS NOT NULL OR tax_amount_minor = 0
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ar_document_line_dimensions — D-18's tags, on a document line.
  //
  // A third tag table rather than a nullable-parent column on
  // `journal_line_dimensions`, for the reason `journal_draft_line_dimensions` is a
  // fourth: the parents differ and so do their delete semantics. One table would
  // mean several nullable foreign keys and a CHECK asserting exactly one is set —
  // an invariant the schema would state and the application would have to remember.
  //
  // Tagging is on the line, not the header, because a single invoice legitimately
  // splits across departments (D-18) — and because the journal these lines post to
  // is tagged per line, so a header-tagged document could not produce it.
  //
  // Same `(org_id, line, dimension)` primary key: a line carrying two values on one
  // axis makes every sliced report count it twice, which is B6 being false.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ar_document_line_dimensions (
      org_id             BINARY(16)  NOT NULL,
      document_line_id   BIGINT      NOT NULL,
      dimension_id       BINARY(16)  NOT NULL,
      dimension_value_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, document_line_id, dimension_id),
      CONSTRAINT fk_ardld_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ardld_line
        FOREIGN KEY (org_id, document_line_id) REFERENCES ar_document_lines (org_id, id)
        ON DELETE CASCADE,
      -- Three columns, so the value's axis and the tag's axis are the same fact
      -- rather than two that can disagree.
      CONSTRAINT fk_ardld_value
        FOREIGN KEY (org_id, dimension_id, dimension_value_id)
        REFERENCES dimension_values (org_id, dimension_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ap_documents — bills and vendor credits.
  //
  // Symmetric to `ar_documents` in every structural respect, and a separate table
  // rather than a `side` column on one, because the two are separate subsystems to
  // everything above the schema: separate services (OB-062 and OB-063), separate
  // permissions (the seeded `ar_only` and `ap_only` roles are exactly this line),
  // separate control accounts, and separate reports. A shared table would put a
  // predicate on `side` in front of every one of those, and the first query that
  // forgot it would mix money a business owes with money it is owed.
  //
  // The one column that means something different: `reference` holds the **vendor's
  // own invoice number** (D-36). That is the number that matters on an AP document —
  // we did not issue it, and `sequence_number` is only our internal handle. On an
  // AR invoice the same column holds the customer's purchase-order number.
  //
  // `due_date` is likewise required only on an approved bill; a vendor credit is
  // allocated rather than chased.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ap_documents (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      document_type      ENUM('bill','vendor_credit') NOT NULL,
      sequence_number    BIGINT UNSIGNED NULL,
      contact_id         BINARY(16)   NOT NULL,
      issue_date         DATE         NOT NULL,
      due_date           DATE         NULL,
      tax_mode           ENUM('inclusive','exclusive') NOT NULL,
      reference          VARCHAR(120) NULL,
      memo               VARCHAR(512) NULL,
      -- The mirror of ar_documents.payment_term_id above: the term this bill was
      -- entered under, overriding the vendor contact's default. Same reason for no
      -- foreign key yet.
      payment_term_id    BINARY(16)   NULL,
      journal_id         BINARY(16)   NULL,
      void_journal_id    BINARY(16)   NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ap_documents_org_id (org_id, id),
      UNIQUE KEY uq_ap_documents_org_type_sequence (org_id, document_type, sequence_number),
      UNIQUE KEY uq_ap_documents_journal (org_id, journal_id),
      UNIQUE KEY uq_ap_documents_void_journal (org_id, void_journal_id),
      KEY idx_ap_documents_org_contact_due (org_id, contact_id, due_date),
      KEY idx_ap_documents_org_type_issue (org_id, document_type, issue_date),
      KEY idx_ap_documents_org_created (org_id, created_at, id),
      KEY idx_ap_documents_org_payment_term (org_id, payment_term_id),
      CONSTRAINT fk_ap_documents_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ap_documents_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ap_documents_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ap_documents_void_journal
        FOREIGN KEY (org_id, void_journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ap_documents_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_ap_documents_approved CHECK (
        (journal_id IS NULL) = (sequence_number IS NULL)
      ),
      CONSTRAINT chk_ap_documents_void_after_approval CHECK (
        void_journal_id IS NULL OR journal_id IS NOT NULL
      ),
      CONSTRAINT chk_ap_documents_bill_due CHECK (
        document_type <> 'bill' OR journal_id IS NULL OR due_date IS NOT NULL
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ap_document_lines — the mirror of `ar_document_lines`, same columns and same
  // constraints. See that table for why quantities are integers, why the two
  // computed amounts are stored, and why no total is.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ap_document_lines (
      id                BIGINT       NOT NULL AUTO_INCREMENT,
      org_id            BINARY(16)   NOT NULL,
      document_id       BINARY(16)   NOT NULL,
      line_number       SMALLINT UNSIGNED NOT NULL,
      description       VARCHAR(512) NULL,
      quantity_micros   BIGINT       NOT NULL,
      unit_amount_minor BIGINT       NOT NULL,
      account_id        BINARY(16)   NOT NULL,
      tax_rate_id       BINARY(16)   NULL,
      line_amount_minor BIGINT       NOT NULL,
      tax_amount_minor  BIGINT       NOT NULL DEFAULT 0,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ap_document_lines_org_id (org_id, id),
      UNIQUE KEY uq_ap_document_lines_document_line (org_id, document_id, line_number),
      KEY idx_ap_document_lines_org_document (org_id, document_id),
      KEY idx_ap_document_lines_org_account (org_id, account_id),
      KEY idx_ap_document_lines_org_tax_rate (org_id, tax_rate_id),
      CONSTRAINT fk_ap_document_lines_document
        FOREIGN KEY (org_id, document_id) REFERENCES ap_documents (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_ap_document_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ap_document_lines_tax_rate
        FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_ap_document_lines_quantity CHECK (quantity_micros > 0),
      CONSTRAINT chk_ap_document_lines_amounts CHECK (
        unit_amount_minor >= 0 AND line_amount_minor >= 0 AND tax_amount_minor >= 0
      ),
      CONSTRAINT chk_ap_document_lines_tax_needs_rate CHECK (
        tax_rate_id IS NOT NULL OR tax_amount_minor = 0
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE ap_document_line_dimensions (
      org_id             BINARY(16)  NOT NULL,
      document_line_id   BIGINT      NOT NULL,
      dimension_id       BINARY(16)  NOT NULL,
      dimension_value_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, document_line_id, dimension_id),
      CONSTRAINT fk_apdld_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_apdld_line
        FOREIGN KEY (org_id, document_line_id) REFERENCES ap_document_lines (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_apdld_value
        FOREIGN KEY (org_id, dimension_id, dimension_value_id)
        REFERENCES dimension_values (org_id, dimension_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // payments — money moving, with no opinion about what it settles (ROADMAP D-37).
  //
  // A payment is an amount and a direction. Which documents it settles is a
  // *separate fact*, recorded in the allocation tables below, and nothing requires
  // the two to be equal at the moment the payment is recorded. That models what
  // actually happens: a deposit arrives before anyone has decided what it settles, a
  // customer rounds up, one transfer pays three invoices. The unallocated remainder
  // is a credit balance on the contact — derived from `amount_minor` minus the
  // allocations, never stored (D-34).
  //
  // ## No draft state, and `journal_id` is NOT NULL because of it
  //
  // Documents have a draft phase because an invoice is composed before it is issued.
  // A payment is not composed; it is recorded after the money moved, so there is
  // nothing to be in progress. Making the journal mandatory is what enforces spec
  // §2.1 structurally here: a payment row that posted nothing would be financial
  // state held outside the ledger, which is the one thing no module may do.
  //
  // Voiding a payment is therefore the only edit it takes, and it is a reversing
  // journal like every other correction (D-16, D-38).
  //
  // `bank_account_id` is the account the money actually hit, and it is a plain
  // `accounts` reference rather than a bank-account entity: bank feeds and
  // reconciliation are M4, and an entity invented here would be one M4 has to
  // migrate. `is_active` and the composite key already give it everything it needs.
  //
  // `direction` decides which subledger an allocation may reach: 'received' settles
  // AR, 'paid' settles AP. The schema cannot state that across tables, so the
  // allocation services (OB-064) do, and the property suite asserts it.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE payments (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      direction          ENUM('received','paid') NOT NULL,
      sequence_number    BIGINT UNSIGNED NOT NULL,
      contact_id         BINARY(16)   NOT NULL,
      payment_date       DATE         NOT NULL,
      amount_minor       BIGINT       NOT NULL,
      bank_account_id    BINARY(16)   NOT NULL,
      reference          VARCHAR(120) NULL,
      memo               VARCHAR(512) NULL,
      journal_id         BINARY(16)   NOT NULL,
      void_journal_id    BINARY(16)   NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_payments_org_id (org_id, id),
      UNIQUE KEY uq_payments_org_direction_sequence (org_id, direction, sequence_number),
      UNIQUE KEY uq_payments_journal (org_id, journal_id),
      UNIQUE KEY uq_payments_void_journal (org_id, void_journal_id),
      -- Aging as at a date (D-40) needs payments by date, and a contact's credit
      -- balance needs them by contact.
      KEY idx_payments_org_contact_date (org_id, contact_id, payment_date),
      KEY idx_payments_org_date (org_id, payment_date, id),
      -- The keyset paymentPageSchema mandates (D-21), which is not the ordering of
      -- either index above. payment_date is what a user sorts on and is the wrong
      -- cursor column: payments are recorded in whatever order the paperwork
      -- surfaces, so a back-dated one lands behind a cursor that has already passed
      -- its date and appears on no page at all. created_at cannot move under a
      -- cursor. Without this index every page is a filesort — the same index
      -- idx_ar_documents_org_created is, for the documents beside it.
      KEY idx_payments_org_created (org_id, created_at, id),
      CONSTRAINT fk_payments_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_payments_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_payments_bank_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_payments_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_payments_void_journal
        FOREIGN KEY (org_id, void_journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_payments_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_payments_amount CHECK (amount_minor > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ar_allocations — the single mechanism by which anything reduces an invoice
  // (ROADMAP D-37, D-39).
  //
  // An allocation ties an amount from one source to one invoice. The source is a
  // payment or a credit note, and `chk_ar_allocations_one_source` makes exactly one
  // of them present. That is the whole of D-39's payoff: a credit note allocates
  // through the same table a payment does, so "what is outstanding on this invoice"
  // has one definition — its total minus the allocations against it — regardless of
  // what reduced it. A credit note modelled as a negative invoice would have needed
  // a second definition and a sign convention in every report.
  //
  // ## An allocation posts no journal, and that is why it may be deleted
  //
  // A payment's journal already moves cash and clears the control account; a credit
  // note's journal already reduces revenue and the control account. Allocating is a
  // statement about *which* invoice those postings relate to, and it moves nothing
  // in the ledger — so removing one restates no financial statement. That is the
  // `journal_line_dimensions` argument (a tag is analysis laid over the ledger, not
  // a term of the entry), and it is why unallocating is an ordinary delete rather
  // than a reversing row. Reversing rows here would mean every outstanding
  // calculation sums signed amounts and every over-allocation check has to reason
  // about which ones cancel.
  //
  // ## What the schema cannot say
  //
  // Over-allocation is refused (C3) and cannot be a constraint: it is a `SUM` across
  // sibling rows compared against a `SUM` across another table's rows, and MySQL has
  // no CHECK that can read either. It lives in the allocation service, which takes
  // the invoice row `FOR UPDATE` first — possible only because these tables are in
  // the mutable grant list, unlike the ledger (D-14). Over-*paying* is fine and lands
  // as contact credit; the asymmetry is the point of D-37.
  //
  // Nor can the schema say that a 'received' payment settles AR and a 'paid' one
  // settles AP, or that `credit_note_id` names a credit note rather than an invoice —
  // both are column values in another row. `chk_ar_allocations_not_self` covers the
  // one case that is expressible and is also the one most likely to be reached by a
  // mistyped id: an invoice allocated against itself, which would net it to zero
  // while moving nothing.
  //
  // `allocated_on` exists because D-40 requires aging to be computed **as at** a
  // historical date. Using today's allocations against a past date's documents
  // produces a report that cannot be reproduced tomorrow, and a date column is the
  // only thing that makes the as-at query expressible at all.
  //
  // ## discount_journal_id — a third source, added in place for Cash application (D-106)
  //
  // An early-pay discount settles a document without a payment behind it: D-106
  // models it as "a settlement whose funding source is the discount account, not
  // cash" — a real journal (debit discount-given, credit the receivables control;
  // the mirror on AP), and an allocation of the discount amount so `outstanding`
  // reaches zero without a special case in `documentTotal − allocatedToDocument`.
  // That allocation cannot be a `payment_id` — `payments` requires a `bank_account_id`
  // and posts through `recordPayment`, and a discount is neither a receipt nor a
  // disbursement — and it cannot be a `credit_note_id` either, which names a real,
  // numbered `ar_documents`/`ap_documents` row a discount is not. So this is a third,
  // separately-nullable source column, naming the journal the discount itself
  // posted, and `chk_ar_allocations_one_source` becomes a three-way exclusive-or
  // below. `bank_line_clearing_entries.entry_type = 'discount'` (`0006_banking`) is
  // what writes a row here, through `applyAllocations`'s new `'discount'`
  // `AllocationSource` kind (`modules/payments/allocate.ts`).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ar_allocations (
      id                 BINARY(16)  NOT NULL,
      org_id             BINARY(16)  NOT NULL,
      invoice_id         BINARY(16)  NOT NULL,
      payment_id         BINARY(16)  NULL,
      credit_note_id     BINARY(16)  NULL,
      discount_journal_id BINARY(16) NULL,
      amount_minor       BIGINT      NOT NULL,
      allocated_on       DATE        NOT NULL,
      created_by_user_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ar_allocations_org_id (org_id, id),
      KEY idx_ar_allocations_org_invoice (org_id, invoice_id, allocated_on),
      KEY idx_ar_allocations_org_payment (org_id, payment_id),
      KEY idx_ar_allocations_org_credit_note (org_id, credit_note_id),
      KEY idx_ar_allocations_org_discount_journal (org_id, discount_journal_id),
      KEY idx_ar_allocations_org_date (org_id, allocated_on, id),
      CONSTRAINT fk_ar_allocations_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ar_allocations_invoice
        FOREIGN KEY (org_id, invoice_id) REFERENCES ar_documents (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ar_allocations_payment
        FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ar_allocations_credit_note
        FOREIGN KEY (org_id, credit_note_id) REFERENCES ar_documents (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_ar_allocations_discount_journal
        FOREIGN KEY (org_id, discount_journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_ar_allocations_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_ar_allocations_amount CHECK (amount_minor > 0),
      CONSTRAINT chk_ar_allocations_one_source CHECK (
        (payment_id IS NOT NULL AND credit_note_id IS NULL AND discount_journal_id IS NULL) OR
        (payment_id IS NULL AND credit_note_id IS NOT NULL AND discount_journal_id IS NULL) OR
        (payment_id IS NULL AND credit_note_id IS NULL AND discount_journal_id IS NOT NULL)
      ),
      CONSTRAINT chk_ar_allocations_not_self CHECK (
        credit_note_id IS NULL OR credit_note_id <> invoice_id
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // ap_allocations — the mirror of `ar_allocations`: a payment, a vendor credit, or
  // a discount journal applied to a bill. See that table for why an allocation
  // posts no journal, why it is deletable, what the schema cannot enforce, and why
  // `discount_journal_id` exists (D-106).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ap_allocations (
      id                 BINARY(16)  NOT NULL,
      org_id             BINARY(16)  NOT NULL,
      bill_id            BINARY(16)  NOT NULL,
      payment_id         BINARY(16)  NULL,
      vendor_credit_id   BINARY(16)  NULL,
      discount_journal_id BINARY(16) NULL,
      amount_minor       BIGINT      NOT NULL,
      allocated_on       DATE        NOT NULL,
      created_by_user_id BINARY(16)  NOT NULL,
      created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ap_allocations_org_id (org_id, id),
      KEY idx_ap_allocations_org_bill (org_id, bill_id, allocated_on),
      KEY idx_ap_allocations_org_payment (org_id, payment_id),
      KEY idx_ap_allocations_org_vendor_credit (org_id, vendor_credit_id),
      KEY idx_ap_allocations_org_discount_journal (org_id, discount_journal_id),
      KEY idx_ap_allocations_org_date (org_id, allocated_on, id),
      CONSTRAINT fk_ap_allocations_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ap_allocations_bill
        FOREIGN KEY (org_id, bill_id) REFERENCES ap_documents (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ap_allocations_payment
        FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ap_allocations_vendor_credit
        FOREIGN KEY (org_id, vendor_credit_id) REFERENCES ap_documents (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_ap_allocations_discount_journal
        FOREIGN KEY (org_id, discount_journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_ap_allocations_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_ap_allocations_amount CHECK (amount_minor > 0),
      CONSTRAINT chk_ap_allocations_one_source CHECK (
        (payment_id IS NOT NULL AND vendor_credit_id IS NULL AND discount_journal_id IS NULL) OR
        (payment_id IS NULL AND vendor_credit_id IS NOT NULL AND discount_journal_id IS NULL) OR
        (payment_id IS NULL AND vendor_credit_id IS NULL AND discount_journal_id IS NOT NULL)
      ),
      CONSTRAINT chk_ap_allocations_not_self CHECK (
        vendor_credit_id IS NULL OR vendor_credit_id <> bill_id
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order: a table cannot be dropped while a foreign key points
  // at it.
  await sql`DROP TABLE IF EXISTS ap_allocations`.execute(db);
  await sql`DROP TABLE IF EXISTS ar_allocations`.execute(db);
  await sql`DROP TABLE IF EXISTS payments`.execute(db);
  await sql`DROP TABLE IF EXISTS ap_document_line_dimensions`.execute(db);
  await sql`DROP TABLE IF EXISTS ap_document_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS ap_documents`.execute(db);
  await sql`DROP TABLE IF EXISTS ar_document_line_dimensions`.execute(db);
  await sql`DROP TABLE IF EXISTS ar_document_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS ar_documents`.execute(db);
  await sql`DROP TABLE IF EXISTS document_sequences`.execute(db);
  await sql`DROP TABLE IF EXISTS tax_rates`.execute(db);
  // Last, because its RESTRICT on `accounts` outlives every table above it and
  // `0002_ledger`'s down() drops `accounts`.
  await sql`DROP TABLE IF EXISTS org_accounting_settings`.execute(db);
}
