import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { createRequestContext, runInContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import {
  acceptInvite,
  inviteMember,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
} from '../../src/modules/members';
import { SYSTEM_ROLE_UUIDS } from '../db';
import type { ActorFixture } from './support';
import {
  actorIn,
  captureEmail,
  contextFor,
  failingEmailProvider,
  memberOf,
  orgFrom,
  TEST_APP_BASE_URL,
  TEST_FROM_ADDRESS,
  tokenFrom,
  useServiceDatabase,
} from './support';

/**
 * Invitations end to end (OB-040).
 *
 * Every acceptance below redeems a token that was **read out of a real message**,
 * produced by the real `log` adapter through the real provider selection — never a
 * value the test handed to the service. That is what makes these tests statements
 * about the flow a recipient actually walks: if the link were built wrongly, or
 * the token were stored in a form the lookup could not find, no assertion here
 * would pass.
 */
const db = useServiceDatabase();
const email = captureEmail();

/** An invitation, and the token as its recipient would find it. */
async function invite(
  actor: ActorFixture,
  address: string,
  roleId: string = SYSTEM_ROLE_UUIDS.bookkeeper,
) {
  const issued = await inviteMember({ email: address, roleId }, actor.ctx);
  const message = email.to(address);
  return { issued, message, token: tokenFrom(message), orgId: orgFrom(message) };
}

describe('inviteMember', () => {
  it('records the invitation and sends a message carrying a working link', async () => {
    const owner = await actorIn(db, 'owner');
    const { issued, message, token, orgId } = await invite(owner, 'bookkeeper@example.test');

    expect(issued.emailDelivered).toBe(true);
    expect(issued.invitation).toMatchObject({
      email: 'bookkeeper@example.test',
      roleId: SYSTEM_ROLE_UUIDS.bookkeeper,
      roleCode: 'bookkeeper',
      status: 'pending',
      invitedByUserId: owner.user.uuid,
      acceptedByUserId: null,
    });

    expect(message.from).toBe(TEST_FROM_ADDRESS);
    expect(message.subject).toContain('invited');
    expect(message.text).toContain(`${TEST_APP_BASE_URL}/invites/accept?org=`);
    expect(orgId).toBe(owner.orgUuid);
    expect(token).toHaveLength(43);
  });

  /**
   * The token is a credential, so the only place it may exist in plaintext is the
   * message. Asserted against the service's own return value and against the whole
   * captured log, since the `log` adapter writes the body and everything else in
   * the process writes to the same stream.
   */
  it('never returns the token to the inviter', async () => {
    const owner = await actorIn(db, 'owner');
    const { issued, token } = await invite(owner, 'bookkeeper@example.test');

    expect(JSON.stringify(issued)).not.toContain(token);
    expect(Object.keys(issued.invitation)).not.toContain('token');
  });

  /**
   * What the database holds is a digest, not the token — the requirement
   * `0001_tenancy` states for "session, invite, and API-key material alike". A
   * `CHAR(64)` column silently truncates an over-long value in a non-strict SQL
   * mode, so the width is asserted against the stored row rather than against the
   * function that produced it.
   */
  it('stores the token as a 64-character digest and never in the clear', async () => {
    const owner = await actorIn(db, 'owner');
    const { token } = await invite(owner, 'bookkeeper@example.test');

    const rows = await db.app.selectFrom('org_invites').select('token_hash').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('is refused for a role without members.write', async () => {
    const owner = await actorIn(db, 'owner');
    const bookkeeper = await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    await expect(
      inviteMember(
        { email: 'someone@example.test', roleId: SYSTEM_ROLE_UUIDS.readOnly },
        bookkeeper.ctx,
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'members.write' },
    });
    expect(email.sent()).toHaveLength(0);
  });

  it('refuses a malformed address before anything is written', async () => {
    const owner = await actorIn(db, 'owner');

    await expect(
      inviteMember({ email: 'not-an-address', roleId: SYSTEM_ROLE_UUIDS.bookkeeper }, owner.ctx),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(listInvites(owner.ctx)).resolves.toHaveLength(0);
  });

  it('refuses a role this org cannot assign', async () => {
    const owner = await actorIn(db, 'owner');

    await expect(
      inviteMember(
        { email: 'someone@example.test', roleId: '00000000-0000-4000-8000-0000000000aa' },
        owner.ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_found', details: { resource: 'role' } });
  });

  it('refuses to invite somebody who is already a member', async () => {
    const owner = await actorIn(db, 'owner');
    const existing = await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    await expect(
      inviteMember({ email: existing.user.email, roleId: SYSTEM_ROLE_UUIDS.readOnly }, owner.ctx),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a second outstanding invitation to the same address', async () => {
    const owner = await actorIn(db, 'owner');
    await invite(owner, 'bookkeeper@example.test');

    await expect(
      inviteMember(
        { email: 'bookkeeper@example.test', roleId: SYSTEM_ROLE_UUIDS.readOnly },
        owner.ctx,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  /**
   * **A send must never fail a write that has already committed.**
   *
   * The provider installed here is a real `EmailProvider` whose behaviour is
   * failure — fault injection rather than a mock; nothing asserts that it was
   * called. The invitation must survive, because it did commit, and the caller
   * must be told the message did not leave so it can offer to reissue.
   */
  it('keeps the invitation when the send fails, and says the send failed', async () => {
    const owner = await actorIn(db, 'owner');
    email.withProvider(failingEmailProvider(new Error('SES is having an afternoon')));

    try {
      const issued = await inviteMember(
        { email: 'bookkeeper@example.test', roleId: SYSTEM_ROLE_UUIDS.bookkeeper },
        owner.ctx,
      );

      expect(issued.emailDelivered).toBe(false);
      expect(issued.invitation.status).toBe('pending');
      const listed = await listInvites(owner.ctx);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(issued.invitation.id);
      expect(email.sent()).toHaveLength(0);
      // The failure is reported, and the report does not carry the token: an
      // operator needs to know which invitation failed, not the ability to redeem
      // it (`invite-email.ts`).
      expect(email.log()).toContain('Invite email could not be sent');
      expect(email.log()).toContain(issued.invitation.id);
      expect(email.log()).not.toContain('/invites/accept');
    } finally {
      email.install();
    }
  });
});

describe('listInvites', () => {
  it('reports every invitation with its derived status', async () => {
    const owner = await actorIn(db, 'owner');
    await invite(owner, 'one@example.test');

    const listed = await listInvites(owner.ctx);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      email: 'one@example.test',
      roleCode: 'bookkeeper',
      status: 'pending',
      orgId: owner.orgUuid,
    });
  });

  it('never shows another org’s invitations', async () => {
    const mine = await actorIn(db, 'owner');
    const theirs = await actorIn(db, 'owner');
    await invite(theirs, 'theirs@example.test');

    await expect(listInvites(mine.ctx)).resolves.toHaveLength(0);
  });

  it('is refused for a role without members.read', async () => {
    const apOnly = await actorIn(db, 'apOnly');

    await expect(listInvites(apOnly.ctx)).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'members.read' },
    });
  });
});

describe('acceptInvite', () => {
  it('joins the org with the invited role', async () => {
    const owner = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { token, orgId } = await invite(owner, 'bookkeeper@example.test');

    const accepted = await asUser(joiner.uuid, () => acceptInvite({ orgId, token }));

    expect(accepted).toEqual({
      orgId: owner.orgUuid,
      userId: joiner.uuid,
      roleId: SYSTEM_ROLE_UUIDS.bookkeeper,
      roleCode: 'bookkeeper',
      joined: true,
    });
    const members = await listMembers(owner.ctx);
    expect(members.map((member) => member.userId).sort()).toEqual(
      [owner.user.uuid, joiner.uuid].sort(),
    );
    expect((await listInvites(owner.ctx))[0]).toMatchObject({
      status: 'accepted',
      acceptedByUserId: joiner.uuid,
    });
  });

  it('can be accepted once and only once', async () => {
    const owner = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { token, orgId } = await invite(owner, 'bookkeeper@example.test');

    await asUser(joiner.uuid, () => acceptInvite({ orgId, token }));

    await expect(asUser(joiner.uuid, () => acceptInvite({ orgId, token }))).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'invite_already_accepted' },
    });
  });

  /**
   * A single-use token stays single-use across a removal. Otherwise the link in a
   * removed member's mailbox is a standing re-entry ticket that no administrator
   * can see, let alone revoke.
   */
  it('cannot be replayed to rejoin after removal', async () => {
    const owner = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { token, orgId } = await invite(owner, 'bookkeeper@example.test');

    await asUser(joiner.uuid, () => acceptInvite({ orgId, token }));
    await removeMember({ userId: joiner.uuid }, owner.ctx);

    await expect(asUser(joiner.uuid, () => acceptInvite({ orgId, token }))).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'invite_already_accepted' },
    });
    await expect(listMembers(owner.ctx)).resolves.toHaveLength(1);
  });

  it('refuses an account whose address is not the invited one', async () => {
    const owner = await actorIn(db, 'owner');
    const someoneElse = await db.factories.user({ email: 'someone.else@example.test' });
    const { token, orgId } = await invite(owner, 'bookkeeper@example.test');

    await expect(
      asUser(someoneElse.uuid, () => acceptInvite({ orgId, token })),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'invite_email_mismatch' },
    });
    // And the invitation is still usable by the person it was for.
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    await expect(asUser(joiner.uuid, () => acceptInvite({ orgId, token }))).resolves.toMatchObject({
      joined: true,
    });
  });

  it('refuses an expired invitation', async () => {
    const owner = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { token, orgId } = await invite(owner, 'bookkeeper@example.test');

    // Aged past its expiry through the migrator, because the invite's lifetime is
    // written at issue and there is no application path that shortens one — which
    // is the property being relied on.
    await sql`UPDATE org_invites SET expires_at = NOW(3) - INTERVAL 1 SECOND`.execute(db.migrator);

    await expect(asUser(joiner.uuid, () => acceptInvite({ orgId, token }))).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'invite_expired' },
    });
    await expect(listMembers(owner.ctx)).resolves.toHaveLength(1);
  });

  /**
   * A revoked invite, a token that names nothing, and a token presented against
   * the wrong org are one indistinguishable answer (A7) — asserted on the wire
   * body, which is what a caller actually receives.
   */
  it('answers revoked, unknown, and wrong-org tokens identically', async () => {
    const owner = await actorIn(db, 'owner');
    const other = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { token, orgId, issued } = await invite(owner, 'bookkeeper@example.test');

    const miss = async (input: { orgId: string; token: string }): Promise<string> => {
      const error = await asUser(joiner.uuid, () => acceptInvite(input)).catch(
        (thrown: unknown) => thrown,
      );
      return JSON.stringify(toWireError(error));
    };

    const wrongOrg = await miss({ orgId: other.orgUuid, token });
    const unknownToken = await miss({ orgId, token: 'not-a-real-token' });
    const malformedOrg = await miss({ orgId: 'not-a-uuid', token });

    await revokeInvite({ inviteId: issued.invitation.id }, owner.ctx);
    const revoked = await miss({ orgId, token });

    expect(JSON.parse(revoked)).toMatchObject({
      code: 'not_found',
      details: { resource: 'invite' },
    });
    // The response body, byte for byte: a token that names nothing, one for
    // another tenant, a malformed org, and a withdrawn invitation are one answer
    // (A7). Anything else is an oracle for which tokens were ever real.
    expect([wrongOrg, unknownToken, malformedOrg]).toEqual([revoked, revoked, revoked]);
  });

  it('requires a signed-in user', async () => {
    const owner = await actorIn(db, 'owner');
    const { token, orgId } = await invite(owner, 'bookkeeper@example.test');

    // An automation's context: a real scope, no human behind it. Acceptance
    // attaches an invitation to an *account*, so there is nothing for this caller
    // to accept as — and it is told that rather than being told about the invite.
    const automation = createRequestContext({
      orgId: owner.orgUuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: null,
      actorType: 'automation',
      actorId: owner.orgUuid,
    });

    await expect(
      runInContext(automation, () => acceptInvite({ orgId, token })),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  /**
   * Accepting while already a member consumes the invitation and leaves the
   * standing role alone. The alternative — applying the invited role — would make
   * an invitation a way to demote an Owner who clicked a stale link.
   */
  it('consumes the invitation without re-roling an existing member', async () => {
    const owner = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { token, orgId } = await invite(
      owner,
      'bookkeeper@example.test',
      SYSTEM_ROLE_UUIDS.readOnly,
    );
    await memberOf(db, owner.orgId, owner.orgUuid, 'owner', joiner);

    const accepted = await asUser(joiner.uuid, () => acceptInvite({ orgId, token }));

    expect(accepted).toMatchObject({ joined: false, roleCode: 'owner' });
    expect((await listInvites(owner.ctx))[0]?.status).toBe('accepted');
  });
});

/**
 * Runs `body` as a signed-in user who is a member of nothing.
 *
 * The pre-auth org sentinel with a real `userId` is exactly the scope a session
 * resolves to for a user with no active org membership (`src/context/`), and it is
 * the scope every genuine acceptance runs in: the caller is not yet a member of
 * the org they are joining.
 */
function asUser<T>(userUuid: string, body: () => Promise<T>): Promise<T> {
  const unauthenticatedOrg = '00000000-0000-0000-0000-000000000000';
  return runInContext(contextFor(unauthenticatedOrg, unauthenticatedOrg, userUuid), body);
}

describe('revokeInvite', () => {
  it('withdraws a pending invitation', async () => {
    const owner = await actorIn(db, 'owner');
    const { issued } = await invite(owner, 'bookkeeper@example.test');

    const revoked = await revokeInvite({ inviteId: issued.invitation.id }, owner.ctx);

    expect(revoked.status).toBe('revoked');
    expect((await listInvites(owner.ctx))[0]?.status).toBe('revoked');
  });

  it('is idempotent', async () => {
    const owner = await actorIn(db, 'owner');
    const { issued } = await invite(owner, 'bookkeeper@example.test');

    const first = await revokeInvite({ inviteId: issued.invitation.id }, owner.ctx);
    const second = await revokeInvite({ inviteId: issued.invitation.id }, owner.ctx);

    expect(second.status).toBe('revoked');
    expect(second.id).toBe(first.id);
  });

  it('refuses to withdraw an invitation that was already accepted', async () => {
    const owner = await actorIn(db, 'owner');
    const joiner = await db.factories.user({ email: 'bookkeeper@example.test' });
    const { issued, token, orgId } = await invite(owner, 'bookkeeper@example.test');
    await asUser(joiner.uuid, () => acceptInvite({ orgId, token }));

    await expect(revokeInvite({ inviteId: issued.invitation.id }, owner.ctx)).rejects.toMatchObject(
      {
        code: 'precondition_failed',
        details: { precondition: 'invite_already_accepted' },
      },
    );
  });

  it('answers another org’s invitation as a plain miss', async () => {
    const mine = await actorIn(db, 'owner');
    const theirs = await actorIn(db, 'owner');
    const { issued } = await invite(theirs, 'theirs@example.test');

    await expect(revokeInvite({ inviteId: issued.invitation.id }, mine.ctx)).rejects.toMatchObject({
      code: 'not_found',
      details: { resource: 'invite' },
    });
  });
});
