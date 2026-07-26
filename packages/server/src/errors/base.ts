import type { ErrorCode, HttpErrorStatus } from './codes';
import { ERROR_CODE_STATUS } from './codes';

/**
 * JSON-representable values, for the structured payload an error carries.
 *
 * A type alias rather than an interface so that plain object types get TypeScript's
 * implicit index signature and are assignable to `ErrorDetails` without a cast.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ErrorDetails = { readonly [key: string]: JsonValue };

/**
 * The root of the error hierarchy.
 *
 * Everything the HTTP layer needs is resolved here, at construction: the code,
 * the status, and the message that is safe to hand a client. OB-022 serializes
 * `toWireError(error)` and never re-derives a status from an error's shape or
 * name, because a transport that has to guess is a transport that guesses
 * differently from the next one (MCP in M5, the workflow engine in M6).
 */
export abstract class OpenBooksError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpErrorStatus;
  readonly details: ErrorDetails | undefined;

  protected constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.code = code;
    this.status = ERROR_CODE_STATUS[code];
    this.details = details;
    this.name = new.target.name;
  }

  /**
   * The message a client may see. Distinct from `message`, which is written for
   * an operator reading logs and is free to name a table, a constraint, or an
   * internal invariant. `InternalError` overrides this; everything else is
   * deliberately phrased for both audiences.
   */
  get clientMessage(): string {
    return this.message;
  }
}

/**
 * Matches a stable identifier token: a resource name, a permission key, a
 * precondition name. Lowercase, no spaces, no punctuation beyond `.`, `_`, `-`
 * and `:`.
 *
 * This exists to make free text un-passable where free text would be a leak. See
 * the A7 commentary on `NotFoundError` for why that matters; the short version is
 * that a validated token cannot carry a sentence about which specific row was or
 * was not there.
 */
const IDENTIFIER_TOKEN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

export function assertIdentifierToken(value: string, parameter: string): void {
  if (!IDENTIFIER_TOKEN.test(value)) {
    throw new Error(
      `${parameter} must be a stable identifier token (e.g. 'invoice', 'invoices.write'), ` +
        `received ${JSON.stringify(value)}. Free text here would reach the client and could ` +
        'describe a specific row — see the A7 note in src/errors/errors.ts.',
    );
  }
}
