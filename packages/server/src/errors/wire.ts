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
    return {
      code: error.code,
      status: error.status,
      message: error.clientMessage,
      // Spread rather than `details: error.details` because
      // exactOptionalPropertyTypes distinguishes an absent key from `undefined`.
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  return {
    code: ERROR_CODES.INTERNAL_ERROR,
    status: ERROR_CODE_STATUS[ERROR_CODES.INTERNAL_ERROR],
    message: 'An internal error occurred.',
  };
}
