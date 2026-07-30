import { describe, expect, it } from 'vitest';

import { createRequestContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { bufferToUuid, systemDb, uuidToBuffer } from '../../src/db';
import { materializeCycle } from '../../src/modules/recurring-journals/engine';
import { createRecurringJournalTemplate } from '../../src/modules/recurring-journals';
import type { DueRecurringJournalTemplateRow } from '../../src/modules/recurring-journals/recurring-journals.repository';
import { selectDueRecurringJournalTemplates } from '../../src/modules/recurring-journals/recurring-journals.repository';
import { SYSTEM_ROLE_UUIDS, useTestDatabase } from '../db';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  contextFor,
  delay,
  parkedTransactionOn,
  transactionOn,
} from '../payments/support';

/**
 * D-76's once-per-cycle guard, proved as a real race rather than assumed
 * (CLAUDE.md: "prove contention, don't assume it") — the concurrent sibling of
 * `materialize-cycle.test.ts`'s sequential re-run assertion.
 *
 * A sequential "call it, then call it again" cannot distinguish a real lock from
 * no lock at all: both pass, because the second call always sees the first one's
 * committed effect. The failure this guards against is two ticks (a slow restart,
 * a re-enqueue) reaching `materializeCycle` for the *same* due row before either
 * has committed — and that window only exists with two transactions open at once.
 * So both sides here run on their own `openAppConnection()` handle, asserted
 * distinct, with the winner parked mid-transaction while the loser is observed
 * *failing to settle* across `CONTENTION_WAIT_MS`.
 *
 * `selectRecurringJournalTemplateByIdForUpdate` (`engine.ts`) takes the row's
 * exclusive lock before comparing `last_run_date` to the dispatched cycle, so the
 * loser blocks behind the winner rather than reading a not-yet-advanced schedule
 * and raising a second journal for the same cycle — which is exactly the
 * mutation (drop the lock, keep the comparison) a sequential test would miss.
 *
 * `useTestDatabase()` alone, not `useServiceDatabase()`: with no process pool, a
 * query that escaped the ambient transaction throws "Database not initialized"
 * rather than quietly running on a third connection, where it would see neither
 * side's uncommitted state and the race would appear to pass having proved
 * nothing (`test/enforcement/support.ts`'s own reasoning).
 */
const db = useTestDatabase();

function automationContextFor(orgUuid: string, userUuid: string, actorId: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: userUuid,
    actorType: 'automation',
    actorId,
  });
}

describe('two concurrent materialisations of the same recurring-journal cycle (D-76, L1)', () => {
  it('serialize on the template row and post exactly one journal', async () => {
    // `db.factories.ledger()` gives an org, an owner member, an open period, and a
    // debit/credit account pair — exactly what a two-line GL template needs, and it
    // runs on the plain `db.app` handle rather than through `tenantDb()`, so it needs
    // no ambient transaction scope (`test/enforcement/posting-race.test.ts`'s own use
    // of the same factory under the same bare harness).
    const ledger = await db.factories.ledger();
    const ctx = contextFor(ledger.org.uuid, SYSTEM_ROLE_UUIDS.owner, ledger.user.uuid);
    const date = ledger.period.startDate;

    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const template = await transactionOn(first, ctx, () =>
        createRecurringJournalTemplate(
          {
            name: 'Prepaid amortisation',
            materializationMode: 'posted',
            frequency: 'monthly',
            intervalCount: 1,
            startDate: date,
            lines: [
              { accountId: ledger.debitAccount.uuid, side: 'debit', amount: '25000' },
              { accountId: ledger.creditAccount.uuid, side: 'credit', amount: '25000' },
            ],
          },
          ctx,
        ),
      ).promise;

      const due: readonly DueRecurringJournalTemplateRow[] = await transactionOn(first, ctx, () =>
        selectDueRecurringJournalTemplates(systemDb(), date),
      ).promise;
      const dueRow = due.find((row) => bufferToUuid(row.id) === template.id);
      if (dueRow === undefined) throw new Error('Expected the template to be due.');

      const automationCtx = automationContextFor(ledger.org.uuid, ledger.user.uuid, template.id);

      // The winner has raised its journal and advanced the schedule, uncommitted,
      // and holds the template's row lock.
      const winner = parkedTransactionOn(first, automationCtx, () =>
        materializeCycle(dueRow, automationCtx),
      );
      await winner.parked;

      const loser = transactionOn(second, automationCtx, () =>
        materializeCycle(dueRow, automationCtx),
      );
      await delay(CONTENTION_WAIT_MS);

      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;
      // Unblocked, the loser's locking read now sees `last_run_date` already at
      // this cycle's date and returns without raising a second journal.
      await loser.promise;

      const journalCount = await db.app
        .selectFrom('journals')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('org_id', '=', ledger.org.id)
        .where('source', '=', 'recurring')
        .executeTakeFirstOrThrow();
      expect(Number(journalCount.count)).toBe(1);

      const row = await db.app
        .selectFrom('recurring_journal_templates')
        .select(['last_run_date', 'next_run_date'])
        .where('id', '=', uuidToBuffer(template.id))
        .executeTakeFirstOrThrow();
      expect(row.last_run_date).toBe(date);
      expect(row.next_run_date > date).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
