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
-- heredoc so the shell substitutes them from the ECS task's injected secrets; the values
-- therefore never appear in the task definition, in CloudTrail, or in process arguments.
--
-- CONSEQUENCE, AND IT IS SHARP: because the shell reads this file, this file must contain
-- no backtick and no dollar-parenthesis sequence anywhere — not in SQL, not in a comment.
-- Either one is command substitution and the bootstrap task will try to execute it. That is
-- not hypothetical; a backtick in a prose comment broke this file once already. Leave schema
-- and column identifiers unquoted, or restructure to avoid needing to quote them.
--
-- infra/scripts/check-db-bootstrap-parity.sh enforces this so it cannot come back. The
-- shared 02-grants.sql is exempt because it goes through a QUOTED heredoc, which is why it
-- can use backtick-quoted identifiers freely.
--
-- The two placeholders below are the only shell references permitted here. Substitution
-- happens once and its result is not re-scanned, so a password containing $, &, % or a
-- backtick is handled correctly.
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
