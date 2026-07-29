/**
 * The OAuth 2.1 authorization server (OB-098; ROADMAP D-53, D-54, D-61).
 *
 * `oauth.service.ts` carries the design notes worth reading first — the split
 * between this project's own JSON operations (client management, authorize,
 * consent, connected apps) and the two RFC 6749/7009 wire endpoints that never
 * throw this project's envelope errors, and why the token/revocation endpoints
 * resolve their own org from a presented credential rather than from a session.
 *
 * `touchOAuthTokenLastUsed` and `selectOAuthClientById` are re-exported for
 * `modules/auth/oauth-identity.ts`'s sake — the bearer identity resolver lives in
 * `auth/` beside `resolveSessionIdentity` (both produce a `ResolvedIdentity`,
 * neither may import transport), but it needs this module's mechanical row access
 * to touch `last_used_at` and to re-check a token's client is still active.
 */
export type {
  ListConnectedAppsQuery,
  ListOAuthClientsQuery,
  OAuthAuthorizationDecision,
  OAuthGrantOutcome,
  OAuthTokenErrorResult,
  OAuthTokenResult,
  OAuthTokenSuccessResult,
} from './oauth.service';
export {
  authorizeRequest,
  deactivateOAuthClient,
  exchangeToken,
  grantAuthorization,
  listConnectedApps,
  listOAuthClients,
  registerOAuthClient,
  revokeConnectedApp,
  revokeToken,
} from './oauth.service';

export type { OAuthClientRow } from './oauth.repository';
export {
  OAUTH_CLIENT_RESOURCE,
  selectOAuthClientById,
  touchOAuthTokenLastUsed,
} from './oauth.repository';
