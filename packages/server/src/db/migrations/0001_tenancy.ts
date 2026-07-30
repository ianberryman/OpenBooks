import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Tenancy, identity, and authorization (spec §4, §5).
 *
 * Shared schema with `org_id` on every tenant table, leading every composite
 * index. Client-facing identifiers are UUIDs in `BINARY(16)`.
 *
 * Three credential types all resolve to an `(org_id, role_id)` context: sessions
 * (web), API keys (scripts), and OAuth tokens (third-party apps). Only sessions
 * and the `api_keys` table land in M1 — the OAuth authorization server is M5.
 * `api_keys` ships unused because spec §7 lists it under tenancy and adding the
 * table later would mean altering a populated schema for no benefit.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // users — NOT tenant-scoped. Spec §5: one login may hold membership in N orgs
  // with a different role in each, which is what makes multi-org accountants
  // work. Scoping users by org would force one account per client engagement.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE users (
      id             BINARY(16)   NOT NULL,
      email          VARCHAR(320) NOT NULL,
      password_hash  VARCHAR(255) NOT NULL,
      display_name   VARCHAR(255) NOT NULL,
      is_active      TINYINT(1)   NOT NULL DEFAULT 1,
      created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
      last_login_at  DATETIME(3)  NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // orgs — the tenant root. Its own `id` IS the org_id, so it is reached by id
  // rather than through the org-scoped wrapper.
  // ---------------------------------------------------------------------------
  //
  // `fiscal_year_start_month` is 1–12, defaulting to January (ROADMAP D-17). A
  // fiscal year frequently does not start in January — April, July, and October
  // are all common — but the periods within it are ordinary calendar months, so
  // the only thing that varies per org is where the year begins.
  //
  // `inbound_email_token` (initiative O, OB-185…191) is the org's half of its
  // inbound bill-capture address — `POST /v1/bills/inbound/:token` resolves this
  // column to an org before any session exists, which is why it is a bare token
  // rather than something requiring one. Nullable and minted lazily by the
  // inbound-address service on first use, not backfilled: an org that never wires
  // up email capture never gets one. `UNIQUE` makes the token the whole lookup —
  // the same shape `invoice_deliveries.key_prefix` uses to resolve an org from a
  // public link with no other context, except here there is no split-credential
  // pair: the inbound route runs `runAsAutomation` under the resolved org exactly
  // as any other scheduled write does, and the harm in a guessed token is a
  // spurious capture, not an authenticated session.
  await sql`
    CREATE TABLE orgs (
      id                      BINARY(16)   NOT NULL,
      name                    VARCHAR(255) NOT NULL,
      slug                    VARCHAR(120) NOT NULL,
      fiscal_year_start_month TINYINT UNSIGNED NOT NULL DEFAULT 1,
      inbound_email_token     BINARY(16)   NULL,
      created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                           ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_orgs_slug (slug),
      UNIQUE KEY uq_orgs_inbound_email_token (inbound_email_token),
      CONSTRAINT chk_orgs_fiscal_year_start_month
        CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // permissions — a fixed catalog, not user-editable (spec §5). Roles are
  // bundles over this catalog.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE permissions (
      code         VARCHAR(64)  NOT NULL,
      description  VARCHAR(255) NOT NULL,
      PRIMARY KEY (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // roles — `org_id IS NULL` marks a seeded system role, shared by every org.
  // A non-null org_id is a custom role, which spec §5 defers to v2; the schema
  // supports it now so v2 is a feature, not a migration of populated tables.
  //
  // The unique key is on (org_id, code) and MySQL treats NULLs as distinct, so
  // it does not prevent two system roles sharing a code. uq_roles_system_code
  // covers that case for system roles specifically.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE roles (
      id          BINARY(16)   NOT NULL,
      org_id      BINARY(16)   NULL,
      code        VARCHAR(64)  NOT NULL,
      name        VARCHAR(120) NOT NULL,
      description VARCHAR(255) NOT NULL,
      is_system   TINYINT(1)   NOT NULL DEFAULT 0,
      created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_roles_org_code (org_id, code),
      UNIQUE KEY uq_roles_org_id (org_id, id),
      CONSTRAINT fk_roles_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX uq_roles_system_code ON roles ((IF(is_system = 1, code, NULL)))
  `.execute(db);

  await sql`
    CREATE TABLE role_permissions (
      role_id          BINARY(16)  NOT NULL,
      permission_code  VARCHAR(64) NOT NULL,
      PRIMARY KEY (role_id, permission_code),
      KEY idx_role_permissions_code (permission_code),
      CONSTRAINT fk_role_permissions_role
        FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
      CONSTRAINT fk_role_permissions_permission
        FOREIGN KEY (permission_code) REFERENCES permissions (code) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // org_members — many-to-many by design (spec §5). The role is per membership,
  // so one login is Owner of their own books and Read-only/Accountant on a
  // client's.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE org_members (
      org_id            BINARY(16)  NOT NULL,
      user_id           BINARY(16)  NOT NULL,
      role_id           BINARY(16)  NOT NULL,
      invited_by_user_id BINARY(16) NULL,
      created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (org_id, user_id),
      KEY idx_org_members_user (user_id),
      KEY idx_org_members_org_role (org_id, role_id),
      CONSTRAINT fk_org_members_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_org_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_org_members_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT,
      CONSTRAINT fk_org_members_inviter
        FOREIGN KEY (invited_by_user_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // org_invites — invite-by-email (spec §5). The token is stored hashed for the
  // same reason session and API-key material is: a database read must not yield
  // a usable credential.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE org_invites (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      email              VARCHAR(320) NOT NULL,
      role_id            BINARY(16)   NOT NULL,
      token_hash         CHAR(64)     NOT NULL,
      invited_by_user_id BINARY(16)   NULL,
      expires_at         DATETIME(3)  NOT NULL,
      accepted_at        DATETIME(3)  NULL,
      accepted_by_user_id BINARY(16)  NULL,
      revoked_at         DATETIME(3)  NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_org_invites_token (token_hash),
      UNIQUE KEY uq_org_invites_org_id (org_id, id),
      KEY idx_org_invites_org_email (org_id, email),
      CONSTRAINT fk_org_invites_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_org_invites_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // api_keys — spec §5: `org_id NOT NULL`, and its own `role_id` rather than
  // inheriting the issuer's. An issuer who is later demoted must not leave
  // behind a key that still carries their old authority.
  //
  // Ships in M1 with no authentication path (see ROADMAP "Explicitly out of M1").
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE api_keys (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      role_id            BINARY(16)   NOT NULL,
      name               VARCHAR(120) NOT NULL,
      key_prefix         VARCHAR(16)  NOT NULL,
      key_hash           CHAR(64)     NOT NULL,
      created_by_user_id BINARY(16)   NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_used_at       DATETIME(3)  NULL,
      revoked_at         DATETIME(3)  NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_api_keys_hash (key_hash),
      UNIQUE KEY uq_api_keys_org_id (org_id, id),
      KEY idx_api_keys_org_prefix (org_id, key_prefix),
      CONSTRAINT fk_api_keys_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_api_keys_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT,
      CONSTRAINT fk_api_keys_creator
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // sessions — NOT in spec §7's table list; added by ROADMAP D-03.
  //
  // Server-side sessions rather than signed stateless cookies, so revocation is
  // immediate. That is the same reasoning spec §5 applies to OAuth tokens
  // ("opaque tokens with DB lookup for instant revocation"), and a stateless
  // cookie that stays valid until expiry after a user is removed from an org is
  // exactly the failure that reasoning exists to prevent.
  //
  // `active_org_id` is the org switcher's state, and it is only ever a *hint*.
  //
  // The tempting constraint is a composite foreign key to
  // `org_members (org_id, user_id)`, so a session could not name an org the user
  // had been removed from. MySQL will not accept it: the key would need
  // `ON DELETE SET NULL`, and that nulls every column in the key — including
  // `user_id`, which is NOT NULL.
  //
  // It would have been belt-and-braces regardless. Authorization re-resolves
  // `org_members` on every request already, and has to: a role changed
  // mid-session would otherwise keep its old permissions until the cookie
  // expired. So the security property lives where it must, and this column is a
  // preference to be re-validated on read, never trusted alone. The FK to `orgs`
  // only stops it naming a deleted org.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE sessions (
      id             BINARY(16)   NOT NULL,
      user_id        BINARY(16)   NOT NULL,
      token_hash     CHAR(64)     NOT NULL,
      active_org_id  BINARY(16)   NULL,
      ip_address     VARBINARY(16) NULL,
      user_agent     VARCHAR(512) NULL,
      created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_seen_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expires_at     DATETIME(3)  NOT NULL,
      revoked_at     DATETIME(3)  NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_sessions_token (token_hash),
      KEY idx_sessions_user (user_id),
      KEY idx_sessions_expires (expires_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_sessions_active_org
        FOREIGN KEY (active_org_id) REFERENCES orgs (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await seedPermissions(db);
  await seedSystemRoles(db);
}

/**
 * The fixed permission catalog (spec §5).
 *
 * Seeded whole, including permissions whose enforcement points arrive in later
 * milestones. The catalog is fixed and the six seeded roles are defined in terms
 * of it, so seeding only the M1 subset would leave AP-only and AR-only as empty
 * bundles — roles that grant nothing and mean nothing. Permissions with no
 * enforcement point yet are marked below.
 */
async function seedPermissions(db: MigrationDb): Promise<void> {
  await sql`
    INSERT INTO permissions (code, description) VALUES
      -- Enforced from M1
      ('orgs.read',              'View organization settings'),
      ('orgs.write',             'Change organization settings'),
      ('members.read',           'View organization members'),
      ('members.write',          'Invite, remove, and re-role members'),
      ('roles.read',             'View roles and their permissions'),
      ('accounts.read',          'View the chart of accounts'),
      ('accounts.write',         'Create and modify accounts'),
      ('periods.read',           'View fiscal periods'),
      ('periods.write',          'Create and modify fiscal periods'),
      ('periods.close',          'Close a fiscal period'),
      ('periods.reopen',         'Reopen a closed fiscal period'),
      ('journals.read',          'View journal entries'),
      ('journals.post',          'Post journal entries'),
      ('journals.reverse',       'Post reversing entries'),
      ('reports.read',           'Run financial reports'),
      ('api_keys.read',          'View API keys'),
      ('api_keys.write',         'Create and revoke API keys'),
      -- Catalog only in M1; enforcement arrives with the named milestone
      ('contacts.read',          'View customers and vendors (M2)'),
      ('contacts.write',         'Create and modify customers and vendors (M2)'),
      ('dimensions.read',        'View dimensions and their values (M2)'),
      ('dimensions.write',       'Create and modify dimensions (M2)'),
      ('invoices.read',          'View customer invoices (M3)'),
      ('invoices.write',         'Create and modify customer invoices (M3)'),
      ('invoices.void',          'Void customer invoices (M3)'),
      ('invoices.send',          'Send an invoice to its customer (INV)'),
      ('credit_notes.read',      'View credit notes (M3)'),
      ('credit_notes.write',     'Create and modify credit notes (M3)'),
      ('payments_received.read', 'View customer payments (M3)'),
      ('payments_received.write','Record and apply customer payments (M3)'),
      ('bills.read',             'View vendor bills (M3)'),
      ('bills.write',            'Create and modify vendor bills (M3)'),
      ('bills.void',             'Void vendor bills (M3)'),
      ('vendor_credits.read',    'View vendor credits (M3)'),
      ('vendor_credits.write',   'Create and modify vendor credits (M3)'),
      ('payments_made.read',     'View vendor payments (M3)'),
      ('payments_made.write',    'Record and apply vendor payments (M3)'),
      ('tax_rates.read',         'View tax rates (M3)'),
      ('tax_rates.write',        'Create and modify tax rates (M3)'),
      ('branding.read',          'View the org invoice letterhead (INV)'),
      ('branding.write',         'Change the org invoice letterhead and logo (INV)'),
      ('banking.read',           'View bank accounts and transactions (M4)'),
      ('banking.import',         'Import bank statement files (M4)'),
      ('banking.match',          'Match and split bank transactions (M4)'),
      ('banking.reconcile',      'Complete a reconciliation session (M4)'),
      ('banking.reopen',         'Reopen a completed reconciliation (M4)'),
      ('integrations.read',      'View third-party integrations (M5)'),
      ('integrations.write',     'Authorize and revoke third-party integrations (M5)'),
      ('agents.review',          'Review and approve scheduled agent proposals (M5)'),
      ('processing.read',        'View payment processor connections and events (PAY)'),
      ('processing.write',       'Connect and manage payment processors (PAY)'),
      ('workflows.read',         'View automations (M6)'),
      ('workflows.write',        'Create and modify automations (M6)'),
      ('workflows.activate',     'Activate an automation (M6)'),
      ('pending_payments.read',  'View the Pay Bills queue (PB)'),
      ('pending_payments.write', 'Build, edit, and cancel pending payments (PB)'),
      ('disbursements.issue',    'Release a pending payment — post it and cut the check (PB)'),
      ('recurring_journals.read',  'View recurring journal templates (L)'),
      ('recurring_journals.write', 'Create and modify recurring journal templates (L)'),
      ('fixed_assets.read',        'View fixed assets and depreciation schedules (L)'),
      ('fixed_assets.write',       'Register, depreciate, and dispose fixed assets (L)'),
      ('purchase_orders.read',     'View purchase orders (M)'),
      ('purchase_orders.write',    'Create, approve, send, and convert purchase orders (M)'),
      ('estimates.read',           'View estimates and quotes (M)'),
      ('estimates.write',          'Create, approve, send, and convert estimates (M)'),
      ('expenses.read',            'View employee expenses (M)'),
      ('expenses.write',           'Enter and modify employee expenses (M)'),
      ('expenses.approve',         'Approve an employee expense into a payable (M)'),
      ('budgets.read',             'View budgets and budget-vs-actual (N)'),
      ('budgets.write',            'Enter and import budget figures (N)')
  `.execute(db);
}

/**
 * The six seeded system roles (spec §5).
 *
 * IDs are fixed reserved UUIDs rather than generated, so `org_members.role_id`
 * is stable across environments and a fresh database and a migrated one agree.
 * They are shaped as valid v4 UUIDs but obviously reserved.
 *
 * Bundles are expressed as set operations over the catalog rather than long
 * literal lists, so a permission added to the catalog in a later migration lands
 * in the right roles by construction instead of by someone remembering.
 */
async function seedSystemRoles(db: MigrationDb): Promise<void> {
  await sql`
    INSERT INTO roles (id, org_id, code, name, description, is_system) VALUES
      (UUID_TO_BIN('00000000-0000-4000-8000-000000000001', 0), NULL, 'owner',
        'Owner', 'Full control, including members and API keys.', 1),
      (UUID_TO_BIN('00000000-0000-4000-8000-000000000002', 0), NULL, 'bookkeeper',
        'Bookkeeper', 'Full access to the books; no org administration.', 1),
      (UUID_TO_BIN('00000000-0000-4000-8000-000000000003', 0), NULL, 'ap_only',
        'AP only', 'Vendor bills, credits, and payments.', 1),
      (UUID_TO_BIN('00000000-0000-4000-8000-000000000004', 0), NULL, 'ar_only',
        'AR only', 'Customer invoices, credit notes, and payments.', 1),
      (UUID_TO_BIN('00000000-0000-4000-8000-000000000005', 0), NULL, 'read_only',
        'Read-only / Accountant', 'Read everything; change nothing.', 1),
      (UUID_TO_BIN('00000000-0000-4000-8000-000000000006', 0), NULL, 'approver',
        'Approver', 'Read everything, and review scheduled agent proposals.', 1)
  `.execute(db);

  // Owner: the entire catalog.
  await sql`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
    WHERE r.is_system = 1 AND r.code = 'owner'
  `.execute(db);

  // Read-only / Accountant: every read, and reports. Explicitly not periods.*
  // beyond read — closing a period is a change even though it writes no journal.
  await sql`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
    WHERE r.is_system = 1 AND r.code = 'read_only'
      AND (p.code LIKE '%.read' OR p.code = 'reports.read')
      AND p.code <> 'api_keys.read'
  `.execute(db);

  // Approver: read-only plus the agent review queue (spec §6). Approving a
  // proposal posts it, so journals.post is required — the point of the role is
  // to be the one who can turn a proposal into a posting.
  await sql`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
    WHERE r.is_system = 1 AND r.code = 'approver'
      AND (
        (p.code LIKE '%.read' AND p.code <> 'api_keys.read')
        OR p.code IN ('reports.read', 'agents.review', 'journals.post', 'expenses.approve')
      )
  `.execute(db);

  // Bookkeeper: the whole catalog except organization administration. A
  // bookkeeper runs the books; they do not manage who has access or mint
  // credentials. `processing.write` joins `integrations.write` in the
  // exclusion for the same reason: connecting a processor hands its secret
  // key and webhook secret to the secrets provider (D-101, D-83), which is an
  // organization-administration act and not a bookkeeping one.
  //
  // `disbursements.issue` is excluded too, and for a different reason than the
  // others: it is the release half of Pay Bills' separation of duties (D-109),
  // seeded to *owner only*. The bookkeeper keeps the queue keys (`pending_payments.*`,
  // which the catch-all grants) — they build the Pay Bills queue — but releasing it,
  // posting the payment and cutting the check, is the controller's act. Without this
  // line the catch-all would hand a bookkeeper both halves and collapse the split.
  await sql`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
    WHERE r.is_system = 1 AND r.code = 'bookkeeper'
      AND p.code NOT IN (
        'orgs.write', 'members.write', 'api_keys.read', 'api_keys.write',
        'integrations.write', 'processing.write', 'workflows.activate',
        'disbursements.issue'
      )
  `.execute(db);

  // AP only: the payables side, plus the reads needed to do that job — and
  // `journals.post`/`journals.reverse`, because approving, voiding and paying a
  // bill all post through the ledger kernel, and a role that exists to enter AP
  // that cannot finish what it entered is a role that does nothing (OB-093).
  //
  // The Pay Bills queue keys (`pending_payments.read`/`.write`) belong here — the AP
  // clerk builds the queue — but `disbursements.issue` deliberately does not (D-109):
  // an `ap_only` user can queue a payment and cannot release it, which is the
  // separation of duties made real rather than architectural. Issue still needs
  // `payments_made.write`/`journals.post` transitively (it calls `recordPayment`), so
  // `disbursements.issue` is the one distinguishing gate the clerk lacks.
  await sql`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
    WHERE r.is_system = 1 AND r.code = 'ap_only'
      AND p.code IN (
        'bills.read', 'bills.write', 'bills.void',
        'vendor_credits.read', 'vendor_credits.write',
        'payments_made.read', 'payments_made.write',
        'pending_payments.read', 'pending_payments.write',
        'contacts.read', 'contacts.write',
        'accounts.read', 'periods.read', 'journals.read',
        'journals.post', 'journals.reverse',
        'tax_rates.read', 'dimensions.read', 'reports.read',
        -- Procure-to-pay (M): the AP clerk raises purchase orders and enters employee
        -- expenses. expenses.approve is withheld — approving an expense into a payable
        -- is a separate duty (the disbursements.issue split, applied to expenses).
        'purchase_orders.read', 'purchase_orders.write',
        'expenses.read', 'expenses.write'
      )
  `.execute(db);

  // AR only: the receivables mirror of AP only, including the same
  // `journals.post`/`journals.reverse` so an AR clerk can approve, void and
  // record a receipt against the invoices they enter (OB-093).
  await sql`
    INSERT INTO role_permissions (role_id, permission_code)
    SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
    WHERE r.is_system = 1 AND r.code = 'ar_only'
      AND p.code IN (
        'invoices.read', 'invoices.write', 'invoices.void', 'invoices.send',
        'credit_notes.read', 'credit_notes.write',
        'payments_received.read', 'payments_received.write',
        'contacts.read', 'contacts.write',
        'accounts.read', 'periods.read', 'journals.read',
        'journals.post', 'journals.reverse',
        'tax_rates.read', 'dimensions.read', 'reports.read',
        -- Procure-to-pay (M): the AR clerk raises estimates/quotes, the sales mirror
        -- of the AP clerk's purchase orders.
        'estimates.read', 'estimates.write'
      )
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order so foreign keys never block a drop.
  await sql`DROP TABLE IF EXISTS sessions`.execute(db);
  await sql`DROP TABLE IF EXISTS api_keys`.execute(db);
  await sql`DROP TABLE IF EXISTS org_invites`.execute(db);
  await sql`DROP TABLE IF EXISTS org_members`.execute(db);
  await sql`DROP TABLE IF EXISTS role_permissions`.execute(db);
  await sql`DROP TABLE IF EXISTS roles`.execute(db);
  await sql`DROP TABLE IF EXISTS permissions`.execute(db);
  await sql`DROP TABLE IF EXISTS orgs`.execute(db);
  await sql`DROP TABLE IF EXISTS users`.execute(db);
}
