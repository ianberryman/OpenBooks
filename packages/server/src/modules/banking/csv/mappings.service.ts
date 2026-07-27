import type {
  BankImportMapping,
  BankImportMappingPage,
  CreateBankImportMappingRequest,
  ListBankImportMappingsQuery,
} from '@openbooks/shared-types';
import {
  createBankImportMappingRequestSchema,
  listBankImportMappingsQuerySchema,
} from '@openbooks/shared-types';

import { getContext, type RequestContext } from '../../../context';
import { resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { assertFound, parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';

import {
  BANK_ACCOUNT_RESOURCE,
  BANK_IMPORT_MAPPING_RESOURCE as RESOURCE,
  insertMapping,
  mappingIdBytes,
  orgScope,
  selectBankAccount,
  selectMappingById,
  selectMappingsPage,
  selectMostRecentlyUsed,
  toBankImportMapping,
} from './mappings.repository';

/**
 * Saved column mappings — which column of this bank's CSV means what (OB-076;
 * ROADMAP D-41, acceptance E1/E9).
 *
 * A mapping is saved once and reused every month, because the column layout is a
 * property of the bank rather than of the file (`imports.ts`). This module saves,
 * reads and lists them; reading a file *through* one is the parser's (`parse.ts`),
 * and touching one on use is OB-078's import flow.
 *
 * Three things are uniform across every operation and stated once here:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else. Enforcement is service-layer
 *    only (spec §2.4, §5) — there are no routes yet (OB-084), so this parse is at
 *    present the *only* parse (spec §12).
 *
 * 2. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has already
 *    confined every read to the context's org, so a cross-org id returns no row and
 *    reaches the same line a nonexistent id reaches — 404, never 403, byte-identical
 *    to a read of something that never existed (E9).
 *
 * 3. **The permission is banking's.** `banking.read` sees mappings; `banking.import`
 *    creates them, because a mapping is import configuration and creating one is
 *    part of setting an import up.
 */

/**
 * Saves a mapping under a name, scoped to a bank account.
 *
 * The bank account is checked to exist first, so an unknown or cross-org account is
 * a 404 rather than a foreign-key 500 — and because that read is org-scoped, another
 * org's account is a miss indistinguishable from a nonexistent one (E9).
 */
export async function saveBankImportMapping(
  bankAccountId: string,
  input: CreateBankImportMappingRequest,
  ctx: RequestContext = getContext('saveBankImportMapping()'),
): Promise<BankImportMapping> {
  await requirePermission(ctx, 'banking.import');
  const request = parseInput(createBankImportMappingRequestSchema, input);

  const db = orgScope(ctx);
  const accountId = assertFound(tryUuidToBuffer(bankAccountId), BANK_ACCOUNT_RESOURCE);
  assertFound(await selectBankAccount(db, accountId), BANK_ACCOUNT_RESOURCE);

  const row = await insertMapping(db, accountId, request.name, request.definition);
  return toBankImportMapping(row);
}

export async function getBankImportMapping(
  mappingId: string,
  ctx: RequestContext = getContext('getBankImportMapping()'),
): Promise<BankImportMapping> {
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  const id = assertFound(mappingIdBytes(mappingId), RESOURCE);
  return toBankImportMapping(assertFound(await selectMappingById(db, id), RESOURCE));
}

/**
 * One page of a bank account's mappings, oldest first (D-21).
 *
 * A malformed or cross-org account id answers with an empty page rather than a 404,
 * matching `listPayments`: a filter that matches nothing is what an unknown one
 * does, and an empty page keeps a filter's failure mode uniform — which E9 requires,
 * since an account in another org must be indistinguishable from one that does not
 * exist, and an empty page is.
 */
export async function listBankImportMappings(
  bankAccountId: string,
  query: ListBankImportMappingsQuery,
  ctx: RequestContext = getContext('listBankImportMappings()'),
): Promise<BankImportMappingPage> {
  await requirePermission(ctx, 'banking.read');
  const filters = parseInput(listBankImportMappingsQuerySchema, query);

  const accountId = tryUuidToBuffer(bankAccountId);
  if (accountId === undefined) return { items: [], nextCursor: null };

  const limit = resolvePageLimit(filters.limit);
  const page = await selectMappingsPage(orgScope(ctx), accountId, filters.cursor, limit);

  return { items: page.rows.map(toBankImportMapping), nextCursor: page.nextCursor };
}

/**
 * The mapping to offer first for a bank account, or `null` when it has none.
 *
 * This is what OB-076 offers in place of a `default_import_mapping_id` on the
 * account (`0006_banking`): a UI landing on an upload preselects the last mapping
 * used, and there is nothing to dangle when the last mapping is deleted. Ordered by
 * `updated_at` and served by `idx_bank_import_mappings_org_account`; see the
 * repository for why the list cannot share that order.
 */
export async function mostRecentlyUsedMapping(
  bankAccountId: string,
  ctx: RequestContext = getContext('mostRecentlyUsedMapping()'),
): Promise<BankImportMapping | null> {
  await requirePermission(ctx, 'banking.read');

  const accountId = tryUuidToBuffer(bankAccountId);
  if (accountId === undefined) return null;

  const row = await selectMostRecentlyUsed(orgScope(ctx), accountId);
  return row === undefined ? null : toBankImportMapping(row);
}
