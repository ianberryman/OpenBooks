import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Invoice delivery, Phase 1 (OB-122): where an org states how its invoices should
 * look, and the immutable record of each one that was sent.
 *
 * Its own file for the reason `0005_subledger` and `0006_banking` are — a new
 * subsystem gets one, and `0999_app_grants` sorting last (its prefix is the ceiling
 * of the four-digit convention) is what makes a file numbered after the ledger
 * possible at all. `0004` stays skipped; the next free prefix is `0007`.
 *
 * ## The two tables sit on opposite sides of the mutable/append-only split
 *
 * `org_branding` is a setting: the letterhead an org prints on the invoices it
 * sends. Editing it restates nothing — it changes how the *next* PDF is rendered and
 * cannot reach a delivery already made, whose artifact was frozen at send time. So it
 * is mutable, and it is shaped exactly like `org_accounting_settings` (0005): one row
 * per org, absent until the first write, created lazily by an upsert. There is no
 * `id` and no surrogate key — the org owns the row and `org_id` is the whole primary
 * key, reached only through `tenantDb(orgId)` like every other tenant table.
 *
 * `invoice_deliveries` is evidence, and evidence you can rewrite is not evidence.
 * The argument is `bank_statement_lines`' argument (0006) and, before it, `journals`'
 * (spec §12): a record is worth keeping because it independently attests that
 * something happened — an invoice went to this address, at this time, as this
 * artifact — and a record the application can UPDATE attests to nothing. So it is
 * append-only: the app user holds SELECT/INSERT on it and no UPDATE/DELETE (0999),
 * and a re-send is a new row rather than an edit of an old one. A failed attempt is
 * likewise its own row (`status = 'failed'`), not an overwrite of a prior try.
 *
 * ## The capability token is stored the way every other credential in this schema is
 *
 * A delivery carries a public link whose bearer may fetch the rendered invoice
 * without logging in. The token behind that link is a credential, so a database read
 * must not yield a usable one — the same rule `sessions.token_hash` and
 * `api_keys.key_hash` follow. Only the SHA-256 of the full token is stored
 * (`token_hash`), and lookup is by a short non-secret `key_prefix` carried in the URL
 * beside the secret, exactly as `api_keys` splits `key_prefix` from `key_hash`: the
 * prefix selects the candidate row by index, the hash is then compared in full. The
 * prefix index is bare `(key_prefix)` rather than `(org_id, key_prefix)` because the
 * link is presented to a public endpoint that has no org context until the row is
 * found — the token is what establishes which org the request belongs to.
 *
 * `token_hash` is `BINARY(32)` — the raw 32 bytes of a SHA-256 — rather than the
 * `CHAR(64)` hex the older tables use. Both store the same digest; the binary form is
 * half the bytes and there is no reason a fresh column should carry the hex encoding.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // org_branding — the org's letterhead, one row per org, created lazily.
  //
  // Mirrors `org_accounting_settings` (0005) in shape and lifecycle: `org_id` is the
  // whole primary key, the row is absent until something writes it, and every column
  // but the display name is nullable so a partially-filled letterhead is a valid row
  // rather than an error. `display_name` is the one thing a rendered invoice cannot do
  // without — it is what prints at the top — so it is the single NOT NULL field, and
  // the upsert that creates the row supplies it.
  //
  // `logo_storage_key` names an object in the artifact store, not the bytes; the same
  // indirection `invoice_deliveries.artifact_storage_key` uses. `brand_color` is a CSS
  // hex string sized for `#RRGGBBAA` (nine characters). `invoice_footer` is free prose
  // of unbounded-enough length to be TEXT rather than a VARCHAR guess.
  //
  // ON DELETE CASCADE: the letterhead has no meaning without its org and dies with it,
  // the same shape `org_accounting_settings` takes.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE org_branding (
      org_id           BINARY(16)   NOT NULL,
      display_name     VARCHAR(255) NOT NULL,
      address_line1    VARCHAR(255) NULL,
      address_line2    VARCHAR(255) NULL,
      city             VARCHAR(120) NULL,
      region           VARCHAR(120) NULL,
      postal_code      VARCHAR(32)  NULL,
      country          VARCHAR(120) NULL,
      email            VARCHAR(320) NULL,
      phone            VARCHAR(64)  NULL,
      website          VARCHAR(255) NULL,
      tax_number       VARCHAR(64)  NULL,
      logo_storage_key VARCHAR(512) NULL,
      brand_color      VARCHAR(9)   NULL,
      invoice_footer   TEXT         NULL,
      created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id),
      CONSTRAINT fk_org_branding_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // invoice_deliveries — the immutable record of one sent invoice (OB-122).
  //
  // Append-only (0999): a delivery attests that an artifact went to an address at a
  // time, so it is kept for the reason `bank_statement_lines` is kept and rewriting it
  // would defeat the point. A re-send or a retry is a new row.
  //
  // `invoice_id` is a composite `(org_id, id)` foreign key into `ar_documents`, the
  // tenancy pattern that makes another org's invoice structurally unreferenceable
  // (README "Tenancy is enforced by composite foreign keys"). RESTRICT rather than
  // CASCADE: an invoice with a delivery on record cannot be deleted out from under it,
  // the same shape `ar_allocations` takes toward the documents it settles. A delivery
  // only ever names an AR invoice, so there is one parent table and no `side` column.
  //
  // `key_prefix` / `token_hash` are the split-credential pair described in the header.
  // `artifact_storage_key` names the frozen PDF in the object store. `status` is the
  // closed set {sent, failed}; it is a VARCHAR with a CHECK rather than an ENUM because
  // the contract (F1) names the two strings, and the CHECK is what keeps a third value
  // from ever being inserted. `provider_message_id` is the email provider's handle for
  // the message, absent on a failure that never reached the provider.
  //
  // `sent_at` is the instant the attempt was made and `created_at` the instant the row
  // was written; they differ only when a queued send settles later. There is no
  // `updated_at` — an append-only row is never updated, so a second timestamp that
  // could only ever equal `created_at` would be a column that lies the moment anyone
  // expects it to move.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE invoice_deliveries (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      invoice_id           BINARY(16)   NOT NULL,
      recipient_email      VARCHAR(320) NOT NULL,
      artifact_storage_key VARCHAR(512) NOT NULL,
      key_prefix           VARCHAR(16)  NOT NULL,
      token_hash           BINARY(32)   NOT NULL,
      provider_message_id  VARCHAR(255) NULL,
      status               VARCHAR(16)  NOT NULL,
      sent_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_invoice_deliveries_org_id (org_id, id),
      -- "Deliveries of this invoice", the natural read for an invoice's history.
      KEY idx_invoice_deliveries_org_invoice (org_id, invoice_id),
      -- Token lookup from a public link, which carries the prefix but no org context.
      KEY idx_invoice_deliveries_key_prefix (key_prefix),
      CONSTRAINT fk_invoice_deliveries_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_invoice_deliveries_invoice
        FOREIGN KEY (org_id, invoice_id) REFERENCES ar_documents (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_invoice_deliveries_status CHECK (status IN ('sent', 'failed'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order. `invoice_deliveries` first: its RESTRICT on `ar_documents`
  // outlives `0005_subledger`, whose down() drops that table.
  await sql`DROP TABLE IF EXISTS invoice_deliveries`.execute(db);
  await sql`DROP TABLE IF EXISTS org_branding`.execute(db);
}
