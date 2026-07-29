import type {
  InboundEmailAttachment,
  InboundEmailMessage,
  InboundMailProvider,
} from '@openbooks/plugin-api';

/**
 * The self-host `InboundMailProvider` (D-07, initiative O): parses the JSON body
 * a local webhook harness — or the E2E narrative — posts, with **no signature
 * verification**. There is no real mail receiver in front of a self-host
 * deployment for a signature to attest to, the same reasoning `email/log.ts`
 * gives for writing to the log rather than a relay: the alternative to this
 * adapter is not "inbound capture works", it is a self-host deployment with no
 * way to exercise the inbound path at all. `ses-inbound` (deferred, see
 * `./ses-inbound.ts`) is the hosted adapter that verifies a real request.
 *
 * Expected body shape:
 * ```json
 * {
 *   "to": "bills+<token>@inbound.example",
 *   "from": "vendor@example.com",
 *   "subject": "Invoice INV-4471",
 *   "attachments": [
 *     { "filename": "invoice.pdf", "contentType": "application/pdf", "contentBase64": "..." }
 *   ]
 * }
 * ```
 * `parse` throws on anything that does not match — the inbound route has no
 * session to fall back to (`InboundMailProvider`'s contract), so a malformed
 * webhook is a request failure, not a value the caller has to remember to check.
 */
export function createDevInboundMailProvider(): InboundMailProvider {
  return {
    parse(raw) {
      return Promise.resolve(parseDevWebhook(raw.body));
    },
  };
}

function parseDevWebhook(body: Uint8Array): InboundEmailMessage {
  const text = new TextDecoder('utf-8').decode(body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('dev inbound-mail webhook body is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('dev inbound-mail webhook body must be a JSON object.');
  }

  const { to, from, subject, attachments } = parsed as Record<string, unknown>;
  if (typeof to !== 'string' || typeof from !== 'string' || typeof subject !== 'string') {
    throw new Error('dev inbound-mail webhook body must carry string `to`, `from`, `subject`.');
  }
  if (!Array.isArray(attachments)) {
    throw new Error('dev inbound-mail webhook body must carry an `attachments` array.');
  }

  return { to, from, subject, attachments: attachments.map(parseAttachment) };
}

function parseAttachment(value: unknown): InboundEmailAttachment {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Every inbound attachment must be a JSON object.');
  }

  const { filename, contentType, contentBase64 } = value as Record<string, unknown>;
  if (
    typeof filename !== 'string' ||
    typeof contentType !== 'string' ||
    typeof contentBase64 !== 'string'
  ) {
    throw new Error(
      'Every inbound attachment must carry string `filename`, `contentType`, `contentBase64`.',
    );
  }

  return {
    filename,
    contentType,
    body: new Uint8Array(Buffer.from(contentBase64, 'base64')),
  };
}
