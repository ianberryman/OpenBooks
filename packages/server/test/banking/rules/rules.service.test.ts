import { beforeEach, describe, expect, it } from 'vitest';

import type { CreateBankRuleRequest } from '@openbooks/shared-types';

import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../../../src/errors';
import {
  createBankRule,
  getBankRule,
  listBankRules,
  updateBankRule,
} from '../../../src/modules/banking/rules';
import type { RuleCandidateLine } from '../../../src/modules/banking/rule-evaluator';
import { bankRuleEvaluator } from '../../../src/modules/banking/rules';
import { useServiceDatabase, withContext } from '../support';
import { ruleSceneIn, type RuleScene } from './support';

/**
 * Bank rules: the service and the evaluator, against real MySQL (OB-080; ROADMAP
 * D-44, acceptance E8/E9/E10).
 *
 * Everything runs through the real service — no stubbed references, no mocked
 * database (spec §11). The fixtures (`ruleSceneIn`) are inserted directly as the app
 * user so the suite does not depend on a sibling wave-2 module being mid-edit.
 */
const db = useServiceDatabase();

let scene: RuleScene;

beforeEach(async () => {
  scene = await ruleSceneIn(db);
});

function createRequest(overrides: Partial<CreateBankRuleRequest> = {}): CreateBankRuleRequest {
  return {
    name: overrides.name ?? 'Tesco groceries',
    ...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
    condition: overrides.condition ?? { description: { mode: 'contains', value: 'tesco' } },
    outcome: overrides.outcome ?? { accountId: scene.accountUuid },
  };
}

function create(overrides: Partial<CreateBankRuleRequest> = {}) {
  return withContext(scene.ctx, () => createBankRule(createRequest(overrides), scene.ctx));
}

function line(overrides: Partial<RuleCandidateLine>): RuleCandidateLine {
  return {
    lineId: overrides.lineId ?? 'line-1',
    bankAccountId: overrides.bankAccountId ?? scene.bankAccountUuid,
    description: overrides.description ?? 'TESCO STORES 1234',
    amount: overrides.amount ?? -1500n,
  };
}

function evaluate(lines: readonly RuleCandidateLine[]) {
  return withContext(scene.ctx, () => bankRuleEvaluator.evaluate(lines, scene.ctx));
}

describe('createBankRule', () => {
  it('round-trips condition and outcome, and reads back through get', async () => {
    const created = await create({
      condition: {
        description: { mode: 'starts_with', value: 'TESCO' },
        direction: 'outbound',
        amountMin: '-500000',
        amountMax: '-100',
        bankAccountId: scene.bankAccountUuid,
      },
      outcome: {
        accountId: scene.accountUuid,
        contactId: scene.contactUuid,
        dimensionValueIds: [scene.valueAUuid],
      },
    });

    expect(created.condition).toEqual({
      description: { mode: 'starts_with', value: 'TESCO' },
      direction: 'outbound',
      amountMin: '-500000',
      amountMax: '-100',
      bankAccountId: scene.bankAccountUuid,
    });
    expect(created.outcome).toEqual({
      accountId: scene.accountUuid,
      contactId: scene.contactUuid,
      dimensionValueIds: [scene.valueAUuid],
    });
    expect(created.isActive).toBe(true);

    const fetched = await withContext(scene.ctx, () => getBankRule(created.id, scene.ctx));
    expect(fetched).toEqual(created);
  });

  it('refuses an empty condition — Zod, before anything is written', async () => {
    await expect(create({ condition: {} })).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a condition that names only a bank account (mirrors the DB CHECK)', async () => {
    await expect(
      create({ condition: { bankAccountId: scene.bankAccountUuid } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a duplicate name in the org', async () => {
    await create({ name: 'Rent' });
    await expect(create({ name: 'Rent' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('404s an outcome account that does not exist in the org', async () => {
    const otherOrg = await ruleSceneIn(db);
    await expect(create({ outcome: { accountId: otherOrg.accountUuid } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('404s a condition bank account from another org', async () => {
    const otherOrg = await ruleSceneIn(db);
    await expect(
      create({
        condition: {
          description: { mode: 'contains', value: 'x' },
          bankAccountId: otherOrg.bankAccountUuid,
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an archived dimension value on the outcome', async () => {
    await expect(
      create({
        outcome: { accountId: scene.accountUuid, dimensionValueIds: [scene.archivedValueUuid] },
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('refuses two dimension values on one axis', async () => {
    await expect(
      create({
        outcome: {
          accountId: scene.accountUuid,
          dimensionValueIds: [scene.valueAUuid, scene.valueBUuid],
        },
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });
});

describe('priority default', () => {
  it('defaults a new rule to the end of the list', async () => {
    const first = await create({ name: 'A' });
    const second = await create({ name: 'B' });
    const third = await create({ name: 'C', priority: 50 });
    const fourth = await create({ name: 'D' });

    expect(first.priority).toBe(100);
    expect(second.priority).toBe(101);
    // `third` explicitly jumps ahead; the next default is still one past the max.
    expect(third.priority).toBe(50);
    expect(fourth.priority).toBe(102);
  });
});

describe('listBankRules', () => {
  it('orders by (priority, created_at, id) and includes org-wide rules under an account filter', async () => {
    const wide = await create({ name: 'Wide', priority: 10 });
    const scoped = await create({
      name: 'Scoped',
      priority: 20,
      condition: {
        description: { mode: 'contains', value: 'x' },
        bankAccountId: scene.bankAccountUuid,
      },
    });
    await create({
      name: 'Other account',
      priority: 5,
      condition: {
        description: { mode: 'contains', value: 'y' },
        bankAccountId: scene.otherBankAccountUuid,
      },
    });

    const all = await withContext(scene.ctx, () => listBankRules({}, scene.ctx));
    expect(all.items.map((r) => r.name)).toEqual(['Other account', 'Wide', 'Scoped']);

    // Filtering by an account returns rules scoped to it AND the org-wide rules that
    // still evaluate against it — not the rule scoped to the other account.
    const forAccount = await withContext(scene.ctx, () =>
      listBankRules({ bankAccountId: scene.bankAccountUuid }, scene.ctx),
    );
    expect(forAccount.items.map((r) => r.name)).toEqual([wide.name, scoped.name]);
  });

  it('filters by isActive', async () => {
    const active = await create({ name: 'Active' });
    const toDisable = await create({ name: 'Disabled' });
    await withContext(scene.ctx, () =>
      updateBankRule(toDisable.id, { isActive: false }, scene.ctx),
    );

    const activeOnly = await withContext(scene.ctx, () =>
      listBankRules({ isActive: true }, scene.ctx),
    );
    expect(activeOnly.items.map((r) => r.name)).toEqual([active.name]);
  });
});

describe('updateBankRule', () => {
  it('replaces the outcome whole, tags included', async () => {
    const created = await create({
      outcome: { accountId: scene.accountUuid, dimensionValueIds: [scene.valueAUuid] },
    });

    const updated = await withContext(scene.ctx, () =>
      updateBankRule(
        created.id,
        { outcome: { accountId: scene.otherAccountUuid, dimensionValueIds: [scene.valueBUuid] } },
        scene.ctx,
      ),
    );

    expect(updated.outcome).toEqual({
      accountId: scene.otherAccountUuid,
      dimensionValueIds: [scene.valueBUuid],
    });
  });

  it('clears tags when the outcome is replaced without any', async () => {
    const created = await create({
      outcome: { accountId: scene.accountUuid, dimensionValueIds: [scene.valueAUuid] },
    });
    const updated = await withContext(scene.ctx, () =>
      updateBankRule(created.id, { outcome: { accountId: scene.accountUuid } }, scene.ctx),
    );
    expect(updated.outcome).toEqual({ accountId: scene.accountUuid });
  });

  it('404s a rule from another org', async () => {
    const otherOrg = await ruleSceneIn(db);
    const mine = await create({});
    await expect(
      withContext(otherOrg.ctx, () => getBankRule(mine.id, otherOrg.ctx)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withContext(otherOrg.ctx, () => updateBankRule(mine.id, { name: 'X' }, otherOrg.ctx)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the evaluator: match modes (case-insensitive)', () => {
  it('contains, equals, starts_with all fold case', async () => {
    const contains = await create({
      name: 'contains',
      condition: { description: { mode: 'contains', value: 'tesco' } },
    });
    const l = line({ description: 'CARD PURCHASE TESCO STORES' });
    const byContains = await evaluate([l]);
    expect(byContains.get(l.lineId)?.ruleId).toBe(contains.id);

    // Replace with an equals rule (deactivate the first so it does not out-rank).
    await withContext(scene.ctx, () => updateBankRule(contains.id, { isActive: false }, scene.ctx));
    const equals = await create({
      name: 'equals',
      condition: { description: { mode: 'equals', value: 'tesco stores' } },
    });
    const exact = line({ description: 'Tesco Stores' });
    expect((await evaluate([exact])).get(exact.lineId)?.ruleId).toBe(equals.id);
    const notExact = line({ description: 'Tesco Stores 99' });
    expect((await evaluate([notExact])).has(notExact.lineId)).toBe(false);

    await withContext(scene.ctx, () => updateBankRule(equals.id, { isActive: false }, scene.ctx));
    const starts = await create({
      name: 'starts',
      condition: { description: { mode: 'starts_with', value: 'TESCO' } },
    });
    const prefix = line({ description: 'tesco petrol' });
    expect((await evaluate([prefix])).get(prefix.lineId)?.ruleId).toBe(starts.id);
    const midMatch = line({ description: 'buy at tesco' });
    expect((await evaluate([midMatch])).has(midMatch.lineId)).toBe(false);
  });
});

describe('the evaluator: signed amount and direction', () => {
  it('matches an outbound rule bounded at negatives', async () => {
    const rule = await create({
      name: 'card fees',
      condition: { direction: 'outbound', amountMin: '-500000', amountMax: '-10000' },
    });

    const inRange = line({ lineId: 'a', amount: -150000n });
    expect((await evaluate([inRange])).get('a')?.ruleId).toBe(rule.id);

    // Above the max (too small an outgoing): -5000 > -10000.
    const tooSmall = line({ lineId: 'b', amount: -5000n });
    expect((await evaluate([tooSmall])).has('b')).toBe(false);

    // Below the min (too large an outgoing): -600000 < -500000.
    const tooLarge = line({ lineId: 'c', amount: -600000n });
    expect((await evaluate([tooLarge])).has('c')).toBe(false);

    // An inbound line of the same magnitude is the wrong direction entirely.
    const inbound = line({ lineId: 'd', amount: 150000n });
    expect((await evaluate([inbound])).has('d')).toBe(false);
  });
});

describe('the evaluator: bankAccountId scoping', () => {
  it('a null scope applies to every account; a set scope only to its own', async () => {
    const orgWide = await create({
      name: 'org-wide',
      condition: { description: { mode: 'contains', value: 'tesco' } },
    });
    const scoped = await create({
      name: 'scoped',
      priority: 1,
      condition: {
        description: { mode: 'contains', value: 'tesco' },
        bankAccountId: scene.bankAccountUuid,
      },
    });

    // On the scoped account, the lower-priority scoped rule wins.
    const onScoped = line({ lineId: 'x', bankAccountId: scene.bankAccountUuid });
    expect((await evaluate([onScoped])).get('x')?.ruleId).toBe(scoped.id);

    // On another account, the scoped rule does not apply; the org-wide one does.
    const onOther = line({ lineId: 'y', bankAccountId: scene.otherBankAccountUuid });
    expect((await evaluate([onOther])).get('y')?.ruleId).toBe(orgWide.id);
  });
});

describe('the evaluator: determinism and deactivation', () => {
  it('lower priority wins; equal priority falls to created_at (first created)', async () => {
    const first = await create({
      name: 'first-100',
      condition: { description: { mode: 'contains', value: 'tesco' } },
    });
    const second = await create({
      name: 'second-100',
      condition: { description: { mode: 'contains', value: 'tesco' } },
    });
    // Both default to a priority (100 then 101). The lower (100, first) wins.
    const l = line({ description: 'TESCO' });
    expect((await evaluate([l])).get(l.lineId)?.ruleId).toBe(first.id);
    expect(second.priority).toBeGreaterThan(first.priority);

    // Two at the *same* priority: the earlier-created wins on the created_at tie.
    const tieA = await create({
      name: 'tie-a',
      priority: 5,
      condition: { description: { mode: 'contains', value: 'shell' } },
    });
    await create({
      name: 'tie-b',
      priority: 5,
      condition: { description: { mode: 'contains', value: 'shell' } },
    });
    const fuel = line({ lineId: 'f', description: 'SHELL' });
    expect((await evaluate([fuel])).get('f')?.ruleId).toBe(tieA.id);
  });

  it('a deactivated rule stops proposing, and reactivating restores it', async () => {
    const rule = await create({
      name: 'tesco',
      condition: { description: { mode: 'contains', value: 'tesco' } },
    });
    const l = line({ description: 'TESCO' });
    expect((await evaluate([l])).get(l.lineId)?.ruleId).toBe(rule.id);

    await withContext(scene.ctx, () => updateBankRule(rule.id, { isActive: false }, scene.ctx));
    expect((await evaluate([l])).has(l.lineId)).toBe(false);

    await withContext(scene.ctx, () => updateBankRule(rule.id, { isActive: true }, scene.ctx));
    expect((await evaluate([l])).get(l.lineId)?.ruleId).toBe(rule.id);
  });

  it('carries the full outcome through the evaluator', async () => {
    const rule = await create({
      condition: { description: { mode: 'contains', value: 'tesco' } },
      outcome: {
        accountId: scene.accountUuid,
        contactId: scene.contactUuid,
        dimensionValueIds: [scene.valueAUuid],
      },
    });
    const l = line({ description: 'TESCO' });
    const match = (await evaluate([l])).get(l.lineId);
    expect(match).toEqual({
      ruleId: rule.id,
      accountId: scene.accountUuid,
      contactId: scene.contactUuid,
      dimensionValueIds: [scene.valueAUuid],
    });
  });
});
