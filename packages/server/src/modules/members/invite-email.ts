import type { Logger } from '../../logging';
import { outboundEmail } from '../../providers';

/**
 * The invite message, and the one place a send is allowed to fail quietly.
 *
 * ## Where the send sits, and why it is after the commit
 *
 * `inviteMember` commits the `org_invites` row, and only then calls
 * `deliverInvite`. Not inside the transaction, for two reasons that point the same
 * way:
 *
 *  - **A send cannot be rolled back.** A message handed to SES inside a
 *    transaction that then aborts is a live-looking invite whose row does not
 *    exist, so the recipient gets a link that 404s and no explanation. The
 *    database can undo its half; the internet cannot undo ours.
 *  - **A network call inside a transaction holds row locks across it.** The invite
 *    path takes no contended locks today, but "we hold locks while we wait on a
 *    third party's API" is the shape that turns a provider's bad afternoon into a
 *    database incident.
 *
 * And the failure direction matters more than either: **a send must never fail a
 * write that has already committed**. So this function returns a boolean and
 * throws nothing. The invite exists whether or not the mail did; the caller
 * reports `emailDelivered: false` and the inviter can revoke and re-invite, which
 * mints a fresh token and tries again.
 *
 * ## Why this is not a job on the worker
 *
 * The worker role exists and starts cleanly with no registered jobs, so enqueuing
 * here is superficially the obvious answer. It is the wrong one at M2, for three
 * reasons:
 *
 *  1. **It would need a `QueueProvider` adapter, which D-07 has not authorized.**
 *     The rule is that an adapter ships with its first consumer; email's consumer
 *     arrived, the queue's has not. Writing the SQS adapter to carry one email is
 *     writing an adapter for a queue whose real first consumers — the M4 banking
 *     import and the M5 agent task queue — will define what it has to do.
 *  2. **The self-host queue would add no durability.** `QUEUE_PROVIDER=in-process`
 *     runs the job in this process, so for the deployment most likely to have a
 *     flaky mail path, "enqueue" and "call it after the commit" are the same thing
 *     with more moving parts.
 *  3. **A retry needs semantics nobody has chosen yet.** At-least-once delivery
 *     means the same invite can be mailed twice, which is fine, and a dead-letter
 *     path means a failed invite needs somewhere to be seen, which is not fine to
 *     invent in passing. That is a milestone's worth of decisions (spec §14 still
 *     lists Redis-vs-in-process as open), not a line in this ticket.
 *
 * When the queue does arrive, the change is this function's body and nothing else:
 * the caller already treats delivery as fallible and unordered with respect to its
 * own success.
 */

export interface InviteMessageInput {
  readonly to: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly roleName: string;
  /** The inviter's display name, or null when the row has gone. */
  readonly invitedBy: string | null;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/**
 * Text only, no HTML part.
 *
 * An HTML invite is prettier and is a second copy of the same content that has to
 * be kept in step with the first, and the one thing the message has to do — carry
 * a link that works — text does without a rendering engine's help. It is also the
 * form that survives every client, including the terminal a self-host operator
 * reads the log adapter's output in.
 */
export function buildInviteMessage(input: InviteMessageInput, appBaseUrl?: string): EmailMessage {
  const link = acceptLink(input.orgId, input.token, appBaseUrl);
  const from = input.invitedBy === null ? 'Someone' : input.invitedBy;

  return {
    to: input.to,
    subject: `You have been invited to ${input.orgName} on OpenBooks`,
    text:
      `${from} invited you to join ${input.orgName} on OpenBooks as ${input.roleName}.\n\n` +
      `Accept the invitation:\n${link}\n\n` +
      `The invitation expires on ${input.expiresAt.toISOString()} and can only be accepted ` +
      `once, by the account registered to ${input.to}.\n\n` +
      'If you were not expecting this, ignore it — nothing happens until you accept, and the ' +
      'invitation lapses on its own.\n',
  };
}

/**
 * The accept link.
 *
 * Carries the org as well as the token because `org_invites` is a tenant table and
 * the redemption has to be scoped before the token can be looked up at all — see
 * `acceptInviteRequestSchema` for the full argument. The org id is not a secret and
 * grants nothing on its own.
 *
 * Relative when no `APP_BASE_URL` is configured. That is deliberately a visible
 * half-answer rather than a plausible default: a link to the wrong host looks
 * correct and fails silently, while a path is obviously incomplete to whoever reads
 * it and is trivially completed by the operator who knows the origin.
 */
function acceptLink(orgId: string, token: string, appBaseUrl: string | undefined): string {
  const path = `/invites/accept?org=${encodeURIComponent(orgId)}&token=${encodeURIComponent(token)}`;
  return appBaseUrl === undefined ? path : new URL(path, appBaseUrl).toString();
}

/**
 * Sends the invite. Never throws.
 *
 * The failure log names the org and the invite and carries the provider's error —
 * and never the message, because the message contains the token. An operator
 * diagnosing a failed send needs to know which invite failed and why, and needs no
 * ability to impersonate its recipient. (The `log` adapter does write the body, on
 * purpose and with its own note; that is a deployment choosing where its
 * credentials go, not this function leaking one into an error path.)
 */
export async function deliverInvite(input: InviteMessageInput, inviteId: string): Promise<boolean> {
  let logger: Logger | undefined;
  try {
    const outbound = outboundEmail();
    logger = outbound.logger;
    await outbound.provider.send(buildInviteMessage(input, outbound.appBaseUrl));
    return true;
  } catch (error) {
    /**
     * `logger` is undefined only if resolving the outbound seam itself threw,
     * which means `getConfig()` failed — and in a running process it cannot,
     * because every entrypoint resolves configuration before it serves anything.
     * The alternative to leaving that branch silent is reaching for `getLogger()`
     * here, which resolves the same configuration and would therefore throw out of
     * the one function whose contract is that it does not.
     */
    logger?.error(
      { err: error, inviteId, orgId: input.orgId },
      'Invite email could not be sent. The invitation exists and can be revoked and reissued.',
    );
    return false;
  }
}
