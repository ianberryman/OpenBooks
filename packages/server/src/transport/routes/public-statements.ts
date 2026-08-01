import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { getPublicStatementArtifact } from '../../modules/account-statements';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';

/**
 * `GET /public/statements/{token}/pdf` (OB-220 part 1) — the hosted customer-statement
 * artifact, sibling of `transport/routes/public-invoices.ts`'s OB-121/D-74 pair (which
 * serves the invoice PDF at `/public/invoices/{token}/pdf`); it shares that `/public/`
 * prefix so the one dev/prod proxy rule already routing `/public/*` to the API reaches
 * this route too, with no new carve-out.
 *
 * ## This is the third sanctioned unauthenticated read on the whole API
 *
 * Registered by `app.ts` directly on the app root, **outside `registerV1Routes`**
 * and therefore outside `/v1` — the same placement `public-invoices.ts`'s header
 * argues for and for the identical reason: this route carries no permission
 * surface at all. Nothing here calls `requirePermission`, reads `getContext()`, or
 * checks `isAuthenticatedContext` (`transport-holds-no-business-logic` in
 * `.dependency-cruiser.cjs`, which this file still satisfies — it maps a `:token`
 * param to a service call and a status), and the authorization itself lives in
 * `modules/account-statements/token.ts`, not here (`services-do-not-import-transport`
 * is why).
 *
 * The token in the path **is** the authorization. `getPublicStatementArtifact`
 * verifies it against `customer_statements` before touching anything else and
 * returns `null` for every way that can fail — `token.ts#verifyStatementToken`'s
 * header explains why an unknown prefix and a wrong secret must produce the
 * identical outcome. `null` becomes `NotFoundError('customer-statement')` here,
 * the same error and the same 404 body a cross-org id produces anywhere else in
 * this API (A7): a forged token, a token for someone else's statement, and a URL
 * that was never issued are indistinguishable from each other.
 *
 * ## The `:token` param is not validated as a shape
 *
 * `public-invoices.ts`'s reasoning applies unchanged: `token` is `z.string().min(1)`,
 * so *every* value that is not a live token — empty, malformed, well-formed but
 * unissued — reaches `verifyStatementToken` and comes back `null`, and every one
 * of those produces the same `404`. A `400` for "wrong shape" would be one more
 * bit an attacker probing this endpoint could use to tell a plausible-looking
 * guess from a syntactically invalid one, which is exactly the kind of oracle A7
 * exists to close.
 *
 * ## Why this route declares no `200` response schema
 *
 * `public-invoices.ts`'s `/pdf` route explains this in full: the success body is
 * raw PDF bytes, not JSON, so there is no Zod shape for the serializer to run it
 * through. Leaving `200` undeclared (only `default: errorResponseSchema` is) means
 * Fastify falls back to its own default reply handling for that status, which
 * sends a `Buffer` payload as-is.
 */
const TAG = 'public-statements';

const publicStatementParamsSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .meta({
      description:
        'The hosted statement page’s capability token, `{prefix}.{secret}` — the whole ' +
        'authorization for this request. No session, no permission, no expiry (D-74).',
    }),
});

export function registerPublicStatementRoutes(app: App): void {
  app.get(
    '/public/statements/:token/pdf',
    {
      schema: {
        operationId: 'getPublicStatementArtifact',
        summary: 'The retained customer-statement PDF, unauthenticated',
        description:
          'Streams the exact PDF snapshot taken when this customer statement was rendered, ' +
          'carrying the capability token from the delivery email. An unknown, malformed or ' +
          'never-issued token all answer with the same `404`.',
        tags: [TAG],
        params: publicStatementParamsSchema,
        // See the file header for why `200` is deliberately absent here.
        response: { default: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const artifact = await getPublicStatementArtifact(request.params.token);
      if (artifact === null) throw new NotFoundError('customer-statement');

      // The zod type provider constrains `send` to the declared response shapes,
      // and the only one here is the error `default` (the header explains why
      // `200` is undeclared). The success body is raw PDF bytes, so it is cast
      // past that constraint; Fastify sends a `Buffer` payload as-is.
      return reply
        .header('content-type', artifact.contentType)
        .send(Buffer.from(artifact.bytes) as never);
    },
  );
}
