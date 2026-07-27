/**
 * The error model (spec §8, A7).
 *
 * Read `codes.ts` for why the codes are a contract, and the A7 commentary on
 * `NotFoundError` in `errors.ts` for how a cross-org read is made
 * indistinguishable from a genuine miss by construction rather than by
 * discipline.
 */
export type { ErrorDetails, JsonValue } from './base';
export { OpenBooksError } from './base';

export type { ErrorCode, HttpErrorStatus } from './codes';
export { ERROR_CODE_STATUS, ERROR_CODES } from './codes';

export type { ValidationIssue } from './errors';
export {
  ConflictError,
  IdempotencyKeyConflictError,
  InternalError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  UnauthenticatedError,
  ValidationError,
} from './errors';

export { assertFound, assertOrgMatch } from './assert';

export { parseInput } from './parse';

export type { WireError } from './wire';
export { isOpenBooksError, toWireError } from './wire';
