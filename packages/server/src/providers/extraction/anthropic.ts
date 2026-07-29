import type { DocumentExtractionProvider } from '@openbooks/plugin-api';

import type { DocumentExtractionConfig } from '../../config';

/**
 * The hosted `DocumentExtractionProvider`, deferred (initiative O's pinned
 * contract, "Locked decisions"). Not implemented: the real adapter calls a
 * hosted LLM to read a bill, which is not something the gate can exercise, so
 * this throws at construction exactly as the `sqs` queue adapter does
 * (`providers/index.ts`'s `selectQueueProvider`) and the S3-only bank-feed
 * adapter does before M4 (D-41). Self-host runs
 * `EXTRACTION_PROVIDER=deterministic` (`./deterministic.ts`, a real parser, not a
 * stub); this adapter lands with the feature that actually calls Claude.
 */
export function createAnthropicExtractionProvider(
  _extraction: Extract<DocumentExtractionConfig, { provider: 'anthropic' }>,
): DocumentExtractionProvider {
  throw new Error(
    'The anthropic document-extraction adapter is not implemented yet (initiative O). ' +
      'Self-host uses EXTRACTION_PROVIDER=deterministic; the hosted adapter lands with the ' +
      'feature that calls it, exactly as the hosted sqs queue adapter does (D-49).',
  );
}
