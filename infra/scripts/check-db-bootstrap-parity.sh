#!/usr/bin/env bash
#
# Guards the one file that must be identical in every environment.
#
# ROADMAP records "the dual-DB-user requirement touches four environments ... a
# mismatch makes A6 pass locally and mean nothing in production" as a risk. This is
# the mechanical answer to it: the grant split is one file, compared byte-for-byte.
# Intended to run in CI (OB-027) alongside the other drift gates.
#
# Exit codes: 0 in parity (or the Compose copy does not exist yet), 1 diverged.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
canonical="${repo_root}/infra/db-bootstrap/02-grants.sql"
compose="${repo_root}/docker/mysql-init/02-grants.sql"

if [[ ! -f "${canonical}" ]]; then
  echo "FAIL: canonical grant file is missing: ${canonical}" >&2
  exit 1
fi

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
