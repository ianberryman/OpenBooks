import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { EmailProvider } from '@openbooks/plugin-api';

import type { EmailConfig } from '../../config';

/**
 * The hosted `EmailProvider`, over SES v2 (`infra/terraform/modules/messaging`).
 *
 * ## Why v2 and not `@aws-sdk/client-ses`
 *
 * Both are current and supported; v2 is the API SES's own configuration surface is
 * expressed in (configuration sets, suppression lists, the tenant-management calls
 * added in 2025), so a v1 client would mean reading the console in one vocabulary
 * and the code in another. `SendEmail` is the same call in both.
 *
 * ## No credentials here
 *
 * The client takes a region and nothing else. Credentials come from the SDK's
 * default chain, which in the hosted deployment is the ECS task role — spec §3's
 * position, restated in `.env.example`: "credentials themselves are never
 * environment variables in the hosted deployment". Adding an access-key pair to
 * this constructor would create a second, worse way to authenticate that would then
 * have to be forbidden somewhere.
 *
 * ## The client is built once, at adapter construction
 *
 * `SESv2Client` holds a connection pool and resolves the credential chain lazily on
 * first use, so constructing one per message would re-resolve credentials on every
 * invite. Construction is already lazy at the process level — `emailProvider()`
 * builds this on the first send, not at import — so a deployment that never sends
 * mail never builds a client, and a deployment that does builds exactly one.
 */
export function createSesEmailProvider(
  email: Extract<EmailConfig, { provider: 'ses' }>,
): EmailProvider {
  const client = new SESv2Client({ region: email.region });

  return {
    async send(message) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: email.fromAddress,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              // Charset stated rather than left to SES's default of us-ascii: an
              // org name is arbitrary text, and a default of ASCII does not fail
              // on a name outside it — it mangles it.
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: message.text, Charset: 'UTF-8' },
                ...(message.html === undefined
                  ? {}
                  : { Html: { Data: message.html, Charset: 'UTF-8' } }),
              },
            },
          },
        }),
      );
    },
  };
}
