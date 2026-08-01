import { describe, expect, it } from 'vitest';

import { bufferToUuid } from '../../db';
import { toWireError } from '../../errors';
import { OWNER_ROLE_ID } from '../orgs';

import { newUuid } from '../../../test/db';
import {
  contactIn,
  contextFor,
  dimensionIn,
  useLedgerDatabase,
  withContext,
} from '../../../test/ledger/support';

import { getJournal } from './journal-read.service';
import { postJournal } from './posting.service';

/**
 * `getJournal` (OB-236) — the by-id read counterpart to `postJournal`/
 * `reverseJournal`'s in-transaction `readBack`, proven here against the same
 * kernel `posting.test.ts` exercises: whatever `postJournal` reports as posted is
 * exactly what a fresh `getJournal` reports as stored, and a cross-org or
 * nonexistent id is refused the same way `getDraft`/`getInvoice` refuse one (A7).
 */
const harness = useLedgerDatabase();

interface Scene {
  readonly ctx: ReturnType<typeof contextFor>;
  readonly cash: string;
  readonly revenue: string;
  readonly date: string;
  readonly orgId: Buffer;
  readonly orgUuid: string;
}

async function scene(): Promise<Scene> {
  const ledger = await harness.factories.ledger();
  return {
    ctx: contextFor(ledger.org.uuid, OWNER_ROLE_ID, ledger.user.uuid),
    cash: ledger.debitAccount.uuid,
    revenue: ledger.creditAccount.uuid,
    date: ledger.period.startDate,
    orgId: ledger.org.id,
    orgUuid: ledger.org.uuid,
  };
}

describe('getJournal', () => {
  it('reports the same header, lines, contact, and tags postJournal reported storing', async () => {
    const s = await scene();
    const contact = await contactIn(harness, s.orgId);
    const department = await dimensionIn(harness, s.orgId, 'DEPT', ['SALES']);
    const [sales] = department.valueIds;
    if (sales === undefined) throw new Error('a dimension value was created');

    const posted = await withContext(s.ctx, () =>
      postJournal({
        date: s.date,
        memo: 'Sale',
        actorType: 'user',
        actorId: s.ctx.actorId,
        lines: [
          {
            accountId: s.cash,
            side: 'debit',
            amount: 150000n,
            contactId: bufferToUuid(contact),
            dimensionValueIds: [bufferToUuid(sales)],
          },
          { accountId: s.revenue, side: 'credit', amount: 150000n },
        ],
      }),
    );

    const fetched = await withContext(s.ctx, () => getJournal(posted.journalId));

    // Not merely equal fields — the identical object `readBack` would have
    // produced, since both routes assemble a `PostedJournal` from the same
    // stored rows.
    expect(fetched).toEqual(posted);
    expect(fetched.lines).toHaveLength(2);
    expect(fetched.lines[0]).toMatchObject({
      side: 'debit',
      amount: 150000n,
      contactId: bufferToUuid(contact),
      dimensionValueIds: [bufferToUuid(sales)],
    });
    expect(fetched.lines[1]).toMatchObject({ side: 'credit', amount: 150000n, contactId: null });
  });

  it(
    'answers another org’s journal, a nonexistent one, and a malformed id identically (A7)',
    async () => {
      const mine = await scene();
      const theirs = await scene();

      const foreign = await withContext(theirs.ctx, () =>
        postJournal({
          date: theirs.date,
          actorType: 'user',
          actorId: theirs.ctx.actorId,
          lines: [
            { accountId: theirs.cash, side: 'debit', amount: 1n },
            { accountId: theirs.revenue, side: 'credit', amount: 1n },
          ],
        }),
      );

      const answers = await withContext(mine.ctx, async () =>
        Promise.all(
          [foreign.journalId, newUuid(), 'not-a-uuid'].map((id) =>
            getJournal(id).then(
              () => undefined,
              (error: unknown) => toWireError(error),
            ),
          ),
        ),
      );

      expect(answers[0]).toMatchObject({ code: 'not_found', status: 404 });
      // Byte-identical, not merely the same code: the body is what an enumerator reads.
      expect(JSON.stringify(answers[1])).toBe(JSON.stringify(answers[0]));
      expect(JSON.stringify(answers[2])).toBe(JSON.stringify(answers[0]));
    },
  );
});
