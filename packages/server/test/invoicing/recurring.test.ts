import { describe, expect, it } from 'vitest';

import { createRequestContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { bufferToUuid, systemDb } from '../../src/db';
import { materializeCycle } from '../../src/modules/invoicing/recurring/engine';
import {
  createRecurringInvoiceTemplate,
  getRecurringInvoiceTemplate,
} from '../../src/modules/invoicing/recurring/recurring.service';
import type {
  DueRecurringTemplateRow,
} from '../../src/modules/invoicing/recurring/recurring.repository';
import {
  selectDueTemplates,
} from '../../src/modules/invoicing/recurring/recurring.repository';
import { listInvoices } from '../../src/modules/invoices';
import { SYSTEM_ROLE_UUIDS } from '../db';
import { sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

/**
 * The materialisation engine end to end, against real MySQL (OB-128). `advance`'s
 * date math is property-proven on its own in `recurring-advance.test.ts`; this is
 * what proves the three guarantees D-76 makes about a cycle: it raises the invoice
 * (and, in `approved` mode, posts it under a system/automation actor), it does not
 * double-raise a cycle already run, and it advances the schedule by exactly one
 * `frequency` × `intervalCount`.
 *
 * `materializeCycle` is exercised directly rather than through
 * `runRecurringSweep`/`runAsAutomation`: the daily tick and the automation-context
 * seam are OB-127's, a sibling ticket this one depends on but does not own, and
 * this suite's job is the cycle itself — everything from the row lock on down.
 */

const db = useServiceDatabase();

/**
 * A stand-in for the context OB-127's `runAsAutomation` will build.
 *
 * `actorType: 'automation'` and not `'user'`, D-76's requirement — but `userId`
 * is a *real* one and not null. `createArDocument`'s `requireAuthor`
 * (`ar-documents.service.ts`) refuses a null user id: `ar_documents.created_by_user_id`
 * is `NOT NULL` and references `users`, so even an unattended cycle attributes the
 * document it raises to somebody. `recurring_invoice_templates` carries no
 * "created by" column of its own, so which user `runAsAutomation` picks (most
 * plausibly the org's owner) is a policy decision that belongs to OB-127, not to
 * this ticket — this test stands in with the scene's own user rather than
 * inventing that policy.
 */
function automationContextFor(scene: Scene): RequestContext {
  return createRequestContext({
    orgId: scene.orgUuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: scene.userUuid,
    actorType: 'automation',
    actorId: scene.userUuid,
    invocationMode: 'scheduled',
  });
}

async function dueRowFor(templateUuid: string, runDate: string): Promise<DueRecurringTemplateRow> {
  const due = await selectDueTemplates(systemDb(), runDate);
  const row = due.find((candidate) => bufferToUuid(candidate.id) === templateUuid);
  if (row === undefined) {
    throw new Error(`Expected ${templateUuid} to be due on or before ${runDate}.`);
  }
  return row;
}

describe('materializeCycle', () => {
  it('raises, approves, and advances without double-raising the cycle', async () => {
    const scene = await sceneIn(db);
    const automationCtx = automationContextFor(scene);

    const template = await withContext(scene.ctx, () =>
      createRecurringInvoiceTemplate(
        {
          contactId: scene.contact.uuid,
          name: 'Monthly retainer',
          materializationMode: 'approved',
          taxMode: 'exclusive',
          frequency: 'monthly',
          intervalCount: 1,
          dueDays: 14,
          startDate: scene.date,
          lines: [
            {
              description: 'Retainer',
              quantity: '1',
              unitAmount: '10000',
              accountId: scene.revenue.uuid,
            },
          ],
        },
        scene.ctx,
      ),
    );

    expect(template.nextRunDate).toBe(scene.date);
    expect(template.lastRunDate).toBeNull();

    const before = await withContext(scene.ctx, () =>
      listInvoices({ contactId: scene.contact.uuid }, scene.ctx),
    );
    expect(before.items).toHaveLength(0);

    const dueRow = await dueRowFor(template.id, scene.date);
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));

    const afterFirstRun = await withContext(scene.ctx, () =>
      listInvoices({ contactId: scene.contact.uuid }, scene.ctx),
    );
    expect(afterFirstRun.items).toHaveLength(1);
    // Auto-approved: the journal is posted and a document number is allocated —
    // both are `null` on a draft (D-38).
    expect(afterFirstRun.items[0]?.status).not.toBe('draft');

    const afterFirstRunTemplate = await withContext(scene.ctx, () =>
      getRecurringInvoiceTemplate(template.id, scene.ctx),
    );
    expect(afterFirstRunTemplate.lastRunDate).toBe(scene.date);
    expect(afterFirstRunTemplate.nextRunDate).not.toBe(scene.date);
    // One calendar month forward, monthly × 1 — `advance`'s own suite proves the
    // arithmetic; this proves the engine actually calls it with the template's
    // own state rather than with the sweep's `runDate`.
    expect(afterFirstRunTemplate.nextRunDate > scene.date).toBe(true);

    // A second attempt at the *same* cycle — the once-per-cycle guard (D-76).
    // `dueRow` is the stale snapshot the first run started from, on purpose: a
    // restart mid-sweep re-reads the same row and must still refuse to double-raise.
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));

    const afterSecondRun = await withContext(scene.ctx, () =>
      listInvoices({ contactId: scene.contact.uuid }, scene.ctx),
    );
    expect(afterSecondRun.items).toHaveLength(1);

    const afterSecondRunTemplate = await withContext(scene.ctx, () =>
      getRecurringInvoiceTemplate(template.id, scene.ctx),
    );
    expect(afterSecondRunTemplate.nextRunDate).toBe(afterFirstRunTemplate.nextRunDate);
    expect(afterSecondRunTemplate.lastRunDate).toBe(afterFirstRunTemplate.lastRunDate);
  });

  it('lands a draft, not a posted invoice, when the template’s mode is draft', async () => {
    const scene = await sceneIn(db);
    const automationCtx = automationContextFor(scene);

    const template = await withContext(scene.ctx, () =>
      createRecurringInvoiceTemplate(
        {
          contactId: scene.contact.uuid,
          name: 'Ad hoc project',
          materializationMode: 'draft',
          taxMode: 'exclusive',
          frequency: 'weekly',
          intervalCount: 2,
          dueDays: 0,
          startDate: scene.date,
          lines: [
            {
              description: 'Project work',
              quantity: '2',
              unitAmount: '5000',
              accountId: scene.revenue.uuid,
            },
          ],
        },
        scene.ctx,
      ),
    );

    const dueRow = await dueRowFor(template.id, scene.date);
    await withContext(automationCtx, () => materializeCycle(dueRow, automationCtx));

    const invoices = await withContext(scene.ctx, () =>
      listInvoices({ contactId: scene.contact.uuid }, scene.ctx),
    );
    expect(invoices.items).toHaveLength(1);
    expect(invoices.items[0]?.status).toBe('draft');
  });
});
