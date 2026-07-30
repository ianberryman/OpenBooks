import type {
  CreateFixedAssetRequest,
  DisposeFixedAssetRequest,
  FixedAsset,
  FixedAssetMethod,
  FixedAssetPage,
  FixedAssetSchedule,
  FixedAssetStatus,
  ListFixedAssetsQuery,
  UpdateFixedAssetRequest,
} from '@openbooks/shared-types';
import {
  createFixedAssetRequestSchema,
  disposeFixedAssetRequestSchema,
  fromMinorString,
  listFixedAssetsQuerySchema,
  toMinorUnits,
  updateFixedAssetRequestSchema,
} from '@openbooks/shared-types';
import type { JournalLineInput } from '@openbooks/plugin-api';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, resolvePageLimit, tryUuidToBuffer, uuidToBuffer } from '../../db';
import { assertFound, parseInput, PreconditionFailedError, ValidationError } from '../../errors';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  selectAccountById,
} from '../accounts/accounts.repository';
import { postJournal } from '../ledger';
import { requirePermission } from '../permissions';
import { resolveDepreciationAccount } from '../settings';

import { computeDepreciationSchedule } from './depreciation';
import type { DepreciationScheduleInput, DepreciationScheduleRow } from './depreciation';
import type {
  FixedAssetPatch,
  FixedAssetRow,
  FixedAssetScheduleRowRecord,
} from './fixed-assets.repository';
import {
  FIXED_ASSET_RESOURCE as RESOURCE,
  assetIdBytes,
  deleteUnpostedScheduleRows,
  hasPostedScheduleRows,
  insertFixedAsset,
  insertScheduleRows,
  orgScope,
  replaceSchedule,
  selectFixedAssetById,
  selectFixedAssetByIdForUpdate,
  selectFixedAssetSchedule,
  selectFixedAssetsPage,
  sumPostedDepreciation,
  updateFixedAssetRow,
} from './fixed-assets.repository';

/**
 * Fixed assets: register, edit, dispose (OB-163, OB-166; ROADMAP D-113…D-117).
 *
 * Read `depreciation.ts` for the pure schedule computation and
 * `depreciation-sweep.ts` for how a period actually posts. This file is the
 * three operations a human (or an MCP tool, or the workflow engine — spec §12)
 * drives directly: registration computes the schedule once, an edit may
 * recompute it while nothing has posted, and disposal stops it for good.
 *
 * `requirePermission` runs first everywhere below, before the payload is parsed
 * — `recurring.service.ts`'s own ordering, so an unauthorized caller learns
 * nothing about the shape of a request it cannot make. A miss is always
 * `assertFound`: `orgScope`/`tenantDb` has already confined every read to the
 * caller's org, so a cross-org id matches nothing and reaches the same 404 a
 * nonexistent one does (A7).
 */

/** A cents-only wire string as minor units — `payments/input.ts`'s own restatement. */
function minorUnits(value: string): bigint {
  return toMinorUnits(fromMinorString(value));
}

/**
 * The user a fixed asset is registered by. `fixed_assets.created_by_user_id` is
 * `NOT NULL`, mirroring `payments.created_by_user_id` — restated here rather
 * than imported from `modules/payments/input.ts`, which is that module's own
 * private helper, for the reason `compute-term.ts` restates `addCalendarDays`
 * rather than reaching into another module's internals.
 */
function requireRecordingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A fixed asset is registered by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot register a fixed asset. Registration ' +
          'is attributed to the person who made it.',
      },
    ]);
  }
  return userId;
}

async function requireWrite(ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'fixed_assets.write');
}

async function requireRead(ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'fixed_assets.read');
}

/** Which account type each of the two depreciation nominations must be (D-115). */
const REQUIRED_TYPE = {
  accumulated: 'asset',
  expense: 'expense',
} as const;

type DepreciationAccountSide = keyof typeof REQUIRED_TYPE;

/**
 * Resolves one of the two depreciation accounts: the id the request named, or —
 * when the request left it unset — the org's own default
 * (`resolveDepreciationAccount`, `modules/settings`). Either way the id is
 * validated to exist, be active, and be of the required type before it is
 * trusted; `control-accounts.ts`'s own re-validate-at-use argument applies
 * doubly here, since an explicit id on this request was never nominated
 * anywhere and has had no chance to be checked before now.
 */
async function resolveDepreciationAccountId(
  db: TenantDatabase,
  side: DepreciationAccountSide,
  explicitAccountId: string | undefined,
): Promise<Buffer> {
  if (explicitAccountId === undefined) {
    return resolveDepreciationAccount(db, side);
  }

  const bytes = assertFound(accountIdBytes(explicitAccountId), ACCOUNT_RESOURCE);
  const account = assertFound(await selectAccountById(db, bytes), ACCOUNT_RESOURCE);
  assertAccountUsable(account, side, bytes);
  return bytes;
}

function assertAccountUsable(
  account: { readonly type: string; readonly is_active: number },
  side: DepreciationAccountSide,
  accountId: Buffer,
): void {
  const requiredType = REQUIRED_TYPE[side];
  if (account.type !== requiredType) {
    throw new PreconditionFailedError(
      side === 'accumulated'
        ? 'accumulated_depreciation_account_wrong_type'
        : 'depreciation_expense_account_wrong_type',
      `The account nominated as this asset's ${describe(side)} account ` +
        `(${bufferToUuid(accountId)}) must be of type ${JSON.stringify(requiredType)}. ` +
        (side === 'accumulated'
          ? 'Accumulated depreciation is an ordinary asset/credit account (D-115) — nominating ' +
            'anything else would post a real depreciation charge into the wrong section of the ' +
            'balance sheet with nothing to show it happened.'
          : 'Depreciation expense belongs on the P&L beside every other operating expense; ' +
            'nominating anything else would understate expenses with nothing in the trial ' +
            'balance to explain it.'),
    );
  }
  if (account.is_active === 0) {
    throw new PreconditionFailedError(
      'account_inactive',
      `The account nominated as this asset's ${describe(side)} account is deactivated, so ` +
        'nothing can post to it. Reactivate the account, or nominate another.',
    );
  }
}

function describe(side: DepreciationAccountSide): string {
  return side === 'accumulated' ? 'accumulated-depreciation' : 'depreciation-expense';
}

/** True exactly when a field this schedule was computed from is present in the patch. */
function changesDepreciationParameters(request: UpdateFixedAssetRequest): boolean {
  return (
    request.method !== undefined ||
    request.salvageValueMinor !== undefined ||
    request.usefulLifeMonths !== undefined ||
    request.decliningRatePpm !== undefined ||
    request.acquisitionCostMinor !== undefined ||
    request.inServiceDate !== undefined
  );
}

export async function registerFixedAsset(
  input: CreateFixedAssetRequest,
  ctx: RequestContext = getContext('registerFixedAsset()'),
): Promise<FixedAsset> {
  await requireWrite(ctx);
  const request = parseInput(createFixedAssetRequestSchema, input);
  const author = requireRecordingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const assetAccountId = assertFound(accountIdBytes(request.assetAccountId), ACCOUNT_RESOURCE);
    assertFound(await selectAccountById(trx, assetAccountId), ACCOUNT_RESOURCE);

    const accumulatedDepreciationAccountId = await resolveDepreciationAccountId(
      trx,
      'accumulated',
      request.accumulatedDepreciationAccountId,
    );
    const depreciationExpenseAccountId = await resolveDepreciationAccountId(
      trx,
      'expense',
      request.depreciationExpenseAccountId,
    );

    const scheduleInput: DepreciationScheduleInput = {
      acquisitionCostMinor: minorUnits(request.acquisitionCostMinor),
      salvageValueMinor: minorUnits(request.salvageValueMinor),
      method: request.method,
      usefulLifeMonths: request.usefulLifeMonths,
      decliningRatePpm: request.decliningRatePpm ?? null,
      inServiceDate: request.inServiceDate,
    };
    const schedule = computeDepreciationSchedule(scheduleInput);

    const id = await insertFixedAsset(trx, {
      name: request.name,
      description: request.description ?? null,
      assetAccountId,
      accumulatedDepreciationAccountId,
      depreciationExpenseAccountId,
      acquisitionCostMinor: scheduleInput.acquisitionCostMinor,
      salvageValueMinor: scheduleInput.salvageValueMinor,
      method: request.method,
      usefulLifeMonths: request.usefulLifeMonths,
      decliningRatePpm: scheduleInput.decliningRatePpm,
      inServiceDate: request.inServiceDate,
      createdByUserId: author,
    });
    await insertScheduleRows(trx, id, schedule);

    return hydrate(trx, id);
  });
}

export async function getFixedAsset(
  fixedAssetId: string,
  ctx: RequestContext = getContext('getFixedAsset()'),
): Promise<FixedAsset> {
  await requireRead(ctx);
  const db = orgScope(ctx);
  const id = assertFound(assetIdBytes(fixedAssetId), RESOURCE);
  return hydrate(db, id);
}

/**
 * One page of the register, oldest first (D-21).
 */
export async function listFixedAssets(
  query: ListFixedAssetsQuery,
  ctx: RequestContext = getContext('listFixedAssets()'),
): Promise<FixedAssetPage> {
  await requireRead(ctx);
  const request = parseInput(listFixedAssetsQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const db = orgScope(ctx);
  const page = await selectFixedAssetsPage(
    db,
    {
      ...(request.status === undefined ? {} : { status: request.status }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    },
    limit,
  );

  return { items: page.rows.map(toFixedAsset), nextCursor: page.nextCursor };
}

export async function getFixedAssetSchedule(
  fixedAssetId: string,
  ctx: RequestContext = getContext('getFixedAssetSchedule()'),
): Promise<FixedAssetSchedule> {
  await requireRead(ctx);
  const db = orgScope(ctx);
  const id = assertFound(assetIdBytes(fixedAssetId), RESOURCE);
  // Establishes the asset itself is visible before answering about its
  // schedule — an id belonging to another org must be the same 404 either way
  // (A7), and a schedule query alone (no matching rows) cannot distinguish
  // "this asset has no schedule" from "this asset does not exist".
  assertFound(await selectFixedAssetById(db, id), RESOURCE);

  const rows = await selectFixedAssetSchedule(db, id);
  return rows.map(toScheduleRow);
}

/**
 * Edits a fixed asset (OB-163). Account repointing and `name`/`description` are
 * always accepted. Changing anything the schedule was computed from is accepted
 * only while no period has posted — `hasPostedScheduleRows` is checked before
 * any write, and a change past that point is `fixed_asset_has_posted_depreciation`
 * rather than a silent re-forecast of periods that have already posted under the
 * old numbers (ROADMAP "no mid-life re-forecast in v1").
 */
export async function updateFixedAsset(
  fixedAssetId: string,
  input: UpdateFixedAssetRequest,
  ctx: RequestContext = getContext('updateFixedAsset()'),
): Promise<FixedAsset> {
  await requireWrite(ctx);
  const request = parseInput(updateFixedAssetRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(assetIdBytes(fixedAssetId), RESOURCE);
    const current = assertFound(await selectFixedAssetByIdForUpdate(trx, id), RESOURCE);

    const assetAccountId =
      request.assetAccountId === undefined
        ? undefined
        : await resolveAssetAccountId(trx, request.assetAccountId);
    const accumulatedDepreciationAccountId =
      request.accumulatedDepreciationAccountId === undefined
        ? undefined
        : await resolveDepreciationAccountId(
            trx,
            'accumulated',
            request.accumulatedDepreciationAccountId,
          );
    const depreciationExpenseAccountId =
      request.depreciationExpenseAccountId === undefined
        ? undefined
        : await resolveDepreciationAccountId(trx, 'expense', request.depreciationExpenseAccountId);

    if (changesDepreciationParameters(request) && (await hasPostedScheduleRows(trx, id))) {
      throw new PreconditionFailedError(
        'fixed_asset_has_posted_depreciation',
        'This asset has at least one posted depreciation period, so its cost, salvage value, ' +
          'method, useful life, declining rate and in-service date can no longer be changed — a ' +
          'change here would re-forecast periods that have already posted under the old numbers. ' +
          'Dispose of the asset and register a new one instead (ROADMAP: no mid-life re-forecast ' +
          'in v1).',
      );
    }

    const patch: FixedAssetPatch = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(assetAccountId === undefined ? {} : { assetAccountId }),
      ...(accumulatedDepreciationAccountId === undefined
        ? {}
        : { accumulatedDepreciationAccountId }),
      ...(depreciationExpenseAccountId === undefined ? {} : { depreciationExpenseAccountId }),
      ...(request.acquisitionCostMinor === undefined
        ? {}
        : { acquisitionCostMinor: minorUnits(request.acquisitionCostMinor) }),
      ...(request.salvageValueMinor === undefined
        ? {}
        : { salvageValueMinor: minorUnits(request.salvageValueMinor) }),
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.usefulLifeMonths === undefined
        ? {}
        : { usefulLifeMonths: request.usefulLifeMonths }),
      ...(request.decliningRatePpm === undefined
        ? {}
        : { decliningRatePpm: request.decliningRatePpm }),
      ...(request.inServiceDate === undefined ? {} : { inServiceDate: request.inServiceDate }),
    };

    // Computed and validated *before* any write reaches the database:
    // `chk_fixed_assets_declining_rate` would refuse a patch that sets `method`
    // without `decliningRatePpm` (or the reverse) at the statement itself, which
    // is a driver error naming nothing a client can act on. Checking the merged
    // pair here first turns that into the same `ValidationError`
    // `createFixedAssetRequestSchema`'s own refine would have raised had this
    // arrived as one request from the start.
    let schedule: readonly DepreciationScheduleRow[] | undefined;
    if (changesDepreciationParameters(request)) {
      const merged: DepreciationScheduleInput = {
        acquisitionCostMinor: patch.acquisitionCostMinor ?? current.acquisition_cost_minor,
        salvageValueMinor: patch.salvageValueMinor ?? current.salvage_value_minor,
        method: (patch.method ?? current.method) as FixedAssetMethod,
        usefulLifeMonths: patch.usefulLifeMonths ?? current.useful_life_months,
        decliningRatePpm:
          patch.decliningRatePpm !== undefined
            ? patch.decliningRatePpm
            : current.declining_rate_ppm,
        inServiceDate: patch.inServiceDate ?? current.in_service_date,
      };

      const hasRate = merged.decliningRatePpm !== null;
      if ((merged.method === 'declining_balance') !== hasRate) {
        throw new ValidationError(
          'decliningRatePpm must be set for declining_balance and absent for straight_line.',
          [
            {
              path: 'decliningRatePpm',
              message:
                merged.method === 'declining_balance'
                  ? 'A declining_balance asset must carry a rate.'
                  : 'A straight_line asset must not carry a rate.',
            },
          ],
        );
      }

      // `chk_fixed_assets_salvage`'s own bound, re-checked against the merged
      // state for `chk_fixed_assets_declining_rate`'s own reason above: either
      // side of the pair may be unchanged by this request, so only the service —
      // holding both — can tell whether the pair the database will see still
      // holds.
      if (merged.salvageValueMinor < 0n) {
        throw new ValidationError('salvageValueMinor must not be negative.', [
          {
            path: 'salvageValueMinor',
            message: 'chk_fixed_assets_salvage requires salvageValueMinor >= 0.',
          },
        ]);
      }
      if (merged.salvageValueMinor >= merged.acquisitionCostMinor) {
        throw new ValidationError('salvageValueMinor must be less than acquisitionCostMinor.', [
          {
            path: 'salvageValueMinor',
            message:
              'The depreciable base would be zero or negative — there is nothing to schedule.',
          },
        ]);
      }

      schedule = computeDepreciationSchedule(merged);
    }

    await updateFixedAssetRow(trx, id, patch);
    if (schedule !== undefined) {
      await replaceSchedule(trx, id, schedule);
    }

    return hydrate(trx, id);
  });
}

/** `assetAccountId`'s own resolve — existence only, no type constraint (the ticket names none). */
async function resolveAssetAccountId(db: TenantDatabase, accountId: string): Promise<Buffer> {
  const bytes = assertFound(accountIdBytes(accountId), ACCOUNT_RESOURCE);
  assertFound(await selectAccountById(db, bytes), ACCOUNT_RESOURCE);
  return bytes;
}

/**
 * Disposes a fixed asset (OB-166; D-116): a fresh journal recognises the gain or
 * loss against proceeds, the asset moves to `disposed`, and its remaining
 * unposted schedule rows are discarded. Full disposal only.
 *
 * ## The journal
 *
 * `accumulated = sumPostedDepreciation(id)`; `nbv = acquisitionCost − accumulated`;
 * `gainLoss = proceeds − nbv`. Four possible lines: **Cr** the asset account for
 * its full acquisition cost (removing it from the books entirely — D-116 is
 * full disposal only); **Dr** accumulated depreciation for what has posted so
 * far (skipped when nothing has — a zero-amount line is not a line
 * `postJournal` accepts); **Dr** the proceeds account for what was received
 * (skipped at zero); and the gain or loss — **Cr** `gainLossAccountId` for a
 * gain, **Dr** it for a loss, no line at all on the one occasion it is exactly
 * zero. The four lines always balance by construction: whichever branch a
 * gain, a loss, or an exact break-even takes, credits and debits both reduce
 * to the same total (see the file's own git history / review notes for the
 * algebra, rather than restate it in four branches of comment).
 */
export async function disposeFixedAsset(
  fixedAssetId: string,
  input: DisposeFixedAssetRequest,
  ctx: RequestContext = getContext('disposeFixedAsset()'),
): Promise<FixedAsset> {
  await requireWrite(ctx);
  const request = parseInput(disposeFixedAssetRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(assetIdBytes(fixedAssetId), RESOURCE);
    const asset = assertFound(await selectFixedAssetByIdForUpdate(trx, id), RESOURCE);

    if (asset.status !== 'active') {
      throw new PreconditionFailedError(
        'fixed_asset_already_disposed',
        'This asset has already been disposed. Its disposal journal is posted and its schedule ' +
          'is stopped; disposing of it again would post a second removal of the same asset.',
      );
    }

    const accumulated = await sumPostedDepreciation(trx, id);
    const netBookValue = asset.acquisition_cost_minor - accumulated;
    const proceeds = minorUnits(request.proceedsMinor);
    const gainLoss = proceeds - netBookValue;

    const lines: JournalLineInput[] = [
      {
        accountId: bufferToUuid(asset.asset_account_id),
        side: 'credit',
        amount: asset.acquisition_cost_minor,
      },
    ];

    if (accumulated > 0n) {
      lines.push({
        accountId: bufferToUuid(asset.accumulated_depreciation_account_id),
        side: 'debit',
        amount: accumulated,
      });
    }

    if (proceeds > 0n) {
      if (request.proceedsAccountId === undefined) {
        // `disposeFixedAssetRequestSchema`'s own refine already requires this
        // pairing on the wire; reached only if a caller bypassed the schema
        // (an MCP tool or the workflow engine — spec §12).
        throw new ValidationError(
          'proceedsAccountId is required when proceedsMinor is greater than zero.',
          [
            {
              path: 'proceedsAccountId',
              message:
                'Proceeds were received for this disposal, so the account they debit must be named.',
            },
          ],
        );
      }
      lines.push({ accountId: request.proceedsAccountId, side: 'debit', amount: proceeds });
    }

    if (gainLoss > 0n) {
      lines.push({ accountId: request.gainLossAccountId, side: 'credit', amount: gainLoss });
    } else if (gainLoss < 0n) {
      lines.push({ accountId: request.gainLossAccountId, side: 'debit', amount: -gainLoss });
    }

    const posted = await postJournal(
      {
        date: request.date,
        source: 'disposal',
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        lines,
      },
      ctx,
    );

    await updateFixedAssetRow(trx, id, {
      status: 'disposed',
      disposedDate: request.date,
      disposalJournalId: uuidToBuffer(posted.journalId),
    });
    await deleteUnpostedScheduleRows(trx, id);

    return hydrate(trx, id);
  });
}

async function hydrate(db: TenantDatabase, id: Buffer): Promise<FixedAsset> {
  const row = assertFound(await selectFixedAssetById(db, id), RESOURCE);
  return toFixedAsset(row);
}

function toFixedAsset(row: FixedAssetRow): FixedAsset {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    description: row.description,
    assetAccountId: bufferToUuid(row.asset_account_id),
    accumulatedDepreciationAccountId: bufferToUuid(row.accumulated_depreciation_account_id),
    depreciationExpenseAccountId: bufferToUuid(row.depreciation_expense_account_id),
    acquisitionCostMinor: row.acquisition_cost_minor.toString(),
    salvageValueMinor: row.salvage_value_minor.toString(),
    // Cast at this one seam — see `fixed-assets.repository.ts`'s own commentary
    // on `FixedAssetRow.method`/`.status` for why the column reads back as
    // `string` rather than the narrower literal union.
    method: row.method as FixedAssetMethod,
    usefulLifeMonths: row.useful_life_months,
    decliningRatePpm: row.declining_rate_ppm,
    inServiceDate: row.in_service_date,
    status: row.status as FixedAssetStatus,
    disposedDate: row.disposed_date,
    disposalJournalId:
      row.disposal_journal_id === null ? null : bufferToUuid(row.disposal_journal_id),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toScheduleRow(row: FixedAssetScheduleRowRecord): FixedAssetSchedule[number] {
  return {
    periodIndex: row.periodIndex,
    periodDate: row.periodDate,
    depreciationAmountMinor: row.depreciationAmountMinor.toString(),
    postedJournalId: row.postedJournalId === null ? null : bufferToUuid(row.postedJournalId),
  };
}
