import { getContext, isAuthenticatedContext } from '../../context';
import { newUuid, systemDb, uuidToBuffer, withTransaction } from '../../db';
import { ConflictError, UnauthenticatedError, ValidationError } from '../../errors';
import type { OrgCreationInput, OrgMembership } from '../orgs';
import { createOrgIn, listMemberships, resolveOrgMembership } from '../orgs';
import { SESSION_TTL_MS } from './cookie';
import {
  hashPassword,
  needsPasswordRehash,
  PASSWORD_LENGTH_BOUNDS,
  passwordLength,
  verifyPassword,
} from './password';
import { newSessionToken, sessionTokenHash } from './tokens';
import {
  insertSession,
  insertUser,
  isDuplicateEntryError,
  recordLogin,
  revokeSessionByTokenHash,
  selectSessionByTokenHash,
  selectUserByEmail,
  selectUserById,
  updateSessionActiveOrg,
} from './auth.repository';

/**
 * Session authentication: register, login, logout, `me`, and the org switch
 * (spec §5, OB-015).
 *
 * Spec §5 has three credential types all resolving to an `(org_id, role_id)` context.
 * This is the session one. The other two arrive later (`api_keys` in M5, OAuth with the
 * authorization server), and the shape they share is the reason nothing below returns a
 * role: the role belongs to the *membership*, `org_members` is many-to-many, and
 * `resolveMembership` is the one function that turns a (user, org) pair into authority.
 * Everything here that needs a role asks it.
 *
 * No route lives in this file. OB-023 owns the HTTP surface; these are the functions it
 * calls, and they are equally callable from an MCP tool (M5) or the workflow engine
 * (M6) because none of them touches a request or a reply.
 */

/** `users.email` is `VARCHAR(320)` — the practical maximum for an address. */
const MAX_EMAIL_LENGTH = 320;

/** `users.display_name` is `VARCHAR(255)`. */
const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * Deliberately loose. This checks that a value is shaped like an address, not that it
 * is deliverable — RFC 5322 permits far more than any regex people write for it, and
 * the strict-looking patterns in circulation reject valid addresses (quoted local
 * parts, new TLDs, `+` tags in unexpected places). Deliverability is settled by sending
 * mail to it, which is M2's invite flow.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Who the caller is and what they may act as.
 *
 * `memberships` is the org switcher's menu, and it is always the full list rather than
 * the active org alone: spec §5's motivating case is one login that is Owner of its own
 * books and Read-only on a client's, so a client that only ever learns about the
 * current org cannot render a switcher at all.
 *
 * `activeOrgId` is null for a user who is a member of nothing — a real state, reached by
 * being removed from the last org. It is deliberately read from the request context
 * rather than from `sessions.active_org_id`, because the context's org has been
 * re-validated against `org_members` and the column has not.
 */
export interface AuthenticatedIdentity {
  readonly user: AuthenticatedUser;
  readonly memberships: readonly OrgMembership[];
  readonly activeOrgId: string | null;
}

/**
 * A newly issued session. `sessionToken` is the only time the token exists in this
 * process — `sessions.token_hash` holds a digest and nothing can recover it (see
 * `tokens.ts`), so a caller that drops this value has issued a session nobody can use.
 */
export interface IssuedSession {
  readonly sessionToken: string;
  readonly expiresAt: Date;
  readonly identity: AuthenticatedIdentity;
}

export interface RegistrationInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  /**
   * Required, because a user with no membership can do nothing in M1: every permission
   * is a statement about authority within an org. The other way an account comes into
   * existence — accepting an invite to an org that already exists — is a second entry
   * point (M2, `org_invites` is already in the schema), not this one with the org made
   * optional.
   */
  readonly org: OrgCreationInput;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Creates a user, their first org, an Owner membership, and a session — atomically.
 *
 * The four are one fact. An org with no members is unreachable (every read of it goes
 * through `org_members`), a user with no membership can do nothing, and a registration
 * that half-succeeded would leave an email address claimed by an account its owner
 * cannot use and cannot re-register.
 *
 * The transaction is opened on `systemDb()` rather than through `tenantDb(orgId)`,
 * because `users` and `orgs` are not tenant tables, so a transaction opened via the
 * tenant wrapper would enclose the membership insert and neither of the other two. See
 * the note at the top of `../orgs/orgs.repository.ts`.
 *
 * `withTransaction` rather than `systemDb().transaction()`, because OB-028 wraps this
 * call in an org-less idempotency claim: the claim's transaction is already in scope by
 * the time this runs, and Kysely throws on `Transaction.transaction()`.
 *
 * Password hashing happens before the transaction opens. It is tens of milliseconds of
 * CPU, and holding row locks across it for no reason is how a login endpoint becomes a
 * lock-contention problem under load. Under an org-less claim the hash is inside the
 * claim's transaction and there is nowhere else to put it — the cost is bounded, because
 * the only row locked is the claim's own index entry and the only request that can
 * contend for it is a retry of this same request.
 */
export async function register(input: RegistrationInput): Promise<IssuedSession> {
  const email = requireEmail(input.email);
  const displayName = requireDisplayName(input.displayName);
  requirePasswordPolicy(input.password);

  const passwordHash = await hashPassword(input.password);

  // Checked before the insert so the ordinary case gets a message naming the problem.
  // The unique index is what actually guarantees it; the catch below is the race.
  if ((await selectUserByEmail(email)) !== undefined) throw emailTakenError();

  const userId = newUuid();
  const userKey = uuidToBuffer(userId);
  const sessionToken = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const membership = await withTransaction(systemDb(), async (trx) => {
    try {
      await insertUser(trx, { id: userKey, email, displayName, passwordHash });
    } catch (error) {
      // `uq_users_email` is the only unique key on `users`, so a duplicate here is
      // always the email — no need to inspect which index fired.
      if (isDuplicateEntryError(error)) throw emailTakenError();
      throw error;
    }

    const created = await createOrgIn(trx, input.org, userKey);

    await insertSession(trx, {
      id: uuidToBuffer(newUuid()),
      userId: userKey,
      tokenHash: sessionTokenHash(sessionToken),
      activeOrgId: uuidToBuffer(created.org.id),
      expiresAt,
    });

    return created;
  });

  return {
    sessionToken,
    expiresAt,
    identity: {
      user: { id: userId, email, displayName },
      memberships: [membership],
      activeOrgId: membership.org.id,
    },
  };
}

/**
 * Exchanges a password for a session.
 *
 * ## Why every failure looks the same, and costs the same
 *
 * `UnauthenticatedError` takes no message precisely so that "no such user" and "wrong
 * password" cannot be told apart (see its commentary in `src/errors/errors.ts`) — the
 * same reasoning as A7, one layer earlier. A matching *status* is not enough on its own,
 * though: if a missing user returned without hashing anything, the response would come
 * back in a millisecond instead of forty, and the timing difference is a working
 * user-enumeration oracle regardless of what the body says.
 *
 * So an unknown email, and an email belonging to a deactivated user, are verified
 * against a decoy hash rather than short-circuited. Same work, same duration, same
 * answer.
 */
export async function login(input: LoginInput): Promise<IssuedSession> {
  // Normalized, never validated. Rejecting a malformed address here would answer a
  // login attempt faster and differently than a well-formed unknown one, which is the
  // oracle this function is built to avoid. Policy applies at registration only —
  // otherwise raising the password minimum would make old passwords un-enterable and
  // tell an attacker which accounts predate the change.
  const email = normalizeEmail(input.email);
  const user = await selectUserByEmail(email);

  const candidateHash = user !== undefined && user.isActive ? user.passwordHash : await decoyHash();
  const verified = await verifyPassword(candidateHash, input.password);

  if (!verified || user === undefined || !user.isActive) throw new UnauthenticatedError();

  const now = new Date();
  await recordLogin(
    user.id,
    now,
    // Upgrading the stored hash is only possible while the plaintext is in hand, which
    // is here and nowhere else. See `password.ts` on changing the cost parameters.
    needsPasswordRehash(user.passwordHash) ? await hashPassword(input.password) : undefined,
  );

  const memberships = await listMemberships(user.id);
  const activeOrgId = memberships[0]?.org.id ?? null;

  const sessionToken = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await insertSession(systemDb(), {
    id: uuidToBuffer(newUuid()),
    userId: uuidToBuffer(user.id),
    tokenHash: sessionTokenHash(sessionToken),
    activeOrgId: activeOrgId === null ? null : uuidToBuffer(activeOrgId),
    expiresAt,
  });

  return {
    sessionToken,
    expiresAt,
    identity: {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      memberships,
      activeOrgId,
    },
  };
}

/**
 * Revokes a session. Succeeds whether or not the token names one.
 *
 * Takes the token rather than reading the context, because the context has no session
 * id to read: `OperationContext` carries the actor, not the credential the actor
 * presented, and one user may hold several live sessions in several browsers. Logging
 * out of "the current session" therefore has to name it, and the only name it has is the
 * token.
 *
 * A token naming nothing is a no-op and not a `404`: logout is the one operation a
 * client legitimately calls with a stale cookie, and reporting a miss would both break
 * that and confirm which tokens were once real.
 */
export async function logout(sessionToken: string): Promise<void> {
  await revokeSessionByTokenHash(sessionTokenHash(sessionToken), new Date());
}

/**
 * The caller's identity and org menu.
 *
 * Gated on `userId` rather than on `isAuthenticatedContext`, and the difference is not
 * pedantic: a user who has just been removed from their only org has a valid session and
 * no org scope, so their context is "unauthenticated" by the org test while still being
 * unambiguously a signed-in person. `me` is exactly the call such a user needs to work —
 * it is what tells a client to render "you are not a member of any organization" instead
 * of bouncing to a login form that will succeed and change nothing.
 */
export async function me(): Promise<AuthenticatedIdentity> {
  const context = getContext('me()');
  if (context.userId === null) throw new UnauthenticatedError();

  const user = await selectUserById(context.userId);
  // The context named a user that is no longer there, or is deactivated. Nothing the
  // caller can fix and nothing worth distinguishing: their credential is void.
  if (user === undefined || !user.isActive) throw new UnauthenticatedError();

  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    memberships: await listMemberships(user.id),
    activeOrgId: isAuthenticatedContext(context) ? context.orgId : null,
  };
}

/**
 * Points the caller's session at a different org, and re-derives what they hold there.
 *
 * ## What makes this safe
 *
 * Membership is re-resolved through `resolveOrgMembership` before `active_org_id` is
 * written, so the stored value is never ahead of a verified membership — but that
 * ordering is tidiness, not the security property. The security property is that the
 * column is re-validated on every subsequent request (`identity.ts`), so even a value
 * written correctly today grants nothing tomorrow if the membership is gone. Migration
 * `0001_tenancy` explains why it cannot be a foreign key and must not be trusted alone;
 * this is the write side of that.
 *
 * The returned role is the one just resolved, not one derived from the previous scope. An
 * accountant switching from their own books to a client's is switching from Owner to
 * Read-only, and carrying a role across the switch would be the whole failure mode.
 *
 * The session is read before it is written, rather than inferring "no live session" from
 * an update that changed no rows: switching to the org that is already active changes
 * nothing, and MySQL's `affectedRows` cannot tell that apart from a session that is not
 * there (see `updateSessionActiveOrg`).
 *
 * ## A7
 *
 * An org the caller is not a member of and an org that does not exist both raise
 * `NotFoundError('org')`, from a single line inside `resolveOrgMembership`. Nothing here
 * reads the `orgs` row before membership is settled, so there is no branch that could
 * answer the two differently — and the credential check above it runs before either, so
 * its outcome cannot vary with the org that was asked for.
 */
export async function switchActiveOrg(sessionToken: string, orgId: string): Promise<OrgMembership> {
  const context = getContext('switchActiveOrg()');
  if (context.userId === null) throw new UnauthenticatedError();

  const tokenHash = sessionTokenHash(sessionToken);
  const now = new Date();
  const session = await selectSessionByTokenHash(tokenHash);
  if (
    session === undefined ||
    session.userId !== context.userId ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= now.getTime()
  ) {
    throw new UnauthenticatedError();
  }

  const membership = await resolveOrgMembership(context.userId, orgId);
  await updateSessionActiveOrg(tokenHash, context.userId, membership.org.id, now);

  return membership;
}

/**
 * A hash to verify against when there is no user, computed once per process.
 *
 * Of a random password, so nothing in the process holds a plaintext that satisfies it —
 * a hardcoded decoy password would be a hash an attacker could pre-compute and, worse,
 * one somebody could eventually make a real account with.
 *
 * Lazy, so a process that never sees a failed login never pays for it, and cached as the
 * promise rather than the value so two concurrent misses share one computation.
 */
let decoy: Promise<string> | undefined;

function decoyHash(): Promise<string> {
  decoy ??= hashPassword(newSessionToken());
  return decoy;
}

/**
 * Lowercased and trimmed on the way in and on the way back out.
 *
 * `users.email` collates `utf8mb4_0900_ai_ci`, so the database already treats
 * `A@b.test` and `a@b.test` as one address; normalizing as well means the *stored* value
 * agrees with that rather than depending on it, and a future migration to a
 * case-sensitive collation does not silently create a second account for someone.
 */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
}

function requireEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LENGTH) {
    throw new ValidationError('A valid email address is required.', [
      { path: 'email', message: 'must be an email address' },
    ]);
  }
  return email;
}

function requireDisplayName(value: string): string {
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ValidationError('Display name must be 1–255 characters.', [
      {
        path: 'displayName',
        message: `must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters`,
      },
    ]);
  }
  return displayName;
}

/**
 * Length only. See `PASSWORD_LENGTH_BOUNDS` in `password.ts` for why there are no
 * composition rules and why the maximum exists.
 */
function requirePasswordPolicy(password: string): void {
  const length = passwordLength(password);
  if (length < PASSWORD_LENGTH_BOUNDS.min || length > PASSWORD_LENGTH_BOUNDS.max) {
    throw new ValidationError(
      `Password must be between ${PASSWORD_LENGTH_BOUNDS.min} and ` +
        `${PASSWORD_LENGTH_BOUNDS.max} characters.`,
      [
        {
          path: 'password',
          message:
            `must be between ${PASSWORD_LENGTH_BOUNDS.min} and ` +
            `${PASSWORD_LENGTH_BOUNDS.max} characters`,
        },
      ],
    );
  }
}

/**
 * The one place registration admits an address is taken.
 *
 * This is a disclosure and it is chosen knowingly. The privacy-preserving alternative —
 * answer as if registration succeeded and email the existing account instead — needs an
 * `EmailProvider` adapter, which ROADMAP D-07 defers to the milestone that first sends
 * mail. Without one, silence would leave a user unable to sign up, unable to explain
 * why, and with no message arriving to tell them. So M1 says so plainly, and the
 * disclosure is confined to registration: `login` reveals nothing, per its own note.
 */
function emailTakenError(): ConflictError {
  return new ConflictError('That email address is already registered.');
}
