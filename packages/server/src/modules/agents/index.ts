/**
 * The agent review queue (OB-103; ROADMAP D-60; spec §6).
 *
 * Read `review.service.ts` for what activates `agents.review`, for why the queue
 * is every pending draft rather than an agent-filtered subset, and for why a
 * reviewer needs `journals.post` alongside `agents.review` to actually approve or
 * reject one.
 */

export { approveProposal, listProposals, rejectProposal } from './review.service';
