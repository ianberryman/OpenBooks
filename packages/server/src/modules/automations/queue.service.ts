import type {
  JournalDraft,
  ListWorkItemsQuery,
  PollWorkQueueInput,
  PollWorkQueueResult,
  SubmitProposalInput,
  WorkItem,
  WorkItemPage,
  WorkItemStatus,
} from '@openbooks/shared-types';
import {
  listWorkItemsQuerySchema,
  pollWorkQueueInputSchema,
  submitProposalInputSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import {
  bufferToUuid,
  newUuidBuffer,
  resolvePageLimit,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { createDraft } from '../drafts';
import { requirePermission } from '../permissions';

import {
  cancelWorkItemRow,
  leaseWorkItemRow,
  orgScope,
  proposeWorkItemRow,
  selectNextQueuedWorkItemForUpdate,
  selectWorkItemById,
  selectWorkItemByIdForUpdate,
  selectWorkItemByLeaseTokenForUpdate,
  selectWorkItemsPage,
  toWorkItem,
  toWorkItemContext,
  WORK_ITEM_RESOURCE,
  workItemIdBytes,
} from './repository';

/**
 * The MCP-facing work queue (Q4…Q7, Q10; ROADMAP D-99, D-100, D-118).
 *
 * `pollWorkQueue` and `submitWorkItemProposal` are the two halves of the seam
 * D-100 draws: OpenBooks never calls a model. An agent's own infrastructure
 * polls this queue over MCP, runs inference wherever it likes, and submits a
 * proposal back — which lands as an ordinary `journal_drafts` row through
 * `createDraft`, the same M2 mechanism a human typing into the journal-entry
 * form uses. A human holding `agents.review` is the only way that draft ever
 * becomes a posting (`modules/agents/review.service.ts`). Nothing in this file
 * calls `postJournal`.
 *
 * `requirePermission` runs first, before the payload is parsed, matching every
 * other service in this tree.
 */

const DEFAULT_LEASE_SECONDS = 300;

/** Terminal states a work item may no longer be cancelled out of. */
const CANCELLABLE_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['queued', 'leased']);

export async function listWorkItems(
  query: ListWorkItemsQuery,
  ctx: RequestContext = getContext('listWorkItems()'),
): Promise<WorkItemPage> {
  await requirePermission(ctx, 'workflows.read');
  const request = parseInput(listWorkItemsQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const page = await selectWorkItemsPage(
    orgScope(ctx),
    {
      ...(request.status === undefined ? {} : { status: request.status }),
      ...(request.automationId === undefined
        ? {}
        : { automationId: tryUuidToBuffer(request.automationId) }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    },
    limit,
  );

  return { items: page.rows.map(toWorkItem), nextCursor: page.nextCursor };
}

export async function getWorkItem(
  workItemId: string,
  ctx: RequestContext = getContext('getWorkItem()'),
): Promise<WorkItem> {
  await requirePermission(ctx, 'workflows.read');

  const db = orgScope(ctx);
  const id = assertFound(workItemIdBytes(workItemId), WORK_ITEM_RESOURCE);
  return toWorkItem(assertFound(await selectWorkItemById(db, id), WORK_ITEM_RESOURCE));
}

/**
 * Cancels a work item — only reachable from `queued` or `leased`. Already-
 * `cancelled` is idempotent, `deactivateRecurringInvoiceTemplate`'s shape; any
 * other terminal status (`proposed`, `failed`) is a `PreconditionFailedError`
 * rather than a silent no-op, because the item has already produced (or failed
 * to produce) an effect that cancelling now cannot undo.
 */
export async function cancelWorkItem(
  workItemId: string,
  ctx: RequestContext = getContext('cancelWorkItem()'),
): Promise<WorkItem> {
  await requirePermission(ctx, 'workflows.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(workItemIdBytes(workItemId), WORK_ITEM_RESOURCE);
    const current = assertFound(await selectWorkItemByIdForUpdate(trx, id), WORK_ITEM_RESOURCE);

    if (current.status !== 'cancelled') {
      if (!CANCELLABLE_STATUSES.has(current.status)) {
        throw new PreconditionFailedError(
          'work_item_not_cancellable',
          `This work item is ${current.status} and can no longer be cancelled.`,
        );
      }
      await cancelWorkItemRow(trx, id);
    }

    return toWorkItem(assertFound(await selectWorkItemById(trx, id), WORK_ITEM_RESOURCE));
  });
}

/**
 * The MCP client claiming this lease — provenance recorded on `leased_by`
 * (Q6/D-100's migration comment: "the MCP client (OAuth client_id / api key
 * id)"). `RequestContext`/`OperationContext` exposes no separate OAuth
 * `client_id` field; `ctx.actorId` is the closest identity this module's
 * contract offers, and it already resolves to exactly that distinction at the
 * two identity resolvers that authenticate an MCP caller: the api-key id for an
 * API-key caller (`resolveApiKeyIdentity`) and the granting user's id for an
 * OAuth bearer caller (`resolveOAuthIdentity`, `actorType: 'user'`). Recorded,
 * not vouched for — the same "agent-attested" caveat the migration draws for
 * `agent_model`.
 */
function mcpClientId(ctx: RequestContext): string {
  return ctx.actorId;
}

/**
 * `work_queue.poll` (Q10): leases the oldest `queued` item in the org, or
 * returns `{ item: null }` — an empty queue is success, never a throw (D-118).
 *
 * The single-grant guarantee is `selectNextQueuedWorkItemForUpdate`'s
 * `FOR UPDATE SKIP LOCKED`: two concurrent polls never receive the same row and
 * never block on each other, which is the whole of Q10.
 */
export async function pollWorkQueue(
  input: PollWorkQueueInput,
  ctx: RequestContext = getContext('pollWorkQueue()'),
): Promise<PollWorkQueueResult> {
  await requirePermission(ctx, 'workflows.read');
  const request = parseInput(pollWorkQueueInputSchema, input);
  const leaseSeconds = request.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  return orgScope(ctx).transaction(async (trx) => {
    const candidate = await selectNextQueuedWorkItemForUpdate(trx);
    if (candidate === undefined) return { item: null };

    const now = new Date();
    const leaseTokenBytes = newUuidBuffer();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

    await leaseWorkItemRow(trx, candidate.id, {
      leaseToken: leaseTokenBytes,
      leasedBy: mcpClientId(ctx),
      leasedAt: now,
      leaseExpiresAt,
    });

    return {
      item: {
        workItemId: bufferToUuid(candidate.id),
        prompt: candidate.prompt,
        context: toWorkItemContext(candidate.context),
        sourceKind: candidate.source_kind,
        sourceRef: candidate.source_ref,
        leaseToken: bufferToUuid(leaseTokenBytes),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      },
    };
  });
}

interface WorkQueueProposal {
  readonly summary: string;
  readonly effects: readonly string[];
}

/**
 * `work_queue.submitProposal` (Q4…Q6).
 *
 * ## Idempotency: why this is a row-lock guard, not `withGlobalIdempotency`
 *
 * `withGlobalIdempotency` (`modules/idempotency/service.ts`) keys its claim on
 * `RequestContext.idempotencyKey`, read ambiently — there is no parameter to
 * key it on a caller-supplied value like the lease token instead, and the MCP
 * host (`modules/mcp/host.ts`) does not thread an `Idempotency-Key` onto a
 * `tools/call`, so that field is null for every MCP caller today. Calling
 * `withGlobalIdempotency` here would therefore refuse every legitimate call
 * with "this operation requires an Idempotency-Key" rather than dedupe
 * anything.
 *
 * The guard instead is the state the lease itself already carries, reloaded
 * `FOR UPDATE` before anything is written: a lease token names at most one
 * `work_items` row and is cleared the moment a proposal is accepted
 * (`proposeWorkItemRow`). Two submissions racing the same token serialize on
 * this lock; the loser reloads after the winner commits, finds `status` no
 * longer `'leased'`, and receives `lease_invalid` rather than a second draft.
 * That refuses a genuine redelivery rather than replaying the first response —
 * a real difference from `withGlobalIdempotency` — but it holds the one
 * invariant that matters here: a lease is proposed at most once.
 */
export async function submitWorkItemProposal(
  input: SubmitProposalInput,
  ctx: RequestContext = getContext('submitWorkItemProposal()'),
): Promise<{ readonly workItemId: string; readonly proposal: WorkQueueProposal }> {
  await requirePermission(ctx, 'journals.post');
  const request = parseInput(submitProposalInputSchema, input);
  const leaseTokenBytes = tryUuidToBuffer(request.leaseToken);

  return orgScope(ctx).transaction(async (trx) => {
    const current =
      leaseTokenBytes === undefined
        ? undefined
        : await selectWorkItemByLeaseTokenForUpdate(trx, leaseTokenBytes);

    if (current === undefined || current.status !== 'leased') {
      throw leaseInvalid();
    }
    if (current.lease_expires_at === null || current.lease_expires_at.getTime() <= Date.now()) {
      throw leaseExpired();
    }

    // `createDraft` joins this transaction ambiently (`transaction-scope.ts`),
    // so the draft and the work item's `proposed` transition commit together.
    const draft = await createDraft(request.draft, ctx);

    await proposeWorkItemRow(trx, current.id, {
      proposedDraftId: uuidToBuffer(draft.id),
      agentModel: request.model ?? null,
      submittedByClient: mcpClientId(ctx),
      submittedAt: new Date(),
    });

    return {
      workItemId: bufferToUuid(current.id),
      proposal: describeProposal(draft),
    };
  });
}

function leaseInvalid(): PreconditionFailedError {
  return new PreconditionFailedError(
    'lease_invalid',
    'This lease does not name a work item this caller currently holds. Poll the work queue again ' +
      'for a fresh lease before submitting a proposal.',
  );
}

function leaseExpired(): PreconditionFailedError {
  return new PreconditionFailedError(
    'lease_expired',
    'This lease has expired. Poll the work queue again for a new one before submitting a proposal.',
  );
}

/**
 * Turns a stored draft into the plain-language proposal a human reviewing the
 * agent review queue needs — `modules/mcp/tools.ts`'s `describeDraft` (private
 * to that file, and this module may not reach into `src/transport/` nor is
 * `mcp/tools.ts` an exported seam), restated here rather than imported across
 * the module boundary. Reads only what `createDraft` already returned — no
 * second lookup of account names, which would need a permission this caller
 * might not hold.
 */
function describeProposal(draft: JournalDraft): WorkQueueProposal {
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
      `Proposed a journal entry (${String(lineCount)} line${lineCount === 1 ? '' : 's'}), ` +
      `${dateClause}${memoClause}. Nothing has posted — this draft sits in the agent review ` +
      'queue until a human with `agents.review` approves or rejects it.',
    effects: [
      ...lineEffects,
      'Approving posts a balanced journal to the ledger, which is then irreversible except by a ' +
        'reversing entry (D-16). Rejecting discards the draft; nothing about it is ever recorded.',
    ],
  };
}
