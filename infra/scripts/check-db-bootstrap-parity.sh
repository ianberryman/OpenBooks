#!/usr/bin/env bash
#
# Two guards on the database bootstrap SQL.
#
# 1. PARITY. ROADMAP records "the dual-DB-user requirement touches four environments ... a
#    mismatch makes A6 pass locally and mean nothing in production" as a risk. This is the
#    mechanical answer: the grant split is one file, compared byte-for-byte.
#
# 2. SHELL SAFETY of 01-users-rds.sql. That file is streamed through an UNQUOTED shell
#    heredoc by the db-bootstrap ECS task so the two generated passwords expand, which means
#    the shell reads the whole file — including its comments. A backtick or a $(...) anywhere
#    in it becomes command substitution executed as the RDS master user's bootstrap process.
#    This is not a theoretical concern: a backtick in a prose comment broke it once already.
#
# Intended to run in CI (OB-027) alongside the other drift gates.
#
# Exit codes: 0 clean (parity check skipped with a warning if the Compose copy does not
# exist yet), 1 diverged or unsafe.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
canonical="${repo_root}/infra/db-bootstrap/02-grants.sql"
users="${repo_root}/infra/db-bootstrap/01-users-rds.sql"
compose="${repo_root}/docker/mysql-init/02-grants.sql"

if [[ ! -f "${canonical}" ]]; then
  echo "FAIL: canonical grant file is missing: ${canonical}" >&2
  exit 1
fi

# --- guard 2: shell safety --------------------------------------------------

status=0

if grep -n '`' "${users}" >&2; then
  echo "FAIL: 01-users-rds.sql contains a backtick (lines above)." >&2
  echo "      It is read by an unquoted shell heredoc, so a backtick is command" >&2
  echo "      substitution — in SQL or in a comment alike. Remove it." >&2
  status=1
fi

if grep -n '\$(' "${users}" >&2; then
  echo "FAIL: 01-users-rds.sql contains \$( (lines above) — command substitution." >&2
  status=1
fi

# Only the two intended placeholders may appear as shell variable references.
unexpected="$(grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*\}?' "${users}" |
  grep -vxE '\$\{(MIGRATOR_PASSWORD|APP_PASSWORD)\}' || true)"

if [[ -n "${unexpected}" ]]; then
  echo "FAIL: 01-users-rds.sql references unexpected shell variables:" >&2
  printf '%s\n' "${unexpected}" | sort -u >&2
  echo "      Only \${MIGRATOR_PASSWORD} and \${APP_PASSWORD} are injected." >&2
  status=1
fi

if [[ "${status}" -eq 0 ]]; then
  echo "OK: 01-users-rds.sql is safe for unquoted heredoc expansion."
else
  exit 1
fi

# --- guard 1: parity --------------------------------------------------------

# OB-004 owns docker/mysql-init/ and may not have landed yet. Warn rather than fail,
# so this script can be wired into CI before its counterpart exists — but say so
# loudly, because a permanently-absent Compose copy means A6 is untested.
if [[ ! -f "${compose}" ]]; then
  echo "WARN: ${compose#"${repo_root}/"} does not exist yet (OB-004 owns it)."
  echo "WARN: copy infra/db-bootstrap/02-grants.sql there verbatim; parity is unchecked until then."
  exit 0
fi

if cmp -s "${canonical}" "${compose}"; then
  echo "OK: grant split is identical in Compose and RDS bootstrap."
  exit 0
fi

echo "FAIL: the shared grant split has diverged between environments." >&2
echo "      A6 (UPDATE/DELETE on journals denied as openbooks_app) cannot be trusted" >&2
echo "      to mean the same thing locally and in production while this differs." >&2
echo >&2
diff -u "${canonical}" "${compose}" >&2 || true
exit 1
