/**
 * Invoicing automation's wire contracts (Phase 4).
 *
 * `recurring.ts` — recurring-invoice templates (OB-128; ROADMAP D-75, D-76); see it for the
 * template shape and why `startDate` is create-only and never appears on the response.
 * `dunning.ts` — dunning policies and their ordered reminder stages (OB-129; D-77).
 */

export * from './recurring';
export * from './dunning';
