import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Pay Bills (initiative G, OB-109…118): the pending-payment queue, its bill-line
 * intents, and a per-bank-account check-number register (ROADMAP D-63…D-69,
 * D-109…D-112).
 *
 * ## Why a pending payment is its own table and not a draft `Payment`
 *
 * A `Payment` in this schema is money that moved: `journal_id` is NOT NULL and there
 * is no draft state (D-37/D-38). The queued-but-unpaid state therefore cannot be a
 * `Payment` — it is a separate, **mutable** entity that posts no journal and holds no
 * ledger fact, materialising into a real `Payment` per vendor only when it is issued
 * (D-64/D-65). That is what lets cash stay put until the check is cut, and it is the
 * seam the separation of duties lives on (D-109): a clerk builds the queue
 * (`pending_payments.write`), a controller releases it (`disbursements.issue`).
 *
 * Everything here is pencil — edited and cancelled up to issue — so every table is in
 * `0999_app_grants`'s `MUTABLE_TABLES`, none in `APPEND_ONLY_TABLES`. The immutable
 * record of a disbursement is the `Payment` and its `journals`, which issue produces
 * through the ordinary `recordPayment` path; nothing in this migration is a ledger
 * fact, so nothing here is append-only.
 *
 * ## Rails are tags, not adapters (D-110)
 *
 * `rail` classifies how the movement will be executed — `check` handled in-app, `ach`
 * and `wire` handed to an external system that performs them and returns the trace or
 * confirmation onto the existing free-text `Payment.reference` (D-36). OpenBooks
 * generates no NACHA file and no wire artifact, so there is no new column on
 * `payments`; the rail id reuses `reference`. Check is the one rail with in-app
 * mechanics — it draws its number from `check_number_sequences` (D-111), the
 * `document_sequences` twin.
 *
 * ## The sensitive vendor-disbursement columns live in `0002_ledger`
 *
 * `contacts.ach_routing_number` / `ach_account_number` / `wire_instructions` and
 * `preferred_payment_rail` were edited into `0002_ledger` in place (D-15), for the
 * same reason `default_payment_term_id` was: the column belongs on the table it
 * describes. They are sensitive (D-67) — never seeded, flagged for log redaction —
 * and carry no foreign key, so no composite constraint is deferred to this file the
 * way `payment_terms` deferred three.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // pending_payments — one per vendor per batch (D-63). A batch Pay Bills run
  // fans out into one pending payment per contact, because a `Payment` carries one
  // contact and allocations refuse to cross contacts (`assertSameContact`) — so one
  // pending payment is also one check.
  //
  // `issued_payment_id` is null until issue and then names the real `Payment` the
  // materialise step created (D-65). `status` is the pencil lifecycle: `open` while
  // it is being built, `issued` once released, `cancelled` if abandoned — none of
  // which is a ledger state, all of which is an UPDATE the mutable grant permits.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE pending_payments (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      contact_id         BINARY(16)   NOT NULL,
      bank_account_id    BINARY(16)   NOT NULL,
      rail               ENUM('check','ach','wire') NOT NULL,
      status             ENUM('open','issued','cancelled') NOT NULL DEFAULT 'open',
      issued_payment_id  BINARY(16)   NULL,
      memo               VARCHAR(512) NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_pending_payments_org_id (org_id, id),
      KEY idx_pending_payments_org_status (org_id, status),
      KEY idx_pending_payments_org_contact (org_id, contact_id),
      KEY idx_pending_payments_org_rail (org_id, rail, status),
      CONSTRAINT fk_pending_payments_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_pending_payments_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_pending_payments_bank_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_pending_payments_issued_payment
        FOREIGN KEY (org_id, issued_payment_id) REFERENCES payments (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_pending_payments_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // pending_payment_intents — the bill lines a pending payment will settle. Each is
  // `{ bill_id, pay_amount_minor }` plus the per-line settlement discount
  // (`discount_amount_minor` + the account it credits, user-selected — D-66/D-112)
  // and an optional vendor credit it applies.
  //
  // `committed` on a bill is `Σ pay_amount_minor` over intents whose pending payment
  // is still `open` (D-68). It is computed on read under the same bill `FOR UPDATE`
  // lock the allocation code takes — never stored — so two builders cannot each spend
  // the same remainder. `available_to_pay = outstanding − committed`.
  //
  // No money default: an intent that silently defaulted a pay amount to zero is the
  // same class of bug the money columns everywhere else in this schema refuse a
  // DEFAULT to catch. Both discount columns are nullable together — a discount amount
  // needs an account to credit, and an account with no amount settles nothing — but a
  // CHECK is not declared here because the queue service is the one writer and a
  // partial discount is inexpressible in its input contract (OB-110).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE pending_payment_intents (
      id                       BINARY(16) NOT NULL,
      org_id                   BINARY(16) NOT NULL,
      pending_payment_id       BINARY(16) NOT NULL,
      bill_id                  BINARY(16) NOT NULL,
      pay_amount_minor         BIGINT     NOT NULL,
      discount_amount_minor    BIGINT     NULL,
      discount_account_id      BINARY(16) NULL,
      applied_vendor_credit_id BINARY(16) NULL,
      created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_pending_payment_intents_org_id (org_id, id),
      KEY idx_ppi_org_pending (org_id, pending_payment_id),
      KEY idx_ppi_org_bill (org_id, bill_id),
      CONSTRAINT fk_ppi_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ppi_pending_payment
        FOREIGN KEY (org_id, pending_payment_id) REFERENCES pending_payments (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_ppi_bill
        FOREIGN KEY (org_id, bill_id) REFERENCES ap_documents (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ppi_discount_account
        FOREIGN KEY (org_id, discount_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_ppi_applied_vendor_credit
        FOREIGN KEY (org_id, applied_vendor_credit_id) REFERENCES ap_documents (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // check_number_sequences — the per-bank-account check register (D-111). The
  // `document_sequences` twin (D-14/D-36): a gapless counter taken `FOR UPDATE` at
  // issue, keyed `(org_id, bank_account_id)` rather than `(org_id, document_type)`.
  // A counter is its own table because journals cannot be locked for a read, and a
  // check number must not leak on a rolled-back issue the way AUTO_INCREMENT would.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE check_number_sequences (
      org_id          BINARY(16) NOT NULL,
      bank_account_id BINARY(16) NOT NULL,
      next_value      BIGINT UNSIGNED NOT NULL DEFAULT 1,
      updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, bank_account_id),
      CONSTRAINT fk_check_number_sequences_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_check_number_sequences_bank_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Children before parents so no foreign key blocks a drop.
  await sql`DROP TABLE IF EXISTS check_number_sequences`.execute(db);
  await sql`DROP TABLE IF EXISTS pending_payment_intents`.execute(db);
  await sql`DROP TABLE IF EXISTS pending_payments`.execute(db);
}
