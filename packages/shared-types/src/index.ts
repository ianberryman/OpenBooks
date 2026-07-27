/**
 * @openbooks/shared-types — Zod schemas, the single source of truth for
 * validation, TypeScript types, and the published OpenAPI spec (spec §3).
 *
 * One rule governs every schema here and it is easy to break by accident:
 * `.meta({ id })` puts a schema into `components.schemas` in `openapi.json`
 * whether or not a route references it, because the transform lifts the whole zod
 * registry rather than the reachable subset. So an `id` belongs on a request-body
 * or response schema that a route uses, and on nothing else — see the block at the
 * top of `accounts/accounts.ts`.
 */

export * from './accounts';
export * from './auth';
export * from './contacts';
export * from './dimensions';
export * from './drafts';
export * from './journals';
export * from './members';
export * from './money';
export * from './orgs';
export * from './periods';
export * from './reports';
export * from './wire';
