import { orgBrandingSchema, updateOrgBrandingRequestSchema } from '@openbooks/shared-types';
import type { OrgBranding } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { getBranding, updateBranding, uploadLogo } from '../../modules/branding';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/branding` — the letterhead an org's invoices are printed under (OB-130, for
 * OB-124; ROADMAP Phase 1 execution, streams F1/S1/S5).
 *
 * ## A singleton at a name-not-a-noun path, exactly as `/v1/accounting-settings` is
 *
 * One row per org (F2's `org_branding`, lazily created — see `getBranding`'s own
 * description below), reached with no org id in the path. `settings.ts` argues the
 * convention at length: every org-scoped path on this surface is implicitly the
 * active org's, and this is another of them.
 *
 * ## `PATCH`, and the same absent-vs-`null` distinction `settings.ts` has
 *
 * `updateOrgBrandingRequestSchema` makes every field optional and every nullable
 * field nullish: an absent key leaves it as it is, an explicit `null` clears it, and
 * a body with neither is refused by the schema's own `.refine` before this route
 * runs at all. `displayName` is the one field with no null state — it can be
 * changed but never cleared, matching the schema's own reasoning: an invoice
 * printed under no name is not one a customer can act on.
 *
 * ## The logo travels as base64 in the JSON body, not multipart
 *
 * This is the first binary upload anywhere on this API, so there is no multipart
 * precedent to match — but there is a precedent for "how does a file reach this
 * API" at all: `bank-imports.ts`'s statement upload, which is deliberately JSON
 * with the file as a body field rather than `multipart/form-data`, because an MCP
 * tool (M5) has no multipart transport and the same operation has to be reachable
 * from both. That reasoning about a *second* caller does not apply here — this
 * route has no MCP twin — but the practical shape still fits, and taking it avoids
 * a second request-parsing path, a new plugin registered on the `app.ts` every
 * stream in this wave depends on, and a new dependency added mid-wave with no
 * way to prove it installs. If a real multipart surface is wanted later, this is
 * the one route on the API that would need it and can move without touching
 * anything else. `bodyLimit` is raised on this route alone (see below) because
 * base64 costs a third more than the bytes it encodes, and a logo is the largest
 * body this surface accepts.
 *
 * `uploadBrandingLogoRequestSchema` is declared locally rather than in
 * `shared-types`, because this stream (S5, transport-only) does not touch the
 * contracts package — F1 shipped no logo-upload contract to reference, and there
 * is no second consumer of this shape yet to justify a shared home for it.
 *
 * ## What is deliberately not here
 *
 * `GET /public/invoices/{token}` and its `/pdf` sibling render the logo through
 * `storageProvider().signedUrl`, outside `/v1` entirely and unauthenticated by
 * design (S3, OB-121) — nothing about how a customer sees the logo belongs on
 * this org-scoped, permissioned surface, and this file does not register it.
 */

const TAG = 'branding';

/**
 * The image formats this route accepts. Raster only: `image/svg+xml` is
 * deliberately excluded, because an SVG can carry a `<script>` and this file is
 * later rendered into an invoice PDF and onto the unauthenticated hosted page
 * (S2, S3) — accepting one would turn a logo upload into a stored-XSS vector on a
 * surface that has to stay safe for a caller holding nothing but a link.
 */
const UPLOAD_LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** 2 MiB of actual image — generous for something printed at letterhead size. */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Base64 costs 4 characters for every 3 bytes it encodes. */
const LOGO_CONTENT_MAX_LENGTH = Math.ceil(LOGO_MAX_BYTES / 3) * 4;

/** See this file's header on why the logo is JSON, not multipart. */
const uploadBrandingLogoRequestSchema = z.strictObject({
  filename: z.string().trim().min(1).max(255).meta({
    description: 'What the file was called. Recorded nowhere — only its bytes and type are kept.',
  }),
  contentType: z.enum(UPLOAD_LOGO_CONTENT_TYPES).meta({
    description: 'The image format. Anything else is refused before the bytes are read.',
  }),
  content: z
    .base64()
    .max(LOGO_CONTENT_MAX_LENGTH)
    .meta({
      description: `The image, base64-encoded. Decodes to at most ${String(LOGO_MAX_BYTES)} bytes (2 MiB).`,
    }),
});

export function registerBrandingRoutes(app: App): void {
  app.get(
    '/v1/branding',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBranding',
        summary: 'The org’s invoice letterhead',
        description:
          'Name, address, contact details, logo and accent colour — what an invoice PDF and the ' +
          'hosted page print at their head (S2, S3). Lazily created: an org that has never set any ' +
          'of this still gets a row back, because a PDF renderer needs somewhere to read from on ' +
          'an org’s very first invoice. Reading this takes `branding.read`.',
        tags: [TAG],
        response: { 200: orgBrandingSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<OrgBranding> => getBranding(getContext()),
  );

  app.patch(
    '/v1/branding',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateBranding',
        summary: 'Change the org’s invoice letterhead',
        description:
          'An omitted field is left as it is; an explicit `null` clears it — except `displayName`, ' +
          'which has no null state and can only be changed. `logoStorageKey` is accepted here so a ' +
          'client can clear the logo with `null`, but the key itself is ordinarily written by ' +
          '`POST /v1/branding/logo`, not typed in by hand. Writing this takes `branding.write`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: updateOrgBrandingRequestSchema,
        response: { 200: orgBrandingSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'updateBranding', request: request.body, successStatus: 200 },
        () => updateBranding(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<OrgBranding>(result));
    },
  );

  app.post(
    '/v1/branding/logo',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      /**
       * Base64 already costs a third more than the image it encodes (see the file
       * header), so the default body limit every other write on this surface runs
       * under would refuse a logo well inside `LOGO_MAX_BYTES`. Raised on this one
       * route rather than globally in `app.ts`, because nothing else this surface
       * accepts is anywhere near this size.
       */
      bodyLimit: LOGO_CONTENT_MAX_LENGTH + 4096,
      schema: {
        operationId: 'uploadBrandingLogo',
        summary: 'Upload the org’s logo',
        description:
          'Replaces the org’s logo and returns the branding record carrying the new ' +
          '`logoStorageKey`. Stored under an org-scoped key (`{orgId}/branding/logo`, F3) and ' +
          'served back only as a derived `logoUrl`, never as this key — see `orgBrandingSchema`. ' +
          'To remove a logo rather than replace it, send `null` to `PATCH /v1/branding`’s ' +
          '`logoStorageKey` instead. Writing this takes `branding.write`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: uploadBrandingLogoRequestSchema,
        response: { 200: orgBrandingSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { contentType, content } = request.body;
      const result = await withIdempotency(
        { endpoint: 'uploadBrandingLogo', request: request.body, successStatus: 200 },
        () => uploadLogo(Buffer.from(content, 'base64'), contentType, ctx),
      );

      return reply.status(result.status).send(idempotentBody<OrgBranding>(result));
    },
  );
}
