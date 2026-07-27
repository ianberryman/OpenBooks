import { createRequestContext, type RequestContext } from '../../../src/context';
import type { TestDatabase } from '../../db';
import { SYSTEM_ROLE_UUIDS, newUuid, systemRoleId, uuidToBuffer } from '../../db';

/**
 * Support for the OB-080 bank-rule suites.
 *
 * The fixtures are built directly as the **app** user, following the convention
 * `test/banking/support.ts` states: a suite that imported another wave-2 module's
 * fixtures would fail whenever that sibling was mid-edit. So an org, its owner, a
 * ledger account to code to, a contact, a dimension with two values, and two bank
 * accounts are inserted here with raw statements — the only thing the tests drive
 * through the real service is the rules module itself.
 */

export interface RuleScene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly ctx: RequestContext;
  /** The ledger account a rule codes to (`outcome.accountId`). */
  readonly accountUuid: string;
  /** A second ledger account, for re-coding on update. */
  readonly otherAccountUuid: string;
  readonly contactUuid: string;
  /** A dimension and two of its values, on one axis (so two clash). */
  readonly dimensionUuid: string;
  readonly valueAUuid: string;
  readonly valueBUuid: string;
  /** An archived value on that same axis. */
  readonly archivedValueUuid: string;
  readonly bankAccountUuid: string;
  readonly bankAccountId: Buffer;
  readonly otherBankAccountUuid: string;
}

async function insertAccount(db: TestDatabase, orgId: Buffer, code: string): Promise<string> {
  const uuid = newUuid();
  await db.app
    .insertInto('accounts')
    .values({
      id: uuidToBuffer(uuid),
      org_id: orgId,
      code,
      name: `Account ${code}`,
      type: 'expense',
      normal_balance: 'debit',
    })
    .execute();
  return uuid;
}

async function insertContact(db: TestDatabase, orgId: Buffer, name: string): Promise<string> {
  const uuid = newUuid();
  await db.app
    .insertInto('contacts')
    .values({ id: uuidToBuffer(uuid), org_id: orgId, display_name: name })
    .execute();
  return uuid;
}

async function insertBankAccount(
  db: TestDatabase,
  orgId: Buffer,
  ledgerAccountUuid: string,
  name: string,
): Promise<string> {
  const uuid = newUuid();
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: uuidToBuffer(uuid),
      org_id: orgId,
      account_id: uuidToBuffer(ledgerAccountUuid),
      name,
    })
    .execute();
  return uuid;
}

async function insertDimensionValue(
  db: TestDatabase,
  orgId: Buffer,
  dimensionId: Buffer,
  code: string,
  isActive: boolean,
): Promise<string> {
  const uuid = newUuid();
  await db.app
    .insertInto('dimension_values')
    .values({
      id: uuidToBuffer(uuid),
      org_id: orgId,
      dimension_id: dimensionId,
      code,
      name: `Value ${code}`,
      is_active: isActive ? 1 : 0,
    })
    .execute();
  return uuid;
}

/** An org with an owner, coding targets, a tagged axis, and two bank accounts. */
export async function ruleSceneIn(db: TestDatabase): Promise<RuleScene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId('owner') });

  const accountUuid = await insertAccount(db, org.id, '6100');
  const otherAccountUuid = await insertAccount(db, org.id, '6200');
  const bankLedgerA = await insertAccount(db, org.id, '1010');
  const bankLedgerB = await insertAccount(db, org.id, '1020');
  const contactUuid = await insertContact(db, org.id, 'Tesco');

  const dimensionUuid = newUuid();
  const dimensionId = uuidToBuffer(dimensionUuid);
  await db.app
    .insertInto('dimensions')
    .values({ id: dimensionId, org_id: org.id, code: 'DEPT', name: 'Department' })
    .execute();
  const valueAUuid = await insertDimensionValue(db, org.id, dimensionId, 'OPS', true);
  const valueBUuid = await insertDimensionValue(db, org.id, dimensionId, 'SALES', true);
  const archivedValueUuid = await insertDimensionValue(db, org.id, dimensionId, 'OLD', false);

  const bankAccountUuid = await insertBankAccount(db, org.id, bankLedgerA, 'Current');
  const otherBankAccountUuid = await insertBankAccount(db, org.id, bankLedgerB, 'Savings');

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    ctx: createRequestContext({
      orgId: org.uuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: user.uuid,
      actorType: 'user',
      actorId: user.uuid,
    }),
    accountUuid,
    otherAccountUuid,
    contactUuid,
    dimensionUuid,
    valueAUuid,
    valueBUuid,
    archivedValueUuid,
    bankAccountUuid,
    bankAccountId: uuidToBuffer(bankAccountUuid),
    otherBankAccountUuid,
  };
}
