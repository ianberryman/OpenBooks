/**
 * The `logs` retention prune (OB-255; ROADMAP D-255-3).
 *
 * A one-file module: `retention.ts` is the whole of it — the queue name, the
 * registration the worker calls, and the sweep itself. See that file's header for
 * why the sweep is global rather than per-org and why it deletes as the app user.
 */

export {
  createLogRetentionSweepHandler,
  LOG_RETENTION_SWEEP_QUEUE,
  registerLogRetentionJob,
  runLogRetentionSweep,
} from './retention';
export type { LogRetentionDeps } from './retention';
