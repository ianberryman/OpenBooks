import { describe, expect, it } from 'vitest';

import { buildInviteMessage } from '../../src/modules/members/invite-email';

/**
 * The message itself (OB-040).
 *
 * `invites.service.test.ts` proves the link works by redeeming it. This file
 * covers the shape of what a recipient reads, and one thing that suite cannot
 * reach: what the link looks like when the operator has not declared the app's
 * public origin.
 */
const input = {
  to: 'bookkeeper@example.test',
  orgId: '11111111-1111-4111-8111-111111111111',
  orgName: 'Ferris Wheel Co',
  roleName: 'Bookkeeper',
  invitedBy: 'Dana Owner',
  token: 'a-token-value',
  expiresAt: new Date('2026-08-02T09:00:00.000Z'),
};

describe('buildInviteMessage', () => {
  it('names the org, the role, and the inviter', () => {
    const message = buildInviteMessage(input, 'https://books.example.test');

    expect(message.to).toBe('bookkeeper@example.test');
    expect(message.subject).toBe('You have been invited to Ferris Wheel Co on OpenBooks');
    expect(message.text).toContain('Dana Owner invited you to join Ferris Wheel Co');
    expect(message.text).toContain('as Bookkeeper');
    expect(message.text).toContain('2026-08-02T09:00:00.000Z');
  });

  it('builds an absolute link against the configured origin', () => {
    const message = buildInviteMessage(input, 'https://books.example.test');

    expect(message.text).toContain(
      'https://books.example.test/invites/accept?org=11111111-1111-4111-8111-111111111111' +
        '&token=a-token-value',
    );
  });

  /**
   * A path, not a link to a guessed host. `APP_BASE_URL` is optional because the
   * server cannot derive it, and the failure mode of a plausible default — a link
   * that looks right and resolves somewhere else — is worse than an obviously
   * incomplete one that whoever reads the log can complete.
   */
  it('emits a relative path when no origin is configured', () => {
    const message = buildInviteMessage(input);

    expect(message.text).toContain(
      '/invites/accept?org=11111111-1111-4111-8111-111111111111&token=a-token-value',
    );
    expect(message.text).not.toContain('http');
  });

  it('says "Someone" when the inviter is not a user', () => {
    const message = buildInviteMessage({ ...input, invitedBy: null });

    expect(message.text).toContain('Someone invited you to join Ferris Wheel Co');
  });

  /** Percent-encoded, so a token containing `-` or `_` survives the round trip. */
  it('encodes the token into the query string', () => {
    const message = buildInviteMessage({ ...input, token: 'a b&c' }, 'https://books.example.test');

    expect(message.text).toContain('token=a%20b%26c');
  });
});
