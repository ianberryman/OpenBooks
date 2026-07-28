import { publicInvoiceViewSchema } from '@openbooks/shared-types';
import type { PublicInvoiceView } from '@openbooks/shared-types';
import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { getPublicInvoiceArtifact, getPublicInvoiceView } from '../../modules/delivery';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';

/**
 * `GET /public/invoices/{token}` and `GET /public/invoices/{token}/pdf` (OB-121;
 * ROADMAP D-74) — the hosted invoice page's two public endpoints.
 *
 * ## This is the one sanctioned unauthenticated read on the whole API
 *
 * Registered by `app.ts` directly on the app root, **outside `registerV1Routes`**
 * and therefore outside `/v1`: not a stylistic choice, but the statement that these
 * two routes carry no permission surface at all. Nothing here calls
 * `requirePermission`, reads `getContext()`, or checks `isAuthenticatedContext` —
 * see `transport-holds-no-business-logic` in `.dependency-cruiser.cjs`, which this
 * file still satisfies (it maps a `:token` param to a service call and a status,
 * same as any other route), and `services-do-not-import-transport`, which is why
 * the authorization itself lives in `modules/delivery/token.ts` and not here.
 *
 * The token in the path **is** the authorization (D-74). `getPublicInvoiceView` and
 * `getPublicInvoiceArtifact` both verify it against `invoice_deliveries` before
 * touching anything else, and both return `null` for every way that can fail —
 * `verifyDeliveryToken`'s header explains why an unknown prefix and a wrong secret
 * must produce the identical outcome. `null` becomes `NotFoundError('invoice')`
 * here, the same error and the same 404 body a cross-org id produces anywhere else
 * in this API (A7): a forged token, a token for someone else's invoice, and a URL
 * that was never issued are indistinguishable from each other.
 *
 * ## The `:token` param is not validated as a shape
 *
 * `accounts.ts`'s `accountParamsSchema` validates `z.uuid()` and a malformed value
 * is a `400` — deliberately different from a well-formed one naming nothing, which
 * is a `404`. That distinction does not exist here on purpose: `token` is
 * `z.string().min(1)`, so *every* value that is not a live token — empty, malformed,
 * well-formed but unissued — reaches `verifyDeliveryToken` and comes back `null`,
 * and every one of those produces the same `404`. A `400` for "wrong shape" would
 * be one more bit an attacker probing this endpoint could use to tell a
 * plausible-looking guess from a syntactically invalid one, which is exactly the
 * kind of oracle A7 exists to close.
 *
 * ## Why the PDF route declares no `200` response schema
 *
 * Every other route in this directory declares `response: { 200: someZodSchema,
 * ...ERROR_RESPONSES }`, and `fastify-type-provider-zod`'s serializer compiler runs
 * the handler's return value through that schema before it goes on the wire. This
 * route's success body is raw PDF bytes, not JSON, so there is no Zod shape to
 * serialize through — declaring one would mean either coercing bytes into a schema
 * that does not describe them or asking the compiler to skip a schema it was given,
 * neither of which is what the shared serializer is for. Leaving `200` undeclared
 * (only `default: errorResponseSchema` is) means Fastify falls back to its own
 * default reply handling for that status, which sends a `Buffer` payload as-is.
 */
const TAG = 'public-invoices';

const publicInvoiceParamsSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .meta({
      description:
        'The hosted invoice page’s capability token, `{prefix}.{secret}` — the whole ' +
        'authorization for this request. No session, no permission, no expiry (D-74).',
    }),
});

export function registerPublicInvoiceRoutes(app: App): void {
  app.get(
    '/public/invoices/:token',
    {
      schema: {
        operationId: 'getPublicInvoiceView',
        summary: 'The hosted invoice page, unauthenticated',
        description:
          'Renders the customer-safe view of one invoice for whoever holds the link — no ' +
          'session, no permission, read-only (D-74). Carries no internal identifiers: no ' +
          'journal, contact or org id, only what prints on an invoice and the two links ' +
          '(this page, and the PDF) a customer can act on. An unknown, malformed or ' +
          'never-issued token all answer with the same `404`.',
        tags: [TAG],
        params: publicInvoiceParamsSchema,
        response: { 200: publicInvoiceViewSchema, default: errorResponseSchema },
      },
    },
    async (request): Promise<PublicInvoiceView> => {
      const view = await getPublicInvoiceView(request.params.token);
      if (view === null) throw new NotFoundError('invoice');
      return view;
    },
  );

  app.get(
    '/public/invoices/:token/pdf',
    {
      schema: {
        operationId: 'getPublicInvoicePdf',
        summary: 'The retained invoice PDF, unauthenticated',
        description:
          'Streams the exact PDF snapshot taken when this invoice was sent, carrying the same ' +
          'capability token as the hosted page. The same `404` rule applies: an unknown, ' +
          'malformed or never-issued token is indistinguishable from a token for an invoice ' +
          'that does not exist.',
        tags: [TAG],
        params: publicInvoiceParamsSchema,
        // See the file header for why `200` is deliberately absent here.
        response: { default: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const artifact = await getPublicInvoiceArtifact(request.params.token);
      if (artifact === null) throw new NotFoundError('invoice');

      // The zod type provider constrains `send` to the declared response shapes, and
      // the only one here is the error `default` (the header explains why `200` is
      // undeclared). The success body is raw PDF bytes, so it is cast past that
      // constraint; Fastify sends a `Buffer` payload as-is.
      return reply
        .header('content-type', artifact.contentType)
        .send(Buffer.from(artifact.bytes) as never);
    },
  );
}
