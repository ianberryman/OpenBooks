import { InternalError } from '../errors';

import type { OrgId } from './tenant';
import { isUuid, uuidToBuffer } from './uuid';

/**
 * Converts the context's `orgId` into the `BINARY(16)` form `tenantDb` requires.
 *
 * `OperationContext.orgId` is a UUID string — the contract in `@openbooks/plugin-api`
 * is transport-shaped and carries strings — while the schema stores `BINARY(16)`.
 * Every service that reaches a tenant table therefore performs this one conversion,
 * and by the time three modules had written it independently it was time for one
 * copy. A fourth would eventually get the byte order wrong, which is silent
 * (see `uuid.ts`).
 *
 * ## Why the failure is an InternalError and not a ValidationError
 *
 * The only `orgId` this ever sees came from a session the server itself resolved
 * from a row it read. A malformed one is a wiring bug in this process, never client
 * input, so blaming the caller with a 400 would be wrong and would also make an
 * internal fault look routine in the logs. It maps to 500 through the same path as
 * any other internal fault.
 *
 * Client-supplied org identifiers — the target of an org switch, say — must NOT come
 * through here. Those go through `tryUuidToBuffer`, which returns undefined so the
 * caller can answer with the 404 that acceptance A7 requires: "malformed", "not
 * yours", and "does not exist" have to be one indistinguishable answer.
 */
export function orgScope(orgId: string): OrgId {
  if (!isUuid(orgId)) {
    throw new InternalError(
      `Context carried a malformed orgId: ${JSON.stringify(orgId)}. ` +
        'This value originates from a resolved session, so a malformed one is a ' +
        'server-side wiring fault rather than client input.',
    );
  }
  return uuidToBuffer(orgId);
}
