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
