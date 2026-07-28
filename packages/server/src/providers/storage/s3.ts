import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider } from '@openbooks/plugin-api';

import type { StorageConfig } from '../../config';

/**
 * The hosted `StorageProvider`, over S3 (`infra/terraform`). Its first consumer is
 * invoicing — org logos and retained PDFs (OB-120).
 *
 * ## No credentials here, one client, built once
 *
 * Constructed exactly as `email/ses.ts` builds its SES client and for the same
 * reasons: the client takes a region and nothing else — credentials come from the
 * SDK's default chain, which in the hosted deployment is the ECS task role, and spec
 * §3's position is that "credentials themselves are never environment variables in
 * the hosted deployment". `S3Client` holds a connection pool and resolves the
 * credential chain lazily on first use, so one client is built at adapter
 * construction and reused; construction is already lazy at the process level
 * (`storageProvider()` builds this on first use), so a deployment that stores nothing
 * builds no client.
 *
 * ## `signedUrl` is a real presigned GET
 *
 * Unlike the local adapter, S3 can sign: `signedUrl` returns a time-limited URL a
 * browser fetches straight from the bucket, so the api never proxies logo or PDF
 * bytes through itself. `expiresInSeconds` is honoured here — it is the presign
 * lifetime — where locally it has no meaning.
 */
export function createS3StorageProvider(
  storage: Extract<StorageConfig, { provider: 's3' }>,
): StorageProvider {
  const client = new S3Client({ region: storage.region });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key: key,
          Body: body,
          // Spread rather than an assignment: exactOptionalPropertyTypes distinguishes
          // an absent key from one holding `undefined`, and the command's field is
          // optional — omit it entirely when the caller gave no type.
          ...(contentType === undefined ? {} : { ContentType: contentType }),
        }),
      );
    },

    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: storage.bucket, Key: key }),
      );
      // `Body` is a stream in Node; the SDK's `transformToByteArray` drains it to the
      // `Uint8Array` the contract returns. It is optional on the response type (a
      // GET can in principle return no body), so its absence is a real error to
      // surface rather than an empty array to invent.
      if (result.Body === undefined) {
        throw new Error(`S3 object '${key}' returned no body.`);
      }
      return await result.Body.transformToByteArray();
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    },

    signedUrl(key, expiresInSeconds) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: storage.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}
