import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * The M5 platform schema (OB-096): third-party identity, the event outbox, and the
 * two audiences that read it — a change-feed consumer and a security auditor.
 *
 * Its own file for `0009_bill_capture`'s reason: a new subsystem gets one, and
 * `0999_app_grants` sorting last is what makes a file numbered after bill capture
 * possible at all.
 *
 * ## Two credential tables, one boundary
 *
 * `api_keys` has carried `role_id` — its own role, not the issuer's — since
 * `0001_tenancy`, unused until now. That column already draws the line ROADMAP D-55
 * states: a key authenticates as an org and a role with no user behind it, for the
 * operator's own scripts. `oauth_tokens` is the table on the other side of it — a
 * token always represents a **person** authorizing a third-party client
 * (`user_id NOT NULL`), and carries the intersected scope D-54 computes fresh on
 * every request rather than a baked-in role. Both are opaque `key_prefix` +
 * SHA-256 hash with instant `revoked_at` (D-61); neither is a bearer JWT, for the
 * reason a blocklist would reintroduce the lookup a JWT exists to avoid.
 *
 * `oauth_clients`, `oauth_grants` (authorization codes), and `oauth_consents`
 * complete the authorization-server half (D-53): PKCE-mandatory codes, single-use
 * and short-lived, and a per-client record of which scopes a user has already
 * granted so re-authorization is not re-consent.
 *
 * ## The outbox is the event, not a side effect of it
 *
 * `event_log` is what D-56 calls the transactional outbox: the state change and
 * its `event_log` row are written in the *same tenant transaction*, so an event
 * exists if and only if its change committed. `position` is assigned from
 * `event_positions`, a per-org counter taken `FOR UPDATE` exactly the way
 * `journal_sequences` allocates `journals.sequence_number` (D-14) — the
 * append-only log cannot itself be locked for a read any more than `journals`
 * can, which is why the counter is its own mutable row beside it.
 *
 * `event_log` and `security_events` both join `APPEND_ONLY_TABLES` in
 * `0999_app_grants`, beside `reconciliation_session_events`: an outbox row a
 * subscriber already read cannot be rewritten out from under it (D-56's
 * "at-least-once, subscribers must be idempotent" only holds if the log itself
 * never changes), and a security audit trail the app could edit would attest to
 * nothing (D-61).
 *
 * `change_feed_cursors` is the consumer side of the same log — D-57's "a
 * projection of the event log, not a second store": the feed itself is a keyset
 * read over `event_log` keyed on `position`, and this table holds nothing but
 * where a subscriber last stopped reading.
 *
 * ## `external_refs` is the correlation map, not a second identity
 *
 * D-58: an integrator's own id mapped to an OpenBooks entity, unique both ways —
 * `(org_id, external_system, entity_type, external_id)` and
 * `(org_id, external_system, entity_type, entity_id)` — so a create carrying a
 * known external ref returns the existing entity rather than duplicating, and an
 * entity resolves back to its external id with no ambiguity either. `entity_id`
 * is deliberately not a foreign key: `entity_type` names which OpenBooks table it
 * points into, and that is a fact only the service layer can resolve — the same
 * shape `journals.source` takes toward the subsystem that produced a posting.
 *
 * ## Why every one of these nine is a tenant table
 *
 * Even `event_log` and `security_events`, which read like system-wide logs: an
 * OAuth client, a token, a security event, all belong to exactly one org, and
 * D-56's own flag names per-org ordering as the deliberate choice over a global
 * one. Nothing here is shared the way `permissions` or the seeded system roles
 * are.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // oauth_clients — a third-party application an org admin registered
  // (D-53: public dynamic client registration is out of M5, so every row here is
  // an admin's own act under `integrations.write`).
  //
  // `client_id` is the public, globally-unique opaque identifier the authorize
  // endpoint resolves an org from before any session exists — the same shape
  // `orgs.inbound_email_token` takes toward the bill-capture inbound route, and
  // for the same reason: a lookup has to work with no context but the token
  // itself. `secret_prefix` + `secret_hash` mirror `api_keys` exactly (D-61).
  //
  // `redirect_uris` is a JSON array of exact-match allowed URIs (OAuth 2.1: no
  // wildcard matching), so a single client can register a production and a
  // development callback without a second row.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE oauth_clients (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      client_id          VARCHAR(64)  NOT NULL,
      name               VARCHAR(120) NOT NULL,
      secret_prefix      VARCHAR(16)  NOT NULL,
      secret_hash        CHAR(64)     NOT NULL,
      redirect_uris      JSON         NOT NULL,
      created_by_user_id BINARY(16)   NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      deactivated_at     DATETIME(3)  NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_oauth_clients_client_id (client_id),
      UNIQUE KEY uq_oauth_clients_org_id (org_id, id),
      CONSTRAINT fk_oauth_clients_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_oauth_clients_creator
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // oauth_grants — authorization codes (D-53: PKCE mandatory, implicit and
  // resource-owner-password refused).
  //
  // Short-lived and single-use: `expires_at` bounds the first, `consumed_at` set
  // on redemption enforces the second — a code read twice is a replay, and the
  // token endpoint's whole job on this table is to check `consumed_at IS NULL`
  // before setting it. `code_hash`, not the code itself, for the same reason
  // every other credential in this schema is stored hashed.
  //
  // `redirect_uri` is carried on the grant, not re-read off the client, because
  // RFC 6749 requires the token endpoint to check it matches the *authorize*
  // request's redirect exactly — a client with two registered URIs must not let
  // a code minted for one be redeemed against the other.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE oauth_grants (
      id                    BINARY(16)    NOT NULL,
      org_id                BINARY(16)    NOT NULL,
      client_id             BINARY(16)    NOT NULL,
      user_id               BINARY(16)    NOT NULL,
      code_hash             CHAR(64)      NOT NULL,
      redirect_uri          VARCHAR(2048) NOT NULL,
      scope                 VARCHAR(1024) NOT NULL,
      code_challenge        VARCHAR(128)  NOT NULL,
      code_challenge_method VARCHAR(8)    NOT NULL,
      expires_at            DATETIME(3)   NOT NULL,
      consumed_at           DATETIME(3)   NULL,
      created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_oauth_grants_code (code_hash),
      UNIQUE KEY uq_oauth_grants_org_id (org_id, id),
      CONSTRAINT fk_oauth_grants_client
        FOREIGN KEY (org_id, client_id) REFERENCES oauth_clients (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_oauth_grants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // oauth_tokens — access and refresh, opaque, mirroring `api_keys` (D-61).
  //
  // `user_id NOT NULL` is D-55's whole distinction expressed as a column: a
  // token always represents a person, where an API key never does. `scope` is
  // the *granted* scope from consent; D-54's effective-permission intersection
  // against the user's current role happens at request time in the service
  // layer, not here, which is why revoking a role narrows every outstanding
  // token with no row in this table touched.
  //
  // `refresh_token_id` names the refresh token that minted an access token, for
  // revocation cascades a service can walk explicitly — not a foreign key,
  // because a refresh token and the access tokens it mints share this table and
  // a self-referencing composite key would gain nothing a service-level lookup
  // does not already give it.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE oauth_tokens (
      id                BINARY(16)    NOT NULL,
      org_id            BINARY(16)    NOT NULL,
      client_id         BINARY(16)    NOT NULL,
      user_id           BINARY(16)    NOT NULL,
      token_type        ENUM('access','refresh') NOT NULL,
      key_prefix        VARCHAR(16)   NOT NULL,
      token_hash        CHAR(64)      NOT NULL,
      scope             VARCHAR(1024) NOT NULL,
      refresh_token_id  BINARY(16)    NULL,
      expires_at        DATETIME(3)   NOT NULL,
      last_used_at      DATETIME(3)   NULL,
      revoked_at        DATETIME(3)   NULL,
      created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_oauth_tokens_hash (token_hash),
      UNIQUE KEY uq_oauth_tokens_org_id (org_id, id),
      -- Mirrors idx_api_keys_org_prefix: the lookup a bearer request runs before
      -- it can hash-compare, exactly the pattern api_keys already established.
      KEY idx_oauth_tokens_org_prefix (org_id, key_prefix),
      CONSTRAINT fk_oauth_tokens_client
        FOREIGN KEY (org_id, client_id) REFERENCES oauth_clients (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_oauth_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // oauth_consents — which scopes a user has granted a client, so returning to
  // an already-authorized client is a silent re-issue rather than a second
  // consent screen.
  //
  // One row per (client, user): `scope` is overwritten on re-consent rather than
  // accumulated, because the consent screen always shows and grants the client's
  // full current request, not a delta — an update, not an append, which is why
  // this table is mutable and not evidence the way `dunning_sends` is.
  // `revoked_at` records a user withdrawing consent independently of any token
  // being revoked.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE oauth_consents (
      id          BINARY(16)    NOT NULL,
      org_id      BINARY(16)    NOT NULL,
      client_id   BINARY(16)    NOT NULL,
      user_id     BINARY(16)    NOT NULL,
      scope       VARCHAR(1024) NOT NULL,
      created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
      revoked_at  DATETIME(3)   NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_oauth_consents_client_user (org_id, client_id, user_id),
      UNIQUE KEY uq_oauth_consents_org_id (org_id, id),
      CONSTRAINT fk_oauth_consents_client
        FOREIGN KEY (org_id, client_id) REFERENCES oauth_clients (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_oauth_consents_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // external_refs — D-58's correlation map: an integrator's own id resolved to
  // an OpenBooks entity, both ways, with no ambiguity.
  //
  // `entity_id` names the OpenBooks row and is deliberately not a foreign key —
  // `entity_type` is which table it points into, a fact only the service layer
  // resolves, the same way `journals.source` names a subsystem without a
  // constraint enforcing it. `uq_external_refs_entity` is what makes the
  // "one entity, one external id per system" half of D-58 structural rather than
  // a service-layer promise.
  //
  // Mutable, and that is a decision and not a relaxation: a ref is re-pointed
  // when two upstream records merge, and re-pointing is an ordinary update to a
  // correlation map, not a restatement of anything financial — the entity it
  // names keeps its own history in whichever ledger or subledger table holds it.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE external_refs (
      id              BINARY(16)   NOT NULL,
      org_id          BINARY(16)   NOT NULL,
      external_system VARCHAR(80)  NOT NULL,
      entity_type     VARCHAR(40)  NOT NULL,
      external_id     VARCHAR(255) NOT NULL,
      entity_id       BINARY(16)   NOT NULL,
      created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_external_refs_external (org_id, external_system, entity_type, external_id),
      UNIQUE KEY uq_external_refs_entity (org_id, external_system, entity_type, entity_id),
      UNIQUE KEY uq_external_refs_org_id (org_id, id),
      CONSTRAINT fk_external_refs_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // event_log — the transactional outbox (D-56). One row per committed domain
  // event, the same record `event_positions` numbers and the change feed
  // (D-57) replays wholesale.
  //
  // `id` is the host-side `eventId`, assigned once by the relay that also
  // assigns `occurred_at` and `position` — never by a publisher, which is the
  // second of D-56's three fixed constraints. `actor_type`/`actor_id` are plain
  // strings rather than `journals`' `ENUM` + `BINARY(16)` pair: an event names
  // the actor that caused it in whatever shape the originating subsystem already
  // has on hand (a user, an automation, an agent, or in principle a subsystem
  // acting on its own), and forcing every one through the ledger's narrower
  // actor vocabulary would make this table only as expressive as `journals`
  // rather than as expressive as everything that can now publish to it.
  //
  // `payload` is the event body — the `.v1` shape `OpenBooksEvent` names for
  // whichever `name` this row carries (`invoice.approved.v1` and so on). No
  // `journal_id` or other narrow foreign key: a payload's own fields carry
  // whatever correlation a subscriber needs, because the set of event kinds
  // grows without a migration (D-56's "additive `.v1` events, never an edit to
  // an existing payload").
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE event_log (
      id               BINARY(16)      NOT NULL,
      org_id           BINARY(16)      NOT NULL,
      position         BIGINT UNSIGNED NOT NULL,
      name             VARCHAR(80)     NOT NULL,
      actor_type       VARCHAR(16)     NOT NULL,
      actor_id         VARCHAR(255)    NOT NULL,
      invocation_mode  VARCHAR(16)     NULL,
      payload          JSON            NOT NULL,
      occurred_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_event_log_org_position (org_id, position),
      UNIQUE KEY uq_event_log_org_id (org_id, id),
      CONSTRAINT fk_event_log_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // event_positions — one counter row per org, allocating `event_log.position`
  // (D-56, the D-14 counter pattern applied a second time).
  //
  // The reason is the same as `journal_sequences`': `event_log` is append-only,
  // and MySQL requires `SELECT` plus one of `UPDATE`/`DELETE`/`LOCK TABLES` for a
  // locking read, so the row the relay takes `FOR UPDATE` cannot be a row in the
  // table it is numbering. A counter table rather than `MAX(position) + 1` for
  // the same concurrency reason `journal_sequences`'s header states at length —
  // and a gap here is the same ambiguity D-56's "an event exists if and only if
  // its change committed" exists to remove.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE event_positions (
      org_id      BINARY(16)      NOT NULL,
      next_value  BIGINT UNSIGNED NOT NULL DEFAULT 1,
      updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id),
      CONSTRAINT fk_event_positions_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // change_feed_cursors — a subscriber's own replay position over `event_log`
  // (D-57).
  //
  // The feed itself holds no state of its own — it is a keyset read over the
  // log — so the only row a consumer needs is this one: how far it has read.
  // One per (org, subscriber), advanced forward as the consumer pages; replay
  // is nothing more than not advancing it, or setting it back.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE change_feed_cursors (
      id          BINARY(16)      NOT NULL,
      org_id      BINARY(16)      NOT NULL,
      subscriber  VARCHAR(120)    NOT NULL,
      position    BIGINT UNSIGNED NOT NULL DEFAULT 0,
      created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_change_feed_cursors_subscriber (org_id, subscriber),
      UNIQUE KEY uq_change_feed_cursors_org_id (org_id, id),
      CONSTRAINT fk_change_feed_cursors_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // security_events — issuance and revocation audit (D-61): "every issuance,
  // consent, and revocation writes an append-only security_events row, beside
  // the other append-only evidence tables."
  //
  // `credential_type`/`credential_id` name what the event is about
  // (`api_key`/`oauth_token`/`oauth_client`, and the row in whichever of those
  // tables) without a foreign key, for `external_refs.entity_id`'s reason: the
  // type is what says which table, and a single polymorphic column cannot point
  // at three. `actor_user_id` is nullable because a revocation can be system-
  // initiated (an expiry sweep) as well as a person's act, and is left
  // unconstrained toward `users` for the same reason this table carries no other
  // foreign key beyond org: an audit row must survive the actor it names being
  // removed from the org, exactly as `journals`' actor provenance is never a
  // referential constraint against membership.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE security_events (
      id                BINARY(16)  NOT NULL,
      org_id            BINARY(16)  NOT NULL,
      event_type        VARCHAR(80) NOT NULL,
      actor_user_id     BINARY(16)  NULL,
      credential_type   VARCHAR(40) NULL,
      credential_id     BINARY(16)  NULL,
      detail            JSON        NULL,
      created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_security_events_org_id (org_id, id),
      -- The list read this table exists for: an org's security history in order.
      KEY idx_security_events_org_created (org_id, created_at),
      CONSTRAINT fk_security_events_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order, children before parents so the composite foreign
  // keys drop cleanly.
  await sql`DROP TABLE IF EXISTS security_events`.execute(db);
  await sql`DROP TABLE IF EXISTS change_feed_cursors`.execute(db);
  await sql`DROP TABLE IF EXISTS event_positions`.execute(db);
  await sql`DROP TABLE IF EXISTS event_log`.execute(db);
  await sql`DROP TABLE IF EXISTS external_refs`.execute(db);
  await sql`DROP TABLE IF EXISTS oauth_consents`.execute(db);
  await sql`DROP TABLE IF EXISTS oauth_tokens`.execute(db);
  await sql`DROP TABLE IF EXISTS oauth_grants`.execute(db);
  await sql`DROP TABLE IF EXISTS oauth_clients`.execute(db);
}
