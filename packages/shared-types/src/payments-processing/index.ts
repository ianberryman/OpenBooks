/**
 * Payment-processor integration (initiative J, OB-143…153; ROADMAP D-82…D-86,
 * D-101…D-104).
 *
 * `connections.ts` — connecting an org's own Stripe or Square to a clearing
 * account and a fee account (D-103), and the connection DTO the UI reads back
 * (never carrying the secret key or webhook secret, D-83).
 * `pay-link.ts` — the hosted-checkout link the pay button on the hosted
 * invoice page (`delivery/delivery.ts`) opens.
 *
 * Neither file carries a `.meta({ id })` yet — the routes arrive in a later
 * stream (OB-150/OB-151) and an id with no route publishes a
 * `components.schemas` entry nothing can reach, `delivery/branding.ts`'s
 * reason exactly.
 */

export {
  connectProcessorRequestSchema,
  PROCESSOR_EXTERNAL_ACCOUNT_ID_MAX_LENGTH,
  PROCESSOR_KINDS,
  PROCESSOR_PUBLISHABLE_KEY_MAX_LENGTH,
  processorConnectionSchema,
  processorKindSchema,
} from './connections';
export type { ConnectProcessorRequest, ProcessorConnection, ProcessorKind } from './connections';

export { payLinkResponseSchema } from './pay-link';
export type { PayLinkResponse } from './pay-link';
