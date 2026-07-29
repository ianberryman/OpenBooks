import type { DocumentExtractionProvider } from '@openbooks/plugin-api';

import type { DocumentExtractionConfig } from '../../config';

import { createAnthropicExtractionProvider } from './anthropic';
import { createDeterministicExtractionProvider } from './deterministic';

/**
 * The extraction adapter for this deployment (D-07), selected by configuration.
 *
 * The switch mirrors `createStorageProvider`: exhaustive over the
 * `DocumentExtractionConfig` discriminated union, so a new provider id does not
 * compile until it has an adapter to answer for it. `deterministic` is the
 * self-host story and a real parser (see `./deterministic.ts`); `anthropic` is
 * the hosted one and a documented deferral (see `./anthropic.ts`).
 */
export function createDocumentExtractionProvider(
  extraction: DocumentExtractionConfig,
): DocumentExtractionProvider {
  switch (extraction.provider) {
    case 'deterministic':
      return createDeterministicExtractionProvider();
    case 'anthropic':
      return createAnthropicExtractionProvider(extraction);
  }
}

export { createAnthropicExtractionProvider } from './anthropic';
export { createDeterministicExtractionProvider } from './deterministic';
