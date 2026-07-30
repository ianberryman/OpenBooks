import type {
  CreateFixedAssetRequest,
  DepreciationAccounts,
  FixedAsset,
  FixedAssetMethod,
  UpdateFixedAssetRequest,
} from './queries';

/**
 * The register/edit form's own model of an asset, and the conversion to the create/update
 * requests that store it — `recurring-invoices/template-state.ts`'s shape, adapted to what
 * a fixed asset actually carries: five scheduling inputs the server computes the whole
 * depreciation schedule from (`CreateFixedAssetRequest`'s own words) and nothing else.
 */

export interface AssetFormState {
  readonly name: string;
  readonly description: string;
  readonly assetAccountId: string | null;
  /** Seeded from the org default (`useDepreciationAccounts`) when this form opens and freely
   *  overridable — `null` only when the org has nominated no default and nobody has chosen
   *  one yet, which registration refuses as `precondition_failed`. There is no separate
   *  "still on the default" flag: sending the resolved default id back explicitly is the
   *  same request `registerFixedAsset` would have produced by falling back to it itself. */
  readonly accumulatedDepreciationAccountId: string | null;
  readonly depreciationExpenseAccountId: string | null;
  /** Minor units (D-13), or `null` for an empty field. */
  readonly acquisitionCostMinor: string | null;
  readonly salvageValueMinor: string | null;
  readonly method: FixedAssetMethod;
  /** Free text while typed — a percentage, e.g. `"20"` for 20%, converted to parts per
   *  million (`decliningRatePpm = percent × 10 000`) only at submit. `null` empty. */
  readonly decliningRatePercent: string | null;
  readonly usefulLifeMonths: string;
  readonly inServiceDate: string;
}

export function blankFormState(defaults: DepreciationAccounts | null): AssetFormState {
  return {
    name: '',
    description: '',
    assetAccountId: null,
    accumulatedDepreciationAccountId: defaults?.accumulatedDepreciationAccountId ?? null,
    depreciationExpenseAccountId: defaults?.depreciationExpenseAccountId ?? null,
    acquisitionCostMinor: null,
    // Zero is the common case — many assets depreciate to nothing — and the field is
    // required on the wire, so a filled-in default spares a user who means exactly that a
    // trip back to explain why the button will not enable.
    salvageValueMinor: '0',
    method: 'straight_line',
    decliningRatePercent: null,
    usefulLifeMonths: '',
    inServiceDate: '',
  };
}

export function stateFromAsset(asset: FixedAsset): AssetFormState {
  return {
    name: asset.name,
    description: asset.description ?? '',
    assetAccountId: asset.assetAccountId,
    accumulatedDepreciationAccountId: asset.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: asset.depreciationExpenseAccountId,
    acquisitionCostMinor: asset.acquisitionCostMinor,
    salvageValueMinor: asset.salvageValueMinor,
    method: asset.method,
    decliningRatePercent:
      asset.decliningRatePpm === null ? null : formatPercent(asset.decliningRatePpm),
    usefulLifeMonths: String(asset.usefulLifeMonths),
    inServiceDate: asset.inServiceDate,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** An integer at least 1, parsed from free text, or `null` when it is not one. */
function parseUsefulLife(text: string): number | null {
  const parsed = Number(text.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * `decliningRatePpm` is parts per million of remaining book value (D-114); this form asks
 * for the same rate as a percentage, because "20% of remaining book value" is what a person
 * means by a declining-balance rate, and `× 10 000` is the one conversion this file owns so
 * no screen re-derives it. Not money — `openbooks/no-float-money` is scoped to the server's
 * branded minor-unit `bigint` and has nothing to say about a plain `number` field — but
 * still rounded once, deliberately, rather than left to accumulate across re-edits.
 */
function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10_000);
}

function formatPercent(ppm: number): string {
  return String(ppm / 10_000);
}

/**
 * Whether the form has enough to submit. `decliningRatePercent` is required exactly when
 * `method` is `declining_balance` and refused otherwise — `CreateFixedAssetRequest`'s own
 * pairing rule, checked here rather than left entirely to the server's `ValidationError` for
 * `recurring-invoices/template-state.ts`'s reason: a disabled button teaches the pairing
 * faster than a round trip does.
 */
export function formIsComplete(state: AssetFormState): boolean {
  if (state.name.trim() === '') return false;
  if (state.assetAccountId === null) return false;
  if (state.acquisitionCostMinor === null) return false;
  if (state.salvageValueMinor === null) return false;
  if (parseUsefulLife(state.usefulLifeMonths) === null) return false;
  if (state.inServiceDate === '') return false;
  if (state.method === 'declining_balance') {
    return parsePercent(state.decliningRatePercent ?? '') !== null;
  }
  return true;
}

/**
 * The create request. `accumulatedDepreciationAccountId` and `depreciationExpenseAccountId`
 * are omitted only when the form still holds no value at all — the field starts seeded from
 * the org default (`blankFormState`) and the user is free to change it, but there is nothing
 * to distinguish "still the seeded default" from "chosen and it happens to match" once the
 * schedule is computed from it either way; both produce the same asset. Absent with the org
 * naming no default is exactly what `registerFixedAsset` treats as `precondition_failed`.
 */
export function toCreateRequest(state: AssetFormState): CreateFixedAssetRequest {
  if (state.assetAccountId === null) {
    throw new Error('Cannot serialize an asset with no asset account.');
  }
  if (state.acquisitionCostMinor === null || state.salvageValueMinor === null) {
    throw new Error('Cannot serialize an asset with no acquisition cost or salvage value.');
  }
  const usefulLifeMonths = parseUsefulLife(state.usefulLifeMonths);
  if (usefulLifeMonths === null) {
    throw new Error('Cannot serialize an asset with no useful life.');
  }

  return {
    name: state.name.trim(),
    description: blankToNull(state.description),
    assetAccountId: state.assetAccountId,
    ...(state.accumulatedDepreciationAccountId === null
      ? {}
      : { accumulatedDepreciationAccountId: state.accumulatedDepreciationAccountId }),
    ...(state.depreciationExpenseAccountId === null
      ? {}
      : { depreciationExpenseAccountId: state.depreciationExpenseAccountId }),
    acquisitionCostMinor: state.acquisitionCostMinor,
    salvageValueMinor: state.salvageValueMinor,
    method: state.method,
    decliningRatePpm:
      state.method === 'declining_balance' ? parsePercent(state.decliningRatePercent ?? '') : null,
    usefulLifeMonths,
    inServiceDate: state.inServiceDate,
  };
}

/**
 * The update patch — the whole editable surface, every time, `recurring-invoices/template-
 * state.ts`'s `toUpdateRequest` reasoning applies: few enough fields that an unconditional
 * patch costs nothing a diff would have saved, and it keeps this a pure mirror of
 * `toCreateRequest` rather than a second set of rules about what changed. The server, not
 * this form, is what refuses a scheduling-parameter change once a period has posted
 * (`fixed_asset_has_posted_depreciation`) — this form does not try to know that in advance.
 */
export function toUpdateRequest(state: AssetFormState): UpdateFixedAssetRequest {
  if (state.assetAccountId === null) {
    throw new Error('Cannot serialize an asset with no asset account.');
  }
  if (state.acquisitionCostMinor === null || state.salvageValueMinor === null) {
    throw new Error('Cannot serialize an asset with no acquisition cost or salvage value.');
  }
  const usefulLifeMonths = parseUsefulLife(state.usefulLifeMonths);
  if (usefulLifeMonths === null) {
    throw new Error('Cannot serialize an asset with no useful life.');
  }

  return {
    name: state.name.trim(),
    description: blankToNull(state.description),
    assetAccountId: state.assetAccountId,
    ...(state.accumulatedDepreciationAccountId === null
      ? {}
      : { accumulatedDepreciationAccountId: state.accumulatedDepreciationAccountId }),
    ...(state.depreciationExpenseAccountId === null
      ? {}
      : { depreciationExpenseAccountId: state.depreciationExpenseAccountId }),
    acquisitionCostMinor: state.acquisitionCostMinor,
    salvageValueMinor: state.salvageValueMinor,
    method: state.method,
    decliningRatePpm:
      state.method === 'declining_balance' ? parsePercent(state.decliningRatePercent ?? '') : null,
    usefulLifeMonths,
    inServiceDate: state.inServiceDate,
  };
}
