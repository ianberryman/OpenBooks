/**
 * Structured logging (spec §12, A13).
 *
 * Every line carries actor provenance from the request context automatically —
 * see the `provenanceMixin` note in `logger.ts` — and secret-named fields are
 * redacted at any depth, see `redact.ts`.
 */
export type { Logger } from './logger';
export { createLogger, getLogger, prettyTransport } from './logger';

export type { LogProvenance } from './provenance';
export { provenanceOf } from './provenance';

export { isSecretLogField, SECRET_LOG_FIELD_SUBSTRINGS } from './redact';
export { redactLogRecord, serializeLogError } from './serialize';
