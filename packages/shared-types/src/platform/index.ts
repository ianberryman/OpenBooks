/**
 * M5's platform wire contracts (OB-097; ROADMAP D-53 through D-58, D-61).
 *
 * `oauth.ts` — the authorization server: client registration, authorize, token,
 * consent, and the connected-apps a user sees under `integrations.read`.
 * `api-keys.ts` — first-party, role-bound server-to-server credentials (D-55).
 * `change-feed.ts` — the resumable, tenant-scoped projection of the event log (D-56, D-57).
 * `external-refs.ts` — the correlation map that makes create idempotent by external
 * identity (D-58).
 *
 * OB-104 gives every response, request, and page shape here a `.meta({ id })` in the same
 * diff as the routes that reference them — each file's own header says which schemas
 * stayed un-ided (querystrings, and the RFC 6749/7009 wire shapes in `oauth.ts`) and why.
 */

export * from './oauth';
export * from './api-keys';
export * from './change-feed';
export * from './external-refs';
