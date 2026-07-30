/**
 * Fixed assets (initiative L, OB-163…166; ROADMAP D-113…D-117).
 *
 * `fixed-assets.ts` is the whole of it: the register, its create/update requests,
 * the depreciation schedule, disposal, and the org's depreciation-account
 * defaults. See that file's header for which schemas carry `.meta({ id })` and
 * why none of them do yet — OB-167's routes have not landed.
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
