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

export * from './account-statements';
export * from './accountant';
export * from './accounts';
export * from './auth';
export * from './automations';
export * from './bank-feeds';
export * from './banking';
export * from './budgets';
export * from './catalog';
export * from './contacts';
export * from './delivery';
export * from './dimensions';
export * from './drafts';
export * from './fixed-assets';
export * from './imports';
export * from './invoicing';
export * from './journals';
export * from './members';
export * from './money';
export * from './orgs';
export * from './pay-bills';
export * from './payment-terms';
export * from './payments-processing';
export * from './periods';
export * from './platform';
export * from './procurement';
export * from './recurring-journals';
export * from './reports';
export * from './subledger';
export * from './tax';
export * from './ten99';
export * from './wire';
