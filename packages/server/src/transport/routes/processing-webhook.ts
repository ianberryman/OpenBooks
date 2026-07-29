import type { ProcessorKind } from '@openbooks/plugin-api';
import { z } from 'zod';

import { bufferToUuid, selectProcessorConnectionOrgAndProcessor } from '../../db';
import { NotFoundError, ValidationError } from '../../errors';
import { handleProcessorWebhook } from '../../modules/payments-processing';
import { runAsAutomation } from '../../modules/scheduling';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';

/**
 * `POST /public/processing/:connectionId/webhook` (OB-148; ROADMAP D-85, F9) —
 * the inbound delivery Stripe/Square/`fake` call, signed and session-less,
 * exactly the shape `public-invoices.ts` and `bill-inbound.ts` are for their own
 * unauthenticated surfaces.
 *
 * ## `:connectionId` resolves the org; the signature is the authorization
 *
 * A webhook carries no session and no org header, only the connection id in the
 * path. `selectProcessorConnectionOrgAndProcessor` (`db/processor-connection-lookup.ts`)
 * is the one sanctioned raw read that answers "whose connection is this" before
 * any org is known — the same shape `resolveOrgIdForInboundToken` is for the
 * bill-capture inbound webhook. Unlike a capability token, `connectionId` is not
 * itself a secret: what actually proves the delivery came from the processor is
 * the signature `handleProcessorWebhook` verifies once the org is resolved
 * (D-85). An unknown or malformed connection id is a `404`, indistinguishable
 * from a signature that then fails to verify against a *real* connection would
 * be a `400` — the two failures look different on purpose, because unlike A7's
 * usual cross-org case there is no caller identity here to protect by collapsing
 * them; a webhook endpoint's shape is not a secret Stripe/Square need hidden.
 *
 * ## This route does **not** use `withGlobalIdempotency`
 *
 * Every other write in this codebase carries an `Idempotency-Key` requirement
 * (spec §12), and the bill-capture inbound webhook (`bill-inbound.ts`) conforms
 * to it. This one deliberately does not: Stripe and Square do not send our
 * header, and the idempotency anchor here is the processor's own event id
 * (`processor_events` + `external_refs`, `webhook.service.ts`'s header) — a
 * *different* mechanism answering the identical question, not an omission
 * (D-85/F9, flagged explicitly per this ticket's own instructions).
 *
 * ## Raw bytes, not the parsed body
 *
 * A signature is computed over the exact bytes the processor sent
 * (`stripe.ts`/`square.ts`/`fake.ts` all HMAC `rawBody` directly), so this route
 * cannot let Fastify's default JSON parser turn the body into a JS value and
 * re-derive bytes from it the way `bill-inbound.ts` does (that file's own
 * comment is explicit that its re-serialization is lossless for JSON *only*
 * because nothing on that path needs byte-exact fidelity — this path does).
 * `addContentTypeParser` is registered on an **encapsulated child instance**,
 * `oauth-flow.ts`'s exact pattern for its own form-urlencoded parser: scoped to
 * this route alone, so every other `/v1` route keeps the app's default JSON
 * parser.
 *
 * ## Business logic lives in `handleProcessorWebhook`
 *
 * This handler does four things and nothing else: resolve the org, read the
 * right signature header for this connection's processor, open the
 * `runAsAutomation` scope, and call the one service function (spec §2.4,
 * transport holds no business logic). Signature verification, the two-level
 * idempotency, and dispatch by event kind are all `webhook.service.ts`'s.
 */
const TAG = 'processing-webhook';

/**
 * Which header each processor signs its delivery with, read case-insensitively
 * (Fastify lowercases every inbound header name, so the keys below already are).
 * `fake`'s is this route's own convention (D-102: `fake` is a real, deterministic
 * third implementation, not Stripe or Square, so it has no vendor header name to
 * match) rather than a value pinned anywhere else in the codebase — flagged as an
 * assumption for the orchestrator to confirm nothing else expects a different name.
 * A `Record<ProcessorKind, string>` rather than a partial lookup: a new
 * `ProcessorKind` does not compile until this route knows its header, the same
 * exhaustiveness `paymentProcessorFor`'s own switch enforces for the adapter itself.
 */
const SIGNATURE_HEADER_BY_PROCESSOR: Record<ProcessorKind, string> = {
  stripe: 'stripe-signature',
  square: 'x-square-hmacsha256-signature',
  fake: 'x-fake-signature',
};

const webhookParamsSchema = z.strictObject({
  connectionId: z
    .string()
    .min(1)
    .meta({
      description:
        'The processor connection this delivery is for. An unknown or malformed id is a `404` — ' +
        'the request’s own signature, verified against this connection’s webhook secret, is the ' +
        'actual authorization (D-85), not this path segment.',
    }),
});

const processorWebhookResultSchema = z
  .object({
    status: z.enum(['processed', 'ignored', 'duplicate', 'failed']).meta({
      description:
        '`duplicate` for a redelivery already on file (F9); `ignored` for an event kind this ' +
        'connection takes no action on (a standalone `fee`, folded into its charge, D-104); ' +
        '`failed` when the signature verified but posting then failed — recorded, not retried by ' +
        'this response (see `webhook.service.ts`\'s header for why a failure here is not a 5xx).',
    }),
  })
  .meta({ id: 'ProcessorWebhookResult' });

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function registerProcessingWebhookRoutes(app: App): void {
  // Encapsulated child instance — see this file's header for why the raw-body
  // content-type parser cannot be registered on `app` itself.
  void app.register((child: App, _opts, pluginDone) => {
    child.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, parserDone) => {
        parserDone(null, body);
      },
    );

    child.post(
      '/public/processing/:connectionId/webhook',
      {
        schema: {
          operationId: 'receiveProcessorWebhook',
          summary: 'Inbound payment-processor webhook (Stripe, Square, or fake)',
          description:
            'No session: the `:connectionId` path segment resolves the org, and the delivery’s ' +
            'own signature (verified against that connection’s stored webhook secret) is the ' +
            'entire authorization (D-85). Deduped two ways — `processor_events` on the delivery’s ' +
            'own event id (F9), `external_refs` on the charge/refund/payout object id — so a ' +
            'redelivery or a poll re-reporting the same object both collapse to one write. Does ' +
            '**not** require an `Idempotency-Key`: Stripe/Square do not send one, and the ' +
            'processor’s own event id is this endpoint’s idempotency anchor instead.',
          tags: [TAG],
          params: webhookParamsSchema,
          response: { 200: processorWebhookResultSchema, default: errorResponseSchema },
        },
      },
      async (request) => {
        const lookup = await selectProcessorConnectionOrgAndProcessor(
          request.params.connectionId,
        );
        if (lookup === undefined) throw new NotFoundError('processor_connection');

        const signatureHeaderName = SIGNATURE_HEADER_BY_PROCESSOR[lookup.processor];
        const signatureHeader = headerValue(request.headers[signatureHeaderName]);
        if (signatureHeader === undefined) {
          throw new ValidationError(
            `Missing the "${signatureHeaderName}" signature header this connection’s processor ` +
              'signs its deliveries with.',
          );
        }

        const rawBody = request.body as Buffer;
        const orgId = bufferToUuid(lookup.orgId);

        return runAsAutomation(orgId, request.params.connectionId, (ctx) =>
          handleProcessorWebhook(
            { connectionId: request.params.connectionId, rawBody, signatureHeader },
            ctx,
          ),
        );
      },
    );

    pluginDone();
  });
}
