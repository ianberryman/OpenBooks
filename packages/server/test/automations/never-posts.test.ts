import type { AutomationAction } from '@openbooks/shared-types';
import fc from 'fast-check';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { approveProposal, listProposals } from '../../src/modules/agents';
import {
  createAutomation,
  pollWorkQueue,
  runAutomation,
  setAutomationActive,
  submitWorkItemProposal,
} from '../../src/modules/automations';
import { uuidToBuffer } from '../db';

import {
  balancedDraftInput,
  draftCount,
  journalCount,
  ledgerOrgIn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * Q4's own guarantee (D-100): nothing in the automations/work-queue path ever
 * posts to the ledger. `queue.service.ts`'s own header states it — "Nothing in
 * this file calls `postJournal`" — and this suite is what makes that a fact
 * about the running system rather than a comment trusted at face value.
 *
 * The only door to the ledger is the one that predates Q entirely: a human
 * holding `agents.review` calling `approveProposal`
 * (`modules/agents/review.service.ts`), the same act that turns a hand-typed
 * draft into a posting. Q's `work_queue.submit_proposal` lands the identical
 * `journal_drafts` row `journal.propose` does (`createDraft`) — it does not add
 * a second, agent-only path to the ledger, it reuses the one M2/M5 already gate.
 *
 * ## Property, not one example
 *
 * CLAUDE.md: "mutation-test anything load-bearing... a two-item example suite
 * hides permutation bugs." A single `[annotate, agent_task]` firing would not
 * notice a mutation that posted on the *second* `agent_task` action in a firing,
 * or on the *last* item polled rather than every one — so the property below
 * runs `runAutomation` over a generated ordered mix of `annotate`/`agent_task`
 * actions (1 to 6 of them), submits a proposal for every work item the firing
 * enqueued, and asserts the journal count is zero after *each* submission, not
 * only at the end.
 */
const db = useServiceDatabase();

const noteArb = fc.constantFrom(
  'Reviewed the statement',
  'Flagged for follow-up',
  'Matched automatically',
  'Needs a human look',
  'Filed under Q1 spend',
);

const promptArb = fc.constantFrom(
  'Summarize this bill',
  'Draft the accrual',
  'Propose a reclass',
  'Check the vendor total',
  'Draft a correcting entry',
);

const actionArb: fc.Arbitrary<AutomationAction> = fc.oneof(
  fc.record({ type: fc.constant('annotate' as const), note: noteArb }),
  fc.record({
    type: fc.constant('agent_task' as const),
    prompt: promptArb,
    sourceKind: fc.constant('test'),
  }),
);

const actionsArb = fc.array(actionArb, { minLength: 1, maxLength: 6 });

describe('Q4 — the automations/work-queue path never posts a journal', () => {
  it('for any mix of annotate/agent_task actions, no journal appears until a human approves', async () => {
    await fc.assert(
      fc.asyncProperty(actionsArb, async (actions) => {
        const org = await ledgerOrgIn(db);

        const automation = await withContext(org.ctx, () =>
          createAutomation(
            { name: 'Property automation', trigger: { type: 'manual' }, actions },
            org.ctx,
          ),
        );
        await withContext(org.ctx, () => setAutomationActive(automation.id, true, org.ctx));
        expect(await journalCount(db, org.orgId)).toBe(0);

        const result = await withContext(org.ctx, () => runAutomation(automation.id, org.ctx));
        const agentTaskCount = actions.filter((action) => action.type === 'agent_task').length;
        expect(result.workItemsEnqueued).toBe(agentTaskCount);
        expect(await journalCount(db, org.orgId)).toBe(0);

        let submitted = 0;
        for (let i = 0; i < agentTaskCount; i += 1) {
          const leased = await withContext(org.ctx, () => pollWorkQueue({}, org.ctx));
          const item = leased.item;
          if (item === null) throw new Error('expected a queued item to lease');

          await withContext(org.ctx, () =>
            submitWorkItemProposal(
              { leaseToken: item.leaseToken, draft: balancedDraftInput(org) },
              org.ctx,
            ),
          );
          submitted += 1;

          // The headline assertion, re-checked after *every* submission — a
          // mutation that posted only on the last item, or only on the second
          // `agent_task` of a firing, is caught here rather than at the end.
          expect(await journalCount(db, org.orgId)).toBe(0);
        }

        expect(submitted).toBe(agentTaskCount);
        expect(await draftCount(db, org.orgId)).toBe(agentTaskCount);

        // Still nothing to lease — every enqueued item was resolved.
        const drained = await withContext(org.ctx, () => pollWorkQueue({}, org.ctx));
        expect(drained.item).toBeNull();

        // The only door: a human holding `agents.review` approves each proposal
        // one at a time. This is Q's own complement of the guarantee above — not
        // "never posts" in isolation, but "posts exactly when, and only when,"
        // the pre-existing human act runs.
        const pending = await withContext(org.ctx, () => listProposals({}, org.ctx));
        expect(pending.items).toHaveLength(agentTaskCount);

        for (const draft of pending.items) {
          expect(await journalCount(db, org.orgId)).toBeLessThan(agentTaskCount);
          await withContext(org.ctx, () => approveProposal(draft.id, org.ctx));
        }

        expect(await journalCount(db, org.orgId)).toBe(agentTaskCount);
        expect(await draftCount(db, org.orgId)).toBe(0);
      }),
      { numRuns: 10 },
    );
  }, 180_000);
});

/**
 * The concrete narrative the property above generalises: `executeAutomation`'s
 * own documented example, `[annotate, agent_task]` in one firing (Q9) — and the
 * one thing the property's random ordering does not itself pin down, that the
 * annotation and the work item from the *same* firing share one `run_token`
 * (read directly off the row; nothing on the `WorkItem` wire type exposes it).
 */
describe('one firing of [annotate, agent_task] shares a run token and posts nothing', () => {
  it('writes the annotation and enqueues the work item, tied together, with no journal', async () => {
    const org = await ledgerOrgIn(db);

    const automation = await withContext(org.ctx, () =>
      createAutomation(
        {
          name: 'Annotate then enqueue',
          trigger: { type: 'manual' },
          actions: [
            { type: 'annotate', note: 'Bill received from Acme' },
            { type: 'agent_task', prompt: 'Draft the accrual', sourceKind: 'bill_capture' },
          ],
        },
        org.ctx,
      ),
    );
    await withContext(org.ctx, () => setAutomationActive(automation.id, true, org.ctx));

    const result = await withContext(org.ctx, () => runAutomation(automation.id, org.ctx));
    expect(result).toMatchObject({ annotationsWritten: 1, workItemsEnqueued: 1 });
    expect(await journalCount(db, org.orgId)).toBe(0);

    const automationId = uuidToBuffer(automation.id);
    const { rows: annotations } = await sql<{ run_token: Buffer; note: string }>`
      SELECT run_token, note FROM automation_annotations WHERE automation_id = ${automationId}
    `.execute(db.app);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.note).toBe('Bill received from Acme');

    const { rows: workItems } = await sql<{ run_token: Buffer }>`
      SELECT run_token FROM work_items WHERE automation_id = ${automationId}
    `.execute(db.app);
    expect(workItems).toHaveLength(1);
    expect(workItems[0]?.run_token.equals(annotations[0]!.run_token)).toBe(true);

    const leased = await withContext(org.ctx, () => pollWorkQueue({}, org.ctx));
    const item = leased.item;
    if (item === null) throw new Error('expected a queued item to lease');
    expect(item.prompt).toBe('Draft the accrual');
    expect(item.sourceKind).toBe('bill_capture');

    await withContext(org.ctx, () =>
      submitWorkItemProposal(
        { leaseToken: item.leaseToken, draft: balancedDraftInput(org) },
        org.ctx,
      ),
    );

    // Still nothing posted — the proposal is a draft, sitting in the review
    // queue, and nothing about `runAutomation` or the queue posted on its own.
    expect(await journalCount(db, org.orgId)).toBe(0);
    expect(await draftCount(db, org.orgId)).toBe(1);
  });
});
