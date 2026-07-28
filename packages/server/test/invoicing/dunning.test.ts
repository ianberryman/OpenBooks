import { describe, expect, it } from 'vitest';

import { uuidToBuffer } from '../../src/db';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import { createDunningPolicy } from '../../src/modules/invoicing/dunning/dunning.service';
import { runDunning } from '../../src/modules/invoicing/dunning/engine';
import { recordPayment } from '../../src/modules/payments';
import { captureEmail } from '../members/support';

import type { DunningScene } from './support';
import { dunningScene, useServiceDatabase, withContext } from './support';

/**
 * The dunning sweep against real MySQL (spec §11 — never SQLite, never mocks).
 *
 * `runDunning` is called directly, with a hand-built context — exactly the
 * shape production reaches it in from `worker.ts`'s `runAsAutomation`, minus
 * the queue and the scheduler (`modules/scheduling`, OB-127) neither of which
 * this suite needs: `runDunning` itself carries no dependency on either, see
 * `engine.ts`'s header.
 *
 * `captureEmail` is imported from `test/members/support.ts` rather than
 * duplicated — the real `log` email adapter over a capture stream is the one
 * deliberately shared test seam (that file's header), reached the same way by
 * `test/enforcement/*` and `test/transport/v1-m2.test.ts`.
 */
const db = useServiceDatabase();
const capture = captureEmail();

async function approvedOverdueInvoice(
  scene: DunningScene,
  issueDate: string,
  dueDate: string,
): Promise<string> {
  return withContext(scene.actor.ctx, async () => {
    const invoice = await createInvoice({
      contactId: scene.contact,
      issueDate,
      dueDate,
      taxMode: 'exclusive',
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitAmount: '10000',
          accountId: scene.income,
        },
      ],
    });
    const approved = await approveInvoice(invoice.id);
    return approved.id;
  });
}

async function sentRows(orgId: Buffer, invoiceId: Buffer) {
  return db.app
    .selectFrom('dunning_sends')
    .select(['id', 'status', 'recipient_email'])
    .where('org_id', '=', orgId)
    .where('invoice_id', '=', invoiceId)
    .execute();
}

describe('runDunning', () => {
  it('sends the due stage for an overdue invoice and records the send', async () => {
    const scene = await dunningScene(db);
    const invoiceId = await approvedOverdueInvoice(scene, '2026-01-05', '2026-01-15');

    await withContext(scene.actor.ctx, async () => {
      await createDunningPolicy({
        name: 'Standard',
        stages: [
          {
            stageNumber: 1,
            offsetDays: 0,
            subject: 'Your invoice is overdue',
            body: 'Please settle your outstanding invoice at your earliest convenience.',
          },
        ],
      });

      // 17 days after the due date — well past a zero-offset stage.
      await runDunning('2026-02-01', scene.actor.ctx);
    });

    const message = capture.to(scene.contactEmail);
    expect(message.subject).toBe('Your invoice is overdue');
    expect(message.text).toBe(
      'Please settle your outstanding invoice at your earliest convenience.',
    );

    const rows = await sentRows(scene.actor.orgId, uuidToBuffer(invoiceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', recipient_email: scene.contactEmail });
  });

  it('does not send the same stage twice on a second sweep', async () => {
    const scene = await dunningScene(db);
    const invoiceId = await approvedOverdueInvoice(scene, '2026-01-05', '2026-01-15');

    await withContext(scene.actor.ctx, async () => {
      await createDunningPolicy({
        name: 'Standard',
        stages: [{ stageNumber: 1, offsetDays: 0, subject: 'Reminder', body: 'Please pay.' }],
      });

      await runDunning('2026-02-01', scene.actor.ctx);
      // A second sweep on a later date: the stage already sent must not resend,
      // even though it is still (of course) due.
      await runDunning('2026-02-15', scene.actor.ctx);
    });

    expect(capture.sent().filter((message) => message.to === scene.contactEmail)).toHaveLength(1);

    const rows = await sentRows(scene.actor.orgId, uuidToBuffer(invoiceId));
    expect(rows).toHaveLength(1);
  });

  it('does not dun a fully paid invoice', async () => {
    const scene = await dunningScene(db);
    const invoiceId = await approvedOverdueInvoice(scene, '2026-01-05', '2026-01-15');

    await withContext(scene.actor.ctx, async () => {
      const cash = await db.factories.account({
        orgId: scene.actor.orgId,
        name: 'Cash',
        type: 'asset',
        normalBalance: 'debit',
      });

      await recordPayment({
        direction: 'received',
        contactId: scene.contact,
        date: '2026-01-20',
        amount: '10000',
        accountId: cash.uuid,
        allocations: [{ targetType: 'invoice', targetId: invoiceId, amount: '10000' }],
      });

      await createDunningPolicy({
        name: 'Standard',
        stages: [{ stageNumber: 1, offsetDays: 0, subject: 'Reminder', body: 'Please pay.' }],
      });

      await runDunning('2026-02-01', scene.actor.ctx);
    });

    expect(capture.sent().filter((message) => message.to === scene.contactEmail)).toHaveLength(0);

    const rows = await sentRows(scene.actor.orgId, uuidToBuffer(invoiceId));
    expect(rows).toHaveLength(0);
  });
});
