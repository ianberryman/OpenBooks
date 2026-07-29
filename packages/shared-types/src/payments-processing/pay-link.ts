import { z } from 'zod';

/**
 * The pay-link (initiative J, ROADMAP D-82…D-86, D-83). Reuses the hosted
 * invoice page (`delivery/delivery.ts`) as its surface — a customer opens the
 * page at the capability-token URL, clicks pay, and this is what stands
 * between that click and the processor's own hosted checkout.
 *
 * No `.meta({ id })` here yet, for `connections.ts`'s reason: the route
 * arrives in a later stream (OB-150) and an id with no route publishes a
 * `components.schemas` entry nothing can reach.
 */
export const payLinkResponseSchema = z
  .strictObject({
    url: z.url().meta({
      description:
        'The processor’s own hosted-checkout URL (D-83). The customer enters card details ' +
        'there, never on an OpenBooks page.',
    }),
  })
  .meta({
    description:
      'The pay-link on the hosted invoice page: the processor’s own hosted-checkout URL, ' +
      'reused from the invoice-delivery capability token (`delivery/delivery.ts`).',
  });

export type PayLinkResponse = z.infer<typeof payLinkResponseSchema>;
