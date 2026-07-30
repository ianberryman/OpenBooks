import type { McpToolDefinition, ToolProposal } from '@openbooks/plugin-api';
import type {
  AccountPage,
  BillPage,
  ContactPage,
  CreateDraftRequest,
  InvoicePage,
  JournalDraft,
  ListAccountsQuery,
  ListBillsQuery,
  ListContactsQuery,
  ListInvoicesQuery,
  PollWorkQueueInput,
  PollWorkQueueResult,
  SubmitProposalInput,
} from '@openbooks/shared-types';
import {
  createDraftRequestSchema,
  listAccountsQuerySchema,
  listBillsQuerySchema,
  listContactsQuerySchema,
  listInvoicesQuerySchema,
  pollWorkQueueInputSchema,
  submitProposalInputSchema,
  trialBalanceQuerySchema,
} from '@openbooks/shared-types';

import { ValidationError } from '../../errors';
import { listAccounts } from '../accounts';
import { pollWorkQueue, submitWorkItemProposal } from '../automations';
import { listBills } from '../bills';
import { listContacts } from '../contacts';
import { createDraft } from '../drafts';
import { getTrialBalance } from '../ledger';
import type { TrialBalance, TrialBalanceQuery } from '../ledger';
import { listInvoices } from '../invoices';
import { requirePermission } from '../permissions';

/**
 * The MCP tool suite (OB-103; ROADMAP D-59, D-60; spec §8, §12). Extended by
 * initiative Q (OB-200…210, D-99/D-100/D-118/D-119) with the agent work queue
 * protocol: `work_queue.poll` and `work_queue.submit_proposal`.
 *
 * **FOCUSED/representative scope, deliberately** — five read tools mirroring one
 * service each, plus the propose-only writes. Not a mirror of every REST endpoint;
 * OB-103's brief is a tool suite that proves the seam (a second transport over the
 * same services, under the same permission catalog), not a second surface to
 * maintain in lockstep with `transport/routes/`.
 *
 * ## Every tool is a thin call onto an existing service, never a second implementation
 *
 * Each `inputSchema` below **is** the service's own list-query schema — the same
 * `listAccountsQuerySchema` the REST route's Fastify schema validates against — so
 * an MCP client and an HTTP client send and are refused the same shapes (F5). The
 * handler's body is `requirePermission` then the service call; nothing here
 * re-derives a filter, a page bound, or a permission the service already owns.
 *
 * ## `requirePermission` first, every time (F11)
 *
 * Every handler below calls it as its first statement, before parsing or touching
 * anything else — `host.ts` does not enforce a tool's `permission` itself (see that
 * file's header for why a second enforcement point is exactly the failure mode
 * spec §2.4/§5 rules out). The declared `permission` field is documentation the
 * MCP manifest can publish; the call in the handler is what actually refuses.
 *
 * ## The write tools refuse to write directly
 *
 * `journal.propose` is `supportsProposeOnly: true` and its handler refuses
 * `mode: 'execute'` outright — a ledger-writing tool has no execute path at all
 * (D-60). It lands a draft via `createDraft`, the same M2 mechanism a human typing
 * into the journal-entry form uses, and a human holding `agents.review` is the only
 * way that draft ever becomes a posting (`modules/agents/review.service.ts`).
 * `work_queue.submit_proposal` is Q's own instance of the same rule (D-100): it never
 * posts either, only lands a `journal_drafts` row through `submitWorkItemProposal`,
 * so an org's agent has exactly one way to write anything through MCP, in both the
 * ad hoc case (`journal.propose`) and the queued-work case (`work_queue.*`).
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const accountsListTool: McpToolDefinition<typeof listAccountsQuerySchema, AccountPage> = {
  name: 'accounts.list',
  description:
    'Lists the chart of accounts, one page at a time. Same filters (`type`, `isActive`) and ' +
    'keyset pagination as `GET /v1/accounts`.',
  inputSchema: listAccountsQuerySchema,
  sideEffects: 'Read-only. Nothing in the org changes.',
  requiresConfirm: false,
  supportsProposeOnly: false,
  permission: 'accounts.read',
  async handler(input: ListAccountsQuery, ctx) {
    await requirePermission(ctx, 'accounts.read');
    const result = await listAccounts(input, ctx);
    return { kind: 'executed', result };
  },
};

export const contactsListTool: McpToolDefinition<typeof listContactsQuerySchema, ContactPage> = {
  name: 'contacts.list',
  description:
    'Lists customers and vendors, one page at a time. Same filters (`isCustomer`, `isVendor`, ' +
    '`isActive`) and keyset pagination as `GET /v1/contacts`.',
  inputSchema: listContactsQuerySchema,
  sideEffects: 'Read-only. Nothing in the org changes.',
  requiresConfirm: false,
  supportsProposeOnly: false,
  permission: 'contacts.read',
  async handler(input: ListContactsQuery, ctx) {
    await requirePermission(ctx, 'contacts.read');
    const result = await listContacts(input, ctx);
    return { kind: 'executed', result };
  },
};

export const trialBalanceTool: McpToolDefinition<typeof trialBalanceQuerySchema, TrialBalance> = {
  name: 'reports.trial_balance',
  description:
    'The trial balance: every account’s debit and credit totals as of an optional date, plus ' +
    'the org-wide totals that must be equal. A direct aggregation over journal lines — no cache, ' +
    'no denormalized total. Same as `GET /v1/reports/trial-balance`.',
  inputSchema: trialBalanceQuerySchema,
  sideEffects: 'Read-only. Nothing in the org changes.',
  requiresConfirm: false,
  supportsProposeOnly: false,
  permission: 'reports.read',
  async handler(input: TrialBalanceQuery, ctx) {
    await requirePermission(ctx, 'reports.read');
    const result = await getTrialBalance(input, ctx);
    return { kind: 'executed', result };
  },
};

export const invoicesListTool: McpToolDefinition<typeof listInvoicesQuerySchema, InvoicePage> = {
  name: 'invoices.list',
  description:
    'Lists AR invoices, one page at a time. Same filters (`contactId`, `status`, a date range, ' +
    '`dueBefore`) and keyset pagination as `GET /v1/invoices`. `status` is derived — draft, ' +
    'approved, part_paid, paid, or void — never stored.',
  inputSchema: listInvoicesQuerySchema,
  sideEffects: 'Read-only. Nothing in the org changes.',
  requiresConfirm: false,
  supportsProposeOnly: false,
  permission: 'invoices.read',
  async handler(input: ListInvoicesQuery, ctx) {
    await requirePermission(ctx, 'invoices.read');
    const result = await listInvoices(input, ctx);
    return { kind: 'executed', result };
  },
};

export const billsListTool: McpToolDefinition<typeof listBillsQuerySchema, BillPage> = {
  name: 'bills.list',
  description:
    'Lists AP bills, one page at a time. Same filters (`contactId`, `status`, a date range, ' +
    '`dueBefore`, the vendor’s own `reference`) and keyset pagination as `GET /v1/bills`. ' +
    '`status` is derived — draft, approved, part_paid, paid, or void — never stored.',
  inputSchema: listBillsQuerySchema,
  sideEffects: 'Read-only. Nothing in the org changes.',
  requiresConfirm: false,
  supportsProposeOnly: false,
  permission: 'bills.read',
  async handler(input: ListBillsQuery, ctx) {
    await requirePermission(ctx, 'bills.read');
    const result = await listBills(input, ctx);
    return { kind: 'executed', result };
  },
};

// ---------------------------------------------------------------------------
// The one write: propose-only (D-60, F6)
// ---------------------------------------------------------------------------

export const journalProposeTool: McpToolDefinition<typeof createDraftRequestSchema, JournalDraft> =
  {
    name: 'journal.propose',
    description:
      'Proposes a manual journal entry. Never posts: it lands a draft — the same `journal_drafts` ' +
      'row a person composing an entry by hand would create — and a human holding `agents.review` ' +
      'must approve it before anything reaches the ledger (ROADMAP D-60). Call with ' +
      '`mode: "propose"`; `mode: "execute"` is refused.',
    inputSchema: createDraftRequestSchema,
    sideEffects:
      'Creates an editable, discardable journal draft. The draft is in no report and no trial ' +
      'balance until a human approves it in the agent review queue. Approving posts a balanced ' +
      'journal to the ledger — a posted journal cannot be edited or deleted, only reversed. ' +
      'Rejecting discards the draft with no trace left in any report.',
    requiresConfirm: true,
    supportsProposeOnly: true,
    permission: 'journals.post',
    async handler(input: CreateDraftRequest, ctx) {
      await requirePermission(ctx, 'journals.post');

      if (ctx.mode !== 'propose') {
        // D-60 in one sentence: an agent write is a proposal, never a direct
        // posting. `supportsProposeOnly: true` says this tool *can* be called in
        // propose mode; it does not say execute is merely discouraged — a
        // ledger-writing tool has no execute path at all, so this refuses rather
        // than silently downgrading to a proposal the caller did not ask for.
        throw new ValidationError('journal.propose only supports mode: "propose".', [
          {
            path: 'mode',
            message:
              'This tool never posts directly (F6, D-60): it drafts an entry for a human holding ' +
              '`agents.review` to approve or reject. Call it with mode: "propose".',
          },
        ]);
      }

      const draft = await createDraft(input, ctx);
      return { kind: 'proposed', proposal: describeDraft(draft) };
    },
  };

/**
 * Turns a stored draft into the plain-language proposal `mcp.ts` requires: enough
 * for a human to approve or reject on the strength of this alone (spec §6).
 *
 * Reads only what `createDraft` already returned — no second lookup of account
 * names or codes, which would need `accounts.read` this tool does not require and
 * would make the proposal's shape depend on a permission its caller might not
 * hold. `accountId` therefore appears as the opaque id it is; the review screen
 * (OB-105) is where a human sees it resolved against the chart they already know.
 */
function describeDraft(draft: JournalDraft): ToolProposal {
  const lineCount = draft.lines.length;
  const memoClause = draft.memo === null ? '' : `, memo "${draft.memo}"`;
  const dateClause = draft.entryDate === null ? 'no entry date yet' : `dated ${draft.entryDate}`;

  const lineEffects = draft.lines.map((line) => {
    const side = line.side ?? 'no side yet';
    const account = line.accountId ?? 'no account yet';
    const lineMemo = line.memo === null ? '' : ` — ${line.memo}`;
    return `Line ${String(line.lineNumber)}: ${side} ${line.amount} on account ${account}${lineMemo}`;
  });

  return {
    summary:
      `Drafted a journal entry (${String(lineCount)} line${lineCount === 1 ? '' : 's'}), ` +
      `${dateClause}${memoClause}. Nothing has posted — this draft sits in the agent review ` +
      'queue until a human with `agents.review` approves or rejects it.',
    effects: [
      ...lineEffects,
      'Approving posts a balanced journal to the ledger, which is then irreversible except by a ' +
        'reversing entry (D-16). Rejecting discards the draft; nothing about it is ever recorded.',
    ],
  };
}

// ---------------------------------------------------------------------------
// The agent work queue (initiative Q, D-99/D-100/D-118/D-119)
// ---------------------------------------------------------------------------

export const workQueuePollTool: McpToolDefinition<
  typeof pollWorkQueueInputSchema,
  PollWorkQueueResult
> = {
  name: 'work_queue.poll',
  description:
    'Leases the next queued work item, if any, for `leaseSeconds` (default set by the server). ' +
    'An empty queue is success, not an error: the result carries `item: null` rather than a ' +
    '404 or an empty-collection refusal (ROADMAP D-118) — the agent’s poll loop should treat a ' +
    'null item as "nothing to do right now", not as a fault. A leased item’s lease expires and ' +
    're-queues on its own if `work_queue.submit_proposal` is never called with its `leaseToken`.',
  inputSchema: pollWorkQueueInputSchema,
  sideEffects:
    'Mutates: on a hit, the returned item moves from `queued` to `leased` and is unavailable to ' +
    'any other poll until the lease expires. Nothing about the org’s books changes — no journal, ' +
    'no draft, no report is affected.',
  requiresConfirm: false,
  supportsProposeOnly: false,
  permission: 'workflows.read',
  async handler(input: PollWorkQueueInput, ctx) {
    await requirePermission(ctx, 'workflows.read');
    const result = await pollWorkQueue(input, ctx);
    return { kind: 'executed', result };
  },
};

export const workQueueSubmitProposalTool: McpToolDefinition<
  typeof submitProposalInputSchema,
  ToolProposal
> = {
  name: 'work_queue.submit_proposal',
  description:
    'Submits the leased work item’s result as a journal draft for human review. Never posts ' +
    '(D-100, the same rule `journal.propose` follows): it lands an ordinary `journal_drafts` row ' +
    'through the existing `agents.review` queue, and only a human holding that permission can ' +
    'turn it into a posting. `leaseToken` proves the caller still holds the item leased by ' +
    '`work_queue.poll`; a stale or already-resolved lease is refused.',
  inputSchema: submitProposalInputSchema,
  sideEffects:
    'Lands a `journal_drafts` row for a human to approve or reject (`agents.review`). The work ' +
    'item moves to `proposed` and records this draft and the agent’s attested model. Nothing ' +
    'posts to the ledger from this call alone.',
  requiresConfirm: true,
  supportsProposeOnly: false,
  permission: 'journals.post',
  async handler(input: SubmitProposalInput, ctx) {
    await requirePermission(ctx, 'journals.post');
    const { proposal } = await submitWorkItemProposal(input, ctx);
    return { kind: 'proposed', proposal };
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The full suite, in the order `tools/list` publishes them. */
export const mcpTools: readonly McpToolDefinition[] = [
  accountsListTool,
  contactsListTool,
  trialBalanceTool,
  invoicesListTool,
  billsListTool,
  journalProposeTool,
  workQueuePollTool,
  workQueueSubmitProposalTool,
];
