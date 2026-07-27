import type { onRequestHookHandler } from 'fastify';
import { z } from 'zod';

import { getContext, isAuthenticatedContext } from '../../context';
import { UnauthenticatedError } from '../../errors';
import type { IdempotentResult } from '../../modules/idempotency';
import { IDEMPOTENCY_KEY_HEADER, requireIdempotencyKey } from '../idempotency';
import { errorResponseSchema } from '../schemas';

/**
 * The pieces every route file in this directory needs, and nothing else.
 *
 * Route files hold argument mapping only (spec §2.4). What lives here is the part
 * of that mapping which would otherwise be restated a dozen times with a dozen
 * chances to differ.
 */

/**
 * Refuses a request that has no org scope, on the routes that need one.
 *
 * ## This is not a permission check, and it must not become one
 *
 * It reads no role, consults no catalog, and names no `PermissionKey`. It asserts one
 * precondition: `isAuthenticatedContext` — that the identity resolver produced an org
 * rather than leaving the pre-auth sentinel in place. `src/transport/context.ts` says
 * which routes may run in that scope (`/health` and the identity-establishing ones)
 * and this is what holds every other route to it.
 *
 * It cannot diverge from service-layer enforcement, and that is why it is acceptable
 * at all: `requirePermission` checks `isAuthenticatedContext` *first* and throws the
 * same `UnauthenticatedError`, so this hook's condition is strictly weaker than every
 * service's. It can never admit a request a service would refuse, and never refuse one
 * a service would admit. Deleting it would change no route's outcome except the one
 * below.
 *
 * ## Why it exists rather than letting the service answer
 *
 * On an org-scoped write the service is reached *inside* `withIdempotency`, which
 * claims a row in `idempotency_keys` before the operation runs. That table's `org_id`
 * has a foreign key to `orgs` (migration `0003`), so a request still carrying the
 * pre-auth sentinel makes the claim insert fail with errno 1452 — and an
 * unauthenticated write would answer `500` instead of `401`, blaming the server for a
 * request it should have refused. The hook moves the refusal in front of the claim,
 * where it belongs.
 *
 * `onRequest` rather than `preHandler` for the same reason as
 * `requireIdempotencyKey`: a request that cannot be authorized should not have its
 * body read.
 */
export const requireOrgScope: onRequestHookHandler = function requireOrgScope(
  _request,
  _reply,
  done,
) {
  if (!isAuthenticatedContext(getContext('requireOrgScope()'))) {
    throw new UnauthenticatedError();
  }
  done();
};

/**
 * The hook chain for an org-scoped write.
 *
 * `requireIdempotencyKey` first, deliberately. Both orders answer both faults
 * correctly and only the message for a request with *neither* differs, so the
 * tie-breaker is that the key requirement is a property of the endpoint, stated in
 * `openapi.json` and identical for every caller. Checking it before any identity is
 * consulted keeps the two hooks independent — the missing-key answer does not depend
 * on who is asking — and it is what lets one test prove the rule for every write route
 * in the table without a session.
 */
export const ORG_SCOPED_WRITE_HOOKS: onRequestHookHandler[] = [
  requireIdempotencyKey,
  requireOrgScope,
];

/**
 * The `Idempotency-Key` header, declared so it appears in the published artifact.
 *
 * **It is documentation, not the enforcement.** `requireIdempotencyKey` is an
 * `onRequest` hook and runs before validation, so a write with no key is already
 * refused by the time this schema would be consulted; a blank one is refused even
 * earlier, by the context hook. Both of those produce the message that explains what
 * to send.
 *
 * Declaring it anyway matters because of who reads `openapi.json`. Spec §12 makes the
 * artifact the integration contract and OB-024 generates its client from it — a
 * required header that appears nowhere in the document is a client whose every write
 * call fails with a 400 the generator could have prevented. A hook is invisible to the
 * document; a `headers` schema is not.
 *
 * `looseObject` and not `object`: Fastify assigns the validation result back to
 * `request.headers`, and a stripping schema would therefore delete every header it
 * does not name — `cookie` included, which is the session.
 */
export const idempotencyKeyHeaderSchema = z.looseObject({
  [IDEMPOTENCY_KEY_HEADER]: z
    .string()
    .min(1)
    .meta({
      description:
        'Required on every write (spec §12). Send one unique value per logical request and reuse ' +
        'it verbatim when retrying: the same key with the same request replays the original ' +
        'outcome, and the same key with a different request is refused with ' +
        '`idempotency_key_conflict`.',
    }),
});

/**
 * The error entry on every route's `response` map.
 *
 * `default` rather than an enumerated list of statuses, copied from
 * `src/transport/health.ts` where the reasoning is set out: the statuses a route
 * can produce are decided by the *shared* hook chain — a malformed
 * `Idempotency-Key` is a 400 raised by the context hook, an unresolvable session is
 * a 401 raised by the identity hook, any unhandled fault is a 500 — so a per-route
 * list is wrong the moment a hook is added. `default` states the true thing once:
 * every non-2xx response on this API has this body.
 */
export const ERROR_RESPONSES = { default: errorResponseSchema } as const;

/**
 * The declared body of a 204.
 *
 * `z.null()` and not `z.void()`: verified against the installed
 * `fastify-type-provider-zod`, `z.null()` emits a `204` with no `content` at all,
 * while `z.void()` emits an empty `application/json` schema — a content type on a
 * response that by definition has no body.
 */
export const noContentSchema = z.null().meta({ description: 'No content.' });

/**
 * A mutable copy of a service's `readonly` array.
 *
 * `z.array()` infers a mutable `T[]` and every service in `src/modules/` returns
 * `readonly T[]`, so the two are not assignable and something has to give. This
 * copies, rather than `.readonly()` on the schema, because `.readonly()` emits
 * OpenAPI `readOnly: true` — which means "this field is response-only, never send
 * it" and is a different claim entirely, applied to both io directions.
 */
export function wireList<T>(values: readonly T[]): T[] {
  return [...values];
}

/**
 * `wireList` for a value whose `readonly` arrays are nested inside it.
 *
 * The three M2 reports return one object holding sections holding rows, every
 * level `readonly`, and copying that by hand at a route would be twenty lines of
 * re-listing fields — which is the one shape of code that silently drops a field
 * when the service gains one. This drops `readonly` in the type and returns the
 * same object.
 *
 * ## Why the cast is not a hole
 *
 * It removes a modifier and nothing else, so it cannot make a wrong shape
 * type-check: the handler still declares the response schema's inferred type as its
 * return type, and `Mutable<ReportShape>` is checked against it there. A field the
 * service adds, renames, or changes the type of fails to compile at that position,
 * exactly as it would without this. What is given up is the compiler's objection to
 * a route mutating a service's result, and no route does — Fastify serializes the
 * value and drops it.
 */
type Mutable<T> = T extends readonly (infer Element)[]
  ? Mutable<Element>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

export function wireValue<T>(value: T): Mutable<T> {
  return value as Mutable<T>;
}

/**
 * The stored response body of an idempotent write, typed for the route's declared
 * response schema.
 *
 * The cast is unavoidable and it is confined to this function. `withIdempotency`
 * returns `JsonValue` by construction: on a replay the body comes out of a `JSON`
 * column, so there is no path on which the compiler could know its shape. What
 * makes the cast safe in practice is that the reply is still serialized through the
 * route's Zod response schema, so a body that does not match is a logged
 * `internal_error` naming the disagreement (`normalize` in
 * `src/transport/errors.ts`) rather than a wrong response.
 *
 * `T` is always given explicitly at the call site, so a route that changes its
 * response schema does not silently start inferring the new one from the cast.
 */
export function idempotentBody<T>(result: IdempotentResult): T {
  return result.body as T;
}
