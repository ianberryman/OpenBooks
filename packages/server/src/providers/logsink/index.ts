import type { LogSinkProvider } from '@openbooks/plugin-api';

import type { Config } from '../../config';
import { createDbLogSink } from './db';

/**
 * The durable log sink for this deployment, or `undefined` for stdout-only (OB-255,
 * D-255-1). The D-07 provider-selection idiom applied to logging: an exhaustive
 * `switch` over `config.logSink`, so a new `LOG_SINK` value cannot be added to the
 * enum without an adapter to answer for it — the `selectEmailProvider`/
 * `selectQueueProvider` shape (`providers/index.ts`).
 *
 * `stdout` returns `undefined`: it is not a second sink but the always-on default,
 * and `createLogger` layers whatever this returns *on top of* stdout rather than in
 * place of it, so a `db`-sink failure can never take the logs with it. The hosted
 * shippers (`otel`/`http`/`cloudwatch`) are the deferred slot behind the same
 * `LogSinkProvider` seam and are not yet members of the `LOG_SINK` enum.
 */
export function selectLogSink(config: Config): LogSinkProvider | undefined {
  switch (config.logSink) {
    case 'stdout':
      return undefined;
    case 'db':
      return createDbLogSink();
  }
}

export { createDbLogSink } from './db';
