/**
 * Automations — agent work queue, MCP-only (initiative Q, M6; OB-200…210;
 * ROADMAP D-99, D-100, D-118, D-119).
 *
 * A trigger + an ordered list of actions the user composes and owns
 * (`automations.service.ts`); a lease-based queue an org's own agent polls over
 * MCP and never OpenBooks itself calls a model (`queue.service.ts`, D-100); the
 * engine that runs one firing's actions in order (`engine.ts`, Q9); and the
 * three daily sweeps that keep a standing automation's promise without a human
 * driving it (`job.ts`). Transport and the MCP tool suite live outside this
 * module (`transport/routes/`, `modules/mcp/`).
 */

export {
  createAutomation,
  getAutomation,
  listAutomations,
  runAutomation,
  setAutomationActive,
  updateAutomation,
} from './automations.service';

export { executeAutomation } from './engine';

export {
  cancelWorkItem,
  getWorkItem,
  listWorkItems,
  pollWorkQueue,
  submitWorkItemProposal,
} from './queue.service';

export {
  AUTOMATIONS_SWEEP_QUEUE,
  createAutomationsSweepHandler,
  registerAutomationsJob,
} from './job';
export type { AutomationsJobDeps, AutomationsSweepPayload } from './job';
