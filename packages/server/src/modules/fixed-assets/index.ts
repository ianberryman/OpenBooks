/**
 * Fixed assets (initiative L, OB-163…166; ROADMAP D-113…D-117).
 *
 * An org registers an asset — cost, salvage, method, life, in-service date, and
 * three accounts — and registration computes a depreciation schedule
 * (`depreciation.ts`, OB-164): one row per period, up front, because
 * declining-balance amounts vary period to period and a fixed recurring
 * template cannot express that (D-113). A daily sweep
 * (`depreciation-sweep.ts`, OB-165) posts the earliest due unposted period as
 * its own journal, idempotently, under the automation actor `runAsAutomation`
 * provides (D-89). Disposal (`fixed-assets.service.ts`, OB-166) posts the gain
 * or loss against proceeds and stops the schedule for good (D-116).
 *
 * There are no routes here: `/v1` for this initiative is OB-167, a later wave.
 * What is exported below is the service surface an HTTP handler, an MCP tool,
 * or the workflow engine (spec §12) all reach identically, plus the sweep's own
 * wiring for `entrypoints/worker.ts` and `entrypoints/api.ts`.
 */

export {
  disposeFixedAsset,
  getFixedAsset,
  getFixedAssetSchedule,
  listFixedAssets,
  registerFixedAsset,
  updateFixedAsset,
} from './fixed-assets.service';

export { FIXED_ASSET_RESOURCE } from './fixed-assets.repository';

export { computeDepreciationSchedule } from './depreciation';
export type {
  DepreciationScheduleInput,
  DepreciationScheduleRow,
  FixedAssetDepreciationMethod,
} from './depreciation';

export { registerFixedAssetDepreciationJob } from './depreciation-sweep';
export { FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE } from './job';
export type { FixedAssetDepreciationSweepPayload } from './job';
