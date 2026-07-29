import { payLinkResponseSchema } from '@openbooks/shared-types';
import type { PayLinkResponse } from '@openbooks/shared-types';
import { z } from 'zod';

import type { Config } from '../../config';
import { NotFoundError, PreconditionFailedError } from '../../errors';
import { resolvePublicInvoiceIdentity } from '../../modules/delivery';
import {
  createCheckoutLink,
  resolveActiveConnectionForOrg,
} from '../../modules/payments-processing';
import { runAsAutomation } from '../../modules/scheduling/automation';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';

/**
 * `POST /public/invoices/{token}/pay-link` (OB-150; ROADMAP D-82…D-86) — the
 * "Pay now" button on the hosted invoice page (`transport/routes/public-invoices.ts`).
 *
 * ## A second unauthenticated route, and why it is not in `public-invoices.ts`
 *
 * It carries the identical authorization shape as `GET /public/invoices/{token}` —
 * no session, no permission, the `:token` path segment is the whole thing (D-74) —
 * so it is registered the same way, directly on `app` in `transport/app.ts` and
 * outside `registerV1Routes` entirely. It lives in its own file because it is a
 * `POST` with its own dependency shape (`modules/payments-processing`,
 * `modules/scheduling/automation`) rather than a third method on
 * `public-invoices.ts`'s existing two GETs, which touch only `modules/delivery`.
 *
 * ## Why this is the one public route that is also a write
 *
 * `getPublicInvoiceView`/`getPublicInvoicePdf` are reads with no side effect
 * beyond regenerating a signed logo URL. This route calls out to a processor and
 * opens a real checkout session — but it carries no `Idempotency-Key`, unlike
 * every write under `/v1`: a customer clicking "Pay now" twice should open two
 * checkout sessions (the processor's own idempotency governs *that*), not be
 * told to resend a header a browser button click cannot set. The financial
 * event this initiative cares about being recorded exactly once is the
 * *charge*, handled by OB-148's webhook/poll idempotency on `processor_events` —
 * not the act of opening a session, which this route is.
 *
 * ## No permission check here, and none in the two service calls this makes
 *
 * `resolveActiveConnectionForOrg` and `createCheckoutLink` both call
 * `requirePermission` — `processing.read` and `processing.read` + `invoices.read`
 * respectively — exactly as they do for every other caller (spec §5: the
 * service enforces, never the transport). Both are satisfied here because both
 * calls run inside `runAsAutomation`'s Owner-role context (H9), not because this
 * route skips anything: a token that verifies at all has already proven the
 * customer holds a link an org member sent, and from that point on the
 * authorization is the org's own standing Owner authority, resolved exactly as
 * the recurring-invoice engine and the dunning sweep resolve theirs.
 *
 * ## Two `runAsAutomation` calls, not one
 *
 * The first resolves *which* connection to charge through — its `actorId` names
 * the lookup itself, because nothing naming a specific connection exists yet at
 * that point. The second is the one this ticket's spec calls out by name: its
 * `actorId` is the resolved connection's own id, so the automation that opened
 * this checkout session is attributable to the standing processor connection
 * that made it possible, the same shape `runAsAutomation(orgId, templateId, …)`
 * gives a materialised recurring cycle. Two automations cost one extra
 * `resolveOwnerUserId` lookup; a single automation could not carry the second's
 * `actorId` without already knowing the answer the first one exists to find.
 */

const payLinkParamsSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .meta({
      description:
        'The hosted invoice page’s capability token, the same one ' +
        '`GET /public/invoices/{token}` verifies (D-74). No session, no permission — this ' +
        'token is the whole authorization.',
    }),
});

/** `runAsAutomation`'s `actorId` while resolving which connection to charge through. */
const CONNECTION_LOOKUP_ACTOR = 'pay-link-connection-lookup';

export function registerPublicPayLinkRoutes(app: App, config: Config): void {
  app.post(
    '/public/invoices/:token/pay-link',
    {
      schema: {
        operationId: 'createPublicPayLink',
        summary: 'Open a hosted-checkout session for this invoice, unauthenticated',
        description:
          'Opens a processor-hosted checkout session for the invoice a hosted-page token ' +
          'names, and returns the URL to send the customer to (D-83) — never a page of ' +
          'OpenBooks’ own. An unknown, malformed or never-issued token is the same `404` ' +
          '`GET /public/invoices/{token}` gives it. An org with no active processor ' +
          'connection is `409 no_processor_connected`: nowhere exists to send this payment yet.',
        tags: ['public-invoices'],
        params: payLinkParamsSchema,
        response: { 200: payLinkResponseSchema, default: errorResponseSchema },
      },
    },
    async (request): Promise<PayLinkResponse> => {
      const { token } = request.params;

      const identity = await resolvePublicInvoiceIdentity(token);
      if (identity === null) throw new NotFoundError('invoice');

      const connection = await runAsAutomation(identity.orgId, CONNECTION_LOOKUP_ACTOR, (ctx) =>
        resolveActiveConnectionForOrg(ctx),
      );
      if (connection === null) {
        throw new PreconditionFailedError(
          'no_processor_connected',
          'This organization has not connected a payment processor, so there is nowhere to send ' +
            'this payment yet. Ask the sender to connect one from their settings.',
        );
      }

      // `send-invoice.service.ts`'s own hosted-page link, restated: `/i/{token}` is the
      // web app's route (`App.tsx`), not this API's `/public/invoices/{token}` — the
      // page the customer lands back on after paying is the one they started from.
      const returnUrl = `${config.appBaseUrl ?? ''}/i/${token}`;

      return runAsAutomation(identity.orgId, connection.id, (ctx) =>
        createCheckoutLink(
          { connectionId: connection.id, invoiceId: identity.invoiceId, returnUrl },
          ctx,
        ),
      );
    },
  );
}
