/**
 * Fixed assets (initiative L, OB-163…166; ROADMAP D-113…D-117; `/v1` routes OB-167).
 *
 * `fixed-assets.ts` is the whole of it: the register, its create/update requests,
 * the depreciation schedule, disposal, and the org's depreciation-account
 * defaults — every one of them now carrying a `.meta({ id })`, added alongside
 * OB-167's routes.
 */

export {
  FIXED_ASSET_METHODS,
  FIXED_ASSET_STATUSES,
  createFixedAssetRequestSchema,
  depreciationAccountsSchema,
  disposeFixedAssetRequestSchema,
  fixedAssetMethodSchema,
  fixedAssetPageSchema,
  fixedAssetScheduleRowSchema,
  fixedAssetScheduleSchema,
  fixedAssetSchema,
  fixedAssetStatusSchema,
  listFixedAssetsQuerySchema,
  updateDepreciationAccountsRequestSchema,
  updateFixedAssetRequestSchema,
} from './fixed-assets';
export type {
  CreateFixedAssetRequest,
  DepreciationAccounts,
  DisposeFixedAssetRequest,
  FixedAsset,
  FixedAssetMethod,
  FixedAssetPage,
  FixedAssetSchedule,
  FixedAssetScheduleRow,
  FixedAssetStatus,
  ListFixedAssetsQuery,
  UpdateDepreciationAccountsRequest,
  UpdateFixedAssetRequest,
} from './fixed-assets';
