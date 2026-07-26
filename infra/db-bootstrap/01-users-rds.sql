-- OpenBooks RDS user creation. Runs immediately before the shared 02-grants.sql.
--
-- This file is the HOSTED counterpart of docker/mysql-init/01-users-compose.sql and
-- is deliberately NOT parity-checked against it: the two legitimately differ, because
-- Compose sets fixed local development passwords in plain text while RDS reads
-- Terraform-generated passwords out of Secrets Manager. Everything that carries the
-- immutability guarantee lives in 02-grants.sql, which IS parity-checked.
--
-- ${MIGRATOR_PASSWORD} and ${APP_PASSWORD} are POSIX shell variables, not Terraform
-- interpolations. The db-bootstrap ECS task streams this file through an unquoted
-- heredoc so the shell substitutes them from the container's `secrets` environment;
-- the values therefore never appear in the task definition, in CloudTrail, or in
-- process arguments. This is also why this file contains no backtick-quoted
-- identifiers: in an unquoted heredoc a backtick would be command substitution.
--
-- ALTER USER is unconditional so that re-running the bootstrap after a Terraform
-- password rotation converges rather than silently leaving the old password in place.
-- The whole file is idempotent and safe to re-run.
--
-- REQUIRE SSL pairs with require_secure_transport=1 in the parameter group. If the
-- application connects without TLS it will be refused at login. See the README's
-- "never been applied" section — this is the single most likely first-apply breakage.

CREATE USER IF NOT EXISTS 'openbooks_migrator'@'%' IDENTIFIED BY '${MIGRATOR_PASSWORD}' REQUIRE SSL;
ALTER USER 'openbooks_migrator'@'%' IDENTIFIED BY '${MIGRATOR_PASSWORD}' REQUIRE SSL;

CREATE USER IF NOT EXISTS 'openbooks_app'@'%' IDENTIFIED BY '${APP_PASSWORD}' REQUIRE SSL;
ALTER USER 'openbooks_app'@'%' IDENTIFIED BY '${APP_PASSWORD}' REQUIRE SSL;
