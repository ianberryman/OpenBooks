import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { NotFoundError, PermissionDeniedError, toWireError } from '../../src/errors';
import { getDiscountAccounts, updateDiscountAccounts } from '../../src/modules/settings';
import { newUuid } from '../db';
import type { ActorFixture } from './support';
import { actorIn, useServiceDatabase } from './support';

/**
 * The org's discount-account nominations (OB-136; ROADMAP D-106, D-107) —
 * `control-accounts.test.ts`'s own claims, over the two columns beside those.
 */
const db = useServiceDatabase();

function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

let codeSequence = 0;

async function expenseAccount(actor: ActorFixture, name = 'Sales discounts') {
  return db.factories.account({
    orgId: actor.orgId,
    code: `6${String((codeSequence += 1)).padStart(3, '0')}`,
    name,
    type: 'expense',
    normalBalance: 'debit',
  });
}

async function revenueAccount(actor: ActorFixture, name = 'Purchase discounts') {
  return db.factories.account({
    orgId: actor.orgId,
    code: `4${String((codeSequence += 1)).padStart(3, '0')}`,
    name,
    type: 'revenue',
    normalBalance: 'credit',
  });
}

describe('reading the nominations', () => {
  it('answers both null for an org that has never nominated one', async () => {
    const actor = await actorIn(db);

    expect(await getDiscountAccounts(actor.ctx)).toEqual({
      discountGivenAccountId: null,
      discountReceivedAccountId: null,
    });
  });

  it('takes orgs.read, which every seeded role holds', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(getDiscountAccounts(actor.ctx)).resolves.toBeDefined();
  });
});

describe('nominating', () => {
  it('records a nomination and reads it back', async () => {
    const actor = await actorIn(db);
    const given = await expenseAccount(actor);

    const updated = await updateDiscountAccounts({ discountGivenAccountId: given.uuid }, actor.ctx);

    expect(updated).toEqual({
      discountGivenAccountId: given.uuid,
      discountReceivedAccountId: null,
    });
    expect(await getDiscountAccounts(actor.ctx)).toEqual(updated);
  });

  it('leaves an omitted side alone and clears an explicitly null one', async () => {
    const actor = await actorIn(db);
    const [given, received] = await Promise.all([expenseAccount(actor), revenueAccount(actor)]);

    await updateDiscountAccounts(
      { discountGivenAccountId: given.uuid, discountReceivedAccountId: received.uuid },
      actor.ctx,
    );

    expect(await updateDiscountAccounts({ discountReceivedAccountId: null }, actor.ctx)).toEqual({
      discountGivenAccountId: given.uuid,
      discountReceivedAccountId: null,
    });
  });

  it('refuses an empty patch', async () => {
    const actor = await actorIn(db);

    await expect(updateDiscountAccounts({}, actor.ctx)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('refuses a bookkeeper, who holds accounts.write and not orgs.write', async () => {
    const owner = await actorIn(db);
    const given = await expenseAccount(owner);
    const clerk = await actorIn(db, 'bookkeeper');

    await expect(
      updateDiscountAccounts({ discountGivenAccountId: given.uuid }, clerk.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('validating the account (A7)', () => {
  it('answers a cross-org account exactly as it answers a nonexistent one', async () => {
    const [mine, theirs] = await Promise.all([actorIn(db), actorIn(db)]);
    const foreign = await expenseAccount(theirs);

    const crossOrg = await withContext(mine.ctx, () =>
      updateDiscountAccounts({ discountGivenAccountId: foreign.uuid }, mine.ctx),
    ).catch((thrown: unknown) => thrown);
    const nonexistent = await withContext(mine.ctx, () =>
      updateDiscountAccounts({ discountGivenAccountId: newUuid() }, mine.ctx),
    ).catch((thrown: unknown) => thrown);

    expect(crossOrg).toBeInstanceOf(NotFoundError);
    expect(toWireError(crossOrg)).toEqual(toWireError(nonexistent));
  });

  it('refuses a discount-given nomination that is not an expense account', async () => {
    const actor = await actorIn(db);
    const revenue = await revenueAccount(actor);

    const error = await updateDiscountAccounts(
      { discountGivenAccountId: revenue.uuid },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'discount_given_account_wrong_type' },
    });
  });

  it('refuses a discount-received nomination that is not a revenue account', async () => {
    const actor = await actorIn(db);
    const expense = await expenseAccount(actor);

    const error = await updateDiscountAccounts(
      { discountReceivedAccountId: expense.uuid },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'discount_received_account_wrong_type' },
    });
  });

  it('refuses a deactivated account', async () => {
    const actor = await actorIn(db);
    const given = await expenseAccount(actor);
    await db.app.updateTable('accounts').set({ is_active: 0 }).where('id', '=', given.id).execute();

    const error = await updateDiscountAccounts(
      { discountGivenAccountId: given.uuid },
      actor.ctx,
    ).catch((thrown: unknown) => thrown);

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'account_inactive' },
    });
  });
});
