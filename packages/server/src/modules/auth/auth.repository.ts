import type { Kysely } from 'kysely';

import type { DB } from '../../db';
import { bufferToUuid, systemDb, tryUuidToBuffer, uuidToBuffer } from '../../db';

/**
 * Reads and writes for `users` and `sessions`.
 *
 * Both are `systemDb` tables and neither has an `org_id`: spec §5 makes one login hold
 * membership in N orgs, so a user scoped to an org would force one account per client
 * engagement (the commentary on `users` in `0001_tenancy.ts`), and a session belongs to
 * the user rather than to any org it happens to be looking at.
 *
 * Nothing here reads `sessions.active_org_id` to authorize anything. It is selected and
 * handed to the service as a *hint*, which `resolveMembership` then re-validates on
 * every request — see the `sessions` commentary in `0001_tenancy.ts` for why it cannot
 * be a foreign key and must not be trusted alone.
 */
type SystemExecutor = Kysely<DB>;

/** mysql2's `errno` for a unique constraint violation (`ER_DUP_ENTRY`). */
const DUPLICATE_ENTRY_ERRNO = 1062;

export function isDuplicateEntryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { errno?: unknown }).errno === DUPLICATE_ENTRY_ERRNO
  );
}

/**
 * How stale `last_seen_at` is allowed to get: **15 minutes**.
 *
 * The column is worth maintaining — a session list in the account UI and any future
 * idle timeout both read it, and neither can be added retroactively to sessions that
 * never recorded it. Writing it on every request is not worth it: it would make every
 * authenticated read a write, on the hottest path in the system, for a value whose
 * consumers do not care about the difference between "now" and "ten minutes ago". The
 * throttle is free to evaluate because the row has already been read.
 */
const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000;

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly isActive: boolean;
}

export interface NewUserRow {
  readonly id: Buffer;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

/** A live-or-not session together with the user it belongs to. One query, one row. */
export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly activeOrgId: string | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date;
  readonly user: UserRow;
}

export interface NewSessionRow {
  readonly id: Buffer;
  readonly userId: Buffer;
  readonly tokenHash: string;
  readonly activeOrgId: Buffer | null;
  readonly expiresAt: Date;
}

export async function insertUser(executor: SystemExecutor, row: NewUserRow): Promise<void> {
  await executor
    .insertInto('users')
    .values({
      id: row.id,
      email: row.email,
      display_name: row.displayName,
      password_hash: row.passwordHash,
    })
    .execute();
}

/**
 * `users.email` is `utf8mb4_0900_ai_ci`, so this equality is already case- and
 * accent-insensitive at the database. The service lowercases on the way in as well, so
 * the stored value and the comparison agree regardless of collation.
 */
export async function selectUserByEmail(email: string): Promise<UserRow | undefined> {
  const row = await systemDb()
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'password_hash', 'is_active'])
    .where('email', '=', email)
    .executeTakeFirst();

  return row === undefined ? undefined : toUserRow(row);
}

export async function selectUserById(userId: string): Promise<UserRow | undefined> {
  const key = tryUuidToBuffer(userId);
  if (key === undefined) return undefined;

  const row = await systemDb()
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'password_hash', 'is_active'])
    .where('id', '=', key)
    .executeTakeFirst();

  return row === undefined ? undefined : toUserRow(row);
}

/**
 * Records a successful sign-in, and rehashes the password if the stored hash was made
 * with weaker parameters.
 *
 * One statement for both, because a successful login is the only moment the plaintext
 * exists and therefore the only moment a rehash is possible — folding it into the write
 * that was happening anyway means the upgrade costs no extra round trip.
 */
export async function recordLogin(userId: string, at: Date, passwordHash?: string): Promise<void> {
  await systemDb()
    .updateTable('users')
    .set({
      last_login_at: at,
      ...(passwordHash === undefined ? {} : { password_hash: passwordHash }),
    })
    .where('id', '=', uuidToBuffer(userId))
    .execute();
}

export async function insertSession(executor: SystemExecutor, row: NewSessionRow): Promise<void> {
  await executor
    .insertInto('sessions')
    .values({
      id: row.id,
      user_id: row.userId,
      token_hash: row.tokenHash,
      active_org_id: row.activeOrgId,
      expires_at: row.expiresAt,
    })
    .execute();
}

/**
 * The session a token names, with its user, whatever state it is in.
 *
 * Revocation and expiry are returned rather than filtered in SQL on purpose. The
 * service has to distinguish "no such session" from "a session that has expired" for
 * logging — a forged or replayed cookie is an event worth noticing and an expired one
 * is not — and both still produce the same `UnauthenticatedError`, so the distinction
 * costs nothing at the boundary. Filtering here would also put the expiry comparison
 * on the database clock while `expires_at` is written from the application's, which is
 * two clocks deciding one question.
 */
export async function selectSessionByTokenHash(tokenHash: string): Promise<SessionRow | undefined> {
  const row = await systemDb()
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.id as session_id',
      's.user_id',
      's.active_org_id',
      's.expires_at',
      's.revoked_at',
      's.last_seen_at',
      'u.email',
      'u.display_name',
      'u.password_hash',
      'u.is_active',
    ])
    .where('s.token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return {
    id: bufferToUuid(row.session_id),
    userId: bufferToUuid(row.user_id),
    activeOrgId: row.active_org_id === null ? null : bufferToUuid(row.active_org_id),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    user: {
      id: bufferToUuid(row.user_id),
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      isActive: row.is_active === 1,
    },
  };
}

/** Whether enough time has passed to be worth writing `last_seen_at` again. */
export function shouldTouchLastSeen(session: SessionRow, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS;
}

export async function touchLastSeen(sessionId: string, at: Date): Promise<void> {
  await systemDb()
    .updateTable('sessions')
    .set({ last_seen_at: at })
    .where('id', '=', uuidToBuffer(sessionId))
    .execute();
}

/**
 * Points a live session at a different org.
 *
 * Guarded on `user_id` as well as the token: the token alone identifies the session, so
 * the extra predicate is redundant against a correct caller and is what makes an
 * incorrect one harmless rather than cross-account. It also guards on liveness, so a
 * session revoked between the caller's own check and this write is not resurrected by
 * being switched.
 *
 * Returns nothing, and deliberately does not report whether a row changed. MySQL's
 * `affectedRows` counts rows whose values actually *differed*, so switching to the org
 * that is already active updates nothing — and a caller treating that as "no such live
 * session" would reject the most ordinary request there is. Liveness is established by
 * the read in `switchActiveOrg`; these predicates are the narrow race behind it.
 *
 * `active_org_id` is written after the membership has been re-resolved; it is stored as a
 * preference and re-validated on read regardless (`0001_tenancy.ts`), so this write is a
 * convenience for the next request and never an authorization.
 */
export async function updateSessionActiveOrg(
  tokenHash: string,
  userId: string,
  orgId: string,
  now: Date,
): Promise<void> {
  await systemDb()
    .updateTable('sessions')
    .set({ active_org_id: uuidToBuffer(orgId) })
    .where('token_hash', '=', tokenHash)
    .where('user_id', '=', uuidToBuffer(userId))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .execute();
}

/**
 * Revokes the session a token names, if it names one.
 *
 * `revoked_at` rather than a `DELETE`, so that "this session was ended" survives as a
 * fact — spec §14 lists security-event logging for revoked credentials as an open
 * decision, and a deleted row cannot be logged about later.
 *
 * Returns nothing. A token that names no session is not an error and must not be
 * reported as one: logout is the one operation a client may call with a stale cookie as
 * a matter of course, and a `404` there would both break that and confirm which tokens
 * were once real.
 */
export async function revokeSessionByTokenHash(tokenHash: string, at: Date): Promise<void> {
  await systemDb()
    .updateTable('sessions')
    .set({ revoked_at: at })
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .execute();
}

function toUserRow(row: {
  readonly id: Buffer;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly is_active: number;
}): UserRow {
  return {
    id: bufferToUuid(row.id),
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isActive: row.is_active === 1,
  };
}
