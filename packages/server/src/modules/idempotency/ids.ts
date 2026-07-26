import { isUuid, newUuidBuffer, uuidToBuffer as decodeUuid } from '../../db/uuid';
import { InternalError } from '../../errors';

/**
 * Claim-row identifiers.
 *
 * The UUID ↔ `BINARY(16)` encoding itself lives in `src/db/uuid.ts` — plain hex
 * byte order, `UUID_TO_BIN(x, 0)`. This module previously carried its own copy
 * because `src/db/` had none; it now does, and a second copy is exactly how the
 * byte order silently diverges.
 *
 * What remains here is the error semantics, which genuinely differ.
 */

/** A fresh `BINARY(16)` primary key for a claim row. */
export function newIdBuffer(): Buffer {
  return newUuidBuffer();
}

/**
 * An `InternalError` and not the `TypeError` that `src/db/uuid.ts` raises.
 *
 * The only UUID this module converts is `context.orgId`, which the session layer
 * produced from a row it read. A malformed one is a wiring bug in this process,
 * never client input, so it maps to 500 through the same path as every other
 * internal fault rather than surfacing as a validation failure the caller could
 * be blamed for.
 */
export function uuidToBuffer(uuid: string): Buffer {
  if (!isUuid(uuid)) {
    throw new InternalError(`Expected a UUID, received ${JSON.stringify(uuid)}.`);
  }
  return decodeUuid(uuid);
}
