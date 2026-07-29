import type { InboundMailProvider } from '@openbooks/plugin-api';

import type { InboundMailConfig } from '../../config';

import { createDevInboundMailProvider } from './dev';
import { createSesInboundMailProvider } from './ses-inbound';

/**
 * The inbound-mail adapter for this deployment (D-07), selected by
 * configuration.
 *
 * The switch mirrors `createDocumentExtractionProvider`: exhaustive over the
 * `InboundMailConfig` discriminated union, so a new provider id does not compile
 * until it has an adapter to answer for it. `dev` is the self-host story and a
 * real parser with no signature verification (see `./dev.ts`); `ses-inbound` is
 * the hosted one and a documented deferral (see `./ses-inbound.ts`).
 */
export function createInboundMailProvider(inboundMail: InboundMailConfig): InboundMailProvider {
  switch (inboundMail.provider) {
    case 'dev':
      return createDevInboundMailProvider();
    case 'ses-inbound':
      return createSesInboundMailProvider(inboundMail);
  }
}

export { createDevInboundMailProvider } from './dev';
export { createSesInboundMailProvider } from './ses-inbound';
