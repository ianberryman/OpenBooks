import type { EmailProvider } from '@openbooks/plugin-api';

import type { EmailConfig } from '../../config';
import type { Logger } from '../../logging';

/**
 * The self-host `EmailProvider`: every message is written to the structured log.
 *
 * ## Why this is an adapter and not a stub
 *
 * A self-host deployment is a Compose stack on someone's own hardware, and the
 * common case is that it has no mail relay at all. The alternative to this adapter
 * is not "email works" — it is an operator who cannot invite their bookkeeper,
 * because the invite link exists only inside a message nothing delivered. Writing
 * the message to the log makes the link reachable by `docker compose logs`, which
 * is a real workflow for a single-tenant install and the only one available before
 * an SMTP adapter exists.
 *
 * It is also what the OB-040 test suite asserts against, and deliberately so: spec
 * §11 rules out mocks, so the invite tests send a real message through a real
 * adapter and read the token back out of the body that was actually produced. A
 * mocked provider would assert that `send` was called; this asserts that the link
 * a recipient receives is a link that works.
 *
 * ## The message body is a credential, and this writes it to the log
 *
 * An invite email carries a token that grants membership of an org (see
 * `modules/members/tokens.ts`). Under this adapter that token lands in the log,
 * which means the logs of a deployment using it must be treated as holding
 * credentials — the same care the mail spool of a real relay would need. That is
 * stated rather than mitigated: redacting the body would remove the one thing the
 * operator needs from it, and every alternative that keeps the link usable puts it
 * somewhere. `EMAIL_PROVIDER=ses` is the answer for a deployment where log access
 * and mailbox access are held by different people.
 */
export function createLogEmailProvider(
  email: Extract<EmailConfig, { provider: 'log' }>,
  logger: Logger,
): EmailProvider {
  return {
    send(message) {
      logger.info(
        {
          email: {
            provider: 'log',
            from: email.fromAddress,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
          },
        },
        'Email delivered to the log; no message was transmitted.',
      );

      // Not `async`: there is nothing to await, and an async function here would
      // allocate a microtask per send to satisfy a signature that already permits
      // a resolved promise.
      return Promise.resolve();
    },
  };
}
