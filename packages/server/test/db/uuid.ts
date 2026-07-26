/**
 * Re-export of the production UUID ↔ `BINARY(16)` helpers.
 *
 * The implementation moved to `src/db/uuid.ts` so the harness, the permissions
 * module, and the idempotency module share one copy instead of three. This file
 * remains so `test/db/uuid.test.ts` — which asserts agreement against a live
 * MySQL `UUID_TO_BIN(x, 0)` rather than against these functions — keeps testing
 * the code that production actually uses.
 */
export {
  bufferToUuid,
  isUuid,
  newUuid,
  newUuidBuffer,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../src/db/uuid';
