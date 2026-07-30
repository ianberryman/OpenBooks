import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Budgets: budget figures by account (and optional dimension) per period
 * (initiative N, OB-180…184; ROADMAP D-N1…D-N6).
 *
 * ## A parallel plane, not a fourth ledger table
 *
 * A budget posts no journal (D-94). It is a target compared against actuals, and
 * the comparison — `budget − actual` — happens in a report
 * (`reports/budget-vs-actual.service.ts`), never in the trial balance. So `budgets`
 * holds a plan, not a financial fact, and is mutable (`0999_app_grants`) for the
 * M3 subledger's own reason: nothing immutability would be protecting lives here,
 * because every posted number lives in `journals`, append-only, where no grant
 * permits an UPDATE. Editing a budget restates no statement — it moves a target the
 * next report reads.
 *
 * ## A row is `(account, period, optional dimension-value)` → an amount (D-N1)
 *
 * A NULL `dimension_value_id` is the **account-total** budget for the period; a
 * non-null one is a **per-slice** budget, the same "slices + unassigned = whole"
 * shape the ledger's dimension grouping already takes (B6). Uniqueness of the slot
 * has to be DB-enforced, and MySQL treats NULLs as distinct in a UNIQUE index — so
 * two account-total rows for one `(account, period)` would both be accepted by
 * `UNIQUE (org_id, account_id, period_id, dimension_value_id)`. The honest answer is
 * a stored generated column: `dimension_slice` is `dimension_value_id` when set and
 * sixteen zero bytes when not (`idempotency_keys.claim_scope`'s own trick,
 * `0003_idempotency`), and the unique index is over that. The service upserts into
 * the slot (`setBudgets` replaces the matching row).
 *
 * ## Only P&L accounts carry a budget in v1 (D-N2)
 *
 * The schema does not enforce `type IN ('revenue','expense')` — a CHECK cannot read
 * another table's column — so `budgets.service.ts`'s `assertAccountsPostable` twin
 * validates the account is active and a P&L type. Balance-sheet budgeting is
 * deferred (flagged).
 *
 * ## The axis-locked dimension FK
 *
 * `(org_id, dimension_id, dimension_value_id)` → `dimension_values
 * (org_id, dimension_id, id)` is the three-column FK every line-dimension table
 * uses (`fk_ardld_value`, `0005_subledger`): it makes the value's axis and the
 * budget's axis the same fact rather than two that a bad write could disagree on.
 * `chk_budgets_dimension_pairing` ties the two dimension columns together so a
 * value can never be named without its axis, nor an axis without a value.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE budgets (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      account_id         BINARY(16)   NOT NULL,
      period_id          BINARY(16)   NOT NULL,
      dimension_id       BINARY(16)   NULL,
      dimension_value_id BINARY(16)   NULL,
      -- The slot key. dimension_value_id when a per-slice budget, sixteen zero
      -- bytes when the account-total one — so the UNIQUE index below can enforce a
      -- single account-total row despite MySQL treating NULLs as distinct.
      -- idempotency_keys.claim_scope's own trick (0003_idempotency).
      dimension_slice    BINARY(16)   AS (COALESCE(dimension_value_id, 0x00000000000000000000000000000000))
                                      STORED NOT NULL,
      -- No DEFAULT, exactly as journal_lines.debit_minor carries none: a budget
      -- amount that silently defaulted to zero because a caller forgot it is the
      -- class of bug no CHECK here can catch.
      amount_minor       BIGINT       NOT NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_budgets_org_id (org_id, id),
      UNIQUE KEY uq_budgets_slot (org_id, account_id, period_id, dimension_slice),
      KEY idx_budgets_org_period (org_id, period_id),
      -- Declared for the account and axis FKs below, exactly as the line-dimension
      -- tables declare theirs (0005_subledger): the covering index is visible where
      -- the constraint is.
      KEY idx_budgets_org_account (org_id, account_id),
      KEY idx_budgets_org_axis (org_id, dimension_id, dimension_value_id),
      CONSTRAINT fk_budgets_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_budgets_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_budgets_period
        FOREIGN KEY (org_id, period_id) REFERENCES fiscal_periods (org_id, id) ON DELETE RESTRICT,
      -- Three columns, so the value's axis and the budget's axis are the same fact
      -- (fk_ardld_value, 0005_subledger): a value can only be tagged on the axis it
      -- actually belongs to.
      CONSTRAINT fk_budgets_value
        FOREIGN KEY (org_id, dimension_id, dimension_value_id)
        REFERENCES dimension_values (org_id, dimension_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_budgets_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_budgets_dimension_pairing CHECK (
        (dimension_id IS NULL) = (dimension_value_id IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS budgets`.execute(db);
}
