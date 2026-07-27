#!/usr/bin/env bash
#
# The B9 gate — OB-056.
#
# ROADMAP B9: "No component names a raw colour, spacing, or radius — tokens only,
# lint-enforced." D-24 says why the token layer is a build gate rather than a
# convention, and says explicitly that `openbooks/no-raw-color` is "the same
# construction as `openbooks/no-float-money` and for the same reason".
#
# `yarn lint` already runs the rule, so why does this script exist? Because the rule
# being *enforced* and the rule being *wired to the web sources* are two different
# facts, and only the first has a test. `packages/eslint-plugin/test/no-raw-color.test.ts`
# proves the rule reports on a hex; nothing proved that eslint.config.js still binds it
# to `packages/web/**/*.{ts,tsx}` at severity `error`. Delete that config block and the
# rule tests still pass, `yarn lint` still passes, and B9 quietly stops being held —
# which is the failure mode this ticket exists to close, since a criterion nobody runs
# is not one.
#
# So: assert the binding, then run the rule. Two steps, one command.
#
# Invoked as `yarn lint:tokens`, and as the "Token layer (B9)" step of the `static` job.
# ESLint is called through node_modules/.bin rather than through Yarn deliberately: the
# pinned Yarn release is named in exactly one place under .github/ (actions/setup), and
# naming it here as well would be a second opinion about the version (D-10).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ESLINT=node_modules/.bin/eslint
WEB_SOURCES='packages/web/**/*.{ts,tsx}'

if [[ ! -x "${ESLINT}" ]]; then
  echo "error: ${ESLINT} not found. Run \`yarn install\` first." >&2
  exit 1
fi

# Any committed component will do — the question is what config ESLint resolves for a
# file in the web source tree, not what it resolves for one particular name. Chosen by
# glob rather than hardcoded so renaming App.tsx does not break the gate for a reason
# that has nothing to do with tokens. Test files are excluded because eslint.config.js
# relaxes rules for them, and a relaxation is exactly what this must not sample.
PROBE="$(find packages/web/src -name '*.tsx' ! -name '*.test.tsx' | sort | head -1)"

if [[ -z "${PROBE}" ]]; then
  echo "error: no component found under packages/web/src to resolve a config for." >&2
  exit 1
fi

echo "Token layer (B9): resolving ESLint config for ${PROBE}"

"${ESLINT}" --print-config "${PROBE}" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    const probe = process.argv[1];
    const rules = JSON.parse(raw).rules ?? {};
    const entry = rules["openbooks/no-raw-color"];

    if (entry === undefined) {
      console.error(
        `B9 FAILED: openbooks/no-raw-color is not configured for ${probe}.\n` +
          "eslint.config.js no longer binds the token rule to the web sources, so a raw\n" +
          "hex, rgb() or arbitrary-value colour would lint clean. See ROADMAP D-24."
      );
      process.exit(1);
    }

    // ESLint normalises severity to a number in --print-config output. `warn` is a
    // failure here as surely as `off` is: D-24 makes the token layer a build gate, and
    // a warning does not fail a build.
    const severity = Array.isArray(entry) ? entry[0] : entry;
    if (severity !== 2) {
      console.error(
        `B9 FAILED: openbooks/no-raw-color resolves at severity ${severity} for ${probe},\n` +
          "not 2 (error). D-24 makes the token layer a build gate; a warning is not one."
      );
      process.exit(1);
    }

    console.log("Token layer (B9): openbooks/no-raw-color is bound at severity error.");
  });
' "${PROBE}"

# The rule itself, over the web sources, under a step named for the criterion it holds.
# This is a strict subset of `yarn lint` (~3s of it) and is duplicated on purpose: a raw
# colour should fail in a place whose name says B9, not as one line in a repo-wide lint
# run. The same argument the ci.yml `static` job already makes for splitting its four
# checks into four steps.
echo "Token layer (B9): linting ${WEB_SOURCES}"
"${ESLINT}" "${WEB_SOURCES}"
echo "Token layer (B9): no component names a raw colour."
