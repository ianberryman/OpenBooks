/**
 * Automations — agent work queue, MCP-only (initiative Q, M6).
 *
 * `automations.ts` — the trigger + actions an automation is composed of, the work-queue
 * item a human and an agent both read, and the two MCP tool schemas (`poll`,
 * `submitProposal`). See it for why the `/v1` schemas carry OpenAPI ids and the MCP ones
 * do not (ROADMAP D-99, D-100, D-118, D-119).
 */

export * from './automations';
