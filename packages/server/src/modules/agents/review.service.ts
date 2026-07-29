import type { PostedJournal } from '@openbooks/plugin-api';
import type { JournalDraftPage, ListDraftsQuery } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { discardDraft, listDrafts, postDraft } from '../drafts';
import { requirePermission } from '../permissions';

/**
 * The agent review queue (OB-103; ROADMAP D-60; spec §6).
 *
 * This is what finally gives `agents.review` a meaning: the code has been seeded
 * and latent since M1 (`0001_tenancy`'s Approver role), waiting on the write path
 * D-60 describes — "an agent proposes; a human posts." `journal.propose`
 * (`modules/mcp/tools.ts`) is that proposer, and it lands an ordinary M2
 * `journal_drafts` row via `createDraft`. Everything here is a thin wrapper over
 * the drafts service (`modules/drafts`) gated on the review permission rather than
 * on `journals.post` — the same draft, read and acted on through a different door.
 *
 * ## `journal_drafts` carries no origin column
 *
 * Nothing distinguishes a draft an agent proposed from one a person typed into the
 * journal-entry form by hand. That is not an oversight this file works around; it
 * is D-16/D-19's own position, restated by `drafts.service.ts`'s `requireAuthor`:
 * a draft is authored by a real user regardless of who is driving — `journal.propose`
 * runs under an MCP caller's *own* identity (an OAuth bearer token resolves to the
 * granting user, never a bare "agent" actor), so the draft it creates is
 * attributed to that user exactly as if they had typed it themselves. `listProposals`
 * below therefore returns every pending draft in the org, not a filtered agent
 * subset — the queue a human with `agents.review` needs is "everything not yet
 * posted or discarded," which is a safe superset of "everything an agent proposed."
 * A future origin marker (if agent-only visibility is ever wanted) is a schema
 * change and a different ticket, not a filter this service can fake.
 *
 * ## Why a reviewer needs two permissions, not one
 *
 * Approving calls `postDraft`, which re-checks `journals.post` (the ledger
 * authorizes its own writes regardless of caller, `openbooks/no-journal-writes`),
 * and rejecting calls `discardDraft`, which does the same. So turning a proposal
 * into a posting — or discarding it — takes `agents.review` *and* `journals.post`
 * together. That is not an accident of composition: the seeded Approver role
 * holds both for exactly this reason ("Approving a proposal posts it, so
 * journals.post is required — the point of the role is to be the one who can turn
 * a proposal into a posting," `0001_tenancy.ts`). A role holding only
 * `agents.review` can see the queue and nothing more.
 */

/**
 * One page of pending proposals — every draft not yet posted or discarded, oldest
 * first (D-21). See the file header for why this is not filtered to agent-authored
 * drafts specifically.
 */
export async function listProposals(
  query: ListDraftsQuery,
  ctx: RequestContext = getContext('listProposals()'),
): Promise<JournalDraftPage> {
  await requirePermission(ctx, 'agents.review');
  return listDrafts(query, ctx);
}

/**
 * Turns a proposal into a posting. `postDraft` does the work — locking the draft,
 * posting a balanced journal, and deleting the draft in one transaction (D-19) —
 * and re-checks `journals.post` itself; see its own commentary
 * (`drafts.service.ts`) for the lock order and for what a concurrent approver
 * sees. Provenance on the resulting journal is the *approver's*, not the
 * proposing agent's — the same rule applies whether the draft's author was a
 * person or an agent acting as one.
 */
export async function approveProposal(
  draftId: string,
  ctx: RequestContext = getContext('approveProposal()'),
): Promise<PostedJournal> {
  await requirePermission(ctx, 'agents.review');
  return postDraft(draftId, ctx);
}

/**
 * Discards a proposal outright — the same operation a person discarding their own
 * unfinished draft performs (D-16). Nothing about a rejected proposal is recorded
 * anywhere: it is gone as completely as a typo caught before it was ever saved.
 */
export async function rejectProposal(
  draftId: string,
  ctx: RequestContext = getContext('rejectProposal()'),
): Promise<void> {
  await requirePermission(ctx, 'agents.review');
  return discardDraft(draftId, ctx);
}
