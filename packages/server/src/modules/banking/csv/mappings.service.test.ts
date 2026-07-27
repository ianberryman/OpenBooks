import type { CreateBankImportMappingRequest } from '@openbooks/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRequestContext, type RequestContext } from '../../../context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../../db';
import { NotFoundError, toWireError } from '../../../errors';
import {
  SYSTEM_ROLE_UUIDS,
  newUuid,
  systemRoleId,
  useTestDatabase,
  uuidToBuffer,
  type TestDatabase,
} from '../../../../test/db';

import {
  getBankImportMapping,
  listBankImportMappings,
  mostRecentlyUsedMapping,
  saveBankImportMapping,
} from './mappings.service';

/**
 * The mapping service against real MySQL (OB-076; acceptance E1, E9).
 *
 * Never a mock and never SQLite (spec §11): the guarantees this file makes are the
 * unique key on `(org_id, bank_account_id, name)`, the foreign key to
 * `bank_accounts`, and the org scoping `tenantDb` applies — none of which a mock
 * has. The claims, in order:
 *
 *  - a saved mapping round-trips through the columns and back to the same definition
 *  - the most-recently-used read is by `updated_at`, which is what OB-076 offers in
 *    place of a default mapping on the account
 *  - a cross-org read is a 404 byte-identical to a nonexistent one — 404, never 403
 *    (E9)
 */

const db = useServiceDatabase();

/**
 * `useTestDatabase` plus the process pool the service reaches through `tenantDb()`.
 *
 * A deliberate duplicate of `test/payments/support.ts`'s helper, following the
 * convention those files state: reaching sideways into another suite's support file
 * means this suite breaks when that one is edited.
 */
function useServiceDatabase(): TestDatabase {
  const handle = useTestDatabase();
  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(handle.appConnectionConfig);
  });
  afterAll(async () => {
    await destroyDatabase();
  });
  return handle;
}

interface Scene {
  readonly orgUuid: string;
  readonly bankAccountUuid: string;
  readonly bankAccountId: Buffer;
  readonly ctx: RequestContext;
}

/** An org with an owner and one bank account (a ledger account plus import metadata). */
async function scene(): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId('owner') });

  const ledgerAccount = await db.factories.account({
    orgId: org.id,
    type: 'asset',
    normalBalance: 'debit',
  });
  const bankAccountUuid = newUuid();
  const bankAccountId = uuidToBuffer(bankAccountUuid);
  await db.app
    .insertInto('bank_accounts')
    .values({ id: bankAccountId, org_id: org.id, account_id: ledgerAccount.id, name: 'Current' })
    .execute();

  return {
    orgUuid: org.uuid,
    bankAccountUuid,
    bankAccountId,
    ctx: createRequestContext({
      orgId: org.uuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: user.uuid,
      actorType: 'user',
      actorId: user.uuid,
    }),
  };
}

function definition(): CreateBankImportMappingRequest['definition'] {
  return {
    hasHeaderRow: true,
    delimiter: ',',
    dateOrder: 'dmy',
    amountConvention: 'signed',
    columns: {
      postedDate: 0,
      description: 2,
      amount: 1,
      debit: null,
      credit: null,
      valueDate: null,
      counterparty: null,
      bankReference: null,
    },
  };
}

function save(s: Scene, name: string) {
  return saveBankImportMapping(s.bankAccountUuid, { name, definition: definition() }, s.ctx);
}

let s: Scene;
beforeEach(async () => {
  s = await scene();
});

describe('saving and reading a mapping', () => {
  it('round-trips a definition through the columns and back', async () => {
    const created = await save(s, 'HSBC current');
    expect(created).toMatchObject({ name: 'HSBC current', definition: definition() });

    const fetched = await getBankImportMapping(created.id, s.ctx);
    expect(fetched).toEqual(created);
  });

  it('refuses a second mapping with the same name on the same account', async () => {
    await save(s, 'HSBC');
    const error = await save(s, 'HSBC').catch((e: unknown) => e);
    expect(toWireError(error)).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('allows the same name on a different account', async () => {
    const other = await scene();
    await save(s, 'Shared name');
    // A different account (in a different org here) is a different uniqueness scope.
    await expect(save(other, 'Shared name')).resolves.toMatchObject({ name: 'Shared name' });
  });

  it('answers an unknown bank account with a 404', async () => {
    const error = await saveBankImportMapping(
      newUuid(),
      { name: 'x', definition: definition() },
      s.ctx,
    ).catch((e: unknown) => e);
    expect(toWireError(error)).toMatchObject({
      code: 'not_found',
      details: { resource: 'bank_account' },
    });
  });
});

describe('listing', () => {
  it('returns every mapping on the account and nothing from another', async () => {
    const other = await scene();
    await save(s, 'A');
    await save(s, 'B');
    await save(s, 'C');
    await save(other, 'Elsewhere');

    const page = await listBankImportMappings(s.bankAccountUuid, {}, s.ctx);
    expect(new Set(page.items.map((m) => m.name))).toEqual(new Set(['A', 'B', 'C']));
    expect(page.nextCursor).toBeNull();
  });

  it('is empty for an account with no mappings', async () => {
    const page = await listBankImportMappings(s.bankAccountUuid, {}, s.ctx);
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});

describe('most-recently-used', () => {
  it('offers the mapping whose updated_at is latest', async () => {
    const a = await save(s, 'A');
    await save(s, 'B');

    // Touch A so it is the most recently *used*, which is what the updated_at index
    // orders on (a real import bumps updated_at through the same column, OB-078).
    await db.app
      .updateTable('bank_import_mappings')
      .set({ updated_at: new Date('2999-01-01T00:00:00.000Z') })
      .where('id', '=', uuidToBuffer(a.id))
      .execute();

    const mru = await mostRecentlyUsedMapping(s.bankAccountUuid, s.ctx);
    expect(mru?.id).toBe(a.id);
  });

  it('is null when the account has no mappings', async () => {
    expect(await mostRecentlyUsedMapping(s.bankAccountUuid, s.ctx)).toBeNull();
  });
});

describe('E9 — a cross-org read is indistinguishable from a miss', () => {
  it('answers a cross-org mapping exactly as a nonexistent one', async () => {
    const theirs = await scene();
    const theirMapping = await save(theirs, 'Theirs');
    const nonexistent = newUuid();

    const crossOrg = await getBankImportMapping(theirMapping.id, s.ctx).catch((e: unknown) => e);
    const missing = await getBankImportMapping(nonexistent, s.ctx).catch((e: unknown) => e);

    expect(crossOrg).toBeInstanceOf(NotFoundError);
    expect(toWireError(crossOrg)).toEqual(toWireError(missing));
    expect(toWireError(crossOrg)).toEqual({
      code: 'not_found',
      status: 404,
      message: 'No such bank_import_mapping.',
      details: { resource: 'bank_import_mapping' },
    });
  });
});
