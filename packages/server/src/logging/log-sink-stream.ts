import pino from 'pino';

import type { LogRecord, LogSinkProvider } from '@openbooks/plugin-api';

/**
 * The batching pino destination that feeds a `LogSinkProvider` (OB-255, D-255-1).
 *
 * pino hands a `DestinationStream` one JSON line per `write` call, synchronously,
 * on the same call stack that produced the log line — often inside a request's
 * posting transaction (`transaction-scope.ts`). A sink that persists to the same
 * database the request is writing to cannot be invoked from there: joining that
 * transaction risks poisoning a rollback with an unrelated log row, and even a
 * detached write turns every logged line into a synchronous round trip on the hot
 * path. This module exists to put a buffer between the two: `write` only parses
 * and enqueues, and a flush — timer-driven or explicit — is the only thing that
 * calls the sink (D-255-2).
 *
 * Transport-agnostic on purpose: nothing here names `db` or MySQL. The same
 * destination will feed a hosted sink (`otel`/`http`/`cloudwatch`, the deferred
 * `LOG_SINK` slot noted in `plugin-api/src/providers.ts`) without changing.
 */

export interface LogSinkStreamOptions {
  /** Max records handed to `sink.write` per flush call. Default 100. */
  readonly batchSize?: number;
  /** Timer cadence for the automatic flush. Default 1000ms. */
  readonly flushIntervalMs?: number;
  /** Bounded buffer; beyond this, the OLDEST records are dropped. Default 10,000. */
  readonly maxBufferSize?: number;
}

export interface LogSinkStream {
  /** pino `DestinationStream` surface: one call per emitted line. */
  write(chunk: string): void;
  /** Drains the buffer to the sink now. Used by tests and on shutdown. */
  flush(): Promise<void>;
  /** Clears the flush timer. */
  stop(): void;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;

/**
 * The structural keys pino's own JSON carries alongside the caller's fields.
 * Everything else in the parsed line is the log call's own payload and lands in
 * `LogRecord.fields` verbatim (it is already redacted upstream — see the
 * `LogRecord` doc comment in `@openbooks/plugin-api`).
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'time',
  'level',
  'msg',
  'pid',
  'hostname',
  'role',
  'orgId',
]);

interface ParsedLine {
  readonly time?: number;
  readonly level?: number;
  readonly msg?: string;
  readonly role?: string;
  readonly orgId?: string;
  readonly [key: string]: unknown;
}

/**
 * Maps one parsed pino line to a `LogRecord`. `write` has already proven the chunk
 * is valid JSON by this point; a missing or wrong-typed field here means the line
 * came from something other than this project's `createLogger` (or an older
 * schema), so each field degrades to a safe default rather than throwing — the one
 * thing a log destination must never do is fail on a line it did not expect.
 */
function toLogRecord(parsed: ParsedLine): LogRecord {
  const at =
    typeof parsed.time === 'number'
      ? new Date(parsed.time).toISOString()
      : new Date().toISOString();
  const level =
    typeof parsed.level === 'number'
      ? (pino.levels.labels[parsed.level] ?? String(parsed.level))
      : 'info';

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    fields[key] = value;
  }
  // D-255-4: the `log` EmailProvider writes an invite token under `email.text`,
  // which upstream name-based redaction does not catch because `email` itself is
  // not a secret-named key. A persisted operational log has no business holding an
  // outbound message body, so it is dropped here rather than trusted to redaction.
  delete fields['email'];

  return {
    at,
    level,
    role: typeof parsed.role === 'string' ? parsed.role : 'unknown',
    message: typeof parsed.msg === 'string' ? parsed.msg : '',
    orgId: typeof parsed.orgId === 'string' ? parsed.orgId : null,
    fields,
  };
}

/**
 * Writes one dropped record to stderr as a single JSON line — the fallback path
 * when the sink itself fails (D-255-2: a DB outage must not lose the line, and
 * must not crash the process either). `process.stderr.write`, not the logger:
 * routing a failed log write back through the logger that feeds this same stream
 * would recurse.
 */
function writeFallback(record: LogRecord): void {
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // The record itself is not JSON-serialisable (should be unreachable — fields
    // came from a JSON.parse). Nothing further can be done with it; dropping is
    // the only option left that still cannot throw.
  }
}

export function createLogSinkStream(
  sink: LogSinkProvider,
  options: LogSinkStreamOptions = {},
): LogSinkStream {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

  const buffer: LogRecord[] = [];

  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // Never keeps the process alive on its own — a process whose only remaining
  // work is flushing an empty log buffer should be able to exit.
  timer.unref();

  function write(chunk: string): void {
    let parsed: ParsedLine;
    try {
      parsed = JSON.parse(chunk) as ParsedLine;
    } catch {
      // A malformed line must never throw in the log path (it would otherwise
      // take down whatever call produced it, which is the opposite of what a
      // logging destination is for).
      return;
    }

    buffer.push(toLogRecord(parsed));

    // Degrade by dropping the OLDEST beyond the bound, never grow without limit
    // and never block (D-255-5) — a sink outage must not turn into unbounded
    // memory growth, and the newest lines are the ones most likely to matter to
    // whoever is diagnosing the outage.
    if (buffer.length > maxBufferSize) {
      buffer.splice(0, buffer.length - maxBufferSize);
    }

    // Deliberately no flush here. `write` runs inside the caller's async scope —
    // often a request's open transaction — and a synchronous flush could join it.
    // Only the timer and an explicit `flush()` call the sink.
  }

  async function flush(): Promise<void> {
    // Capture the length at entry so a sink that somehow re-enters `write` during
    // its own await cannot turn this into an unbounded loop — the number of sink
    // calls this invocation makes is bounded by the backlog that existed when it
    // started, not by whatever arrives while it runs.
    let remaining = buffer.length;

    while (remaining > 0) {
      const batch = buffer.splice(0, Math.min(batchSize, remaining));
      if (batch.length === 0) break;
      remaining -= batch.length;

      try {
        await sink.write(batch);
      } catch {
        // The sink's own contract says it must not throw, but this is the
        // fallback of last resort if it does anyway — never let a sink failure
        // propagate out of flush, and never lose the batch silently.
        for (const record of batch) writeFallback(record);
      }
    }
  }

  function stop(): void {
    clearInterval(timer);
  }

  return { write, flush, stop };
}
