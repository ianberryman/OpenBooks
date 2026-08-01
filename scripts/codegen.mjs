#!/usr/bin/env node
/**
 * Regenerates `packages/server/src/db/generated.ts` from a live migrated schema.
 *
 * The generated file is committed, and CI regenerates it against a freshly
 * migrated database and fails on any diff. That gate is the point: Kysely's type
 * safety is only as good as the types matching the schema, and a hand-edited or
 * stale `generated.ts` turns compile-time guarantees into decoration.
 *
 * A dev-and-CI tool, not part of the server bundle, so it lives under scripts/
 * and reads the environment directly rather than through the validated config.
 * It connects as the migrator user: introspection needs to see the whole schema.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outFile = path.join(repoRoot, 'packages/server/src/db/generated.ts');

const {
  DATABASE_HOST = '127.0.0.1',
  DATABASE_PORT = '3306',
  DATABASE_NAME = 'openbooks',
  DATABASE_MIGRATOR_USER,
  DATABASE_MIGRATOR_PASSWORD,
} = process.env;

if (!DATABASE_MIGRATOR_USER || !DATABASE_MIGRATOR_PASSWORD) {
  process.stderr.write(
    'codegen needs DATABASE_MIGRATOR_USER and DATABASE_MIGRATOR_PASSWORD.\n' +
      'Introspection must see the whole schema, which the application user cannot.\n',
  );
  process.exit(1);
}

const url =
  `mysql://${encodeURIComponent(DATABASE_MIGRATOR_USER)}:` +
  `${encodeURIComponent(DATABASE_MIGRATOR_PASSWORD)}@` +
  `${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}`;

// kysely-codegen is a devDependency of @openbooks/server, so it is only on the
// bin path inside that workspace.
const serverWorkspace = path.join(repoRoot, 'packages/server');

/**
 * Column type overrides, because the generator's defaults are wrong for this
 * schema in two ways that matter.
 *
 * BIGINT → `number`. That is precision loss on the money columns above 2^53 and
 * contradicts spec §12 outright. The driver is configured to return every BIGINT
 * as a bigint (see src/db/connection.ts), so these overrides make the types
 * describe what actually arrives.
 *
 * DATE → `Date`. The driver returns DATE as a string, deliberately: a calendar
 * date has no timezone and constructing a Date from one invents a moment.
 * DATETIME columns are genuine instants and keep their `Date` mapping, so they
 * are not listed here.
 *
 * Each entry is a place the generated types would otherwise lie about runtime.
 */
const OVERRIDES = {
  columns: {
    // Generated<> is preserved deliberately: this is AUTO_INCREMENT, so an insert
    // must be able to omit it. An override replaces the whole mapped type, so
    // dropping the wrapper here would make Kysely demand an id on every insert.
    'journal_lines.id': 'Generated<bigint>',
    // Plain bigint, NOT Generated<bigint>, even though both columns carry a
    // DEFAULT 0. Requiring the amount explicitly on insert is the point — a money
    // column silently defaulting to zero because a caller forgot it is precisely
    // the class of bug the one-sided CHECK constraint cannot catch.
    'journal_lines.debit_minor': 'bigint',
    'journal_lines.credit_minor': 'bigint',
    // BIGINT UNSIGNED is still LONGLONG to the driver, so these arrive as bigint
    // like every other BIGINT. The uniform rule is worth more than the slight
    // ergonomic cost on a display sequence: an exception here would mean the
    // README's "every BIGINT is a bigint" stops being true.
    'journals.sequence_number': 'bigint',
    'journal_sequences.next_value': 'Generated<bigint>',
    // A STORED generated column (0003_idempotency). MySQL rejects any attempt to
    // write it, so it must not be required on insert; the generator has no notion of
    // generated columns and typed it as a plain Buffer. `Generated<>` is the closest
    // available truth — it makes the column optional. It does not make supplying one
    // impossible, so nothing should reference it outside the unique index it exists
    // for.
    'idempotency_keys.claim_scope': 'Generated<Buffer>',
    // Drafts repeat the ledger's shapes and so repeat its
    // overrides. `debit_minor`/`credit_minor` stay plain `bigint` despite their
    // DEFAULT 0 for the same reason as `journal_lines`: a draft line that silently
    // defaults to zero because a caller forgot the amount is a draft that posts as
    // zero, and the schema deliberately holds no balance CHECK to catch it.
    'journal_draft_lines.id': 'Generated<bigint>',
    'journal_draft_lines.debit_minor': 'bigint',
    'journal_draft_lines.credit_minor': 'bigint',
    // Not Generated<>: a tag names an existing line, so the id is always supplied.
    'journal_line_dimensions.journal_line_id': 'bigint',
    'journal_draft_line_dimensions.draft_line_id': 'bigint',
    'journals.entry_date': 'string',
    // Nullability has to be spelled out: an override replaces the whole mapped type,
    // so `'string'` here would type a draft's unset date as a non-null string.
    'journal_drafts.entry_date': 'string | null',
    'fiscal_periods.start_date': 'string',
    'fiscal_periods.end_date': 'string',

    // ── The M3 subledger (0005_subledger) ───────────────────────────────────
    //
    // Same two defaults, same two corrections, one more column kind. Money stays
    // `bigint`; `quantity_micros` is a BIGINT that is deliberately *not* money — a
    // count scaled by 1e6 — and gets the same treatment for the same reason, since
    // the driver returns it as a bigint whatever it means. `rate_ppm` is an
    // `INT UNSIGNED` and needs no override: it is well inside 2^53 and the generator
    // maps it to `number` correctly.
    'document_sequences.next_value': 'Generated<bigint>',

    'ar_documents.sequence_number': 'bigint | null',
    'ar_documents.issue_date': 'string',
    'ar_documents.due_date': 'string | null',
    'ar_document_lines.id': 'Generated<bigint>',
    'ar_document_lines.quantity_micros': 'bigint',
    'ar_document_lines.unit_amount_minor': 'bigint',
    'ar_document_lines.line_amount_minor': 'bigint',
    // Plain bigint despite the DEFAULT 0, exactly as `journal_lines.debit_minor` is:
    // an amount that silently defaults because a caller forgot it is the bug no
    // CHECK constraint here can catch.
    'ar_document_lines.tax_amount_minor': 'bigint',
    'ar_document_line_dimensions.document_line_id': 'bigint',

    'ap_documents.sequence_number': 'bigint | null',
    'ap_documents.issue_date': 'string',
    'ap_documents.due_date': 'string | null',
    'ap_document_lines.id': 'Generated<bigint>',
    'ap_document_lines.quantity_micros': 'bigint',
    'ap_document_lines.unit_amount_minor': 'bigint',
    'ap_document_lines.line_amount_minor': 'bigint',
    'ap_document_lines.tax_amount_minor': 'bigint',
    'ap_document_line_dimensions.document_line_id': 'bigint',

    'payments.sequence_number': 'bigint',
    'payments.amount_minor': 'bigint',
    'payments.payment_date': 'string',

    'ar_allocations.amount_minor': 'bigint',
    'ar_allocations.allocated_on': 'string',
    'ap_allocations.amount_minor': 'bigint',
    'ap_allocations.allocated_on': 'string',

    // ── M4 banking (0006_banking) ───────────────────────────────────────────
    //
    // The same two corrections again. `bank_statement_imports.lines_read` and
    // `lines_duplicate` are INT UNSIGNED and need no override — well inside 2^53,
    // and the generator maps them to `number` correctly — as do
    // `bank_match_proposals.rank` and every column-index column on a mapping.
    // OB-078 made those two counts NULLABLE (they are unknown until the async import
    // completes), and added `status` (an ENUM the generator maps to a string-literal
    // union) and `failure_reason` (VARCHAR NULL): all three are read back correctly
    // by the generator, so none needs an override here — the money/date rule is the
    // only place the generator lies, and none of these is money or a calendar date.
    //
    // The closing balance the uploaded file stated, which is money and is nullable
    // because a bare CSV states none (D-46).
    'bank_statement_imports.closing_balance_minor': 'bigint | null',
    'bank_statement_lines.posted_date': 'string',
    'bank_statement_lines.value_date': 'string | null',
    // Signed, unlike every other money column in this schema: E4 is an equation over
    // amounts and a term whose sign must be looked up is where a sign error goes.
    // See the header of `0006_banking`.
    'bank_statement_lines.amount_minor': 'bigint',
    // Nullability has to be spelled out, because an override replaces the whole
    // mapped type: `'bigint'` here would type an unbounded rule's amount as
    // non-null.
    'bank_rules.match_amount_min_minor': 'bigint | null',
    'bank_rules.match_amount_max_minor': 'bigint | null',
    // Plain bigint despite the DEFAULT 0, exactly as `journal_lines.debit_minor`
    // is: a difference that silently defaults to zero because a caller forgot it
    // is the discrepancy E4 exists to record going unrecorded.
    'bank_line_clearings.cleared_amount_minor': 'bigint',
    'bank_line_clearings.difference_amount_minor': 'bigint',
    'reconciliation_sessions.end_date': 'string',
    'reconciliation_sessions.statement_closing_balance_minor': 'bigint',
    // A STORED generated column, as `idempotency_keys.claim_scope` is: MySQL
    // rejects any attempt to write it, so `Generated<>` is what keeps it off the
    // insert type. Nullable — it holds the bank account id only while the session
    // is open — and the two have to be combined by hand, since an override
    // replaces the mapped type outright.
    'reconciliation_sessions.open_marker': 'Generated<Buffer | null>',
    'reconciliation_session_events.asserted_balance_minor': 'bigint | null',

    // ── Cash application (0006_banking's restructure, 0012_cash_application) ─
    //
    // The child D-105 moved the singular clearing target onto repeats
    // `bank_line_clearings.cleared_amount_minor`'s own correction: a signed BIGINT,
    // and a difference that silently defaulted to zero is exactly the discrepancy
    // E4 exists to record. `payment_terms.net_days`/`discount_rate_ppm`/
    // `discount_window_days` need no entry — all three are `INT UNSIGNED`, well
    // inside 2^53, the same reason `tax_rates.rate_ppm` needs none.
    'bank_line_clearing_entries.entry_amount_minor': 'bigint',

    // ── Recurring invoices & dunning (0008_recurring_dunning) ────────────────
    //
    // The same three column kinds one more time. The schedule dates are calendar
    // DATEs and map to `string` (nullability spelled out, since an override replaces
    // the whole mapped type); the template line repeats `ar_document_lines`' money
    // and quantity corrections exactly; and the optional late fee is a nullable money
    // BIGINT. `dunning_sends` and `dunning_policies` need no entry — their only
    // non-scalar columns are DATETIME instants, which keep their `Date` mapping.
    'recurring_invoice_templates.next_run_date': 'string',
    'recurring_invoice_templates.last_run_date': 'string | null',
    'recurring_invoice_templates.end_date': 'string | null',
    'recurring_invoice_template_lines.id': 'Generated<bigint>',
    'recurring_invoice_template_lines.quantity_micros': 'bigint',
    'recurring_invoice_template_lines.unit_amount_minor': 'bigint',
    'dunning_stages.late_fee_minor': 'bigint | null',

    // ── Bill capture / OCR (0009_bill_capture) ───────────────────────────────
    //
    // The same corrections one more time. `byte_size` is a BIGINT file size (not
    // money, but the driver returns every BIGINT as a bigint, so the uniform rule
    // holds — cf. `ar_document_lines.quantity_micros`). `extracted_total_minor` is
    // nullable money (a capture may not state a total). `extracted_issue_date` is a
    // calendar DATE and maps to `string` (nullability spelled out, since an override
    // replaces the whole mapped type). `extraction_json` needs no entry — MySQL JSON
    // already maps correctly, as `idempotency_keys.response_body` does.
    'document_captures.byte_size': 'bigint',
    'document_captures.extracted_total_minor': 'bigint | null',
    'document_captures.extracted_issue_date': 'string | null',
    'bill_attachments.byte_size': 'bigint',

    // ── M5 platform (0010_platform) ───────────────────────────────────────────
    //
    // `position` is BIGINT UNSIGNED wherever it appears, so it needs the same
    // override `journals.sequence_number` does — the driver returns every BIGINT
    // as a bigint regardless of signedness. `event_log.position` is assigned by
    // the relay from `event_positions` and always supplied on insert (D-56), so
    // it stays plain `bigint`, exactly as `journals.sequence_number` does for the
    // same reason: the relay's whole job is to supply it, and a column that could
    // silently default to zero is the append-only log gaining an unnumbered row.
    // `event_positions.next_value` and `change_feed_cursors.position` are the
    // counters, each `Generated<>` for `journal_sequences.next_value`'s reason —
    // both carry a DEFAULT and an insert must be able to omit them.
    'event_log.position': 'bigint',
    'event_positions.next_value': 'Generated<bigint>',
    'change_feed_cursors.position': 'Generated<bigint>',

    // ── Pay Bills (0013_pay_bills) ────────────────────────────────────────────
    //
    // The intent's pay and discount amounts are money and get `bigint`, the same
    // correction every `*_minor` column above takes — plain `bigint` (not
    // `Generated<>`), because an intent that silently defaulted its pay amount to
    // zero would queue a payment that pays nothing. The discount amount is nullable
    // (a line may carry no discount), spelled out because an override replaces the
    // whole mapped type. `check_number_sequences.next_value` is the register counter,
    // `Generated<bigint>` for `document_sequences.next_value`'s reason exactly — it
    // carries a DEFAULT and an insert must be able to omit it.
    'pending_payment_intents.pay_amount_minor': 'bigint',
    'pending_payment_intents.discount_amount_minor': 'bigint | null',
    'check_number_sequences.next_value': 'Generated<bigint>',

    // ── Fixed assets & recurring journals (0014_fixed_assets) ─────────────────
    //
    // The same three column kinds one last time. The schedule dates are calendar
    // DATEs and map to `string` (nullability spelled out, since an override replaces
    // the whole mapped type). The template line's amount and the asset's cost and
    // salvage are money BIGINTs — plain `bigint`, not `Generated<>`, because an
    // amount that silently defaulted to zero is the bug no CHECK here can catch. The
    // template line id is `BIGINT AUTO_INCREMENT`, so `Generated<bigint>` as
    // `ar_document_lines.id` is. `interval_count`, `useful_life_months`,
    // `declining_rate_ppm`, `period_index` and `line_number` need no entry — all are
    // `INT UNSIGNED`/`SMALLINT UNSIGNED`, well inside 2^53, like `tax_rates.rate_ppm`.
    'recurring_journal_templates.next_run_date': 'string',
    'recurring_journal_templates.last_run_date': 'string | null',
    'recurring_journal_templates.end_date': 'string | null',
    'recurring_journal_template_lines.id': 'Generated<bigint>',
    'recurring_journal_template_lines.amount_minor': 'bigint',
    'fixed_assets.acquisition_cost_minor': 'bigint',
    'fixed_assets.salvage_value_minor': 'bigint',
    'fixed_assets.in_service_date': 'string',
    'fixed_assets.disposed_date': 'string | null',
    'fixed_asset_schedule.period_date': 'string',
    'fixed_asset_schedule.depreciation_amount_minor': 'bigint',

    // ── Procure-to-pay (0015_procure_to_pay) ──────────────────────────────────
    //
    // The lines repeat `ar_document_lines`' three corrections exactly: the id is
    // `BIGINT AUTO_INCREMENT` (`Generated<bigint>`), the quantity and the three money
    // columns are `bigint`, and the issue/expected/expiry dates are calendar DATEs
    // (`string`, nullability spelled out since an override replaces the whole mapped
    // type). `sequence_number` is `BIGINT UNSIGNED` and nullable before approval,
    // exactly as `ar_documents.sequence_number` is. `line_number` needs no entry —
    // `SMALLINT UNSIGNED`, well inside 2^53, like every other line-position column
    // above.
    'purchase_orders.sequence_number': 'bigint | null',
    'purchase_orders.issue_date': 'string',
    'purchase_orders.expected_date': 'string | null',
    'purchase_order_lines.id': 'Generated<bigint>',
    'purchase_order_lines.quantity_micros': 'bigint',
    'purchase_order_lines.unit_amount_minor': 'bigint',
    'purchase_order_lines.line_amount_minor': 'bigint',
    'purchase_order_lines.tax_amount_minor': 'bigint',

    'estimates.sequence_number': 'bigint | null',
    'estimates.issue_date': 'string',
    'estimates.expiry_date': 'string | null',
    'estimate_lines.id': 'Generated<bigint>',
    'estimate_lines.quantity_micros': 'bigint',
    'estimate_lines.unit_amount_minor': 'bigint',
    'estimate_lines.line_amount_minor': 'bigint',
    'estimate_lines.tax_amount_minor': 'bigint',

    // ── Budgets (0016_budgets) ────────────────────────────────────────────────
    //
    // `amount_minor` is money and gets the same `bigint` correction every `*_minor`
    // column above takes — plain `bigint`, not `Generated<>`, because a budget that
    // silently defaulted its amount to zero is the bug no CHECK here can catch.
    // `dimension_slice` is a STORED generated column (`idempotency_keys.claim_scope`'s
    // own kind): MySQL rejects any attempt to write it, so `Generated<Buffer>` is what
    // keeps it off the insert type. It is NOT NULL (COALESCE never yields null), so no
    // nullability to spell out.
    'budgets.amount_minor': 'bigint',
    'budgets.dimension_slice': 'Generated<Buffer>',

    // ── Accountant access & period close (0017_accountant_close) ──────────────
    //
    // `statement_packages.period_start`/`period_end` are calendar DATEs and map to
    // `string`, the same correction `fiscal_periods.start_date` takes. No money or
    // BIGINT here, and `period_close_events.checklist` is JSON, which the generator
    // maps correctly (as `idempotency_keys.response_body` does) — so these two DATE
    // columns are the only overrides P needs.
    'statement_packages.period_start': 'string',
    'statement_packages.period_end': 'string',

    // ── Automations (0018_automations) ────────────────────────────────────────
    //
    // One override, one column: `last_fired_run_date` is the scheduled-trigger
    // once-per-cycle guard and a calendar DATE, so it maps to `string` (nullability
    // spelled out, since an override replaces the whole mapped type) — the same
    // correction `recurring_invoice_templates.last_run_date` takes. `work_items` and
    // `automation_annotations` need no entry: their non-scalar columns are DATETIME(3)
    // instants (kept `Date`) and JSON (mapped correctly), with no money or BIGINT
    // counter among them.
    'automations.last_fired_run_date': 'string | null',

    // ── Item catalog (0019_catalog) ───────────────────────────────────────────
    //
    // One override: `unit_amount_minor` is the item's default price, a nullable
    // BIGINT money column, so the generator's `number` becomes `bigint | null`
    // (nullability spelled out, since an override replaces the whole mapped type) —
    // `ar_document_lines.unit_amount_minor`'s correction, made optional. The new
    // `catalog_item_id` BINARY(16) columns on the four line tables need no entry:
    // the generator maps BINARY(16) to `Buffer` and carries the nullability itself.
    'catalog_items.unit_amount_minor': 'bigint | null',

    // ── Customer statement of account (0022_account_statements) ────────────────
    //
    // One override: `customer_statements.as_of` is a calendar DATE — the date the
    // open-item balance is computed as at — so it maps to `string`, the same
    // correction `statement_packages.period_start` takes. Its other non-scalar
    // columns are DATETIME(3) (`created_at`, kept `Date`) and BINARY (mapped to
    // `Buffer`), with no money or BIGINT counter, so this is the only override.
    'customer_statements.as_of': 'string',
  },
};

const args = process.argv.slice(2);

const result = spawnSync(
  'yarn',
  [
    'kysely-codegen',
    '--dialect',
    'mysql',
    '--out-file',
    outFile,
    // Kysely's own bookkeeping tables are not application schema.
    '--exclude-pattern',
    'kysely_migration*',
    '--singularize',
    'false',
    '--overrides',
    JSON.stringify(OVERRIDES),
    // `--verify` turns this into the CI drift gate rather than a regenerate.
    ...args,
  ],
  {
    cwd: serverWorkspace,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  },
);

process.exit(result.status ?? 1);
