-- OpenBooks canonical database grant split.
--
-- ROADMAP "Two database users" and spec §12: `openbooks_app` must be unable to
-- UPDATE or DELETE `journals` / `journal_lines` at the *database grant* level, so
-- immutability is enforced by MySQL rather than by application discipline. Spec §11
-- requires that to be tested as the app user, which only means something if the
-- hosted database has these users too — hence this file is shared, byte-for-byte,
-- between environments.
--
-- THIS FILE IS SHARED AND MUST NOT DIVERGE.
--   Compose / testcontainers : docker/mysql-init/02-grants.sql  (OB-004, OB-014)
--   Hosted RDS               : run by the db-bootstrap ECS task (OB-007)
-- `infra/scripts/check-db-bootstrap-parity.sh` fails if the two copies differ; it
-- is intended to run in CI (OB-027). Because parity is enforced by byte comparison,
-- this file contains no placeholders — the database name is the fixed product
-- constant `openbooks`, not a variable, and user passwords are set in the
-- environment-specific `01-users-*.sql` that runs before this file.
--
-- WHY DATABASE-LEVEL SELECT/INSERT AND NOTHING ELSE:
-- MySQL privileges are additive and a database-level grant cannot be revoked at
-- table level. `GRANT UPDATE ON openbooks.*` followed by
-- `REVOKE UPDATE ON openbooks.journals` leaves the database-level UPDATE intact and
-- the journal still mutable — a REVOKE that appears to work and does nothing. So
-- `openbooks_app` is never granted UPDATE or DELETE at database level. Migrations
-- (OB-011) grant those two privileges *per table*, to the tables that are legitimately
-- mutable, and simply never to the journal tables. The privilege is absent rather
-- than revoked.
--
-- The trade-off: every future migration that introduces a mutable table must also
-- grant table-level UPDATE/DELETE on it to `openbooks_app`. Forgetting fails loudly
-- and safely — the write is denied and the test for it fails — which is the correct
-- direction for this failure to point.

CREATE DATABASE IF NOT EXISTS `openbooks` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Migrator: full DDL over the OpenBooks schema only. WITH GRANT OPTION is required
-- so that migrations, running as this user, can issue the narrow table-level
-- UPDATE/DELETE grants to `openbooks_app` described above.
--
-- This does mean the migrator could grant itself or the app anything within
-- `openbooks`. That is accepted: the migrator credential exists only in the
-- `migrate` task's environment, the application process never holds it, and the
-- alternative (the RDS master user running every future grant) would put master
-- credentials in the deploy path.
GRANT ALL PRIVILEGES ON `openbooks`.* TO 'openbooks_migrator'@'%' WITH GRANT OPTION;

-- Application: read and append across the schema. No UPDATE, no DELETE, no DDL,
-- no DROP, no ALTER, no CREATE TEMPORARY TABLES, no LOCK TABLES, no REFERENCES.
GRANT SELECT, INSERT ON `openbooks`.* TO 'openbooks_app'@'%';

-- Deliberately absent, for the record: `FLUSH PRIVILEGES` (CREATE USER and GRANT
-- update the in-memory tables directly, and the RDS master user's RELOAD privilege
-- is not something to depend on), and any GRANT to the RDS master user — the master
-- user is neither of these two identities and no application or migration path uses it.
