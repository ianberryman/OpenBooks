import { describe, expect, it } from 'vitest';

import { createRequestContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { bufferToUuid, systemDb } from '../../src/db';
import { materializeCycle } from '../../src/modules/recurring-journals/engine';
import {
  createRecurringJournalTemplate,
  getRecurringJournalTemplate,
} from '../../src/modules/recurring-journals';
import type { DueRecurringJournalTemplateRow } from '../../src/modules/recurring-journals/recurring-journals.repository';
import { selectDueRecurringJournalTemplates } from '../../src/modules/recurring-journals/recurring-journals.repository';
import { SYSTEM_ROLE_UUIDS } from '../db';
import { sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

/**
 * `materializeCycle` end to end for a recurring GL template (OB-162, OB-168; ROADMAP
 * D-76, D-90, D-113…D-117, L1), the sibling of `test/invoicing/recurring.test.ts` —
 * that file's own header explains why `materializeCycle` is exercised directly here
 * rather than through `runRecurringJournalSweep`/`runAsAutomation`: the daily tick and
 * the automation-context seam are OB-127's, and this suite's job is the cycle itself.
 *
 * Two things a sequential test can prove (the concurrent version, in
 * `materialize-cycle.race.test.ts`, proves the once-per-cycle guard actually holds a
 * lock rather than merely running in some order): a `posted` template raises a real
 * journal (`source: 'recurring'`) and advances its own schedule, and a `draft` template
 * lands an editable draft instead of a posted journal — the one branch this engine has
 * that the invoice engine does not (`engine.ts`'s own header).
 */
const db = useServiceDatabase();

/**
 * A stand-in for the context `runAsAutomation` (OB-127) would build — `automation`
 * actor type, a real (non-null) `userId` so provenance is attributable, no
 * `invocationMode` (`chk_journals_invocation_mode` makes it agent-only).
 * `recurring.test.ts`'s own `automationContextFor`, restated for a GL template.
 */
function automationContextFor(scene: Scene): RequestContext {
  return createRequestContext({
    orgId: scene.orgUuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: scene.userUuid,
    actorType: 'automation',
    actorId: scene.userUuid,
  });
}

async function dueRowFor(
  templateUuid: string,
  runDate: string,
): Promise<DueRecurringJournalTemplateRow> {
  const due = await selectDueRecurringJournalTemplates(systemDb(), runDate);
  const row = due.find((candidate) => bufferToUuid(candidate.id) === templateUuid);
  if (row === undefined) {
    throw new Error(`Expected ${templateUuid} to be due on or before ${runDate}.`);
  }
  return row;
}

async function journalCountBySource(scene: Scene, source: string): Promise<number> {
  const row = await db.app
    .selectFrom('journals')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', scene.orgId)
    .where('source', '=', source)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function draftCount(scene: Scene): Promise<number> {
  const row = await db.app
    .selectFrom('journal_drafts')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', scene.orgId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe('materializeCycle — posted mode', () => {
  it('posts once per cycle and advances the schedule exactly once', async () => {
    const scene = await sceneIn(db);
    const automationCtx = automationContextFor(scene);

    const template = await withContext(scene.ctx, () =>
      createRecurringJournalTemplate(
        {
          name: 'Monthly rent accrual',
          materializationMode: 'posted',
          frequency: 'monthly',
          intervalCount: 1,
          startDate: scene.date,
          lines: [
            { accountId: scene.expense.uuid, side: 'debit', amount: '50000' },
            { accountId: scene.payable.uuid, side: 'credit', amount: '50000' },
          ],
        },
        scene.ctx,
      ),
    );

    expect(template.nextRunDate).toBe(scene.date);
    expect(template.lastRunDate).toBeNull();
    expect(await journalCountBySource(scene, 'recurring')).toBe(0);

    const dueRow = await dueRowFor(template.id, scene.date);
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));

    expect(await journalCountBySource(scene, 'recurring')).toBe(1);

    const afterFirstRun = await withContext(scene.ctx, () =>
      getRecurringJournalTemplate(template.id, scene.ctx),
    );
    expect(afterFirstRun.lastRunDate).toBe(scene.date);
    // One calendar month forward, monthly × 1 — `advance`'s own suite proves the
    // arithmetic; this proves the engine calls it with the template's own state.
    expect(afterFirstRun.nextRunDate > scene.date).toBe(true);

    // A second attempt at the *same* cycle, from the same stale `dueRow` a restart
    // mid-sweep would re-read — D-76's once-per-cycle guard.
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));

    expect(await journalCountBySource(scene, 'recurring')).toBe(1);
    const afterSecondRun = await withContext(scene.ctx, () =>
      getRecurringJournalTemplate(template.id, scene.ctx),
    );
    expect(afterSecondRun.lastRunDate).toBe(afterFirstRun.lastRunDate);
    expect(afterSecondRun.nextRunDate).toBe(afterFirstRun.nextRunDate);
  });
});

describe('materializeCycle — draft mode', () => {
  it('lands a draft, not a posted journal, and still advances the schedule once', async () => {
    const scene = await sceneIn(db);
    const automationCtx = automationContextFor(scene);

    const template = await withContext(scene.ctx, () =>
      createRecurringJournalTemplate(
        {
          name: 'Prepaid insurance amortisation',
          materializationMode: 'draft',
          frequency: 'monthly',
          intervalCount: 1,
          startDate: scene.date,
          lines: [
            { accountId: scene.expense.uuid, side: 'debit', amount: '10000' },
            { accountId: scene.bank.uuid, side: 'credit', amount: '10000' },
          ],
        },
        scene.ctx,
      ),
    );

    const dueRow = await dueRowFor(template.id, scene.date);
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));

    expect(await journalCountBySource(scene, 'recurring')).toBe(0);
    expect(await draftCount(scene)).toBe(1);

    const afterFirstRun = await withContext(scene.ctx, () =>
      getRecurringJournalTemplate(template.id, scene.ctx),
    );
    expect(afterFirstRun.lastRunDate).toBe(scene.date);

    // Once more from the stale row: still one draft, not two.
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));
    expect(await draftCount(scene)).toBe(1);
  });
});
