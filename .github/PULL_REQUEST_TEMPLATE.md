<!-- Thanks for contributing to OpenBooks. Keep this checklist — it maps to the gate in CONTRIBUTING.md. -->

## What & why

<!-- What does this change, and what does it close? -->

Closes #

## Verified

<!-- Which gates did you run, and what passed? `yarn check` is the whole gate. -->

- [ ] `yarn check` passes locally on a clean checkout (format, lint, lint:tokens, lint:deps, typecheck, drift, build, test).
- [ ] **Ledger change:** property/invariant tests cover it, and any correction is a reversing entry — no update/delete path.
- [ ] **Schema / route / permission change:** `generated.ts`, `openapi.json`, and the web client are regenerated, and the pinned tripwire tests (permission-matrix, route-table, cross-org) are updated.
- [ ] Tests run against real MySQL via testcontainers — no SQLite, no mocks.
- [ ] No new `any` in `src`, no `console.*`, no `process.env` outside `src/config/`.

## Notes for reviewers

<!-- Anything non-obvious: a measurement you took, a fork you resolved, a deliberate omission. -->

---

By opening this PR I confirm my contribution is offered under the project license and that I have signed the [CLA](../CLA.md).
