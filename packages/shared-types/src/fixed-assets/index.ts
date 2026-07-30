/**
 * Fixed assets and depreciation schedules (initiative L, OB-163…166; ROADMAP D-113…D-116).
 *
 * `fixed-assets.ts` holds the whole wire surface: the register (create/update), the
 * computed schedule and its rows, the disposal request, and the list query. OB-167's
 * `/v1` routes are where these gain their `.meta({ id })` and the keyset page schema —
 * see that ticket for why none does yet (this package's index header explains the rule).
 */

export {
  FIXED_ASSET_METHODS,
  FIXED_ASSET_STATUSES,
  createFixedAssetRequestSchema,
  disposeFixedAssetRequestSchema,
  fixedAssetMethodSchema,
  fixedAssetScheduleRowSchema,
  fixedAssetScheduleSchema,
  fixedAssetSchema,
  fixedAssetStatusSchema,
  listFixedAssetsQuerySchema,
  updateFixedAssetRequestSchema,
} from './fixed-assets';
export type {
  CreateFixedAssetRequest,
  DisposeFixedAssetRequest,
  FixedAsset,
  FixedAssetMethod,
  FixedAssetSchedule,
  FixedAssetScheduleRow,
  FixedAssetStatus,
  ListFixedAssetsQuery,
  UpdateFixedAssetRequest,
} from './fixed-assets';
