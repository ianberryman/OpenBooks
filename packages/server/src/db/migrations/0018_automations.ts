import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Automations — agent work queue, MCP-only (initiative Q, M6; OB-200…210; ROADMAP
 * D-99/D-100/D-118/D-119).
 *
 * Three tables and no model credentials anywhere: OpenBooks holds none and calls no
 * model (D-100). It orchestrates a queue and an engine; the org's own agent polls
 * over MCP, runs inference on its own infra, and submits a proposal back. A
 * "proposal" is not a new record type — it is an ordinary `journal_drafts` row
 * landed through the existing `createDraft`, which the M5 `agents.review` queue
 * already surfaces for a human to post. So Q adds only what nothing else records:
 * the standing automations, the work queue, and the annotation the trivial
 * deterministic action writes.
 *
 * ## `automations` — the standing instruction (MUTABLE, D-99/D-119)
 *
 * A trigger + an ordered list of actions the user composes and owns. Mutable for
 * `recurring_invoice_templates`' reason (0999_app_grants): it is a standing
 * definition edited freely, and a change reaches the *next* firing, never a work
 * item already enqueued. `trigger_config` and `actions` are JSON because the shape
 * is the service's to own and validate (Zod), not the schema's to pin — the same
 * argument `period_close_events.checklist` makes. `is_active` defaults 0: an
 * automation is composed under `workflows.write` but only fires once enabled under
 * `workflows.activate` (the reserved compose-vs-activate split, owner-only activate).
 * `last_fired_run_date` is the scheduled-trigger idempotency guard, the exact role
 * `recurring_invoice_templates.last_run_date` plays: the daily sweep compares it to
 * the dispatched run date so a re-enqueue or crash-restart fires a cycle at most
 * once. A calendar DATE (mapped `string`, see codegen.mjs), NULL until first fired.
 *
 * ## `work_items` — the queue (MUTABLE, with a lease; D-100 Q7/Q10)
 *
 * One row per unit of agent work: a prompt + context, a status lifecycle, and a
 * lease. Mutable — not append-only — for `bank_statement_imports`' reason (OB-078):
 * the row is claimed and settled in place. The lease is the single-grant mechanism
 * (Q10): `poll` takes the next `queued` row `FOR UPDATE` (which needs the UPDATE
 * grant a locking read requires — D-14, the same reason a counter is its own table)
 * and moves it to `leased` with a token and an expiry, so two agents never process
 * one item. Recovery is time-based, not credential-based (D-100): a lease that
 * expires with no submission returns the row to `queued` and increments `attempts`,
 * flagging it past a threshold — never silently dropped. `proposed_draft_id` is a
 * *soft* reference to `journal_drafts`, deliberately not an FK: a draft is deleted
 * when a human posts it (`postDraft`), so a hard FK would either block the post or
 * null the provenance link the moment the work succeeded. Provenance is
 * agent-attested (D-100): `agent_model` and `submitted_by_client` are what the agent
 * reported and the MCP client it authenticated as — OpenBooks records them, it does
 * not vouch for the model it never called. `automation_id` is NULL for a raw
 * producer that enqueues without an automation; the composite FK `(org_id,
 * automation_id)` is satisfied-when-null (MySQL MATCH SIMPLE), so that is legal.
 *
 * ## `automation_annotations` — the `annotate` action's output (APPEND_ONLY, D-119)
 *
 * The trivial deterministic action: a note attached to a firing. Append-only —
 * `period_close_events`' reason — because it is a record that something happened,
 * not working state. `run_token` ties the note to the `work_item` the same firing
 * enqueued (both carry the token), which is how the E2E proves an `[annotate,
 * agent_task]` automation ran both actions in order (Q9). It has no external side
 * effect and needs no secret; its whole job is to make composition observable.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE automations (
      id                  BINARY(16)    NOT NULL,
      org_id              BINARY(16)    NOT NULL,
      name                VARCHAR(200)  NOT NULL,
      -- Composed inactive (workflows.write); enabled under workflows.activate.
      is_active           TINYINT(1)    NOT NULL DEFAULT 0,
      trigger_type        ENUM('manual','scheduled','event') NOT NULL,
      -- Shape owned by the service (Zod), not the schema — cf. period_close_events.checklist.
      trigger_config      JSON          NOT NULL,
      -- Ordered [{ type: 'annotate' | 'agent_task', ... }]; the action model is an
      -- open discriminant so a later action type (an outbound-http, D-119) is a new
      -- case, not an ALTER.
      actions             JSON          NOT NULL,
      -- The scheduled-trigger once-per-cycle guard (cf. recurring_invoice_templates.last_run_date).
      -- A calendar DATE (mapped to string), NULL until first fired.
      last_fired_run_date DATE          NULL,
      created_by_user_id  BINARY(16)    NOT NULL,
      created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                            ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_automations_org_id (org_id, id),
      -- The scheduled sweep reads "this org's active scheduled automations".
      KEY idx_automations_org_trigger (org_id, trigger_type, is_active),
      CONSTRAINT fk_automations_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_automations_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE work_items (
      id                  BINARY(16)    NOT NULL,
      org_id              BINARY(16)    NOT NULL,
      -- NULL for a raw producer that enqueues without an automation; the composite FK
      -- below is satisfied-when-null (MySQL MATCH SIMPLE).
      automation_id       BINARY(16)    NULL,
      -- Ties one firing's composed actions (the annotation and this item) together.
      run_token           BINARY(16)    NULL,
      source_kind         VARCHAR(60)   NOT NULL,
      -- An opaque id of the originating object (a bill capture, a bank line). A string,
      -- not an FK'd entity, because a work item can point at any of several domains.
      source_ref          VARCHAR(255)  NULL,
      prompt              VARCHAR(2000) NOT NULL,
      -- The payload the agent needs; shape owned by the producer, not the schema.
      context             JSON          NOT NULL,
      status              ENUM('queued','leased','proposed','failed','cancelled')
                            NOT NULL DEFAULT 'queued',
      -- The lease (Q10): set by poll under FOR UPDATE, cleared on submit/expiry.
      lease_token         BINARY(16)    NULL,
      -- The MCP client (OAuth client_id / api key id) that claimed it — provenance (Q6).
      leased_by           VARCHAR(255)  NULL,
      leased_at           DATETIME(3)   NULL,
      lease_expires_at    DATETIME(3)   NULL,
      attempts            INT UNSIGNED  NOT NULL DEFAULT 0,
      flagged             TINYINT(1)    NOT NULL DEFAULT 0,
      -- Soft ref to journal_drafts (deleted on post) — deliberately not an FK.
      proposed_draft_id   BINARY(16)    NULL,
      -- Agent-attested (D-100): recorded, not vouched for.
      agent_model         VARCHAR(200)  NULL,
      submitted_by_client VARCHAR(255)  NULL,
      submitted_at        DATETIME(3)   NULL,
      last_error          VARCHAR(1000) NULL,
      created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                            ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_work_items_org_id (org_id, id),
      -- The poll: the oldest queued item in this org (FIFO).
      KEY idx_work_items_poll (org_id, status, created_at),
      CONSTRAINT fk_work_items_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_work_items_automation
        FOREIGN KEY (org_id, automation_id) REFERENCES automations (org_id, id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE automation_annotations (
      id            BINARY(16)    NOT NULL,
      org_id        BINARY(16)    NOT NULL,
      automation_id BINARY(16)    NOT NULL,
      -- Shared with the work_item the same firing enqueued (Q9 composition).
      run_token     BINARY(16)    NOT NULL,
      note          VARCHAR(512)  NOT NULL,
      created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_automation_annotations_org_id (org_id, id),
      KEY idx_aa_org_automation (org_id, automation_id, created_at),
      KEY idx_aa_org_run (org_id, run_token),
      CONSTRAINT fk_aa_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_aa_automation
        FOREIGN KEY (org_id, automation_id) REFERENCES automations (org_id, id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS automation_annotations`.execute(db);
  await sql`DROP TABLE IF EXISTS work_items`.execute(db);
  await sql`DROP TABLE IF EXISTS automations`.execute(db);
}
