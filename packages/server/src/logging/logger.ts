import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger, LoggerOptions } from 'pino';
import type { Config } from '../config';
import { getConfig } from '../config';
import { tryGetContext } from '../context';
import { provenanceOf } from './provenance';
import { redactLogRecord, serializeLogError } from './serialize';

export type Logger = PinoLogger;

/**
 * Reads the context and returns the provenance fields for this line.
 *
 * This is the whole of A13. pino calls `mixin` on every log call, so provenance is
 * a property of the logger rather than of the call site — there is no
 * `logger.info({ ...ctx })` to forget, and no code path that produces a log line
 * without an actor when one exists. A convention ("always attach the context")
 * would be satisfied by 99% of lines and the interesting line is always in the
 * other 1%.
 *
 * Returns `{}` outside a scope. Boot, shutdown, and migration lines have no actor
 * and must still be logged; `tryGetContext()` rather than `getContext()` is the
 * one sanctioned use of the non-throwing read (see `context/store.ts`).
 */
function provenanceMixin(): Record<string, unknown> {
  const context = tryGetContext();
  return context === undefined ? {} : provenanceOf(context);
}

/**
 * pino's default strategy lets the caller's object override the mixin. Inverted
 * here, so `logger.info({ orgId: someOtherOrg }, '…')` cannot produce a line
 * attributed to an org that did not make the request. Provenance is evidence
 * (spec §6, §12); evidence a call site can overwrite is not evidence.
 */
function provenanceWins(callerFields: object, provenance: object): object {
  return Object.assign({}, callerFields, provenance);
}

interface PrettyTransport {
  readonly target: 'pino-pretty';
  readonly options: Readonly<Record<string, string | boolean>>;
}

/**
 * Human-readable output in development, JSON everywhere else — decided from
 * `config.nodeEnv`, so a container never has to be told twice which it is.
 * `test` deliberately gets JSON: a transport is a worker thread, and a test that
 * spawns one to assert on its formatting is testing pino-pretty.
 *
 * Exported so that the selection is assertable without constructing a logger that
 * spawns that thread.
 */
export function prettyTransport(config: Config): PrettyTransport | undefined {
  if (config.nodeEnv !== 'development') return undefined;
  return {
    // Resolved by name at runtime, not imported: pino-pretty is a devDependency,
    // and a static import would both break the production bundle's external list
    // and put a dev dependency on a production path. `development` is the only
    // mode that selects it, and devDependencies are installed by definition there.
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
  };
}

/**
 * Builds a logger.
 *
 * Pure in `config` and accepting an explicit destination, so tests capture real
 * output instead of asserting against a mock. `getLogger()` is the process-wide
 * application of it.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  // A transport spawns a worker thread and takes ownership of the output, which is
  // incompatible with a caller-supplied destination — pino throws if given both.
  const transport = destination === undefined ? prettyTransport(config) : undefined;

  const options: LoggerOptions = {
    level: config.logLevel,
    // Which of the three roles produced the line (spec §2.5). pino adds pid and
    // hostname; in Fargate neither identifies the process usefully on its own.
    base: { role: config.role },
    mixin: provenanceMixin,
    mixinMergeStrategy: provenanceWins,
    formatters: { log: redactLogRecord },
    serializers: { err: serializeLogError },
    ...(transport === undefined ? {} : { transport }),
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}

let resolved: Logger | undefined;

/**
 * The process-wide logger, built on first call.
 *
 * A function rather than an exported `const` for the same reason `getConfig()` is:
 * importing this module must not validate the environment or open an output stream
 * as a side effect of something in an import graph mentioning logging.
 */
export function getLogger(): Logger {
  resolved ??= createLogger(getConfig());
  return resolved;
}
