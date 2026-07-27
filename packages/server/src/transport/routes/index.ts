import type { Config } from '../../config';
import type { App } from '../types';
import { registerAccountRoutes } from './accounts';
import { registerAuthRoutes } from './auth';
import { registerJournalRoutes } from './journals';
import { registerOrgRoutes } from './orgs';
import { registerPeriodRoutes } from './periods';
import { registerReportRoutes } from './reports';

/**
 * The `/v1` route surface (OB-023).
 *
 * | Method   | Path                                    | operationId           | Idempotency-Key | Claim scope    |
 * | -------- | --------------------------------------- | --------------------- | --------------- | -------------- |
 * | `POST`   | `/v1/auth/register`                     | `register`            | required        | global         |
 * | `POST`   | `/v1/auth/login`                        | `login`               | required        | global         |
 * | `POST`   | `/v1/auth/logout`                       | `logout`              | required        | global         |
 * | `GET`    | `/v1/auth/me`                           | `getCurrentIdentity`  | —               | —              |
 * | `POST`   | `/v1/orgs`                              | `createOrg`           | required        | global         |
 * | `GET`    | `/v1/orgs`                              | `listOrgMemberships`  | —               | —              |
 * | `POST`   | `/v1/orgs/active`                       | `switchActiveOrg`     | required        | global         |
 * | `POST`   | `/v1/accounts`                          | `createAccount`       | required        | org            |
 * | `GET`    | `/v1/accounts`                          | `listAccounts`        | —               | —              |
 * | `GET`    | `/v1/accounts/:accountId`               | `getAccount`          | —               | —              |
 * | `PATCH`  | `/v1/accounts/:accountId`               | `updateAccount`       | required        | org            |
 * | `POST`   | `/v1/accounts/:accountId/deactivate`    | `deactivateAccount`   | required        | org            |
 * | `POST`   | `/v1/accounts/:accountId/reactivate`    | `reactivateAccount`   | required        | org            |
 * | `DELETE` | `/v1/accounts/:accountId`               | `deleteAccount`       | required        | org            |
 * | `POST`   | `/v1/fiscal-years`                      | `generateFiscalYear`  | required        | org            |
 * | `POST`   | `/v1/fiscal-periods`                    | `createFiscalPeriod`  | required        | org            |
 * | `GET`    | `/v1/fiscal-periods`                    | `listFiscalPeriods`   | —               | —              |
 * | `POST`   | `/v1/fiscal-periods/:periodId/close`    | `closeFiscalPeriod`   | required        | org            |
 * | `POST`   | `/v1/fiscal-periods/:periodId/reopen`   | `reopenFiscalPeriod`  | required        | org            |
 * | `POST`   | `/v1/journals`                          | `postJournal`         | required        | org            |
 * | `GET`    | `/v1/journals`                          | `listJournals`        | —               | —              |
 * | `POST`   | `/v1/journals/:journalId/reverse`       | `reverseJournal`      | required        | org            |
 * | `GET`    | `/v1/reports/trial-balance`             | `getTrialBalance`     | —               | —              |
 *
 * ## What a handler in this directory is allowed to contain
 *
 * Argument mapping, and nothing else (spec §2.4). Concretely: read the validated
 * body, params, and query; read the request context; call one service function; set a
 * status, a header, or a cookie from what it returned. There is no validation logic
 * here — Zod owns that, and every service re-parses with the same schema because HTTP
 * is not its only caller. There is no authorization logic here — `requirePermission`
 * is service-layer only (spec §5), which is also why nothing in this directory
 * imports `src/modules/permissions/`. And there are no queries: importing a
 * `*.repository.ts` or anything under `src/db/` past its index is a `yarn lint:deps`
 * failure, by rule `transport-holds-no-business-logic`.
 *
 * ## Why there is no `RouteDefinition` → Fastify adapter
 *
 * OB-022 deliberately left one unbuilt, and with the real routes in hand the decision
 * is to leave it to M5 rather than build it now. Three reasons, in increasing weight:
 *
 * 1. **`RouteDefinition.input` is one schema per operation; Fastify validates params,
 *    query, and body separately.** An adapter therefore either needs a per-route map
 *    saying where each key comes from — which puts the transport structure back into
 *    the definition it was meant to keep out — or it merges the three and validates
 *    the union itself, bypassing Fastify's compiled validators. The second is what
 *    costs: `jsonSchemaTransform` builds the OpenAPI request documentation *from* the
 *    per-location schemas, so an adapter that validated by hand would publish an
 *    artifact with no request bodies and no parameters, and OB-024 generates its
 *    client from that artifact.
 * 2. **`handler(input, ctx)` has no reply, so three of these routes are not
 *    expressible in it.** Register and login must set an `HttpOnly` cookie, and
 *    `createAccount` sets a `Location`. Adding a reply-shaped return value to
 *    `RouteDefinition` would make it Fastify-shaped, which is the one thing its
 *    comment says it must not be.
 * 3. **`RouteDefinition.permission` is declarative "so the host enforces it
 *    identically for every transport", and in this system the host does not enforce
 *    it — the service does** (spec §2.4, §5, and `permissions.service.ts` is
 *    explicit). An adapter honouring that field would be a second enforcement point,
 *    which is exactly what the service-layer-only rule exists to prevent.
 *
 * None of that says the abstraction is wrong; it says there is currently one consumer,
 * so any shape chosen now would be fitted to HTTP alone. When M5 needs the same
 * operations as MCP tools there will be two, and the seam can be cut where they
 * actually differ. The likely shape is a per-operation input schema plus a location
 * map for the HTTP side — or MCP calling the services directly, which is already
 * possible because no service in `src/modules/` mentions a request or a reply.
 *
 * ## How idempotency is applied at this boundary
 *
 * Two mechanisms, and they answer different questions.
 *
 * `requireIdempotencyKey` is an `onRequest` hook on **every** write route above.
 * Spec §12 requires the key on every write endpoint, and `onRequest` is early enough
 * that the server refuses on a missing header before reading a body it is going to
 * reject. It runs before validation, so a write with no key is a `400` whatever else
 * is wrong with it. It is also, incidentally, what stops a cross-site form POST
 * reaching a write at all — a form cannot set a custom header (see the `sameSite`
 * note in `src/transport/app.ts`).
 *
 * `withIdempotency(spec, operation)` is what makes a replay return the *original*
 * response without re-executing. It is applied to every org-scoped write, and the
 * `request` it fingerprints always includes the path id as well as the body, so the
 * same key reused against a different account or period is an
 * `idempotency_key_conflict` rather than the first resource's response. The operation
 * callback ignores its transaction parameter and calls the service directly, which is
 * correct here and only because `src/db/transaction-scope.ts` propagates the
 * transaction ambiently — `tenantDb()` inside the service joins the claim's
 * transaction, so the claim and the write commit together.
 *
 * `withGlobalIdempotency(spec, operation)` covers the five identity and org-lifecycle
 * writes — register, login, logout, create org, switch active org — which have no org
 * to scope a claim to. They run either before any org exists or, in the case of
 * switch, against the org the caller is *leaving*. The claim goes to the same table
 * with `org_id` null and the zero-byte `claim_scope` that migration `0003` exists to
 * provide, and the fingerprint folds in the calling user, because the global namespace
 * is shared and keys are client-chosen: without that, two callers who picked the same
 * key would be each other's replays and the second `createOrg` would be answered with
 * the first caller's org. It is a separate function rather than a flag on
 * `IdempotencySpec` so the namespace cannot default wrong.
 *
 * One asymmetry to know about: a replayed `register` or `login` returns the identity
 * with no `Set-Cookie`, because the session token exists only during execution and is
 * deliberately never stored (D-03). That is right for the double-submit this guards
 * against; a caller who genuinely lost the response has to log in again.
 */
export function registerV1Routes(app: App, config: Config): void {
  registerAuthRoutes(app, config);
  registerOrgRoutes(app);
  registerAccountRoutes(app);
  registerPeriodRoutes(app);
  registerJournalRoutes(app);
  registerReportRoutes(app);
}
