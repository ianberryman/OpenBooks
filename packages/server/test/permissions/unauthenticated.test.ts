import { describe, expect, it } from 'vitest';

import { UNAUTHENTICATED_ID } from '../../src/context';
import { toWireError } from '../../src/errors';
import { requirePermission, hasPermission } from '../../src/modules/permissions';
import { contextFor, useServiceDatabase } from './support';

/**
 * A request that presented no credentials gets 401, not 403.
 *
 * Before the pre-auth sentinel moved into `src/context/`, this check could not see
 * it — transport owned it, and a service may not import transport. The behaviour
 * was safe (the nil UUID names no row, so every check failed closed) but reported
 * `403`, which tells a caller their credentials are insufficient rather than absent
 * and sends them hunting a permission problem instead of a login.
 *
 * Pinned because it is a status-code change, and because the failure mode if it
 * regresses is silent: an unauthenticated request would still be *refused*, so no
 * test would fail on authorization grounds — only the reported reason would be
 * wrong.
 */
useServiceDatabase();

const preAuth = contextFor(UNAUTHENTICATED_ID, UNAUTHENTICATED_ID, UNAUTHENTICATED_ID);

describe('an unauthenticated context', () => {
  it('is refused with 401 and not 403', async () => {
    await expect(requirePermission(preAuth, 'accounts.read')).rejects.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });
  });

  it('names no permission in the response, since none was the problem', async () => {
    // PermissionDeniedError carries the permission key; an unauthenticated refusal
    // should not, because the caller's authority was never evaluated.
    const wire = await requirePermission(preAuth, 'journals.post').catch((error: unknown) =>
      toWireError(error),
    );

    expect(wire).toEqual({
      code: 'unauthenticated',
      status: 401,
      message: expect.any(String),
    });
    expect(JSON.stringify(wire)).not.toContain('journals.post');
  });

  it('still fails closed if the status logic were ever bypassed', async () => {
    // The defence in depth that made the old behaviour safe: the sentinel is a
    // well-formed UUID naming no row, so resolution yields an empty set. This must
    // keep holding independently of the 401 check above.
    await expect(hasPermission(preAuth, 'accounts.read')).resolves.toBe(false);
    await expect(hasPermission(preAuth, 'journals.post')).resolves.toBe(false);
  });
});
