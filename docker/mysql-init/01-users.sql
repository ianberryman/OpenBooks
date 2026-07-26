-- Dual database users (spec §12; ROADMAP gate A6).
--
-- WHY: spec §12 requires that the user the application connects as holds no
-- UPDATE or DELETE grant on `journals` or `journal_lines`, so ledger
-- immutability is enforced by MySQL rather than by application discipline. Spec
-- §11 requires that be tested *as the app user* — a test that connects as root
-- proves nothing.
--
--   openbooks_migrator  DDL. Used only by OPENBOOKS_ROLE=migrate.
--   openbooks_app       DML. Used by the api and worker roles, and by tests.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THIS SPLIT MUST BE REPRODUCED IDENTICALLY IN THREE OTHER PLACES:
--   * testcontainers provisioning        (OB-014)
--   * RDS bootstrap                      (OB-007)
--   * the ledger DDL migration           (OB-011)
-- A divergence — most likely tests connecting as root, or RDS granting the app
-- user schema-wide DML — makes the immutability assertion pass locally and mean
-- nothing in production. That is the failure mode this comment exists to
-- prevent; it is listed as a named risk in ROADMAP.md.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Credentials here are literals: MySQL's entrypoint does not expand environment
-- variables in *.sql. They match the DATABASE_PASSWORD and
-- DATABASE_MIGRATOR_PASSWORD defaults in .env.example and docker-compose.yml, so
-- `cp .env.example .env && docker compose up` works untouched. Changing either
-- password in .env means changing it here too *and* deleting the `mysql-data`
-- volume, because these scripts run only against an empty data directory. If you
-- forget, MySQL rejects the connection with "Access denied for user
-- 'openbooks_app'" — loud, not silent.
--
-- The same applies to the schema name: `openbooks` below must match
-- DATABASE_NAME. The MySQL entrypoint creates the schema from MYSQL_DATABASE, so
-- a changed DATABASE_NAME produces the right schema with none of the grants
-- below attached to it.
--
-- Hosted deployments never run this file; OB-007 provisions the same two users
-- from Secrets Manager.

-- Redundant against the entrypoint's MYSQL_DATABASE, and deliberately so: it
-- makes this file runnable on its own against any MySQL 8 instance, which is how
-- OB-014's testcontainers setup and OB-007's RDS bootstrap should consume it.
CREATE DATABASE IF NOT EXISTS `openbooks`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;


-- ── openbooks_migrator ───────────────────────────────────────────────────────
-- Scoped to the `openbooks` schema rather than *.*: the migrator has no
-- business outside it, and holds no global privilege, so it cannot CREATE USER
-- or reach another database.
--
-- WITH GRANT OPTION is required, not incidental. OB-011 must adjust
-- openbooks_app's table privileges from inside a migration, and MySQL only
-- permits granting or revoking a privilege you hold *and* hold GRANT OPTION on.
-- Without it the ledger migration fails with ERROR 1044.
CREATE USER IF NOT EXISTS 'openbooks_migrator'@'%'
  IDENTIFIED BY 'change-me-migrator';
GRANT ALL PRIVILEGES ON `openbooks`.* TO 'openbooks_migrator'@'%' WITH GRANT OPTION;


-- ── openbooks_app ────────────────────────────────────────────────────────────
-- SELECT and INSERT schema-wide; UPDATE and DELETE deliberately absent.
--
-- The absence is the whole mechanism, and it is shaped by a hard MySQL
-- constraint that is worth stating explicitly because the obvious alternative
-- looks correct and is not:
--
--   MySQL has no DENY. Grants are purely additive, and a table-level REVOKE
--   against a schema-level grant fails with
--     ERROR 1147: There is no such grant defined for user ... on table ...
--   MySQL 8's `partial_revokes` does not rescue this either — partial revokes
--   restrict a *global* privilege at *schema* granularity only, never at table
--   granularity. Verified empirically against mysql:8.4.
--
-- So `GRANT UPDATE, DELETE ON openbooks.* TO openbooks_app` followed by a
-- revoke on the journal tables is not implementable. The privilege that must
-- not exist has to never be granted, which means UPDATE and DELETE are granted
-- per table, by the migration that creates each table:
--
--   GRANT UPDATE, DELETE ON `openbooks`.`<table>` TO 'openbooks_app'@'%';
--
-- issued for every mutable table (OB-010, OB-012, and later waves) and never
-- for `journals` or `journal_lines`. INSERT on those two comes from the
-- schema-wide grant below, which is correct: appending to the ledger is allowed,
-- rewriting it is not. Reversal is a new journal carrying
-- `reverses_journal_id`, so no existing journal row is ever written (D-02).
--
-- A missed grant fails loudly at runtime (ERROR 1142) rather than silently, but
-- OB-008 should still consider a post-migration step that grants UPDATE/DELETE
-- on every table in the schema except the two journal tables, so the invariant
-- is maintained in one place instead of once per migration.
CREATE USER IF NOT EXISTS 'openbooks_app'@'%'
  IDENTIFIED BY 'change-me-app';
GRANT SELECT, INSERT ON `openbooks`.* TO 'openbooks_app'@'%';

FLUSH PRIVILEGES;
