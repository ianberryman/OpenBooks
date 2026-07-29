import type { InboundMailProvider } from '@openbooks/plugin-api';

import type { InboundMailConfig } from '../../config';

/**
 * The hosted `InboundMailProvider`, deferred (initiative O's pinned contract,
 * "Locked decisions"). Not implemented: real MX records, an SES receipt rule,
 * and verifying that a webhook actually came from SES are out of scope this
 * wave. Throws at construction exactly as the `sqs` queue and `anthropic`
 * extraction adapters do — self-host runs `INBOUND_MAIL_PROVIDER=dev`
 * (`./dev.ts`, a real parser with no verification, because there is no receiver
 * in front of it to spoof); this adapter lands with real inbound-email
 * receiving.
 */
export function createSesInboundMailProvider(
  _inboundMail: Extract<InboundMailConfig, { provider: 'ses-inbound' }>,
): InboundMailProvider {
  throw new Error(
    'The ses-inbound mail adapter is not implemented yet (initiative O). Self-host uses ' +
      'INBOUND_MAIL_PROVIDER=dev; the hosted adapter lands with real inbound-email receiving, ' +
      'exactly as the hosted sqs queue adapter does (D-49).',
  );
}
