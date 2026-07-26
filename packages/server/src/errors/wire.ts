import type { ErrorDetails } from './base';
import { OpenBooksError } from './base';
import type { ErrorCode, HttpErrorStatus } from './codes';
import { ERROR_CODES, ERROR_CODE_STATUS } from './codes';

/**
 * The serialized form of an error. This is the response body shape (under
 * whatever envelope OB-022 chooses) and it is fully determined here — the HTTP
 * layer maps status from `status` and never from the error's class, name, or
 * message.
 */
export interface WireError {
  readonly code: ErrorCode;
  readonly status: HttpErrorStatus;
  readonly message: string;
  readonly details?: ErrorDetails;
}

export function isOpenBooksError(value: unknown): value is OpenBooksError {
  return value instanceof OpenBooksError;
}

/**
 * Serializes anything thrown.
 *
 * Accepts `unknown` rather than `OpenBooksError` because a `catch` clause in the
 * transport layer receives `unknown`, and the fallback has to be the *safe*
 * branch: an error this module does not recognise could be a driver error
 * carrying a query string, or a `TypeError` carrying a variable name. Those
 * become a bare `internal_error` with a fixed message. The alternative —
 * forwarding `String(error)` — is how a connection string ends up in a 500 body.
 */
export function toWireError(error: unknown): WireError {
  if (isOpenBooksError(error)) {
    const details = wireDetails(error);
    return {
      code: error.code,
      status: error.status,
      message: error.clientMessage,
      // Spread rather than `details` because exactOptionalPropertyTypes
      // distinguishes an absent key from one set to `undefined`.
      ...(details === undefined ? {} : { details }),
    };
  }

  return {
    code: ERROR_CODES.INTERNAL_ERROR,
    status: ERROR_CODE_STATUS[ERROR_CODES.INTERNAL_ERROR],
    message: 'An internal error occurred.',
  };
}

/**
 * `details` never travels on an `internal_error`, whatever the error carries.
 *
 * `clientMessage` already replaces an operator message with a fixed string for
 * this code, but `details` was forwarded unconditionally — so an `InternalError`
 * constructed with a details bag put it in a 500 response body regardless. That is
 * the same class of leak `clientMessage` exists to prevent, arriving through the
 * other field. It was found in practice: a serialization failure carrying Zod
 * issue text reached a response before OB-022 stripped it at the call site.
 *
 * Stripping here rather than at each throw site is the point. There is no
 * legitimate reason a client needs structured detail about a fault it cannot act
 * on, and a rule enforced in one place cannot be forgotten at the next `throw`.
 * The detail is not lost — the error object still carries it to the logger, which
 * is where an operator reads it.
 */
function wireDetails(error: OpenBooksError): ErrorDetails | undefined {
  return error.code === ERROR_CODES.INTERNAL_ERROR ? undefined : error.details;
}
