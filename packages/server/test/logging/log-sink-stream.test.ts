import type { LogRecord, LogSinkProvider } from '@openbooks/plugin-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLogSinkStream,
  type LogSinkStream,
  type LogSinkStreamOptions,
} from '../../src/logging/log-sink-stream';

/**
 * Pure unit tests for the batching pino destination (OB-255). No database: this
 * proves the buffering/mapping/fallback contract in isolation from any sink
 * implementation, the same split `test/providers/logsink/db.test.ts` takes for the
 * concrete `db` sink itself.
 *
 * A capturing `LogSinkProvider` rather than a mock (spec §11's "no mocks" applies
 * to this suite's own doubles too) — it is a real object collecting the batches it
 * was actually handed, not an assertion that a method was called.
 */

interface CapturingSink extends LogSinkProvider {
  readonly batches: (readonly LogRecord[])[];
}

function capturingSink(): CapturingSink {
  const batches: (readonly LogRecord[])[] = [];
  return {
    batches,
    write(batch) {
      batches.push(batch);
      return Promise.resolve();
    },
  };
}

/** A line in the exact shape `createLogger` produces (`logging/logger.ts`). */
function pinoLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    level: 30,
    time: 1_700_000_000_000,
    pid: 123,
    hostname: 'host',
    role: 'api',
    msg: 'something happened',
    ...fields,
  });
}

// A long flush interval so the interval timer never fires mid-test; every case
// below drives `flush()` explicitly. `stop()` in afterEach clears it regardless.
const NEVER_MS = 60_000;

let openStream: LogSinkStream | undefined;

function stream(sink: LogSinkProvider, options: LogSinkStreamOptions = {}): LogSinkStream {
  openStream = createLogSinkStream(sink, { flushIntervalMs: NEVER_MS, ...options });
  return openStream;
}

afterEach(() => {
  openStream?.stop();
  openStream = undefined;
  vi.restoreAllMocks();
});

describe('createLogSinkStream', () => {
  it('parses a pino line and maps it to a LogRecord', async () => {
    const sink = capturingSink();
    const s = stream(sink);

    s.write(pinoLine({ orgId: 'org-1', requestId: 'req-1' }));
    await s.flush();

    expect(sink.batches).toHaveLength(1);
    const [record] = sink.batches[0]!;
    expect(record).toMatchObject({
      level: 'info', // labels[30] === 'info'
      role: 'api',
      message: 'something happened',
      orgId: 'org-1',
    });
    expect(record!.at).toBe(new Date(1_700_000_000_000).toISOString());
    // Structural keys are stripped; caller fields survive.
    expect(record!.fields).toEqual({ requestId: 'req-1' });
    expect(record!.fields).not.toHaveProperty('time');
    expect(record!.fields).not.toHaveProperty('level');
    expect(record!.fields).not.toHaveProperty('msg');
    expect(record!.fields).not.toHaveProperty('pid');
    expect(record!.fields).not.toHaveProperty('hostname');
    expect(record!.fields).not.toHaveProperty('role');
    expect(record!.fields).not.toHaveProperty('orgId');
  });

  it('drops an email field from fields (D-255-4)', async () => {
    const sink = capturingSink();
    const s = stream(sink);

    s.write(
      pinoLine({
        email: { provider: 'log', to: 'a@example.test', text: 'invite token abc123' },
      }),
    );
    await s.flush();

    const [record] = sink.batches[0]!;
    expect(record!.fields).not.toHaveProperty('email');
  });

  it('does not throw out of flush when the sink rejects, and falls back to stderr', async () => {
    const failing: LogSinkProvider = {
      write: () => Promise.reject(new Error('db is down')),
    };
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const s = stream(failing);
    s.write(pinoLine({}));

    await expect(s.flush()).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0]![0] as string;
    expect(JSON.parse(written)).toMatchObject({ message: 'something happened' });
  });

  it('drops the oldest records once the bounded buffer is exceeded', async () => {
    const sink = capturingSink();
    const s = stream(sink, { maxBufferSize: 3 });

    for (let i = 0; i < 5; i += 1) {
      s.write(pinoLine({ msg: `line-${i}` }));
    }
    await s.flush();

    const seen = sink.batches.flat().map((r) => r.message);
    // Oldest (0, 1) dropped; newest 3 survive, in order.
    expect(seen).toEqual(['line-2', 'line-3', 'line-4']);
  });

  it('drops an unparseable line without throwing', async () => {
    const sink = capturingSink();
    const s = stream(sink);

    expect(() => s.write('not json at all')).not.toThrow();
    await s.flush();

    expect(sink.batches).toHaveLength(0);
  });
});
