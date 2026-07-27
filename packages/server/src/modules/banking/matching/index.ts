/**
 * The match proposal engine's public surface (OB-079).
 *
 * `proposeMatches` is the read-only service the transport (OB-084) and the accept
 * flow (OB-081) reach; `MatchProposalDeps` is how the concrete `RuleEvaluator` is
 * injected at the composition point. The banking barrel (`../index.ts`) re-exports
 * these at integration — this file is where wave 2 hands them over.
 */
export { proposeMatches } from './service';
export type { MatchProposalDeps } from './service';
