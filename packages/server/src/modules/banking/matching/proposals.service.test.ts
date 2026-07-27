import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BankMatchProposal, BankMatchReasonCode } from '@openbooks/shared-types';

import { createRequestContext } from '../../../context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../../db';
import { PermissionDeniedError } from '../../../errors';
import type { RuleMatch } from '../rule-evaluator';
import { SYSTEM_ROLE_UUIDS, newUuid, systemRoleId, useTestDatabase } from '../../../../test/db';
import {
  bankJournalIn,
  billIn,
  buildScene,
  codingHistoryIn,
  creditNoteAllocationIn,
  fakeEvaluator,
  invoiceIn,
  lineIn,
  noRules,
  withContext,
  type MatchScene,
} from '../../../../test/banking/matching/support';

import { proposeMatches } from './service';

/**
 * The match proposal engine (OB-079; ROADMAP D-43, D-44, acceptance E3, E10).
 *
 * Every candidate is a real row — a journal on the bank account, an open invoice, a
 * prior coding — so the engine is exercised end to end against MySQL (spec §11). The
 * rule source is the injected fake, which is the seam OB-080 fills; the fake also
 * counts its calls, which is how the page's batching is proven.
 *
 * The ranking is asserted by exact `rank` and by the reason codes that justify it: the
 * order is the product (D-43), and a comparator bug that is right on one candidate and
 * wrong on two is the class this project has been bitten by, so every ordering case
 * ranks more than one candidate, and the deterministic case more than one line.
 */

const db = useTestDatabase();

beforeAll(() => {
  if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
});

afterAll(async () => {
  await destroyDatabase();
});

let scene: MatchScene;

beforeEach(async () => {
  scene = await buildScene(db);
});

function propose(lineUuids: readonly string[], evaluator = noRules) {
  return withContext(scene.ctx, () =>
    proposeMatches({ lineIds: [...lineUuids] }, { ruleEvaluator: evaluator.evaluator }, scene.ctx),
  );
}

function codesOf(proposal: BankMatchProposal): Set<BankMatchReasonCode> {
  return new Set(proposal.reasons.map((reason) => reason.code));
}

function assertKind<K extends BankMatchProposal['kind']>(
  proposal: BankMatchProposal | undefined,
  kind: K,
): Extract<BankMatchProposal, { kind: K }> {
  expect(proposal?.kind).toBe(kind);
  return proposal as Extract<BankMatchProposal, { kind: K }>;
}

describe('the three proposal kinds', () => {
  it('ranks an exact journal on the bank account as link_entry first', async () => {
    const line = await lineIn(db, scene, {
      amount: 150_00n,
      description: 'ACME PAYMENT',
      counterparty: 'Acme',
      bankReference: 'INV-1',
      postedDate: '2026-03-15',
    });
    const exact = await bankJournalIn(db, scene, {
      amount: 150_00n,
      date: '2026-03-15',
      memo: 'INV-1',
    });
    const near = await bankJournalIn(db, scene, {
      amount: 150_50n,
      date: '2026-03-19',
      memo: 'unrelated',
    });

    const { lines } = await propose([line.uuid]);
    const proposals = lines[0]!.proposals;
    expect(proposals).toHaveLength(2);

    const first = assertKind(proposals[0], 'link_entry');
    expect(first).toMatchObject({ rank: 1, journalAmount: '15000' });
    expect(first.journalId).toBe(exact.uuid);
    expect(codesOf(first)).toEqual(new Set(['amount_exact', 'date_exact', 'reference_match']));

    const second = assertKind(proposals[1], 'link_entry');
    expect(second.rank).toBe(2);
    expect(second.journalId).toBe(near.uuid);
    expect(codesOf(second)).toEqual(new Set(['amount_close', 'date_close']));
  });

  it('proposes allocate_document with the outstanding balance for an open invoice', async () => {
    const invoice = await invoiceIn(db, scene, { amountMinor: 200_00n, contactName: 'Globex' });
    const line = await lineIn(db, scene, {
      amount: 200_00n,
      description: 'FROM GLOBEX',
      counterparty: 'Globex',
      postedDate: '2026-03-10',
    });

    const { lines } = await propose([line.uuid]);
    const first = assertKind(lines[0]!.proposals[0], 'allocate_document');

    expect(first).toMatchObject({
      rank: 1,
      targetType: 'invoice',
      outstanding: '20000',
      contactName: 'Globex',
      documentNumber: invoice.number,
    });
    expect(first.targetId).toBe(invoice.uuid);
    expect(codesOf(first)).toEqual(new Set(['amount_exact', 'counterparty_match']));
  });

  it('reflects a partial allocation in the outstanding it proposes (D-34)', async () => {
    const invoice = await invoiceIn(db, scene, { amountMinor: 500_00n, contactName: 'Initech' });
    // Settle part of it through the subledger's one mechanism, so outstanding is
    // computed on read (D-34) rather than read from a column.
    await creditNoteAllocationIn(db, scene, {
      invoiceId: invoice.id,
      contactId: invoice.contactId,
      amountMinor: 120_00n,
    });

    const line = await lineIn(db, scene, {
      amount: 380_00n,
      counterparty: 'Initech',
      description: 'INITECH',
      postedDate: '2026-03-12',
    });

    const { lines } = await propose([line.uuid]);
    const first = assertKind(lines[0]!.proposals[0], 'allocate_document');
    expect(first).toMatchObject({ outstanding: '38000', rank: 1 });
    expect(codesOf(first)).toEqual(new Set(['amount_exact', 'counterparty_match']));
  });

  it('turns a rule match into a post_entry carrying rule_match and the ruleId', async () => {
    const line = await lineIn(db, scene, {
      amount: -50_00n,
      description: 'AWS',
      counterparty: 'Amazon',
      postedDate: '2026-03-12',
    });
    const ruleMatch: RuleMatch = {
      ruleId: newUuid(),
      accountId: scene.accountUuids.coding,
      contactId: null,
      dimensionValueIds: [],
    };
    const evaluator = fakeEvaluator(new Map([[line.uuid, ruleMatch]]));

    const { lines } = await propose([line.uuid], evaluator);
    const first = assertKind(lines[0]!.proposals[0], 'post_entry');

    expect(first).toMatchObject({
      rank: 1,
      ruleId: ruleMatch.ruleId,
      accountId: scene.accountUuids.coding,
    });
    expect(codesOf(first)).toEqual(new Set(['rule_match']));
    // The rule evaluator ran once for the page, not once per line (E10).
    expect(evaluator.calls()).toBe(1);
  });

  it('proposes a post_entry from the org’s own coding history, with ruleId null', async () => {
    await codingHistoryIn(db, scene, {
      counterparty: 'Netflix',
      amount: -9_99n,
      codedAccountId: scene.accounts.coding,
    });
    const line = await lineIn(db, scene, {
      amount: -9_99n,
      description: 'NETFLIX.COM',
      counterparty: 'Netflix',
      postedDate: '2026-03-20',
    });

    const { lines } = await propose([line.uuid]);
    const history = lines[0]!.proposals.find((proposal) => proposal.kind === 'post_entry');

    expect(history).toBeDefined();
    expect(history).toMatchObject({
      kind: 'post_entry',
      ruleId: null,
      accountId: scene.accountUuids.coding,
    });
    expect(codesOf(history!)).toEqual(new Set(['contact_history', 'counterparty_match']));
  });
});

describe('the ordinary non-answers', () => {
  it('returns an empty proposal array for a line nothing resembles', async () => {
    const line = await lineIn(db, scene, {
      amount: 777_77n,
      description: 'MYSTERY',
      counterparty: 'Nobody',
      postedDate: '2026-03-15',
    });

    const { lines } = await propose([line.uuid]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ lineId: line.uuid, proposals: [] });
  });

  it('omits a line this org does not hold rather than erroring the page (E9)', async () => {
    const real = await lineIn(db, scene, {
      amount: 10_00n,
      description: 'X',
      postedDate: '2026-03-15',
    });
    const stranger = newUuid();

    const { lines } = await propose([stranger, real.uuid]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.lineId).toBe(real.uuid);
  });

  it('never returns more than ten candidates for a line', async () => {
    for (let index = 0; index < 15; index += 1) {
      await bankJournalIn(db, scene, {
        amount: 100_00n,
        date: '2026-03-15',
        memo: `entry-${index}`,
      });
    }
    const line = await lineIn(db, scene, {
      amount: 100_00n,
      description: 'CAP',
      postedDate: '2026-03-15',
    });

    const { lines } = await propose([line.uuid]);
    const proposals = lines[0]!.proposals;
    expect(proposals).toHaveLength(10);
    expect(proposals.map((proposal) => proposal.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(proposals.every((proposal) => proposal.kind === 'link_entry')).toBe(true);
  });
});

describe('the ranking is deterministic and correct across kinds and lines', () => {
  /**
   * Two lines, each with candidates of three different strengths spanning all three
   * kinds. The exact ranks are asserted, then the whole call is repeated and the order
   * asserted identical — a comparator that is right on one candidate and wrong on two,
   * or that leans on the freshly-minted proposal id, fails here.
   */
  async function seedTwoLines(): Promise<{ a: string; b: string; ruleId: string }> {
    // Line A — inbound: an exact ledger entry, an invoice by name, and a near miss.
    const lineA = await lineIn(db, scene, {
      amount: 300_00n,
      description: 'ACME PAYMENT',
      counterparty: 'ACME',
      bankReference: 'REF7',
      postedDate: '2026-03-15',
    });
    await bankJournalIn(db, scene, { amount: 300_00n, date: '2026-03-15', memo: 'REF7' });
    await invoiceIn(db, scene, { amountMinor: 300_00n, contactName: 'ACME', reference: 'ZZZ' });
    await bankJournalIn(db, scene, { amount: 300_50n, date: '2026-03-16', memo: 'other' });

    // Line B — outbound: a rule, a bill by name, and a near miss.
    const lineB = await lineIn(db, scene, {
      amount: -50_00n,
      description: 'BOB',
      counterparty: 'BOB',
      postedDate: '2026-03-10',
    });
    await billIn(db, scene, { amountMinor: 50_00n, contactName: 'BOB' });
    await bankJournalIn(db, scene, { amount: -50_10n, date: '2026-03-10', memo: 'x' });

    return { a: lineA.uuid, b: lineB.uuid, ruleId: newUuid() };
  }

  it('assigns the ranks the reasons justify', async () => {
    const { a, b, ruleId } = await seedTwoLines();
    const evaluator = fakeEvaluator(
      new Map([
        [
          b,
          { ruleId, accountId: scene.accountUuids.coding, contactId: null, dimensionValueIds: [] },
        ],
      ]),
    );

    const { lines } = await propose([a, b], evaluator);
    const byLine = new Map(lines.map((line) => [line.lineId, line.proposals]));

    const aProposals = byLine.get(a)!;
    expect(aProposals.map((proposal) => [proposal.kind, proposal.rank])).toEqual([
      ['link_entry', 1],
      ['allocate_document', 2],
      ['link_entry', 3],
    ]);
    expect(codesOf(aProposals[0]!)).toEqual(
      new Set(['amount_exact', 'date_exact', 'reference_match']),
    );
    expect(codesOf(aProposals[1]!)).toEqual(new Set(['amount_exact', 'counterparty_match']));

    const bProposals = byLine.get(b)!;
    expect(bProposals.map((proposal) => [proposal.kind, proposal.rank])).toEqual([
      ['post_entry', 1],
      ['allocate_document', 2],
      ['link_entry', 3],
    ]);
    expect(codesOf(bProposals[0]!)).toEqual(new Set(['rule_match']));

    // The page was evaluated for rules in a single batched call over both lines.
    expect(evaluator.calls()).toBe(1);
    expect(evaluator.lastLineCount()).toBe(2);
  });

  it('returns the same order when asked twice', async () => {
    const { a, b, ruleId } = await seedTwoLines();
    const evaluator = fakeEvaluator(
      new Map([
        [
          b,
          { ruleId, accountId: scene.accountUuids.coding, contactId: null, dimensionValueIds: [] },
        ],
      ]),
    );

    const signature = (list: readonly BankMatchProposal[]) =>
      list.map((proposal) => {
        const identity =
          proposal.kind === 'link_entry'
            ? proposal.journalId
            : proposal.kind === 'allocate_document'
              ? proposal.targetId
              : `${proposal.accountId}:${proposal.ruleId ?? 'history'}`;
        return `${proposal.rank}:${proposal.kind}:${identity}`;
      });

    const first = await propose([a, b], evaluator);
    const second = await propose([a, b], evaluator);

    for (const line of first.lines) {
      const match = second.lines.find((candidate) => candidate.lineId === line.lineId);
      expect(signature(match!.proposals)).toEqual(signature(line.proposals));
    }
  });

  it('breaks ties on the candidate’s own identity, not the freshly-minted id', async () => {
    // Five journals identical in every scored respect: same amount, date and memo, so
    // every reason and therefore every score is equal. The order among them must still
    // be the same on every call — a tie-break on the response id (which is minted per
    // call) would shuffle them, and the same statement would rank differently twice.
    const journals: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const journal = await bankJournalIn(db, scene, {
        amount: 88_00n,
        date: '2026-03-15',
        memo: 'TIED',
      });
      journals.push(journal.uuid);
    }
    const line = await lineIn(db, scene, {
      amount: 88_00n,
      description: 'TIED',
      bankReference: 'TIED',
      postedDate: '2026-03-15',
    });

    const order = async (): Promise<string[]> => {
      const { lines } = await propose([line.uuid]);
      return lines[0]!.proposals.map((proposal) =>
        proposal.kind === 'link_entry' ? proposal.journalId : proposal.kind,
      );
    };

    const first = await order();
    expect(new Set(first)).toEqual(new Set(journals));
    expect(await order()).toEqual(first);
  });
});

describe('E10: the page path is bounded and batched', () => {
  it('issues a query count that does not scale with the number of lines', async () => {
    // A fixed candidate universe every line draws from.
    await bankJournalIn(db, scene, { amount: 42_00n, date: '2026-03-15', memo: 'shared' });
    await invoiceIn(db, scene, { amountMinor: 42_00n, contactName: 'Shared' });

    const makeLines = async (count: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const line = await lineIn(db, scene, {
          amount: 42_00n,
          description: `L${index}`,
          counterparty: 'Shared',
          postedDate: '2026-03-15',
        });
        ids.push(line.uuid);
      }
      return ids;
    };

    const comSelect = async (): Promise<number> => {
      const result = await sql<{ Variable_name: string; Value: string }>`
        SHOW GLOBAL STATUS LIKE 'Com_select'
      `.execute(db.migrator);
      return Number(result.rows[0]?.Value ?? '0');
    };

    const small = await makeLines(3);
    const large = await makeLines(60);

    // Warm the pool and the permission read so the measurement is of steady state.
    await propose(small);

    const beforeSmall = await comSelect();
    await propose(small);
    const smallDelta = (await comSelect()) - beforeSmall;

    const beforeLarge = await comSelect();
    await propose(large);
    const largeDelta = (await comSelect()) - beforeLarge;

    // A per-line query storm would make the 60-line page cost ~20× the 3-line page.
    // The sources are loaded once for the page, so the counts are a small constant and
    // the larger page issues no more queries than the smaller one.
    expect(smallDelta).toBeLessThan(12);
    expect(largeDelta).toBeLessThanOrEqual(smallDelta);
  });
});

describe('permission', () => {
  it('refuses a caller without banking.read', async () => {
    const apOnly = await db.factories.user();
    await db.factories.orgMember({
      orgId: scene.orgId,
      userId: apOnly.id,
      roleId: systemRoleId('apOnly'),
    });
    const ctx = createRequestContext({
      orgId: scene.ctx.orgId,
      roleId: SYSTEM_ROLE_UUIDS.apOnly,
      userId: apOnly.uuid,
      actorType: 'user',
      actorId: apOnly.uuid,
    });

    await expect(
      withContext(ctx, () =>
        proposeMatches({ lineIds: [newUuid()] }, { ruleEvaluator: noRules.evaluator }, ctx),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
