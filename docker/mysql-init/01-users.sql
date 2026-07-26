-- Dual database users for Compose and testcontainers (spec §12; ROADMAP gate A6).
--
-- WHY: spec §12 requires the user the application connects as to hold no UPDATE
-- or DELETE grant on `journals` or `journal_lines`, so ledger immutability is
-- enforced by MySQL rather than by application discipline. Spec §11 requires that
-- be tested *as the app user* — a test that connects as root proves nothing.
--
--   openbooks_migrator  DDL. Used only by OPENBOOKS_ROLE=migrate.
--   openbooks_app       DML. Used by the api and worker roles, and by tests.
--
-- This file creates the identities only. The grant split — which is the part that
-- must not diverge between environments — lives in `02-grants.sql`, which is a
-- byte-identical copy of `infra/db-bootstrap/02-grants.sql` and is verified as
-- such by `infra/scripts/check-db-bootstrap-parity.sh`. Read that file for why
-- the app user is granted SELECT and INSERT schema-wide and nothing else.
--
-- The split into two files exists precisely so parity is checkable: passwords are
-- environment-specific and cannot be shared with RDS, while the grants are the
-- security property and must be. Keeping both in one file meant the byte
-- comparison could never be made, and the parity gate passed vacuously.
--
-- MySQL runs `*.sql` here in filename order, so users exist before `02-grants.sql`
-- references them.
--
-- Credentials below are literals: MySQL's entrypoint does not expand environment
-- variables in *.sql. They match the DATABASE_PASSWORD and
-- DATABASE_MIGRATOR_PASSWORD defaults in .env.example and docker-compose.yml, so
-- `cp .env.example .env && docker compose up` works untouched. Changing either
-- password in .env means changing it here too *and* deleting the `mysql-data`
-- volume, because these scripts run only against an empty data directory. If you
-- forget, MySQL rejects the connection with "Access denied for user
-- 'openbooks_app'" — loud, not silent.
--
-- Hosted deployments never run this file; OB-007 provisions the same two users
-- from Secrets Manager via `infra/db-bootstrap/01-users-rds.sql`.

-- ── openbooks_migrator ───────────────────────────────────────────────────────
-- Scoped to the `openbooks` schema rather than *.*: the migrator has no business
-- outside it, and holds no global privilege, so it cannot CREATE USER or reach
-- another database. Its GRANT OPTION is issued in `02-grants.sql`.
CREATE USER IF NOT EXISTS 'openbooks_migrator'@'%'
  IDENTIFIED BY 'change-me-migrator';

-- ── openbooks_app ────────────────────────────────────────────────────────────
CREATE USER IF NOT EXISTS 'openbooks_app'@'%'
  IDENTIFIED BY 'change-me-app';

-- No FLUSH PRIVILEGES. CREATE USER and GRANT update the in-memory privilege
-- tables directly; the flush is only needed after writing `mysql.*` by hand. It
-- also requires the global RELOAD privilege, which the migrator deliberately does
-- not hold and managed MySQL often will not grant — so issuing it here would make
-- this file unrunnable in the one environment where it matters most.
