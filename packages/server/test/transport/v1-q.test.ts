import { describe, expect, it } from 'vitest';

import { captureEmail, tokenFrom } from '../members/support';

import { errorBody } from './harness';
import type { App } from '../../src/transport/index';
import { authorizedWrite, createAccount, registerUser, useV1App } from './v1-support';
import type { Session } from './v1-support';

/**
 * The `/v1` and `/mcp` halves of initiative Q, end to end against real MySQL
 * (agent work queue, MCP-only; OB-200…210; ROADMAP D-99/D-100/D-118/D-119).
 *
 * One narrative (D-26: "one narrative per milestone, not a suite"), in three
 * beats:
 *
 *  1. **Compose vs. activate is a real separation of duties.** A bookkeeper —
 *     seeded with `workflows.write` but not the owner-only `workflows.activate`
 *     (`0001_tenancy.ts`'s own exclusion list) — may create and edit an
 *     automation but is refused on `activate` and on `run`, both `403
 *     permission_denied` naming `workflows.activate`.
 *  2. **The MCP queue protocol.** `work_queue.poll` leases the item `run`
 *     enqueued; `work_queue.submit_proposal` with a bogus lease token answers
 *     HTTP 200 with a typed `error.data.code` (D-118), never a 500; submitting
 *     with the real token lands a draft that shows up in the review queue with
 *     money as a cents-only wire string, never a JSON number (D-13) — and the
 *     ledger only moves once the existing `POST /v1/agent-proposals/{id}/approve`
 *     is called, the same human act M5 already gated.
 *  3. **The person-facing work-item surface.** List, get, and cancel — the
 *     doors this file owns; only the org's own agent ever leases or resolves
 *     one, over MCP.
 */
const harness = useV1App();
const email = captureEmail();

interface AutomationBody {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly trigger: { readonly type: string };
  readonly actions: readonly { readonly type: string }[];
}

interface AutomationRunResultBody {
  readonly runToken: string;
  readonly annotationsWritten: number;
  readonly workItemsEnqueued: number;
}

interface WorkItemBody {
  readonly id: string;
  readonly status: string;
  readonly prompt: string;
  readonly proposedDraftId: string | null;
}

interface McpPollResult {
  readonly result: {
    readonly kind: string;
    readonly result: {
      readonly item: {
        readonly workItemId: string;
        readonly prompt: string;
        readonly leaseToken: string;
      } | null;
    };
  };
}

interface McpSubmitResult {
  readonly result: {
    readonly kind: string;
    readonly proposal: { readonly summary: string; readonly effects: readonly string[] };
  };
}

interface McpErrorResult {
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data: {
      readonly code: string;
      readonly status: number;
      readonly details?: Record<string, unknown>;
    };
  };
}

let mcpCallId = 0;

function mcpCall(
  app: App,
  session: Session,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  mcpCallId += 1;
  return app
    .inject({
      method: 'POST',
      url: '/mcp',
      headers: { cookie: session.cookie },
      payload: {
        jsonrpc: '2.0',
        id: mcpCallId,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    })
    .then((response) => ({ status: response.statusCode, body: response.json<unknown>() }));
}

/** Invites `guest` into `owner`'s org under `roleId`, accepts, and switches active org. */
async function joinAsRole(
  app: App,
  owner: Session,
  guest: Session,
  guestEmail: string,
  roleId: string,
  nonce: string,
): Promise<void> {
  // `captureEmail`'s sink is only re-installed by its own `afterEach`, so the first
  // test in a file runs with `useV1App`'s discarding email provider (its `beforeAll`
  // installed that last). This suite's SoD test is that first test, so install the
  // capture explicitly before the invite — otherwise the invite mail is discarded and
  // `email.to(...)` finds nothing. Order-independent, unlike relying on a prior test.
  email.install();

  const invited = await app.inject({
    method: 'POST',
    url: '/v1/invites',
    headers: authorizedWrite(owner, `q-invite-${nonce}`),
    payload: { email: guestEmail, roleId },
  });
  if (invited.statusCode !== 201) {
    throw new Error(`invite failed: ${String(invited.statusCode)} ${invited.body}`);
  }

  const token = tokenFrom(email.to(guestEmail));
  const accepted = await app.inject({
    method: 'POST',
    url: '/v1/invites/accept',
    headers: authorizedWrite(guest, `q-accept-${nonce}`),
    payload: { orgId: owner.orgId, token },
  });
  if (accepted.statusCode !== 200) {
    throw new Error(`accept failed: ${String(accepted.statusCode)} ${accepted.body}`);
  }

  const switched = await app.inject({
    method: 'POST',
    url: '/v1/orgs/active',
    headers: authorizedWrite(guest, `q-switch-${nonce}`),
    payload: { orgId: owner.orgId },
  });
  if (switched.statusCode !== 200) {
    throw new Error(`switch failed: ${String(switched.statusCode)} ${switched.body}`);
  }
}

describe('compose vs. activate: a real separation of duties (Q1, reserved permission)', () => {
  it('a bookkeeper may create and edit an automation, but activating or running it is refused', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'q-sod-owner@example.invalid',
      orgName: 'Q SoD Books',
    });
    const guest = await registerUser(app, {
      email: 'q-sod-guest@example.invalid',
      orgName: 'Q SoD Guest Books',
    });

    const roles = await app.inject({
      method: 'GET',
      url: '/v1/roles',
      headers: { cookie: owner.cookie },
    });
    const bookkeeper = roles
      .json<{ roles: { id: string; code: string }[] }>()
      .roles.find((role) => role.code === 'bookkeeper');
    expect(bookkeeper).toBeDefined();

    await joinAsRole(app, owner, guest, 'q-sod-guest@example.invalid', bookkeeper?.id ?? '', 'sod');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers: authorizedWrite(guest, 'q-sod-create'),
      payload: {
        name: 'Bookkeeper composed automation',
        trigger: { type: 'manual' },
        actions: [{ type: 'agent_task', prompt: 'Summarize this bill', sourceKind: 'test' }],
      },
    });
    // `workflows.write` — the bookkeeper's whole-catalog grant minus org
    // administration (`0001_tenancy.ts`) — reaches composing.
    expect(created.statusCode).toBe(201);
    const automation = created.json<AutomationBody>();
    expect(automation.isActive).toBe(false);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/automations/${automation.id}`,
      headers: authorizedWrite(guest, 'q-sod-update'),
      payload: { name: 'Renamed by the bookkeeper' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<AutomationBody>().name).toBe('Renamed by the bookkeeper');

    const activateRefused = await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/activate`,
      headers: authorizedWrite(guest, 'q-sod-activate'),
    });
    expect(activateRefused.statusCode).toBe(403);
    expect(errorBody(activateRefused.body).error).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'workflows.activate' },
    });

    // `run` fires the automation on demand and is gated by the identical
    // permission (`automations.service.ts`'s own header: the reserved
    // compose-vs-activate split is what makes activation the natural home for a
    // manual run too) — refused the bookkeeper cannot reach even indirectly.
    const runRefused = await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/run`,
      headers: authorizedWrite(guest, 'q-sod-run'),
    });
    expect(runRefused.statusCode).toBe(403);
    expect(errorBody(runRefused.body).error).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'workflows.activate' },
    });

    // The automation is still exactly as the bookkeeper left it: inactive, and
    // never fired.
    const stillInactive = await app.inject({
      method: 'GET',
      url: `/v1/automations/${automation.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(stillInactive.json<AutomationBody>().isActive).toBe(false);

    // And the owner — holding the whole catalog — can do what the bookkeeper
    // could not, which is the control that makes the refusals above about the
    // permission and not about something broken in the route.
    const activated = await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/activate`,
      headers: authorizedWrite(owner, 'q-sod-owner-activate'),
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json<AutomationBody>().isActive).toBe(true);
  });
});

describe('the MCP queue protocol: poll, a bogus submit, then a real one (Q9, Q10, D-118)', () => {
  it('runs an automation, leases its work item over MCP, refuses a bogus lease, and lands a review-queue draft', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'q-queue-owner@example.invalid',
      orgName: 'Q Queue Books',
    });
    const cash = await createAccount(app, owner, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, owner, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(owner, 'q-queue-year'),
      payload: { fiscalYear: 2026 },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers: authorizedWrite(owner, 'q-queue-create'),
      payload: {
        name: 'Draft the March accrual',
        trigger: { type: 'manual' },
        actions: [{ type: 'agent_task', prompt: 'Draft the March accrual', sourceKind: 'test' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const automation = created.json<AutomationBody>();

    await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/activate`,
      headers: authorizedWrite(owner, 'q-queue-activate'),
    });

    const ran = await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/run`,
      headers: authorizedWrite(owner, 'q-queue-run'),
    });
    expect(ran.statusCode).toBe(200);
    const runResult = ran.json<AutomationRunResultBody>();
    expect(runResult).toMatchObject({ annotationsWritten: 0, workItemsEnqueued: 1 });

    // Poll over MCP — the only way any caller ever leases a work item (Q's own
    // seam: OpenBooks orchestrates the queue, an agent's own infra polls it).
    const polled = await mcpCall(app, owner, 'work_queue.poll');
    expect(polled.status).toBe(200);
    const polledBody = polled.body as McpPollResult;
    expect(polledBody.result.kind).toBe('executed');
    const item = polledBody.result.result.item;
    expect(item).not.toBeNull();
    expect(item?.prompt).toBe('Draft the March accrual');

    // A bogus lease token — HTTP 200, D-118, with the refusal riding in the
    // typed `error.data.code`, never a 500 that would look like this system's
    // own bug rather than the caller's stale token.
    const bogusSubmit = await mcpCall(app, owner, 'work_queue.submit_proposal', {
      leaseToken: '00000000-0000-4000-8000-000000000000',
      draft: { entryDate: '2026-03-31', lines: [] },
    });
    expect(bogusSubmit.status).toBe(200);
    const bogusBody = bogusSubmit.body as McpErrorResult;
    expect(bogusBody.error.data.code).toBe('precondition_failed');
    expect(bogusBody.error.data.details).toMatchObject({ precondition: 'lease_invalid' });

    // The real submission — the seam's whole point: an ordinary
    // `journal_drafts` row, money as a cents-only string on the wire (D-13),
    // nothing posted.
    const leaseToken = item?.leaseToken ?? '';
    const submitted = await mcpCall(app, owner, 'work_queue.submit_proposal', {
      leaseToken,
      draft: {
        entryDate: '2026-03-31',
        lines: [
          { accountId: cash, side: 'debit', amount: '50000' },
          { accountId: revenue, side: 'credit', amount: '50000' },
        ],
      },
    });
    expect(submitted.status).toBe(200);
    const submittedBody = submitted.body as McpSubmitResult;
    expect(submittedBody.result.kind).toBe('proposed');
    expect(submittedBody.result.proposal.summary).toContain('Proposed a journal entry');

    const workItemId = item?.workItemId ?? '';
    const workItemAfter = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${workItemId}`,
      headers: { cookie: owner.cookie },
    });
    expect(workItemAfter.statusCode).toBe(200);
    const workItemBody = workItemAfter.json<WorkItemBody>();
    expect(workItemBody.status).toBe('proposed');
    expect(workItemBody.proposedDraftId).not.toBeNull();

    // The draft lands in the existing review queue, unchanged by Q — the list
    // is headers only (`journalDraftPageSchema`'s own reason: embedding lines
    // would make a page's size depend on how many lines a draft happens to
    // carry), so the money shape is read off the one-draft endpoint the review
    // queue's own page links to.
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/agent-proposals',
      headers: { cookie: owner.cookie },
    });
    expect(pending.statusCode).toBe(200);
    const pendingBody = pending.json<{ items: { id: string }[] }>();
    expect(pendingBody.items).toHaveLength(1);
    expect(pendingBody.items[0]?.id).toBe(workItemBody.proposedDraftId);

    const draftId = workItemBody.proposedDraftId ?? '';
    const draft = await app.inject({
      method: 'GET',
      url: `/v1/journal-drafts/${draftId}`,
      headers: { cookie: owner.cookie },
    });
    expect(draft.statusCode).toBe(200);
    const draftBody = draft.json<{ lines: { amount: string }[] }>();
    expect(draftBody.lines).toHaveLength(2);
    for (const line of draftBody.lines) {
      expect(typeof line.amount).toBe('string');
    }
    // Money as a cents-only string, never a JSON number (D-13) — the pattern a
    // bare numeric `amount` field would match and a quoted one never does.
    expect(JSON.stringify(draftBody)).not.toMatch(/"amount":\s*\d/u);
    expect(draftBody.lines.map((line) => line.amount).sort()).toEqual(['50000', '50000']);

    // The ledger has not moved yet — Q never posts (D-100). Only the existing
    // human act does.
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/agent-proposals/${workItemBody.proposedDraftId ?? ''}/approve`,
      headers: authorizedWrite(owner, 'q-queue-approve'),
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json<{ journalId: string }>().journalId).toBeTypeOf('string');
  });
});

describe('the person-facing work-item surface: list, get, cancel', () => {
  it('lists a queued item and cancels it — the doors this file owns', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'q-list-owner@example.invalid',
      orgName: 'Q List Books',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers: authorizedWrite(owner, 'q-list-create'),
      payload: {
        name: 'Never leased',
        trigger: { type: 'manual' },
        actions: [{ type: 'agent_task', prompt: 'Sit in the queue', sourceKind: 'test' }],
      },
    });
    const automation = created.json<AutomationBody>();

    await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/activate`,
      headers: authorizedWrite(owner, 'q-list-activate'),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/automations/${automation.id}/run`,
      headers: authorizedWrite(owner, 'q-list-run'),
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/work-items?status=queued',
      headers: { cookie: owner.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json<{ items: WorkItemBody[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('queued');
    const workItemId = items[0]?.id ?? '';

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/work-items/${workItemId}/cancel`,
      headers: authorizedWrite(owner, 'q-list-cancel'),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<WorkItemBody>().status).toBe('cancelled');

    // Idempotent — a repeated cancel of an already-cancelled item is returned
    // unchanged rather than refused (`cancelWorkItem`'s own header).
    const cancelledAgain = await app.inject({
      method: 'POST',
      url: `/v1/work-items/${workItemId}/cancel`,
      headers: authorizedWrite(owner, 'q-list-cancel-again'),
    });
    expect(cancelledAgain.statusCode).toBe(200);
    expect(cancelledAgain.json<WorkItemBody>().status).toBe('cancelled');

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/work-items/${workItemId}`,
      headers: { cookie: owner.cookie },
    });
    expect(fetched.json<WorkItemBody>().status).toBe('cancelled');

    // A cancelled item is never leased — the MCP poll finds the queue empty.
    const polled = await mcpCall(app, owner, 'work_queue.poll');
    const polledBody = polled.body as McpPollResult;
    expect(polledBody.result.result.item).toBeNull();
  });
});
