/**
 * Response schemas that belong to the transport itself rather than to a domain
 * module.
 *
 * They live here and not in `@openbooks/shared-types` because the error codes are
 * owned by `src/errors/codes.ts`, which says plainly that adding a code happens
 * there. Restating the list in a package that cannot import it would create the
 * second source of truth that file exists to prevent, and buys nothing: OB-024
 * generates its client from `openapi.json`, so the codes reach the browser
 * through the artifact either way.
 */
import { z } from 'zod';

import { ERROR_CODES } from '../errors';

/**
 * Built from `ERROR_CODES` rather than restated, so a code added to the registry
 * appears in the artifact — and therefore in the drift gate's diff — without
 * anyone remembering to add it here.
 *
 * Not given an `id`, so it is inlined rather than lifted into
 * `components.schemas`. `fastify-type-provider-zod` emits *two* components for
 * every registered schema (`X` and `XInput`, one per io direction), which for a
 * response-only enum used in exactly one place is two dead entries in the
 * published document. See `errorResponseSchema` for the case where a component is
 * worth that cost.
 */
const errorCodeSchema = z.enum(Object.values(ERROR_CODES)).meta({
  description:
    'Stable machine-readable failure code. Integrators branch on this, not on the HTTP ' +
    'status: `conflict` and `idempotency_key_conflict` are both 409 and have different ' +
    'recoveries. Codes are never renamed and never change status.',
});

/**
 * The error body, for every non-2xx response the API produces.
 *
 * ## The envelope
 *
 * `{ error: … }` rather than the bare object, so a success payload and a failure
 * payload are never ambiguous at the top level — a client that forgot to check the
 * status still cannot mistake one for the other — and so a later top-level
 * addition has somewhere to go that is not inside the error.
 *
 * ## Why `status` is not in the body
 *
 * `WireError` carries one and `src/transport/errors.ts` uses it to set the HTTP
 * status, but it is not serialized. A second copy is a second source of truth that
 * can disagree with the status line after any proxy or gateway rewrites it, and
 * the disagreement is unresolvable for the client. The status line is the status.
 *
 * ## A7
 *
 * There is no field here for an object identifier, and none is added by the
 * handler. `details` is whatever the error class chose to carry, and the classes
 * that could leak existence (`NotFoundError`, `PermissionDeniedError`) accept only
 * a validated identifier token — see the A7 commentary in `src/errors/errors.ts`.
 * So two 404s for two different reasons produce identical bytes because there is
 * no channel through which they could differ.
 */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      /**
       * Safe to show a user. `OpenBooksError.clientMessage`, which `InternalError`
       * overrides with a fixed string precisely so an operator message naming a
       * table or a connection string cannot reach here.
       */
      message: z.string(),
      /**
       * Shape depends on `code`: `issues` (array of `{ path, message }`) for
       * `validation_failed`, `resource` for `not_found`, `permission` for
       * `permission_denied`, `precondition` for `precondition_failed`. Never an
       * object identifier.
       */
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .meta({
    // Registered with an id, unlike everything else here, so it becomes one named
    // `components.schemas` entry that every route's error responses `$ref`. The
    // alternative is this whole object inlined once per declared status per route
    // — dozens of copies across OB-023's surface, and an anonymous type per
    // response in OB-024's generated client.
    id: 'ErrorResponse',
    description: 'The body of every non-2xx response.',
  });

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * `GET /health`. See `src/transport/health.ts` for why it reports one thing.
 *
 * A literal rather than a string, so the schema itself documents that there is no
 * "degraded" to branch on: this endpoint either answers 200 `ok` or does not
 * answer.
 */
export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .meta({
    description: 'Liveness only. Reports no dependency state — see the route commentary.',
  });
