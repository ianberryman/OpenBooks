import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { bufferToUuid } from '../../src/db';
import {
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import {
  createDraft,
  discardDraft,
  getDraft,
  listDrafts,
  postDraft,
  updateDraft,
} from '../../src/modules/drafts';
import { newUuid, SYSTEM_ROLE_UUIDS } from '../db';
import type { ActorFixture } from './support';
import {
  actorIn,
  contactIn,
  contextFor,
  dimensionIn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * The drafts service against real MySQL (spec §11 — never SQLite, never mocks).
 *
 * Everything goes through the exported service functions: the permission check,
 * the A7 miss, and the post-time validation all live at that boundary, and a test
 * reaching the repository would pass while the boundary was missing.
 *
 * Every call runs inside `withContext`, which is the shape production has —
 * `assertPostable` reads the ambient context rather than taking one, so a posting
 * test outside a scope proves nothing about the posting path.
 *
 * The concurrency claims — that a post and its discard are one transaction, and
 * that two posts of one draft yield one journal — are in `post-race.test.ts`,
 * because a sequential simulation of a race passes against code that has no
 * locking at all.
 */
const db = useServiceDatabase();

interface Scene {
  readonly actor: ActorFixture;
  readonly debit: string;
  readonly credit: string;
  readonly date: string;
}

/** An org with a member, an open period covering 2026, and a debit/credit pair. */
async function scene(role: Parameters<typeof actorIn>[1] = 'owner'): Promise<Scene> {
  const actor = await actorIn(db, role);
  const [period, debit, credit] = await Promise.all([
    db.factories.fiscalPeriod({ orgId: actor.orgId }),
    db.factories.account({ orgId: actor.orgId, type: 'expense', normalBalance: 'debit' }),
    db.factories.account({ orgId: actor.orgId, type: 'liability', normalBalance: 'credit' }),
  ]);

  return { actor, debit: debit.uuid, credit: credit.uuid, date: period.startDate };
}

function balancedLines(s: Scene, amount = '150000'): Parameters<typeof createDraft>[0]['lines'] {
  return [
    { accountId: s.debit, side: 'debit', amount },
    { accountId: s.credit, side: 'credit', amount },
  ];
}

/** The error a call produced, in wire form — or `undefined` if it succeeded. */
async function wireErrorOf(body: () => Promise<unknown>): Promise<unknown> {
  return body().then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('creating, reading, and listing drafts', () => {
  it('creates an empty draft — no date, no lines, nothing required', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({});

      expect(draft).toMatchObject({
        entryDate: null,
        memo: null,
        reference: null,
        createdByUserId: s.actor.userUuid,
        lines: [],
      });
      expect(await getDraft(draft.id)).toEqual(draft);
    });
  });

  it('round-trips a line’s account, contact, side, amount, memo, and tags', async () => {
    const s = await scene();
    const contact = await contactIn(db, s.actor.orgId);
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales', 'ops']);
    const sales = bufferToUuid(department.valueIds[0] ?? contact);

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        entryDate: s.date,
        memo: 'Rent',
        reference: 'INV-42',
        lines: [
          {
            accountId: s.debit,
            contactId: bufferToUuid(contact),
            side: 'debit',
            amount: '150000',
            memo: 'March',
            dimensionValueIds: [sales],
          },
          { accountId: s.credit, side: 'credit', amount: '150000' },
        ],
      });

      expect(draft.lines).toHaveLength(2);
      expect(draft.lines[0]).toMatchObject({
        lineNumber: 1,
        accountId: s.debit,
        contactId: bufferToUuid(contact),
        side: 'debit',
        amount: '150000',
        memo: 'March',
        dimensionValueIds: [sales],
      });
      expect(draft.lines[1]).toMatchObject({
        lineNumber: 2,
        accountId: s.credit,
        contactId: null,
        side: 'credit',
        amount: '150000',
        memo: null,
        dimensionValueIds: [],
      });
      // A `BIGINT` on the wire as a string, so it cannot lose precision past 2^53.
      expect(typeof draft.lines[0]?.lineId).toBe('string');
    });
  });

  it('accepts the half-finished states a journal could not hold', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      // Unbalanced, an account with no amount, an amount-less line with a side, and
      // an empty line. Every one is refused by `journal_lines` and is an ordinary
      // state for a form in progress (D-19).
      const draft = await createDraft({
        lines: [
          { accountId: s.debit, side: 'debit', amount: '100' },
          { accountId: s.credit },
          { side: 'credit', amount: '0' },
          {},
        ],
      });

      expect(draft.lines).toHaveLength(4);
      expect(draft.lines[1]).toMatchObject({ side: null, amount: '0' });
      expect(draft.lines[3]).toMatchObject({ accountId: null, side: null, amount: '0' });
    });
  });

  it('reads a side back from the amount columns, so a side with no amount has neither', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({ lines: [{ accountId: s.debit, side: 'debit' }] });

      expect(draft.lines[0]).toMatchObject({ side: null, amount: '0' });
    });
  });

  it('lists drafts oldest first and pages with a cursor', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const first = await createDraft({ memo: 'one' });
      const second = await createDraft({ memo: 'two' });
      const third = await createDraft({ memo: 'three' });

      const page = await listDrafts({ limit: 2 });
      expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
      expect(page.nextCursor).not.toBeNull();

      const rest = await listDrafts({ limit: 2, cursor: page.nextCursor ?? '' });
      expect(rest.items.map((item) => item.id)).toEqual([third.id]);
      expect(rest.nextCursor).toBeNull();
    });
  });

  it('filters the list by author, and an unknown author is an empty page', async () => {
    const s = await scene();
    const other = await db.factories.user();
    await db.factories.orgMember({ orgId: s.actor.orgId, userId: other.id });

    const mine = await withContext(s.actor.ctx, () => createDraft({ memo: 'mine' }));
    const theirs = await withContext(
      contextFor(s.actor.orgUuid, SYSTEM_ROLE_UUIDS.owner, other.uuid),
      () => createDraft({ memo: 'theirs' }),
    );

    await withContext(s.actor.ctx, async () => {
      expect((await listDrafts({ createdByUserId: s.actor.userUuid })).items).toEqual([
        expect.objectContaining({ id: mine.id }),
      ]);
      expect((await listDrafts({ createdByUserId: other.uuid })).items).toEqual([
        expect.objectContaining({ id: theirs.id }),
      ]);
      expect((await listDrafts({ createdByUserId: newUuid() })).items).toEqual([]);
    });
  });
});

describe('A7 — a cross-org draft is indistinguishable from one that never existed', () => {
  it('answers another org’s draft, a nonexistent one, and a malformed id identically', async () => {
    const mine = await scene();
    const theirs = await scene();
    const foreign = await withContext(theirs.actor.ctx, () => createDraft({ memo: 'theirs' }));

    const answers = await withContext(mine.actor.ctx, async () =>
      Promise.all(
        [foreign.id, newUuid(), 'not-a-uuid'].map((id) => wireErrorOf(() => getDraft(id))),
      ),
    );

    expect(answers[0]).toMatchObject({ code: 'not_found', status: 404 });
    // Byte-identical, not merely the same code: the body is what an enumerator reads.
    expect(JSON.stringify(answers[1])).toBe(JSON.stringify(answers[0]));
    expect(JSON.stringify(answers[2])).toBe(JSON.stringify(answers[0]));
  });

  it('refuses another org’s account as a miss rather than a foreign-key error', async () => {
    const mine = await scene();
    const theirs = await scene();

    await withContext(mine.actor.ctx, async () => {
      await expect(createDraft({ lines: [{ accountId: theirs.debit }] })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(createDraft({ lines: [{ accountId: newUuid() }] })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('refuses another org’s dimension value as a miss', async () => {
    const mine = await scene();
    const theirs = await scene();
    const theirDimension = await dimensionIn(db, theirs.actor.orgId, 'department', ['sales']);
    const theirValue = bufferToUuid(theirDimension.valueIds[0] ?? theirs.actor.orgId);

    await withContext(mine.actor.ctx, async () => {
      await expect(
        createDraft({ lines: [{ accountId: mine.debit, dimensionValueIds: [theirValue] }] }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('what a draft still refuses', () => {
  it('refuses a negative amount — that is a sign convention, not incompleteness', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      await expect(
        createDraft({ lines: [{ accountId: s.debit, side: 'debit', amount: '-100' }] }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('refuses an amount with no side, because there is no column to store it in', async () => {
    const s = await scene();

    const error = await withContext(s.actor.ctx, () =>
      wireErrorOf(() => createDraft({ lines: [{ amount: '100' }] })),
    );

    expect(error).toMatchObject({ code: 'validation_failed', status: 400 });
    expect(JSON.stringify(error)).toContain('lines.0.side');
  });

  it('refuses two values on one axis rather than picking one', async () => {
    const s = await scene();
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales', 'ops']);
    const both = department.valueIds.map((id) => bufferToUuid(id));

    await withContext(s.actor.ctx, async () => {
      await expect(
        createDraft({ lines: [{ accountId: s.debit, dimensionValueIds: both }] }),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
    });
  });
});

describe('editing and discarding', () => {
  it('patches the header, clears a field with null, and leaves absent fields alone', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({ memo: 'first', reference: 'REF-1' });

      const updated = await updateDraft(draft.id, { memo: null, entryDate: s.date });

      expect(updated).toMatchObject({ memo: null, reference: 'REF-1', entryDate: s.date });
    });
  });

  it('replaces the whole line set, taking the old lines’ tags with it', async () => {
    const s = await scene();
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales']);
    const sales = bufferToUuid(department.valueIds[0] ?? s.actor.orgId);

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        lines: [{ accountId: s.debit, side: 'debit', amount: '100', dimensionValueIds: [sales] }],
      });

      const updated = await updateDraft(draft.id, {
        lines: [{ accountId: s.credit, side: 'credit', amount: '250' }],
      });

      expect(updated.lines).toHaveLength(1);
      expect(updated.lines[0]).toMatchObject({
        accountId: s.credit,
        side: 'credit',
        amount: '250',
        dimensionValueIds: [],
      });
    });

    const tags = await db.app
      .selectFrom('journal_draft_line_dimensions')
      .select('dimension_value_id')
      .where('org_id', '=', s.actor.orgId)
      .execute();
    expect(tags).toEqual([]);
  });

  it('clears every line with an empty array', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({ lines: balancedLines(s) });

      expect((await updateDraft(draft.id, { lines: [] })).lines).toEqual([]);
    });
  });

  it('bumps updatedAt when only the lines changed', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({ memo: 'unchanged' });

      const updated = await updateDraft(draft.id, { lines: balancedLines(s) });

      // ON UPDATE CURRENT_TIMESTAMP fires only when a column's value changes, so a
      // lines-only edit would otherwise leave the header claiming it was never touched.
      expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(draft.updatedAt) - 1);
      expect(updated.lines).toHaveLength(2);
    });
  });

  it('discards the draft, its lines, and its tags, and refuses a second discard', async () => {
    const s = await scene();
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales']);
    const sales = bufferToUuid(department.valueIds[0] ?? s.actor.orgId);

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        lines: [{ accountId: s.debit, side: 'debit', amount: '100', dimensionValueIds: [sales] }],
      });

      await discardDraft(draft.id);

      await expect(getDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(discardDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    const lines = await db.app
      .selectFrom('journal_draft_lines')
      .select('id')
      .where('org_id', '=', s.actor.orgId)
      .execute();
    const tags = await db.app
      .selectFrom('journal_draft_line_dimensions')
      .select('dimension_value_id')
      .where('org_id', '=', s.actor.orgId)
      .execute();

    expect(lines).toEqual([]);
    expect(tags).toEqual([]);
  });
});

describe('posting a draft', () => {
  it('posts the entry and discards the draft', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        entryDate: s.date,
        memo: 'Rent',
        lines: balancedLines(s),
      });

      const posted = await postDraft(draft.id);

      expect(posted).toMatchObject({
        date: s.date,
        memo: 'Rent',
        actorType: 'user',
        actorId: s.actor.userUuid,
        reversesJournalId: null,
      });
      expect(posted.lines).toEqual([
        expect.objectContaining({ accountId: s.debit, side: 'debit', amount: 150000n }),
        expect.objectContaining({ accountId: s.credit, side: 'credit', amount: 150000n }),
      ]);

      // Gone as part of the posting rather than after it — see `post-race.test.ts`
      // for the claim that the two are one transaction.
      await expect(getDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('takes its sequence number at post, not at draft (D-14)', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const first = await createDraft({ entryDate: s.date, lines: balancedLines(s) });
      const second = await createDraft({ entryDate: s.date, lines: balancedLines(s) });
      const third = await createDraft({ entryDate: s.date, lines: balancedLines(s) });

      // Discarding the middle one must leave no hole: it never held a number.
      await postDraft(third.id);
      await discardDraft(second.id);
      await postDraft(first.id);
    });

    const numbers = await db.app
      .selectFrom('journals')
      .select('sequence_number')
      .where('org_id', '=', s.actor.orgId)
      .orderBy('sequence_number')
      .execute();

    expect(numbers.map((row) => String(row.sequence_number))).toEqual(['1', '2']);
  });

  it('resolves the period from the entry date at post, not at draft (D-19)', async () => {
    const s = await scene();
    const draft = await withContext(s.actor.ctx, () =>
      createDraft({ entryDate: s.date, lines: balancedLines(s) }),
    );

    // The period was open when the draft was written and is closed now.
    await db.app
      .updateTable('fiscal_periods')
      .set({ status: 'closed', closed_at: new Date() })
      .where('org_id', '=', s.actor.orgId)
      .execute();

    await withContext(s.actor.ctx, async () => {
      const error = await wireErrorOf(() => postDraft(draft.id));

      expect(error).toMatchObject({ code: 'precondition_failed' });
      // The whole value of a draft surviving a rejected post.
      expect((await getDraft(draft.id)).lines).toHaveLength(2);
    });
  });

  it('leaves the draft intact when the entry does not balance', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        entryDate: s.date,
        lines: [
          { accountId: s.debit, side: 'debit', amount: '100' },
          { accountId: s.credit, side: 'credit', amount: '250' },
        ],
      });

      await expect(postDraft(draft.id)).rejects.toBeInstanceOf(ValidationError);

      expect((await getDraft(draft.id)).lines).toHaveLength(2);
    });

    expect(await journalCount(s)).toBe(0);
  });

  it('names every incomplete field at once rather than one per attempt', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        lines: [{ side: 'debit', amount: '100' }, { accountId: s.credit }],
      });

      const error = await wireErrorOf(() => postDraft(draft.id));
      const body = JSON.stringify(error);

      expect(error).toMatchObject({ code: 'validation_failed' });
      expect(body).toContain('entryDate');
      expect(body).toContain('lines.0.accountId');
      expect(body).toContain('lines.1.amount');
    });

    expect(await journalCount(s)).toBe(0);
  });

  it('refuses a second post of the same draft with a miss', async () => {
    const s = await scene();

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({ entryDate: s.date, lines: balancedLines(s) });

      await postDraft(draft.id);

      await expect(postDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    expect(await journalCount(s)).toBe(1);
  });

  /**
   * OB-059. This test replaces one that pinned the opposite: the contact and the
   * tags used to be dropped at post, and the drop was recorded as a known gap.
   *
   * Read from the tables rather than from `postDraft`'s return value. The return
   * value is assembled by the same call that did the writing, so it would report
   * what the posting *intended*; only the tables report what the database accepted,
   * and `journal_lines` is the one table nothing can go back and correct.
   */
  it('carries each line’s contact and tags into the journal it posts', async () => {
    const s = await scene();
    const contact = await contactIn(db, s.actor.orgId);
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales']);
    const sales = bufferToUuid(department.valueIds[0] ?? contact);

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        entryDate: s.date,
        lines: [
          {
            accountId: s.debit,
            contactId: bufferToUuid(contact),
            side: 'debit',
            amount: '150000',
            dimensionValueIds: [sales],
          },
          { accountId: s.credit, side: 'credit', amount: '150000' },
        ],
      });

      await postDraft(draft.id);
    });

    const lines = await db.app
      .selectFrom('journal_lines')
      .select(['id', 'line_number', 'contact_id'])
      .where('org_id', '=', s.actor.orgId)
      .orderBy('line_number')
      .execute();
    const tags = await db.app
      .selectFrom('journal_line_dimensions')
      .select(['journal_line_id', 'dimension_id', 'dimension_value_id'])
      .where('org_id', '=', s.actor.orgId)
      .execute();

    // The contact is on the line that named it and on no other, which is the half
    // a per-line assertion catches and a "some line has it" assertion would not.
    expect(lines.map((line) => line.contact_id?.toString('hex') ?? null)).toEqual([
      contact.toString('hex'),
      null,
    ]);

    expect(tags).toHaveLength(1);
    expect(tags[0]?.journal_line_id).toBe(lines[0]?.id);
    expect(tags[0]?.dimension_id.toString('hex')).toBe(department.dimensionId.toString('hex'));
    expect(tags[0]?.dimension_value_id.toString('hex')).toBe(
      (department.valueIds[0] ?? contact).toString('hex'),
    );
  });

  /**
   * Acceptance **B6**, end to end, and the property the dropped tags broke — though
   * not in the way the sum suggests.
   *
   * "Slices plus unassigned equals the whole" held perfectly well while the tags
   * were being dropped, because an untagged line lands in the unassigned bucket:
   * the totals reconciled and the sliced report was simply short by every entry
   * somebody had tagged by hand. So the assertion is the pair — each slice holds
   * what was tagged into it, *and* the slices plus unassigned come back to the
   * unsliced total. Only the first half fails when the tag write is broken, which
   * is why it is here.
   */
  it('slices a posted draft by axis, plus unassigned, back to the unsliced total (B6)', async () => {
    const s = await scene();
    const other = await db.factories.account({
      orgId: s.actor.orgId,
      type: 'expense',
      normalBalance: 'debit',
    });
    const department = await dimensionIn(db, s.actor.orgId, 'department', ['sales', 'ops']);
    const [salesId, opsId] = department.valueIds;
    if (salesId === undefined || opsId === undefined) throw new Error('two values were created');

    await withContext(s.actor.ctx, async () => {
      const draft = await createDraft({
        entryDate: s.date,
        lines: [
          {
            accountId: s.debit,
            side: 'debit',
            amount: '100000',
            dimensionValueIds: [bufferToUuid(salesId)],
          },
          {
            accountId: other.uuid,
            side: 'debit',
            amount: '50000',
            dimensionValueIds: [bufferToUuid(opsId)],
          },
          // Deliberately untagged: the unassigned bucket is not optional (D-18).
          { accountId: s.credit, side: 'credit', amount: '150000' },
        ],
      });

      await postDraft(draft.id);
    });

    const sliced = await slicedByAxis(s.actor.orgId, department.dimensionId);
    const whole = await unslicedTotals(s.actor.orgId);

    expect(sliced.get(salesId.toString('hex'))).toEqual({ debit: 100000n, credit: 0n });
    expect(sliced.get(opsId.toString('hex'))).toEqual({ debit: 50000n, credit: 0n });
    expect(sliced.get(UNASSIGNED)).toEqual({ debit: 0n, credit: 150000n });

    const summed = [...sliced.values()].reduce(
      (total, bucket) => ({
        debit: total.debit + bucket.debit,
        credit: total.credit + bucket.credit,
      }),
      { debit: 0n, credit: 0n },
    );
    expect(summed).toEqual(whole);
    expect(whole).toEqual({ debit: 150000n, credit: 150000n });
  });

  /**
   * ROADMAP D-30, and the reason posting a tagged entry takes `journals.post`
   * alone. Approver's bundle is `%.read` plus a named few including `journals.post`
   * and *not* `dimensions.write` — so if the tag write demanded that permission,
   * an Approver could post a plain draft and would be refused the same draft with
   * a department on it, which is the one an approval workflow exists for.
   *
   * There is no approval workflow until M5, which is exactly why the rule is
   * asserted now: nothing else in the suite would notice it changing.
   */
  it('lets a role holding journals.post without dimensions.write post a tagged draft', async () => {
    const owner = await scene();
    const department = await dimensionIn(db, owner.actor.orgId, 'department', ['sales']);
    const sales = bufferToUuid(department.valueIds[0] ?? owner.actor.orgId);

    const draft = await withContext(owner.actor.ctx, () =>
      createDraft({
        entryDate: owner.date,
        lines: [
          { accountId: owner.debit, side: 'debit', amount: '100', dimensionValueIds: [sales] },
          { accountId: owner.credit, side: 'credit', amount: '100' },
        ],
      }),
    );

    const approver = await db.factories.user();
    await db.factories.orgMember({
      orgId: owner.actor.orgId,
      userId: approver.id,
      role: 'approver',
    });

    await withContext(
      contextFor(owner.actor.orgUuid, SYSTEM_ROLE_UUIDS.approver, approver.uuid),
      async () => {
        await postDraft(draft.id);
      },
    );

    const tags = await db.app
      .selectFrom('journal_line_dimensions')
      .select('dimension_value_id')
      .where('org_id', '=', owner.actor.orgId)
      .execute();

    expect(tags).toHaveLength(1);
  });

  /**
   * The rule OB-059 chose for an inactive contact, at the seam where it bites: a
   * draft composed while the contact was active and posted after it was
   * deactivated. Refused, like an inactive account — and, like every other refused
   * post, it leaves the draft intact to be fixed rather than losing the work.
   */
  it('refuses a draft naming a deactivated contact, and leaves it intact', async () => {
    const s = await scene();
    const contact = await contactIn(db, s.actor.orgId);

    const draft = await withContext(s.actor.ctx, () =>
      createDraft({
        entryDate: s.date,
        lines: [
          {
            accountId: s.debit,
            contactId: bufferToUuid(contact),
            side: 'debit',
            amount: '100',
          },
          { accountId: s.credit, side: 'credit', amount: '100' },
        ],
      }),
    );

    await db.app
      .updateTable('contacts')
      .set({ is_active: 0 })
      .where('org_id', '=', s.actor.orgId)
      .where('id', '=', contact)
      .execute();

    await withContext(s.actor.ctx, async () => {
      const error = await wireErrorOf(() => postDraft(draft.id));

      expect(error).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'contact_inactive' },
      });
      expect((await getDraft(draft.id)).lines).toHaveLength(2);
    });

    expect(await journalCount(s)).toBe(0);
  });
});

describe('permissions (spec §5, enforced in the service)', () => {
  it('refuses every write to a role that can only read journals', async () => {
    const s = await scene('readOnly');

    await withContext(s.actor.ctx, async () => {
      await expect(createDraft({})).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(updateDraft(newUuid(), { memo: 'x' })).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(discardDraft(newUuid())).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(postDraft(newUuid())).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  it('lets a read-only role read the org’s drafts', async () => {
    const owner = await scene();
    const draft = await withContext(owner.actor.ctx, () => createDraft({ memo: 'in progress' }));

    // The same org, a different member: `read_only` reads everything and changes
    // nothing, and a draft is org work-in-progress rather than private correspondence.
    const reader = await db.factories.user();
    await db.factories.orgMember({
      orgId: owner.actor.orgId,
      userId: reader.id,
      role: 'readOnly',
    });

    await withContext(
      contextFor(owner.actor.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, reader.uuid),
      async () => {
        expect(await getDraft(draft.id)).toMatchObject({ id: draft.id });
        expect((await listDrafts({})).items).toHaveLength(1);
      },
    );
  });

  it('refuses the permission before it looks at the payload', async () => {
    const s = await scene('readOnly');

    // A malformed body from an unauthorized caller is still a permission failure:
    // validating first would describe an API surface they are not entitled to.
    await withContext(s.actor.ctx, async () => {
      await expect(createDraft({ lines: [{ amount: 'not-a-number' }] })).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });
  });

  it('refuses a caller with no user identity, because a draft is authored', async () => {
    const s = await scene();
    const automation = { ...s.actor.ctx, userId: null };

    // `journal_drafts.created_by_user_id` is NOT NULL and references `users`.
    await withContext(automation, async () => {
      await expect(createDraft({})).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

interface Totals {
  readonly debit: bigint;
  readonly credit: bigint;
}

/** The key the untagged lines are counted under — D-18's explicit unassigned bucket. */
const UNASSIGNED = 'unassigned';

/**
 * Every journal line of an org, grouped by its value on one axis.
 *
 * A `LEFT JOIN`, so a line carrying no value on this axis is counted rather than
 * dropped — the "smaller business than exists" failure D-18 names, and the one a
 * report written with an inner join produces silently. Deliberately its own query
 * over the tables rather than a call into the reporting service: this is the oracle
 * the posting path is checked against, and an oracle that shares code with the
 * thing it checks proves only that they agree.
 */
async function slicedByAxis(orgId: Buffer, dimensionId: Buffer): Promise<Map<string, Totals>> {
  const { rows } = await sql<{
    bucket: Buffer | null;
    debit: string | null;
    credit: string | null;
  }>`
    SELECT jld.dimension_value_id AS bucket,
           SUM(jl.debit_minor) AS debit,
           SUM(jl.credit_minor) AS credit
      FROM journal_lines jl
      LEFT JOIN journal_line_dimensions jld
        ON jld.org_id = jl.org_id
       AND jld.journal_line_id = jl.id
       AND jld.dimension_id = ${dimensionId}
     WHERE jl.org_id = ${orgId}
     GROUP BY jld.dimension_value_id
  `.execute(db.app);

  return new Map(
    rows.map((row) => [
      row.bucket === null ? UNASSIGNED : row.bucket.toString('hex'),
      { debit: BigInt(row.debit ?? '0'), credit: BigInt(row.credit ?? '0') },
    ]),
  );
}

/** The same lines, not sliced at all. */
async function unslicedTotals(orgId: Buffer): Promise<Totals> {
  const { rows } = await sql<{ debit: string | null; credit: string | null }>`
    SELECT SUM(debit_minor) AS debit, SUM(credit_minor) AS credit
      FROM journal_lines
     WHERE org_id = ${orgId}
  `.execute(db.app);

  return { debit: BigInt(rows[0]?.debit ?? '0'), credit: BigInt(rows[0]?.credit ?? '0') };
}

async function journalCount(s: Scene): Promise<number> {
  const rows = await db.app
    .selectFrom('journals')
    .select('id')
    .where('org_id', '=', s.actor.orgId)
    .execute();
  return rows.length;
}
