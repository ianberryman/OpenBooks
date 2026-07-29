import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { createCaptureFromInbound } from '../../modules/bills';
import { withGlobalIdempotency } from '../../modules/idempotency';
import { resolveOrgIdForInboundToken } from '../../modules/orgs';
import { runAsAutomation } from '../../modules/scheduling';
import { inboundMailProvider } from '../../providers';
import { requireIdempotencyKey } from '../idempotency';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';
import { idempotencyKeyHeaderSchema, idempotentBody } from './support';

/**
 * `POST /v1/bills/inbound/:token` — the inbound-email webhook a mail relay posts
 * to (initiative O, OB-186; ROADMAP "Real MX/receipt-rule receiving is out of
 * scope this wave").
 *
 * ## No session, exactly like `public-invoices.ts`
 *
 * The `:token` in the path **is** the authorization — `resolveOrgIdForInboundToken`
 * (`modules/orgs/inbound-email.ts`) is what stands in for `requirePermission` and
 * `getContext()` here, the same shape `verifyDeliveryToken` gives the hosted
 * invoice page. Nothing in this handler reads `getContext()` or calls
 * `requirePermission`; the org is resolved from the token and every write from
 * there on runs under `runAsAutomation(orgId, 'document-extraction', …)`
 * (the pinned contract), never under a caller identity, because a mail relay is
 * not a member of the org it is delivering into.
 *
 * An unknown, malformed, or never-issued token all answer the same `404` (A7):
 * there is nothing here for a relay probing for a live token to learn.
 *
 * ## The raw body, not the parsed one
 *
 * `InboundMailProvider.parse` takes `{ headers, body: Uint8Array }` — raw bytes,
 * because the hosted `ses-inbound` adapter (deferred) will need to verify a
 * signature over exactly what was sent, and a signature cannot be checked
 * against a body a JSON parser has already re-serialized. Fastify's default JSON
 * parser has already turned `request.body` into a JS value by the time this
 * handler runs, so the bytes handed to `parse` are `request.body` re-encoded —
 * lossless for JSON (the `dev` adapter's own shape: it only ever
 * `JSON.parse`s what it is given) and correct for every adapter this wave ships,
 * since the one that would need byte-exact fidelity throws `not implemented`.
 *
 * ## The response body is not in `shared-types`
 *
 * `inboundCaptureResultSchema` is declared locally, `uploadBrandingLogoRequestSchema`'s
 * reasoning: this route has no second consumer (an MCP tool does not receive
 * inbound email), so there is nothing yet to justify a shared-types home for it.
 */

const TAG = 'bill-inbound';

/**
 * Generous headroom over a captured document's own 10 MiB ceiling
 * (`DOCUMENT_CAPTURE_MAX_BYTES`): an inbound message can carry more than one
 * attachment, and each travels base64-encoded inside the JSON body — a third
 * larger again than its decoded size.
 */
const INBOUND_BODY_MAX_BYTES = 32 * 1024 * 1024;

const inboundParamsSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .meta({
      description:
        'The org’s inbound-capture token (`GET /v1/bills/inbound-address`’s local-part). The whole ' +
        'authorization for this request — no session, no permission.',
    }),
});

const inboundCaptureResultSchema = z
  .object({
    captureIds: z.array(z.uuid()).meta({
      description:
        'One id per eligible attachment. An email with no eligible attachment yields none.',
    }),
  })
  .meta({ id: 'InboundCaptureResult' });

export function registerBillInboundRoutes(app: App): void {
  app.post(
    '/v1/bills/inbound/:token',
    {
      bodyLimit: INBOUND_BODY_MAX_BYTES,
      // `requireIdempotencyKey`, not `ORG_SCOPED_WRITE_HOOKS`: this is an
      // unauthenticated write, so it carries the same idempotency requirement every
      // write does (spec §12) but reaches it the way `register`/`login` do — the key
      // alone, no session. A mail relay retrying delivery (SES/SNS redelivers) sends
      // the same key and the message is captured once, which is exactly what the
      // guarantee is for on a channel that retries on its own.
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'receiveInboundBill',
        summary: 'Inbound email webhook for bill capture',
        description:
          'No session: the `:token` path segment resolves the org and is the entire authorization ' +
          '(D-74’s shape, applied to a mailbox). Requires an `Idempotency-Key` like every write ' +
          '(spec §12) — a redelivering relay sends the same key and captures once. Creates one ' +
          '`document_captures` row per eligible attachment and enqueues extraction for each. An ' +
          'unknown or malformed token is a `404`, indistinguishable from a token never issued.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: inboundParamsSchema,
        response: { 201: inboundCaptureResultSchema, default: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await withGlobalIdempotency(
        {
          endpoint: 'receiveInboundBill',
          request: { token: request.params.token },
          successStatus: 201,
        },
        async () => {
          const orgId = await resolveOrgIdForInboundToken(request.params.token);
          if (orgId === null) throw new NotFoundError('org');

          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(request.headers)) {
            headers[key] = Array.isArray(value) ? value.join(', ') : value;
          }
          const body = new TextEncoder().encode(JSON.stringify(request.body ?? {}));

          const msg = await inboundMailProvider().parse({ headers, body });
          const captures = await runAsAutomation(orgId, 'document-extraction', (ctx) =>
            createCaptureFromInbound(msg, orgId, ctx),
          );

          return { captureIds: captures.map((capture) => capture.id) };
        },
      );

      return reply.status(result.status).send(idempotentBody(result));
    },
  );
}
