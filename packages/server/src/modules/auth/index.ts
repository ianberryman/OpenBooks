/**
 * Session authentication and the org switcher (spec §5, OB-015).
 *
 * Four files carry the decisions worth reading before changing anything here:
 *
 * - `password.ts` — the Argon2id cost parameters and why they are not the library's
 *   defaults (memory is per concurrent hash on an unauthenticated endpoint).
 * - `tokens.ts` — why the stored form is a *fast* hash, which is the opposite of the
 *   answer for passwords and for the opposite reason.
 * - `cookie.ts` — the cookie's lifetime and attributes, and why it is not signed.
 * - `identity.ts` — how `sessions.active_org_id` is re-validated on every request, and
 *   which cookie failures are `null` rather than a `401`.
 *
 * Wiring: `buildApp({ resolveIdentity: resolveSessionIdentity })`. The entrypoint does
 * that, not this module — `resolveSessionIdentity` cannot name transport's
 * `IdentityResolver` type, for the boundary reason set out in `identity.ts`.
 */
export type {
  AuthenticatedIdentity,
  AuthenticatedUser,
  IssuedSession,
  LoginInput,
  RegistrationInput,
} from './auth.service';
export { login, logout, me, register, switchActiveOrg } from './auth.service';

export type {
  CookieCarrier,
  SessionCookie,
  SessionCookieConfig,
  SessionCookieOptions,
} from './cookie';
export {
  clearedSessionCookie,
  readSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionCookie,
} from './cookie';

export type { ResolvedIdentity } from './identity';
export { resolveSessionIdentity } from './identity';

export { PASSWORD_LENGTH_BOUNDS } from './password';
