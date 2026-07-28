import { thinRequest } from '../../lib/thin-client';

/**
 * The org letterhead (OB-131, Phase 1, S4) — `GET/PATCH /v1/branding` and
 * `POST /v1/branding/logo`.
 *
 * **Mocked.** These three routes are authored in the S5 stream in parallel with this one
 * and are not in `schema.d.ts` yet, so this file exists instead of three calls through
 * `../../api`. `OrgBranding` and `UpdateOrgBrandingRequest` are hand-mirrored from
 * `packages/shared-types/src/delivery/branding.ts`'s `orgBrandingSchema` and
 * `updateOrgBrandingRequestSchema` — see `../../lib/thin-client.ts` for why they are
 * copied rather than imported. **The one-line swap once F2/S5 land:** delete this file,
 * replace its three functions' call sites with `unwrap(await api.GET('/v1/branding'))` /
 * `api.PATCH(...)` / `api.POST('/v1/branding/logo', ...)`, and import the two types from
 * `../../api` (`components['schemas']['OrgBranding']` /
 * `components['schemas']['UpdateOrgBrandingRequest']`) instead of from here.
 *
 * `POST /v1/branding/logo` is JSON, not multipart — confirmed by the transport stream
 * mid-build, after this file's first draft assumed the ticket's word "multipart" meant a
 * `FormData` body. The actual contract:
 *
 * ```
 * POST /v1/branding/logo
 * { "filename": string, "contentType": string, "content": <base64 of the file bytes> }
 * → 200 OrgBranding
 * ```
 *
 * `uploadBrandingLogo` below reads the file with `File.arrayBuffer()` and base64-encodes
 * it in chunks (`bytesToBase64`) rather than in one `String.fromCharCode(...bytes)` call,
 * which blows the call stack on anything past a few tens of thousands of bytes — a logo
 * image clears that on the first try.
 */

export interface OrgBranding {
  readonly displayName: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly taxNumber: string | null;
  readonly logoStorageKey: string | null;
  readonly brandColor: string | null;
  readonly invoiceFooter: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Every field optional; an absent field is left alone and an explicit `null` clears a
 * nullable one (`updateOrgBrandingRequestSchema`'s doc comment). `displayName` has no
 * null state — it can be changed but never cleared, which is why it is `string`
 * (optional) rather than `string | null` (optional).
 */
export interface UpdateOrgBrandingRequest {
  readonly displayName?: string;
  readonly addressLine1?: string | null;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly website?: string | null;
  readonly taxNumber?: string | null;
  readonly logoStorageKey?: string | null;
  readonly brandColor?: string | null;
  readonly invoiceFooter?: string | null;
}

export async function fetchBranding(): Promise<OrgBranding> {
  return thinRequest<OrgBranding>('/v1/branding', { method: 'GET' });
}

export async function patchBranding(
  patch: UpdateOrgBrandingRequest,
  idempotencyKey: string,
): Promise<OrgBranding> {
  return thinRequest<OrgBranding>('/v1/branding', { method: 'PATCH', body: patch, idempotencyKey });
}

/**
 * `Uint8Array` → base64, in 32 KiB chunks.
 *
 * `btoa(String.fromCharCode(...bytes))` is the one-liner and the trap: spreading a large
 * typed array as call arguments hits the engine's argument-count limit (V8's is in the
 * tens of thousands), so it works in a unit test with a ten-byte fixture and throws
 * `RangeError: Maximum call stack size exceeded` on a real logo image. Chunking keeps
 * every `String.fromCharCode` call small regardless of file size.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * `logoStorageKey` is server-written, not typed here (the schema header's reason): the
 * upload path is what sets it, and the response is read back as the source of truth for
 * whatever the server resolved the key to rather than assumed from the file that was sent.
 */
export async function uploadBrandingLogo(file: File, idempotencyKey: string): Promise<OrgBranding> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return thinRequest<OrgBranding>('/v1/branding/logo', {
    method: 'POST',
    body: { filename: file.name, contentType: file.type, content: bytesToBase64(bytes) },
    idempotencyKey,
  });
}
