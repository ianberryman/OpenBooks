/**
 * The one place a thrown error becomes an HTTP response.
 *
 * `toWireError` decides everything: the code, the status, and the message a client
 * may see. This file adds no mapping table of its own and has no fallback branch —
 * `ERROR_CODE_STATUS` is `Record<ErrorCode, HttpErrorStatus>`, so a new code does
 * not compile until it has a status, and re-deriving a status from an error's class
 * or name here would be a second, divergent answer to a question `src/errors/`
 * has already answered for every transport (MCP in M5, the workflow engine in M6).
 *
 * The rule that shapes the rest of this file: anything not recognised by
 * `src/errors/` becomes an opaque `internal_error` with a fixed message. A driver
 * error carries a query string, a `TypeError` carries a variable name, and an
 * `InternalError` deliberately carries an operator message that may name a table
 * or a connection string. All of it goes to the log and none of it to the body.
 *
 * One consequence to know when constructing an `InternalError`: `clientMessage` is
 * fixed but `toWireError` forwards `details` for *every* `OpenBooksError`, so a
 * `details` bag on a 500 does reach the response body. Nothing here passes one, and
 * OB-023 should not either.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ResponseSerializationError,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';

import type { ValidationIssue, WireError } from '../errors';
import { InternalError, NotFoundError, ValidationError, toWireError } from '../errors';
import type { Logger } from '../logging';
import type { ErrorResponse } from './schemas';

/**
 * Fastify's own request-input failures, by error code prefix.
 *
 * These are errors Fastify raises *for* the transport before a handler runs:
 * unparseable JSON, an unsupported content type, a body over the limit, a failed
 * schema validation. They are the client's input being wrong, which is
 * `validation_failed`.
 *
 * This is a named set of Fastify codes, not a status fallback: the alternative —
 * "if `error.statusCode` is 4xx, trust it" — would let any plugin's chosen status
 * become part of our contract, and `HttpErrorStatus` deliberately enumerates what
 * this system is capable of returning.
 *
 * The mapping is lossy and knowingly so. A 415 or a 413 is a better answer than a
 * 400 for two of these, and neither status exists in `HttpErrorStatus`. Adding
 * them is a change to `src/errors/codes.ts` — a public-contract decision made
 * there, with a code to go with it — not something transport should mint on the
 * side.
 */
const FASTIFY_INPUT_ERROR_PREFIXES = ['FST_ERR_CTP_', 'FST_ERR_VALIDATION'] as const;

function isFastifyInputError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return (
    typeof code === 'string' &&
    FASTIFY_INPUT_ERROR_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
}

/**
 * Zod issues, as `ValidationError` details.
 *
 * `src/errors/errors.ts` states that OB-022 maps Zod issues onto
 * `ValidationError`, and this is that. The `instancePath` Fastify's validation
 * contract uses is JSON-Pointer-ish (`/lines/0/amount`); `ValidationIssue.path` is
 * documented as dotted (`lines.0.amount`), so it is converted rather than passed
 * through.
 */
function zodIssues(validation: readonly { instancePath: string; message?: string }[]): {
  readonly issues: readonly ValidationIssue[];
} {
  return {
    issues: validation.map((issue) => ({
      path: issue.instancePath.replace(/^\//u, '').replaceAll('/', '.'),
      message: issue.message ?? 'invalid',
    })),
  };
}

/**
 * Normalizes a thrown value into something `src/errors/` recognises, or leaves it
 * alone so it becomes an opaque 500.
 *
 * Everything this function *does* recognise it converts into one of our own error
 * classes rather than into a response, so there is exactly one serialization path.
 */
function normalize(error: unknown, request: FastifyRequest): unknown {
  /**
   * A primitive throw is not a bug this handler may crash on.
   *
   * `throw 'something'` is legal JavaScript and arrives here as a string. Every
   * predicate below is a shape test, and a handler that throws while deciding what
   * a thrown value was is handled by Fastify's *default* serializer — which puts
   * the raw message in the response body. So a string carrying a connection string
   * would be echoed to the client by the very code written to prevent that. Bail
   * out to the opaque path before any inspection.
   */
  if (typeof error !== 'object' || error === null) return error;

  if (hasZodFastifySchemaValidationErrors(error)) {
    const { issues } = zodIssues(error.validation);
    return new ValidationError('Request validation failed.', issues);
  }

  /**
   * Our response did not match our own output schema. That is our bug, not the
   * client's, so it is an `InternalError` — its `clientMessage` is fixed and the
   * Zod issues, which describe our internals, go only to the operator message.
   *
   * `instanceof` and not the library's `isResponseSerializationError`, which is
   * `'method' in value`: that both throws on a primitive and returns true for any
   * object with a `method` property, which is a plausible shape for a thrown
   * config or request object.
   */
  if (error instanceof ResponseSerializationError) {
    const issues = error.cause.issues.map((issue) => issue.message).join('; ');
    return new InternalError(
      `Response for ${request.method} ${request.url} did not match its declared output ` +
        `schema. The route and its schema disagree: ${issues}`,
    );
  }

  if (isFastifyInputError(error)) {
    return new ValidationError('The request could not be read.');
  }

  return error;
}

/**
 * Writes a wire error. The only function in the process that produces an error
 * body.
 */
function send(reply: FastifyReply, wire: WireError): void {
  const body: ErrorResponse = {
    error: {
      code: wire.code,
      message: wire.message,
      // Spread rather than `details: wire.details` — exactOptionalPropertyTypes
      // distinguishes an absent key from an explicit `undefined`, and an explicit
      // `undefined` would serialize the key.
      ...(wire.details === undefined ? {} : { details: wire.details }),
    },
  };

  // `.code(wire.status)` and never a status derived here. See the file header.
  void reply.code(wire.status).send(body);
}

/**
 * The error handler.
 *
 * `logger` is the application logger rather than `request.log`: provenance is
 * attached by pino's mixin from the request context (A13), and `request.log` is a
 * child carrying a `reqId` binding that would duplicate the mixin's `requestId`
 * with a differently-named field.
 *
 * Log level splits on the status, not on the class. A 5xx is ours to fix and is
 * logged at `error` with the full internal message — this is the *only* place that
 * message exists, which is the point of `InternalError` keeping `message` and
 * `clientMessage` separate. A 4xx is the client's to fix and is logged at `warn`,
 * because a stream of them is worth noticing and each one individually is not.
 */
export function createErrorHandler(logger: Logger) {
  return function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
    const normalized = normalize(error, request);
    const wire = toWireError(normalized);

    const line = {
      err: normalized,
      method: request.method,
      url: request.url,
      code: wire.code,
      statusCode: wire.status,
    };

    if (wire.status >= 500) logger.error(line, 'request failed');
    else logger.warn(line, 'request rejected');

    send(reply, wire);
  };
}

/**
 * No route matched.
 *
 * Fastify's built-in 404 body is `{ statusCode, error, message }`, a second error
 * shape on the same API and one that echoes the requested URL. This replaces it
 * with the one envelope, via the one error class the miss is allowed to produce.
 *
 * `'route'` is the resource token, so an unrouted path produces the same bytes as
 * any other miss. It deliberately does not name the path: a 404 that echoes what
 * was asked for is the shape A7 rules out, and while a route table is not secret,
 * having two kinds of 404 — one that echoes and one that must not — is how the
 * wrong one gets copied.
 */
export function createNotFoundHandler(logger: Logger) {
  const handler = createErrorHandler(logger);
  return function handleNotFound(request: FastifyRequest, reply: FastifyReply): void {
    handler(new NotFoundError('route'), request, reply);
  };
}
