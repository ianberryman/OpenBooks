import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import { uuidToBuffer } from '../../src/db';
import { errorBody } from '../transport/harness';
import { authorizedWrite, registerUser, useV1App } from '../transport/v1-support';

/**
 * **B8 — a key claims one request, and a claim belongs to one caller.**
 *
 * The two failure modes the M1 gap-1 fix (OB-028) has to keep out, asserted over the
 * real HTTP surface because both of them are about what a *client* can do with a
 * header, and the header exists nowhere below transport.
 *
 * ## Why "different resource" is a separate claim from "different body"
 *
 * `test/idempotency/service.test.ts` already asserts that the same key with a
 * different *body* is a `409` rather than a replay. That is the same-endpoint case,
 * and it is the easy one: the fingerprint covers the request. The case here is a key
 * reused against a different **endpoint** — a client that generates one key per
 * screen rather than one per request, which is the mistake that actually happens.
 * The fingerprint covers `endpoint` as well as `request` for exactly this reason,
 * and nothing else in the suite says so. A system that ignored the endpoint would
 * replay the contact's `201` in answer to an account create, handing the client a
 * body of the wrong shape and creating nothing.
 *
 * ## Why "different caller" is a claim only the global namespace needs
 *
 * An org claim is partitioned by `uq_idempotency_scope_key` on
 * `(claim_scope, idempotency_key)`, so one tenant's key cannot reach another's row.
 * The org-less namespace added by migration `0003` has no such partition — every
 * global claim in the system shares it — and the keys are picked by clients. Two
 * clients that chose the same value would be one another's retries, and the second
 * `createOrg` would replay the first's response: an org id and slug the caller is
 * not a member of, while their own org is never created. `globalRequestFingerprint`
 * folds the principal in to make that a refusal instead, and this is the test that
 * says the refusal is real rather than that the function exists.
 */
const harness = useV1App();

const SHARED_KEY = 'one-key-two-requests';

describe('B8 — an org-scoped key claims one request', () => {
  it('refuses the same key against a different resource, and creates nothing', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'b8-org@example.invalid',
      orgName: 'Books',
    });

    const contact = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: authorizedWrite(owner, SHARED_KEY),
      payload: { displayName: 'Acme' },
    });
    expect(contact.statusCode).toBe(201);

    const account = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authorizedWrite(owner, SHARED_KEY),
      payload: { code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    });

    expect(account.statusCode).toBe(409);
    expect(errorBody(account.body).error.code).toBe('idempotency_key_conflict');

    // The half that matters more than the status: a refusal must not be a partial
    // success. Nothing was written, and the contact the key really claimed is intact.
    const accounts = await harness.db.app
      .selectFrom('accounts')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('org_id', '=', uuidToBuffer(owner.orgId))
      .executeTakeFirstOrThrow();
    expect(Number(accounts.count)).toBe(0);

    const contacts = await harness.db.app
      .selectFrom('contacts')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('org_id', '=', uuidToBuffer(owner.orgId))
      .executeTakeFirstOrThrow();
    expect(Number(contacts.count)).toBe(1);
  });

  /**
   * The converse, without which the test above is satisfied by a system that refuses
   * every reuse. A retry is the case the header exists for.
   */
  it('replays the same key against the same request, yielding exactly one contact', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'b8-replay@example.invalid',
      orgName: 'Books',
    });

    const send = (): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/v1/contacts',
        headers: authorizedWrite(owner, 'retried-once'),
        payload: { displayName: 'Acme' },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);

    const contacts = await harness.db.app
      .selectFrom('contacts')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('org_id', '=', uuidToBuffer(owner.orgId))
      .executeTakeFirstOrThrow();
    expect(Number(contacts.count)).toBe(1);
  });
});

describe('B8 — a global claim belongs to the caller who made it', () => {
  it('refuses a second caller the same key, and does not hand over the first org', async () => {
    const app = harness.app();
    const first = await registerUser(app, { email: 'b8-first@example.invalid', orgName: 'First' });
    const second = await registerUser(app, {
      email: 'b8-second@example.invalid',
      orgName: 'Second',
    });

    // Byte-identical requests, which is the whole difficulty: nothing but the caller
    // distinguishes these two, so a fingerprint that omitted the principal would see
    // a retry.
    const payload = { name: 'Shared Name' };

    const mine = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: authorizedWrite(first, 'a-key-two-people-picked'),
      payload,
    });
    expect(mine.statusCode).toBe(201);

    const theirs = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: authorizedWrite(second, 'a-key-two-people-picked'),
      payload,
    });

    expect(theirs.statusCode).toBe(409);
    expect(errorBody(theirs.body).error.code).toBe('idempotency_key_conflict');

    // Exactly one org by that name, and the second caller is a member of neither it
    // nor a duplicate: the refusal neither replayed somebody else's org nor created a
    // second one nobody asked for.
    const created = await harness.db.app
      .selectFrom('orgs')
      .select('id')
      .where('name', '=', 'Shared Name')
      .execute();
    expect(created).toHaveLength(1);

    const memberships = await harness.db.app
      .selectFrom('org_members')
      .select('org_id')
      .where('user_id', '=', uuidToBuffer(second.userId))
      .execute();
    expect(memberships.map((row) => row.org_id.toString('hex'))).toEqual([
      uuidToBuffer(second.orgId).toString('hex'),
    ]);
  });

  /**
   * And the same key retried by the caller who claimed it replays, for the reason the
   * org-scoped pair above states: a namespace that refused every reuse would pass the
   * test above while making the header useless.
   */
  it('replays for the caller who claimed it, yielding exactly one org', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'b8-retry@example.invalid',
      orgName: 'Original',
    });

    const send = (): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: authorizedWrite(owner, 'create-org-retried'),
        payload: { name: 'Second Set Of Books' },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(201);
    expect(second.body).toBe(first.body);

    const created = await harness.db.app
      .selectFrom('orgs')
      .select('id')
      .where('name', '=', 'Second Set Of Books')
      .execute();
    expect(created).toHaveLength(1);
  });
});
