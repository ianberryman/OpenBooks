/**
 * The value walk pino applies to every log record.
 *
 * Registered as pino's `formatters.log`, which runs on the merged object of every
 * log call, so redaction is not something a call site opts into. Errors get the
 * same treatment through `serializers.err`.
 *
 * Three jobs, all of which have to happen in one walk because they are all
 * "recurse the record once":
 *
 * 1. Redact secret-named fields at any depth (see `redact.ts`).
 * 2. Turn `Error` instances into plain objects. pino's own `err` serializer is
 *    replaced rather than reused: it attaches the original error as `raw`, which
 *    puts every field of the error back into the record *unredacted*, and it
 *    returns an object with a custom prototype that a redaction pass would have to
 *    reconstruct anyway.
 * 3. Stringify `bigint`. Money is a branded `bigint` of minor units end to end
 *    (OB-005), and `JSON.stringify` throws on one — a single `logger.info({ total })`
 *    on a money value would otherwise take down the log call, and by extension
 *    whatever was being logged about.
 *
 * One known gap, stated rather than papered over: pino serializes a child logger's
 * *bindings* once at `child()` time and replaces the bindings formatter with an
 * identity for children created without explicit options, so `logger.child({ … })`
 * arguments do not pass through this walk. Per-call objects and errors do, which is
 * where untrusted and incidental data actually arrives; child bindings are written
 * by our own code and are component names, not payloads. If that stops being true,
 * the fix is a `childLogger()` wrapper here, not a convention.
 */
import { REDACTED } from '../config';
import { isSecretLogField } from './redact';

const CIRCULAR = '[circular]';

/** Keys `serializeError` writes itself, so the own-property copy must not fight it. */
const RESERVED_ERROR_KEYS: ReadonlySet<string> = new Set(['type', 'message', 'stack', 'name']);

function serializeError(error: Error, active: Set<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) result['stack'] = error.stack;

  // Own enumerable properties carry the parts of our hierarchy worth having in a
  // log line — `code`, `status`, `details` (src/errors/base.ts).
  for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
    if (RESERVED_ERROR_KEYS.has(key) || key === 'cause') continue;
    result[key] = isSecretLogField(key) ? REDACTED : redactValue(value, active);
  }

  // `cause` is non-enumerable when set through the Error constructor, so the loop
  // above never sees it, and dropping it would lose the actual failure whenever
  // one error wraps another.
  if (error.cause !== undefined) result['cause'] = redactValue(error.cause, active);

  return result;
}

/**
 * `active` holds the objects on the current path rather than every object seen, so
 * a value referenced twice in a tree is serialized twice and only a genuine cycle
 * becomes `[circular]`.
 */
function redactValue(value: unknown, active: Set<object>): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (active.has(value)) return CIRCULAR;

  active.add(value);
  try {
    if (value instanceof Error) return serializeError(value, active);
    if (value instanceof Date) return value;
    if (Array.isArray(value)) {
      return (value as readonly unknown[]).map((item) => redactValue(item, active));
    }

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSecretLogField(key) ? REDACTED : redactValue(nested, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

/** pino `formatters.log`. */
export function redactLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const active = new Set<object>();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = isSecretLogField(key) ? REDACTED : redactValue(value, active);
  }
  return result;
}

/**
 * pino `serializers.err`. Idempotent, because `formatters.log` runs first and has
 * usually already flattened the error — the registration exists to displace
 * pino's default `err` serializer, which would otherwise re-process the result and
 * re-attach `raw`.
 */
export function serializeLogError(value: unknown): unknown {
  return redactValue(value, new Set<object>());
}
