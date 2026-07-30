import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Narrows the application database user's privileges so that journals are
 * append-only at the database level (spec §12).
 *
 * ## Why this is a grant allowlist and not a REVOKE
 *
 * The obvious reading of spec §12 — "app DB user holds no UPDATE/DELETE grant on
 * journals or journal_lines" — suggests granting broadly and then revoking on two
 * tables. MySQL cannot do that. Privileges are additive across a hierarchy
 * (global → database → table → column) and a REVOKE can only remove a privilege
 * at the level it was granted. `GRANT UPDATE ON openbooks.*` followed by
 * `REVOKE UPDATE ON openbooks.journals` fails outright; there is no subtraction.
 *
 * So the app user gets `SELECT, INSERT` at the database level — safe for every
 * table, including journals, which must be insertable — and `UPDATE, DELETE`
 * table by table from an explicit allowlist. `journals` and `journal_lines`
 * simply never appear in it.
 *
 * ## The maintenance consequence, which is a feature
 *
 * Every future migration that adds a mutable table must add it to a grants
 * migration. Forgetting means the new table is append-only, which surfaces as a
 * loud failure the first time something tries to update it. The opposite default
 * — new tables mutable unless someone remembers to lock them down — is how the
 * guarantee erodes silently.
 *
 * ## Why this file is numbered 0999
 *
 * MySQL resolves a table name in a `GRANT` as the statement runs and refuses one on
 * a table that does not exist (`ERROR 1146`, measured on 8.4), so every table named
 * below must be created by a migration that sorts ahead of this one — Kysely applies
 * them in lexicographic order.
 *
 * While this file was `0999_app_grants` that constraint was satisfied by convention,
 * and M2 paid for it twice: first with `0003a`/`0003b`/`0003c` suffixes, then by
 * dissolving those back into `0002_ledger`. OB-060 moved the constraint into the
 * name instead. `0999` is the largest prefix the four-digit convention can express,
 * so a migration that follows the convention cannot sort after this one — sorting
 * last is now a property of the numbering scheme rather than something each wave has
 * to remember. A merely large gap (`0099`) would postpone the same collision instead
 * of removing it.
 *
 * ## Failing loudly on a missing user
 *
 * If the app user does not exist this migration fails and takes the deploy with
 * it. That is deliberate. A migration that skipped the grants on a misconfigured
 * database would produce exactly the outcome ROADMAP warns about: the
 * immutability test passing locally and meaning nothing in production.
 */

/**
 * Cross-environment contract. This same pair of users is provisioned by
 * `docker/mysql-init/` for Compose, by the testcontainers harness for the test
 * suite, and by the RDS bootstrap in `infra/terraform/`. The three must agree —
 * spec §11 requires the immutability test to run as the *app* user, so a
 * mismatch makes that test meaningless.
 */
const APP_DB_USER = 'openbooks_app';

/**
 * Tables the application may never UPDATE or DELETE.
 *
 * Three different reasons land a table here, and all three matter:
 *
 *  - `journals` / `journal_lines` — the ledger is append-only and corrections are
 *    reversing entries (spec §2.2, §12). This is the guarantee the whole grant split
 *    exists to enforce.
 *  - `permissions` — the fixed catalog (spec §5). The application reads it and never
 *    writes it; only a migration may change it.
 *  - The three M4 banking tables — each is a record of something that happened, and
 *    a record the application can rewrite is not one. See the block beside them.
 *
 * `permissions` is listed rather than left out even though omission produced the same
 * behaviour, because the *signal* is what this file trades on: "in neither list" has
 * to mean "somebody forgot". A table whose correct treatment happens by accident
 * cannot be told apart from an oversight, which is precisely the confusion the
 * declarative lists are here to prevent. Found by OB-026's converse check.
 */
const APPEND_ONLY_TABLES = [
  'journals',
  'journal_lines',
  'permissions',
  // ── The M4 banking evidence (0006_banking) ─────────────────────────────────
  //
  // The first tables since M1 to join this list, and the first ever added for a
  // reason other than the ledger's own immutability.
  //
  // `bank_statement_lines` is criterion E2 and ROADMAP D-42: a statement line is
  // what the bank said. The argument is `journals`' argument applied to a different
  // record — the reason to keep a line is that it *independently corroborates* the
  // ledger, and a corroborating record you can rewrite corroborates nothing. So
  // everything the matching pipeline decides lives in a row that references a line
  // (`bank_match_proposals`, `bank_line_clearings`), and both of those are mutable
  // while the line is not.
  //
  // `bank_statement_imports` was here in wave 0 and is not any more: it moved to
  // `MUTABLE_TABLES` below when OB-078 made the import asynchronous (D-47/D-49). The
  // reasoning is beside it there. The short version is that the async model writes
  // the row at `status = 'queued'` before any line exists and updates it to
  // `complete`/`failed` when the worker finishes, which is an UPDATE the append-only
  // grant would refuse — and the evidence argument survives the move because a
  // *re-import* still creates a new row rather than rewriting an old one.
  //
  // `reconciliation_session_events` is criterion E6: reopening a finalised session
  // is permission-gated and leaves a record of who and when. A deletable audit trail
  // satisfies neither half. The session itself is mutable — `state` is the row the
  // application takes `FOR UPDATE`, which is only possible for a table in the list
  // below (D-14) — so the lock is mutable and the history is not.
  'bank_statement_lines',
  'reconciliation_session_events',
  // ── Invoice delivery (0007_invoice_delivery) ───────────────────────────────
  //
  // `invoice_deliveries` is the record that an invoice was sent — to which address,
  // at which time, as which frozen artifact. It is evidence, and the append-only
  // argument is `bank_statement_lines`' argument (D-42) applied to an outbound event:
  // a record the application can rewrite attests to nothing. A re-send is a new row
  // and a failed attempt is its own row, so no delivery's record is ever edited. Its
  // sibling `org_branding` is a setting and is mutable, below.
  'invoice_deliveries',
  // ── Dunning (0008_recurring_dunning) ───────────────────────────────────────
  //
  // `dunning_sends` is both evidence a reminder went out and the once-per-stage guard
  // (D-77): a stage sends at most once per invoice, enforced by a unique key whose
  // point is defeated the moment a row can be deleted and the send retried. It is
  // `invoice_deliveries`' append-only argument applied to a chase. Its policy and stage
  // siblings are settings and are mutable, below.
  'dunning_sends',
  // ── M5 platform (0010_platform) ────────────────────────────────────────────
  //
  // `event_log` is the transactional outbox (D-56): a subscriber's "at-least-once,
  // must be idempotent" guarantee only holds if a row it already read can never be
  // rewritten out from under it — `reconciliation_session_events`' argument applied
  // to the event stream every other M5 surface is built on. `security_events` is
  // D-61's issuance-and-revocation audit trail; a log the app could edit would
  // attest to nothing, which is `invoice_deliveries`' argument again. Both are new
  // reasons for the same rule this file has enforced since M1, not an exception to
  // it — the working state each produces (`oauth_tokens`, `change_feed_cursors`,
  // …) is mutable, below.
  'event_log',
  'security_events',
] as const;

/**
 * Tables the application may UPDATE and DELETE. Ordinary mutable state:
 * settings, membership, the chart of accounts, period status, session lifecycle.
 */
const MUTABLE_TABLES = [
  'users',
  'orgs',
  'roles',
  'role_permissions',
  'org_members',
  'org_invites',
  'api_keys',
  'sessions',
  'accounts',
  'contacts',
  'fiscal_periods',
  'idempotency_keys',
  // The journal sequence counter must be updatable even though the journals it
  // numbers are not. This is the table the posting transaction locks, precisely
  // because it cannot lock `journals` — see the comment in 0002_ledger.
  'journal_sequences',
  // Dimensions and their values are ordinary settings: renamed, archived, and — while
  // no journal line carries them — deleted (OB-037).
  'dimensions',
  'dimension_values',
  // The tags are mutable too, and that is a deliberate departure from how this file
  // treats everything else attached to a posting. A tag names which slice of the
  // business an amount belongs to; it is an analysis dimension laid over the ledger,
  // not a term of the entry. Nothing in the trial balance, the P&L, or the balance
  // sheet moves when one changes — only how a sliced report divides a total that stays
  // the same, which is the property B6 asserts. Refusing an edit here would mean the
  // only way to fix a mis-tagged line is to reverse and repost a journal that was
  // correct, and manufacturing two journal entries to correct a label is a worse
  // record of what happened than the edit is.
  'journal_line_dimensions',
  // The first genuinely new mutable tables since M1 (ROADMAP D-19). A draft is
  // editable and discardable *because* it is not a posting: it is in no report and no
  // trial balance, and posting it is a separate act that produces an immutable journal.
  // These two entries are the reason drafts can exist at all — a status column on
  // `journals` could never have worked, since the app user holds no UPDATE there.
  'journal_drafts',
  'journal_draft_lines',
  // The draft's tags. Mutable for the same reason its lines are — a draft is a form
  // in progress — and separately from `journal_line_dimensions` because the two
  // reference different parents with different delete semantics.
  'journal_draft_line_dimensions',
  // ── The M3 subledger (0005_subledger) ──────────────────────────────────────
  //
  // Every one of these, and none in APPEND_ONLY_TABLES. That looks like the largest
  // widening this file has ever taken and is the opposite: it is what ROADMAP D-34
  // means expressed as grants. A subledger holds no balance and no status — an
  // invoice's outstanding amount is its total minus its allocations, computed on
  // read, and paid/part-paid is derived the same way. So none of these tables holds
  // a financial fact that immutability would be protecting. Every such fact is a row
  // in `journals`, which stays append-only, and a void is a reversing journal rather
  // than an edit (D-38, D-16).
  //
  // The direction the guarantee could actually erode is a column: an
  // `outstanding_minor` or a `status` here would be financial state living outside
  // the ledger, and no grant could make it safe. `0005_subledger`'s header is where
  // that is argued; this list only follows from it.
  //
  // Two of these need UPDATE for a reason worth naming, because it is the reason
  // journals cannot have one. `document_sequences` is the counter row taken
  // `FOR UPDATE` when a document number is issued (D-36) — the same trick
  // `journal_sequences` exists for. And the document tables are lockable at all only
  // because they are here, which is what lets the allocation service refuse an
  // over-allocation (C3) by taking the document row before summing against it.
  // Which accounts an org has nominated as its AR and AP control accounts
  // (OB-066a). Mutable because the nomination is a setting and changing it is an
  // ordinary act — it moves where *future* postings land and cannot reach past
  // ones, which stay in `journals` where no grant here permits an UPDATE.
  'org_accounting_settings',
  'tax_rates',
  'document_sequences',
  'ar_documents',
  'ar_document_lines',
  'ar_document_line_dimensions',
  'ap_documents',
  'ap_document_lines',
  'ap_document_line_dimensions',
  'payments',
  // Allocations are deleted, not reversed, and that is deliberate. An allocation
  // posts no journal — the payment's and the credit note's journals already moved
  // the money — so unallocating restates no financial statement. Reversing rows
  // would make every outstanding calculation sum signed amounts.
  'ar_allocations',
  'ap_allocations',
  // ── M4 banking (0006_banking) ──────────────────────────────────────────────
  //
  // Seven of the ten new tables; the other three are in APPEND_ONLY_TABLES above,
  // and the split is the whole shape of D-42: what the bank said is evidence, what
  // anyone concluded from it is working state.
  //
  // `bank_accounts` and `bank_import_mappings` are settings — a nominated ledger
  // account and a saved CSV layout — and hold no financial fact between them (D-46).
  // `bank_rules` and its tags are a lookup table the user edits, and D-44's E8 is
  // enforced by what the schema does not contain rather than by a grant: no rule is
  // reachable from a posted entry, so no edit here can restate one.
  'bank_accounts',
  'bank_import_mappings',
  'bank_rules',
  'bank_rule_dimensions',
  // Moved out of APPEND_ONLY_TABLES by OB-078 (D-47/D-49). The import is asynchronous
  // now: `startImport` writes this row `queued` before parsing, and the worker updates
  // it to `complete` with the counts (or `failed` with a reason) when it is done — an
  // UPDATE the append-only grant would refuse. It is the one banking evidence table
  // that had to become working state, and only for its own status lifecycle: a
  // re-import still creates a new row rather than editing an old one, so no upload's
  // record is ever rewritten. The `bank_statement_lines` it produces stay append-only
  // above, which is where E2's immutability actually lives.
  'bank_statement_imports',
  // Proposals are deleted and regenerated wholesale. D-43's corollary is that
  // nothing depends on a proposal being right, only on it being ranked well, so
  // they are the most disposable rows in the schema.
  'bank_match_proposals',
  // The two that look like they belong above, and do not.
  //
  // A clearing is deletable for the reason `ar_allocations` is: it posts no journal.
  // The entry was posted separately, by a human, through the ordinary path (D-43,
  // E3), and the clearing states which bank line it corresponds to. Un-matching a
  // line restates no financial statement, and modelling it as a reversing row would
  // make every cleared-balance sum signed amounts. What must not be deletable is a
  // clearing inside a *finalised* session, and that is a rule about another row's
  // column value which no grant can express — it lives in OB-082 beside the rest of
  // the session lock.
  'bank_line_clearings',
  // The session is mutable because `state` is the lock. A concurrent clearing has to
  // test it, testing it means `SELECT … FOR UPDATE`, and MySQL requires UPDATE,
  // DELETE or LOCK TABLES for a locking read — which is exactly why the journal
  // sequence counter is its own table (D-14). Its history is append-only above.
  'reconciliation_sessions',
  // ── Invoice delivery (0007_invoice_delivery) ───────────────────────────────
  //
  // The org's letterhead, one row per org (OB-122). Mutable for the reason
  // `org_accounting_settings` is: it is a setting, and changing it moves how the
  // *next* invoice renders without reaching one already sent — a delivery's artifact
  // was frozen at send time and lives in `invoice_deliveries`, which is append-only
  // above. Editing the letterhead restates no financial statement.
  'org_branding',
  // ── Recurring invoices & dunning (0008_recurring_dunning) ──────────────────
  //
  // Standing instructions, all settings. A recurring template and its lines, and a
  // dunning policy and its stages, are edited freely: a change reaches the *next*
  // cycle or reminder and no invoice already raised or chased. The append-only halves
  // are the things they produce — the invoices (their own journals) and `dunning_sends`
  // above — not these definitions. `recurring_invoice_template_lines` and
  // `dunning_stages` are mutable children whose parents are here for the same reason.
  'recurring_invoice_templates',
  'recurring_invoice_template_lines',
  'dunning_policies',
  'dunning_stages',
  // ── OCR bill capture (0009_bill_capture) ──────────────────────────────────
  //
  // Both are working state, `bank_match_proposals`' argument again: nothing
  // downstream depends on an extraction being *right*, only on it being a fair
  // starting point for a human to correct or dismiss, and neither table posts a
  // journal. The record of what actually happened is the draft bill a capture
  // produces (`ap_documents`, already above) and, once approved, `journals` — not
  // this staging row. `bill_attachments` is the retained-original counterpart of
  // `invoice_deliveries.artifact_storage_key`, but unlike a sent invoice the file
  // it names was never itself evidence that something happened; the bill it is
  // attached to is.
  'document_captures',
  'bill_attachments',
  // ── M5 platform (0010_platform) ────────────────────────────────────────────
  //
  // The working-state half of D-53 through D-58, none of which posts a journal.
  // `oauth_clients`, `oauth_tokens`, and `oauth_consents` need UPDATE for the
  // reason `bank_statement_imports` moved here (OB-078): a token's `revoked_at`
  // and `last_used_at`, a client's `deactivated_at`, and a consent re-granted on
  // a later authorization are all ordinary lifecycle writes to a credential's own
  // row, not a rewrite of anything that happened — the fact that a credential was
  // *issued* is what `security_events` above records, immutably, beside it.
  // `oauth_grants` is mutable so `consumed_at` can mark an authorization code
  // redeemed, which is the single-use guard D-53 requires.
  //
  // `external_refs` is mutable by D-58's own design: a ref is re-pointed when two
  // upstream records merge, and re-pointing a correlation map restates nothing
  // financial about the entity it names.
  //
  // `event_positions` needs UPDATE for `journal_sequences`' reason exactly: it is
  // the counter row the event relay takes `FOR UPDATE` to allocate
  // `event_log.position`, and the table it numbers cannot itself be locked for a
  // read (D-56). `change_feed_cursors` is a subscriber's own bookmark, advanced
  // forward as it reads — the least consequential kind of mutable state in this
  // file, on a par with `dunning_policies`.
  'oauth_clients',
  'oauth_grants',
  'oauth_tokens',
  'oauth_consents',
  'external_refs',
  'event_positions',
  'change_feed_cursors',
  // ── Payment processing (0011_payment_processing) ───────────────────────────
  //
  // `secrets` is mutable, not append-only, and that is not a relaxation of D-101:
  // reconnecting a processor with a rotated key overwrites the same row
  // (`upsertSecret`'s `ON DUPLICATE KEY UPDATE`), and the value stored there was
  // never itself a financial fact — it is the ciphertext of a credential, and an
  // append-only history of past keys would only be a second place a rotated
  // secret could still be read from. `processor_connections` is a setting for
  // `bank_accounts`' reason (D-46 applied to a processor): the nomination of a
  // clearing/fee account and a key reference, changeable without reaching any
  // payment already recorded. `processor_events` is working state for
  // `bank_match_proposals`'/`document_captures`' reason: nothing downstream
  // depends on an event row being edited, only on the payment or fee it produced
  // — which lives in `journals`, append-only above, or `external_refs`,
  // mutable above for D-58's own reason — so `status`/`processed_at`/
  // `processing_error` need UPDATE for the same ordinary lifecycle-write
  // argument `bank_statement_imports` moved on.
  'secrets',
  'processor_connections',
  'processor_events',
  // ── Cash application (0012_cash_application, plus the 0006_banking restructure) ──
  //
  // `payment_terms` is a settings list `org_accounting_settings`'s own reason:
  // editing a term (its name, its discount window) moves how a *future* document
  // computes a due date and cannot reach one already raised, because no posted
  // journal names a term at all. D-107 gates it on `orgs.read`/`orgs.write`, the
  // same keys the control-account nominations beside it already use — no new
  // permission for this file to widen a grant around.
  //
  // `bank_line_clearing_entries` is the child D-105 moved the singular clearing
  // target onto. It is deletable for `bank_line_clearings`' own reason, beside it
  // above: an entry posts no journal of its own creation — the journal it names was
  // posted separately, through the ordinary path — so removing it (undoing a
  // clearing) restates no financial statement.
  'payment_terms',
  'bank_line_clearing_entries',
  // ── Pay Bills (0013_pay_bills) ─────────────────────────────────────────────
  //
  // All three are pencil, not ledger facts (D-64), so all three are mutable and
  // none is append-only. `pending_payments` and `pending_payment_intents` are the
  // queued-but-unissued state — built, edited, and cancelled up to issue, which is
  // an UPDATE/DELETE the append-only grant would refuse; the immutable record of a
  // disbursement is the `Payment` and its `journals` that issue produces through
  // `recordPayment`, not these rows. `check_number_sequences` is the register taken
  // `FOR UPDATE` when a check number is drawn — `document_sequences`'/
  // `journal_sequences`' own reason for needing UPDATE (D-14): the table it numbers
  // cannot itself be locked for a read.
  'pending_payments',
  'pending_payment_intents',
  'check_number_sequences',
  // ── Fixed assets & recurring journals (0014_fixed_assets) ──────────────────
  //
  // All four are standing instructions and plans, not ledger facts (D-113…D-116),
  // so all four are mutable and none is append-only. A `recurring_journal_template`
  // and its lines are a setting, edited freely; changing one changes the next cycle
  // and reaches no journal already posted. A `fixed_asset` carries its status and the
  // disposal journal that discharged it, both UPDATEs. `fixed_asset_schedule` is the
  // one that needs UPDATE for the pointed reason journals cannot have one: the
  // depreciation sweep stamps `posted_journal_id` onto the row it just discharged —
  // the once-per-period idempotency key — which is an UPDATE the append-only grant
  // would refuse. The immutable record of every posting is the `journals` each raises.
  'recurring_journal_templates',
  'recurring_journal_template_lines',
  'fixed_assets',
  'fixed_asset_schedule',
] as const;

export async function up(db: MigrationDb): Promise<void> {
  // Guards against a future edit adding a journal table to the mutable list.
  // Cheap, and the failure mode it prevents is silent loss of the core guarantee.
  const overlap = MUTABLE_TABLES.filter((table) =>
    (APPEND_ONLY_TABLES as readonly string[]).includes(table),
  );
  if (overlap.length > 0) {
    throw new Error(
      `Append-only tables must never be granted UPDATE/DELETE: ${overlap.join(', ')}. ` +
        'Journals are append-only and corrections are reversing entries (spec §2.2).',
    );
  }

  // Database-level read/append. Covers journals, which must be insertable.
  // GRANT is not parameterizable, so these are built without placeholders.
  await sql.raw(`GRANT SELECT, INSERT ON \`openbooks\`.* TO '${APP_DB_USER}'@'%'`).execute(db);

  for (const table of MUTABLE_TABLES) {
    await sql
      .raw(`GRANT UPDATE, DELETE ON \`openbooks\`.\`${table}\` TO '${APP_DB_USER}'@'%'`)
      .execute(db);
  }

  // No FLUSH PRIVILEGES. It is unnecessary — GRANT and REVOKE take effect at
  // once, and the flush is only needed after modifying the mysql.* grant tables
  // by hand — and it requires the global RELOAD privilege, which the migrator
  // deliberately does not have and which managed MySQL often will not grant at
  // all. Issuing it here would fail the migration on RDS.
  //
  // This migration deliberately does NOT verify its own outcome. The obvious
  // check — reading back information_schema.TABLE_PRIVILEGES — is worse than no
  // check at all: those views are filtered by the *querying* user's privileges,
  // and the migrator holds schema-level rights only, so it cannot see grants
  // belonging to another user. Measured against MySQL 8.4, the read-back returns
  // zero rows whether or not the grant is present, and `SHOW GRANTS FOR` and
  // `mysql.tables_priv` are both denied outright. A self-check that passes
  // unconditionally would report the guarantee as verified while proving nothing.
  //
  // The authority is the enforcement test in OB-026, which connects *as*
  // openbooks_app and asserts that UPDATE and DELETE on the journal tables are
  // refused. Spec §11 requires exactly that — tested as the app user, not as a
  // superuser — for this reason.
}

export async function down(db: MigrationDb): Promise<void> {
  for (const table of MUTABLE_TABLES) {
    await sql
      .raw(`REVOKE UPDATE, DELETE ON \`openbooks\`.\`${table}\` FROM '${APP_DB_USER}'@'%'`)
      .execute(db);
  }
  await sql.raw(`REVOKE SELECT, INSERT ON \`openbooks\`.* FROM '${APP_DB_USER}'@'%'`).execute(db);
}
