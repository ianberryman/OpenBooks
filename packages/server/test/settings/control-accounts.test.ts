import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { NotFoundError, PermissionDeniedError, toWireError } from '../../src/errors';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import { getControlAccounts, updateControlAccounts } from '../../src/modules/settings';
import { bufferToUuid, newUuid, newUuidBuffer, uuidToBuffer } from '../db';
import type { ActorFixture } from './support';
import { actorIn, useServiceDatabase } from './support';

/**
 * The org's control-account nominations (OB-066a; ROADMAP D-23, D-34).
 *
 * Three claims are worth testing here and only three, because everything else this
 * module does is asserted where it is consumed (`test/invoices`, `test/bills`,
 * `test/payments` each prove their own refusal):
 *
 *  1. **A nomination is validated the way the tax service validates its liability
 *     account** — exists, is this org's, is active, is of a defensible type — and a
 *     cross-org id is a 404 whose body is byte-identical to a nonexistent one (A7).
 *  2. **`null` and absent are different values.** A patch that could not express
 *     "clear the payables one and leave the receivables one alone" would force a
 *     caller to restate a value it may not have read.
 *  3. **Changing a nomination restates nothing.** This is the claim the whole
 *     design rests on and the only one a reader is entitled to be sceptical of, so
 *     it is asserted against the posted journal rather than against a comment.
 */
const db = useServiceDatabase();

function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

let codeSequence = 0;

async function assetAccount(actor: ActorFixture, name = 'Accounts receivable') {
  return db.factories.account({
    orgId: actor.orgId,
    code: `1${String((codeSequence += 1)).padStart(3, '0')}`,
    name,
    type: 'asset',
    normalBalance: 'debit',
  });
}

async function liabilityAccount(actor: ActorFixture, name = 'Accounts payable') {
  return db.factories.account({
    orgId: actor.orgId,
    code: `2${String((codeSequence += 1)).padStart(3, '0')}`,
    name,
    type: 'liability',
    normalBalance: 'credit',
  });
}

describe('reading the nominations', () => {
  it('answers both null for an org that has never nominated one', async () => {
    const actor = await actorIn(db);

    expect(await getControlAccounts(actor.ctx)).toEqual({
      receivableControlAccountId: null,
      payableControlAccountId: null,
      inventoryShrinkageAccountId: null,
    });
  });

  it('takes orgs.read, which every seeded role holds', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(getControlAccounts(actor.ctx)).resolves.toBeDefined();
  });
});

describe('nominating', () => {
  it('records a nomination and reads it back', async () => {
    const actor = await actorIn(db);
    const receivable = await assetAccount(actor);

    const updated = await updateControlAccounts(
      { receivableControlAccountId: receivable.uuid },
      actor.ctx,
    );

    expect(updated).toEqual({
      receivableControlAccountId: receivable.uuid,
      payableControlAccountId: null,
      inventoryShrinkageAccountId: null,
    });
    expect(await getControlAccounts(actor.ctx)).toEqual(updated);
  });

  /**
   * The distinction the patch type carries down from the wire contract. An omitted
   * field is left alone; an explicit `null` clears. Collapsing the two would make
   * "set only the payables one" impossible to express without restating a value the
   * caller may not have read, which is the lost-update shape partial updates exist
   * to avoid.
   */
  it('leaves an omitted side alone and clears an explicitly null one', async () => {
    const actor = await actorIn(db);
    const [receivable, payable] = await Promise.all([assetAccount(actor), liabilityAccount(actor)]);

    await updateControlAccounts(
      {
        receivableControlAccountId: receivable.uuid,
        payableControlAccountId: payable.uuid,
      },
      actor.ctx,
    );

    // Omitted: untouched.
    expect(await updateControlAccounts({ payableControlAccountId: null }, actor.ctx)).toEqual({
      receivableControlAccountId: receivable.uuid,
      payableControlAccountId: null,
      inventoryShrinkageAccountId: null,
    });
  });

  it('refuses an empty patch', async () => {
    const actor = await actorIn(db);

    await expect(updateControlAccounts({}, actor.ctx)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  /**
   * `orgs.write`, not `accounts.write`. The role that enters documents is not the
   * role that decides where every future document lands, and `bookkeeper` is the
   * seeded role that draws exactly that line (`0001_tenancy` excludes `orgs.write`
   * from its bundle while granting the rest).
   */
  it('refuses a bookkeeper, who holds accounts.write and not orgs.write', async () => {
    const owner = await actorIn(db);
    const receivable = await assetAccount(owner);
    const clerk = await actorIn(db, 'bookkeeper');

    await expect(
      updateControlAccounts({ receivableControlAccountId: receivable.uuid }, clerk.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('validating the account (A7)', () => {
  /**
   * The existence oracle, closed. A cross-org account and a nonexistent one must
   * produce the same bytes — otherwise "is that a real account id" is answerable by
   * anyone with a login anywhere in the system.
   *
   * Compared as wire bodies rather than as error classes, because the classes were
   * always going to be equal and the payload is what leaks: a message, a details
   * bag or an echoed id would each distinguish the two.
   */
  it('answers a cross-org account exactly as it answers a nonexistent one', async () => {
    const [mine, theirs] = await Promise.all([actorIn(db), actorIn(db)]);
    const foreign = await assetAccount(theirs);

    const crossOrg = await withContext(mine.ctx, () =>
      updateControlAccounts({ receivableControlAccountId: foreign.uuid }, mine.ctx),
    ).catch((thrown: unknown) => thrown);
    const nonexistent = await withContext(mine.ctx, () =>
      updateControlAccounts({ receivableControlAccountId: newUuid() }, mine.ctx),
    ).catch((thrown: unknown) => thrown);

    expect(crossOrg).toBeInstanceOf(NotFoundError);
    expect(toWireError(crossOrg)).toEqual(toWireError(nonexistent));

    // And nothing was written by the attempt.
    expect(await getControlAccounts(mine.ctx)).toEqual({
      receivableControlAccountId: null,
      payableControlAccountId: null,
      inventoryShrinkageAccountId: null,
    });
  });

  it('answers a malformed id the same way', async () => {
    const actor = await actorIn(db);

    const malformed = await updateControlAccounts(
      { receivableControlAccountId: 'not-a-uuid' },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    // The schema catches this one before the repository does, which is the same
    // answer for a different reason and is fine — what must not happen is a shape
    // of id that produces a *distinguishable* success or miss.
    expect(toWireError(malformed).code).toBe('validation_failed');
  });

  /**
   * A receivable is a claim and a payable is an obligation, so the balance sheet
   * section is not a preference. The refusal exists because the mistake is
   * invisible: nothing would be refused, the postings would land, and the first
   * sign would be a liability sitting in current assets at a year end.
   */
  it('refuses a receivable nomination that is not an asset account', async () => {
    const actor = await actorIn(db);
    const liability = await liabilityAccount(actor);

    const error = await updateControlAccounts(
      { receivableControlAccountId: liability.uuid },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'receivable_control_account_wrong_type' },
    });
  });

  it('refuses a payable nomination that is not a liability account', async () => {
    const actor = await actorIn(db);
    const asset = await assetAccount(actor);

    const error = await updateControlAccounts(
      { payableControlAccountId: asset.uuid },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'payable_control_account_wrong_type' },
    });
  });

  /** Shares `account_inactive` with the tax service: one fact, one name. */
  it('refuses a deactivated account', async () => {
    const actor = await actorIn(db);
    const receivable = await assetAccount(actor);
    await db.app
      .updateTable('accounts')
      .set({ is_active: 0 })
      .where('id', '=', receivable.id)
      .execute();

    const error = await updateControlAccounts(
      { receivableControlAccountId: receivable.uuid },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'account_inactive' },
    });
  });
});

/**
 * The claim the design rests on: repointing a control account moves future postings
 * and cannot restate a past one.
 *
 * Asserted against the ledger rather than against the setting, because the setting
 * agreeing with itself proves nothing. What has to be true is that the journal
 * posted under the old nomination still names the old account after the change —
 * and it is true structurally, since journals carry account ids and the app user
 * holds no UPDATE on them (spec §12), but a structural guarantee nobody has
 * exercised is a guarantee of unknown value.
 */
describe('changing a nomination restates nothing', () => {
  let actor: ActorFixture;
  let oldControl: { readonly id: Buffer; readonly uuid: string };
  let newControl: { readonly id: Buffer; readonly uuid: string };
  let income: string;
  let contact: string;
  let date: string;

  beforeEach(async () => {
    actor = await actorIn(db);
    const period = await db.factories.fiscalPeriod({ orgId: actor.orgId });
    date = period.startDate;

    const [first, second, revenue] = await Promise.all([
      assetAccount(actor, 'Accounts receivable'),
      assetAccount(actor, 'Trade debtors'),
      db.factories.account({ orgId: actor.orgId, type: 'revenue', normalBalance: 'credit' }),
    ]);
    oldControl = { id: first.id, uuid: first.uuid };
    newControl = { id: second.id, uuid: second.uuid };
    income = revenue.uuid;

    const contactId = newUuidBuffer();
    await db.app
      .insertInto('contacts')
      .values({ id: contactId, org_id: actor.orgId, display_name: 'Acme Ltd', is_customer: 1 })
      .execute();
    contact = bufferToUuid(contactId);

    await updateControlAccounts({ receivableControlAccountId: oldControl.uuid }, actor.ctx);
  });

  async function approve(): Promise<string> {
    return withContext(actor.ctx, async () => {
      const draft = await createInvoice({
        contactId: contact,
        issueDate: date,
        dueDate: date,
        taxMode: 'exclusive',
        lines: [
          { description: 'Consulting', quantity: '1', unitAmount: '10000', accountId: income },
        ],
      });
      const approved = await approveInvoice(draft.id);
      if (approved.journalId === null) throw new Error('approval posted no journal');
      return approved.journalId;
    });
  }

  async function accountsOn(journalId: string): Promise<readonly Buffer[]> {
    const rows = await db.app
      .selectFrom('journal_lines')
      .select('account_id')
      .where('journal_id', '=', uuidToBuffer(journalId))
      .where('debit_minor', '>', 0n)
      .execute();
    return rows.map((row) => row.account_id);
  }

  it('leaves the earlier journal naming the account it posted to', async () => {
    const before = await approve();
    await updateControlAccounts({ receivableControlAccountId: newControl.uuid }, actor.ctx);
    const after = await approve();

    expect(await accountsOn(before)).toEqual([oldControl.id]);
    expect(await accountsOn(after)).toEqual([newControl.id]);
  });

  /**
   * The consequence stated in `modules/settings/index.ts`, made visible: while the
   * document posted to the old account is outstanding, the receivable is spread
   * across two accounts and neither alone ties to the subledger. That is why
   * repointing is a setup act and not a way to reorganize a chart in use — and it
   * is asserted so the day someone decides to net the two, the claim is here.
   */
  it('leaves the balance split across the two accounts until the old ones settle', async () => {
    await approve();
    await updateControlAccounts({ receivableControlAccountId: newControl.uuid }, actor.ctx);
    await approve();

    const balances = await db.app
      .selectFrom('journal_lines')
      .select(['account_id'])
      .select((eb) => eb.fn.sum<string>('debit_minor').as('debits'))
      .where('org_id', '=', actor.orgId)
      .where('account_id', 'in', [oldControl.id, newControl.id])
      .groupBy('account_id')
      .execute();

    expect(balances).toHaveLength(2);
    for (const row of balances) expect(BigInt(row.debits)).toBe(10000n);
  });
});
