/**
 * The transport half of idempotency (spec §12: every write endpoint requires an
 * `Idempotency-Key`).
 *
 * ## The division of labour with OB-017
 *
 * `src/modules/idempotency/` owns the behaviour: the claim row, the request
 * fingerprint, the replay, the retention window, and the decision about what "the
 * same request" means. Its entry point is
 * `withIdempotency(spec, operation)`, and it reads both the key and the org from
 * request context rather than from parameters. Nothing in this file may grow into
 * that; a second implementation of the at-most-once rule is how A8 stops holding.
 *
 * There is deliberately **no runner interface declared here**. An earlier draft of
 * this file defined one, which was a mistake worth recording: `withIdempotency`
 * already exists and takes the org and the key from context, so a transport-side
 * abstraction over it would be a second shape for OB-023 to build against and
 * nobody to implement it.
 *
 * ## What transport guarantees before a write handler runs
 *
 * 1. **The header is read here and only here.** `initialContext` in
 *    `src/transport/context.ts` calls `readIdempotencyKey` once per request and puts
 *    the result on `OperationContext.idempotencyKey`, which is where
 *    `withIdempotency` reads it. That is the same rule spec §4 applies to `orgId`,
 *    for the same reason: a value that travels as an argument can be omitted at one
 *    call site.
 * 2. **A malformed key is refused, never silently dropped.** Dropping it would turn
 *    a request the client believes is idempotent into one that is not — a worse
 *    outcome than a 400.
 * 3. **`requireIdempotencyKey` refuses a declared write with no key before the body
 *    is parsed.** `withIdempotency` performs the same check, so this hook is not
 *    what makes the rule true; it is what stops the server reading a megabyte of
 *    body it is going to reject on a header. Attach it to every route whose
 *    `RouteDefinition.requiresIdempotencyKey` is true.
 *
 * ## What OB-023's write routes are expected to do
 *
 * ```ts
 * app.post(path, { schema, onRequest: requireIdempotencyKey }, async (request, reply) => {
 *   const result = await withIdempotency(
 *     { endpoint: route.operationId, request: input, successStatus: 201 },
 *     (trx) => service.doTheWriteIn(trx, input, getContext()),
 *   );
 *   return reply.status(result.status).send(result.body);
 * });
 * ```
 *
 * The transport does not branch on `result.outcome`; the stored body is deep-equal
 * on the first execution and on every replay, which is the property that makes a
 * retry indistinguishable from the original.
 */
import type { FastifyRequest, onRequestHookHandler } from 'fastify';

import { ValidationError } from '../errors';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The transport's bound on the value, and only the bound.
 *
 * `src/modules/idempotency/service.ts` is the authority on key validity and applies
 * its own check (`assertUsableKey`: non-blank, at most 255 characters, matching the
 * `VARCHAR(255)` column in migration `0003`). This is a restatement of the same two
 * limits, applied earlier, because the value reaches the request context and
 * therefore every log line for the request before any handler runs, and an
 * unbounded header should not get that far.
 *
 * It restates rather than imports because the constant is module-private there.
 * That is the one drift risk in this file: if the two disagree, the service is right
 * and this must follow. Note also what is deliberately *not* checked here — there is
 * no charset restriction, because inventing one at the edge would reject keys the
 * service accepts, and then "a valid key" would have two definitions.
 */
const MAX_KEY_LENGTH = 255;

/**
 * The validated key, or null when the header is absent.
 *
 * Throws on a header that is present and unusable. Absent and unusable are
 * genuinely different: absent is legal on a read, unusable is never legal.
 */
export function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (raw === undefined) return null;

  // A repeated header arrives as an array. Honouring one would mean choosing
  // between two contradictory idempotency claims; this is the one check the service
  // cannot make, because by then the two have been collapsed into a value.
  if (Array.isArray(raw)) {
    throw new ValidationError('Idempotency-Key must be sent at most once.', [
      { path: IDEMPOTENCY_KEY_HEADER, message: 'sent more than once' },
    ]);
  }

  if (raw.trim().length === 0) {
    throw new ValidationError('Idempotency-Key must not be blank.', [
      { path: IDEMPOTENCY_KEY_HEADER, message: 'must contain a non-whitespace character' },
    ]);
  }

  if (raw.length > MAX_KEY_LENGTH) {
    throw new ValidationError(
      `Idempotency-Key must be at most ${String(MAX_KEY_LENGTH)} characters.`,
      [{ path: IDEMPOTENCY_KEY_HEADER, message: `received ${String(raw.length)} characters` }],
    );
  }

  return raw;
}

/**
 * Route hook for every `RouteDefinition` with `requiresIdempotencyKey: true`.
 *
 * `onRequest` rather than `preHandler`, so a write that cannot be made idempotent is
 * refused before the body is read.
 *
 * It reads the header rather than the context, so the hook is also usable on an
 * instance that has not opened a context. Both paths go through
 * `readIdempotencyKey`, so they cannot disagree about what is present.
 */
export const requireIdempotencyKey: onRequestHookHandler = function requireKey(
  request,
  _reply,
  done,
) {
  if (readIdempotencyKey(request) === null) {
    throw new ValidationError(
      'This endpoint requires an Idempotency-Key header (spec §12). Send one unique value ' +
        'per logical request and reuse it verbatim when retrying.',
      [{ path: IDEMPOTENCY_KEY_HEADER, message: 'must be set' }],
    );
  }
  done();
};
