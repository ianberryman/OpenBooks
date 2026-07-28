import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { StorageProvider } from '@openbooks/plugin-api';

import type { StorageConfig } from '../../config';

/**
 * The self-host `StorageProvider`: artifacts live on the filesystem under `basePath`
 * (D-07). Its first consumer is invoicing — org logos and retained PDFs (OB-120).
 *
 * ## Why a filesystem adapter, and not "S3 or nothing"
 *
 * A self-host deployment is a Compose stack on someone's own hardware, and requiring
 * an object store to attach a logo to an invoice would put an AWS dependency in front
 * of a single-container install — the same shape [D-47] rules out for the queue. The
 * bytes go under a directory the operator already backs up, reachable by `docker
 * compose` volume mounts, which is the whole self-host story for durable blobs.
 *
 * ## `signedUrl` returns a retrieval path the api serves itself
 *
 * S3 signs a URL a browser fetches straight from the bucket; the filesystem cannot
 * sign anything, and there is no third party to fetch from. So `signedUrl` here does
 * not point outside the app — it returns a stable, app-relative retrieval path
 * (`/artifacts/<key>`) and the api streams the object out of `get` itself. The
 * `expiresInSeconds` argument is part of the contract but has no meaning locally: a
 * path the app serves is authorized by the app's own session, not by an expiring
 * signature, so it is accepted and ignored rather than encoded into a token this
 * adapter could not later verify. The consumer treats both providers' return values
 * the same — a URL to hand a client — and only the local api needs a route that
 * recognizes this prefix and calls `get`.
 *
 * ## Keys are confined to `basePath`
 *
 * A key becomes a path under `basePath`, so a key containing `..` could otherwise
 * escape the directory. Every key is resolved and checked to still sit under the
 * root before any filesystem call, and one that does not throws rather than reading
 * or writing outside the configured store.
 */
export function createLocalStorageProvider(
  storage: Extract<StorageConfig, { provider: 'local' }>,
): StorageProvider {
  const root = resolve(storage.basePath);

  // Resolves a key to an absolute path and proves it stays under `root`. `resolve`
  // collapses `..`, so the containment check is on the resolved result, not the raw
  // key — a key of `../../etc/passwd` resolves outside `root` and is refused here.
  const pathFor = (key: string): string => {
    const full = resolve(root, key);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(
        `Storage key '${key}' resolves outside the configured basePath; refusing to read or ` +
          'write outside the store.',
      );
    }
    return full;
  };

  return {
    async put(key, body, _contentType) {
      // contentType is part of the contract because S3 stores it as object metadata;
      // the filesystem has nowhere to put it, so it is accepted and dropped. The api
      // that serves a local artifact sets the response type from the key or a
      // sidecar it keeps, not from the bytes on disk.
      const full = pathFor(key);
      // Keys contain `/` (e.g. `orgs/<id>/logo.png`) — create the nested directories
      // before the write, so a consumer never has to pre-create a layout.
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
    },

    async get(key) {
      const buffer = await readFile(pathFor(key));
      // `readFile` returns a Node `Buffer`; the contract is `Uint8Array`. A Buffer is
      // one, but it can be a view onto a larger pooled ArrayBuffer, so slice to the
      // exact bytes rather than handing a caller a window with a surprising `buffer`.
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },

    async delete(key) {
      // `force: true` so deleting an absent key is not an error — `delete` is
      // idempotent by contract, and a retry after a partial failure must not throw on
      // the object that already went.
      await rm(pathFor(key), { force: true });
    },

    signedUrl(key, _expiresInSeconds) {
      // See the header: local has no signing. Return the app-relative path the api
      // streams from `get`. Not `async` — there is nothing to await, and an async
      // function would allocate a microtask to satisfy a signature a resolved promise
      // already meets.
      return Promise.resolve(`${LOCAL_ARTIFACT_PREFIX}${key}`);
    },
  };
}

/**
 * The path prefix `signedUrl` emits for the local adapter. Exported so the api's
 * artifact route and this adapter agree on one string rather than each spelling it.
 */
export const LOCAL_ARTIFACT_PREFIX = '/artifacts/';
