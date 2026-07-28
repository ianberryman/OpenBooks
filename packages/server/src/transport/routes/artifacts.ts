import type { Config } from '../../config';
import { NotFoundError } from '../../errors';
import { storageProvider } from '../../providers';
import type { App } from '../types';

/**
 * `GET /artifacts/*` — the retrieval endpoint the local `StorageProvider.signedUrl`
 * points at (OB-120; `providers/storage/local.ts`'s header, which this implements).
 *
 * ## Only under the local adapter, and why it carries no session
 *
 * S3 signs a URL a browser fetches straight from the bucket; the filesystem cannot,
 * so the local adapter returns `/artifacts/<key>` and the api streams the bytes out
 * of `get` itself. Under `s3` that path is never emitted — `signedUrl` returns a real
 * presigned URL — so this route has no consumer there and is not registered: an
 * always-on object-read endpoint with nothing linking to it would be surface without
 * purpose.
 *
 * It is reached **without a session**, and this is deliberate: the hosted invoice
 * page (`/public/invoices/{token}`) renders an org logo whose URL, under local, is an
 * `/artifacts/<key>` path, and the customer opening that page holds no session. So
 * `/artifacts/*` is the self-host analog of an s3 presigned URL — the unguessable key
 * *is* the authorization, exactly as the signed query string is for s3 — which is why
 * `app.ts` lists it beside the two `/public/invoices/*` routes in the identity-skip
 * set. Keys are high-entropy (`org/{uuid}/…/{uuid}`), and the local adapter already
 * refuses any key that resolves outside `basePath` (`local.ts`), so a `..` traversal
 * cannot reach a file the store does not own.
 *
 * Hidden from `openapi.json` (`hide: true`): it is a self-host infrastructure path,
 * not part of the published API surface, and keeping it out of the document also
 * keeps that document identical whether the deployment runs `local` or `s3`.
 */

const CONTENT_TYPE_BY_SUFFIX: ReadonlyArray<readonly [string, string]> = [
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
];

/**
 * The response type, chosen from the key's suffix. The filesystem stores no content
 * type (`local.ts`'s `put` drops it), and a logo key carries no extension, so an
 * unrecognised key falls back to `application/octet-stream` — which a browser sniffs
 * for an `<img>` anyway. A retained PDF ends in `.pdf` and is served as such.
 */
function contentTypeForKey(key: string): string {
  const lower = key.toLowerCase();
  for (const [suffix, type] of CONTENT_TYPE_BY_SUFFIX) {
    if (lower.endsWith(suffix)) return type;
  }
  return 'application/octet-stream';
}

export function registerArtifactRoutes(app: App, config: Config): void {
  if (config.providers.storage.provider !== 'local') return;

  app.get('/artifacts/*', { schema: { hide: true } }, async (request, reply) => {
    const key = (request.params as Record<string, string>)['*'] ?? '';
    if (key === '') throw new NotFoundError('artifact');

    let bytes: Uint8Array;
    try {
      bytes = await storageProvider().get(key);
    } catch {
      // A missing file — or a key the adapter refuses because it escapes `basePath` —
      // is the same 404 a nonexistent artifact is, never a 500 that tells them apart.
      throw new NotFoundError('artifact');
    }

    return reply.header('content-type', contentTypeForKey(key)).send(Buffer.from(bytes));
  });
}
