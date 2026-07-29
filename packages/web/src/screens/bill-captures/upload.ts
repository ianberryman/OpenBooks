/**
 * The document formats `createBillCapture` accepts (`UploadCaptureRequest.contentType`'s
 * own enum). Checked here, before the bytes are ever read, so a screen refuses a `.docx`
 * with a message about the file rather than a 400 from the server after an upload that
 * looked like it worked.
 */
export const ALLOWED_CAPTURE_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
] as const;

export type CaptureContentType = (typeof ALLOWED_CAPTURE_CONTENT_TYPES)[number];

export function isCaptureContentType(contentType: string): contentType is CaptureContentType {
  return (ALLOWED_CAPTURE_CONTENT_TYPES as readonly string[]).includes(contentType);
}

export class UnsupportedCaptureTypeError extends Error {
  constructor(contentType: string) {
    super(
      `"${contentType || 'unknown'}" is not a format this screen accepts. Upload a PDF, PNG or ` +
        `JPEG.`,
    );
    this.name = 'UnsupportedCaptureTypeError';
  }
}

/**
 * `Uint8Array` → base64, in 32 KiB chunks — copied from `settings/branding-client.ts`'s
 * `bytesToBase64` (`uploadBrandingLogo`, the one other client-side base64 file upload in
 * this package) rather than reinvented, chunking for the same reason stated there:
 * `btoa(String.fromCharCode(...bytes))` spreads the whole array as call arguments and
 * throws `RangeError: Maximum call stack size exceeded` on anything past a few tens of
 * thousands of bytes, which a scanned invoice clears easily and a ten-byte test fixture
 * does not — the trap that makes the one-liner pass a unit test and fail in the browser.
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
 * Reads a `File` as the base64 payload `UploadCaptureRequest.content` wants — the document
 * bytes, decoded to at most 10 MiB server-side, with no `data:…;base64,` prefix.
 */
export async function readCaptureFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return bytesToBase64(bytes);
}
