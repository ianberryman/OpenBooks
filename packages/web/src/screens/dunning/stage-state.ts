import type { DunningStage } from './queries';

/**
 * The stage-ladder editor's own model of a row, and the conversion back to the request.
 *
 * `key` is the React identity for a row, minted locally rather than taken from the wire:
 * a stage has no id, only a `stageNumber`, and reordering the ladder must not remount a
 * row the user is mid-edit on — the same problem and the same fix as `EditorLine.key` in
 * `sales/document-state.ts`.
 *
 * `stageNumber` is deliberately absent from this type. The ladder's position *is* the
 * numbering — the create/update request's own doc says stages may arrive "in any order"
 * because `stageNumber` carries it, but this editor never lets the two disagree in the
 * first place: `stagesToRequest` derives `stageNumber` from array position at the moment
 * of submission, so add/remove/reorder can never produce a duplicate or a gap for the
 * server to refuse.
 */
export interface StageDraft {
  readonly key: string;
  readonly offsetDays: number;
  readonly subject: string;
  readonly body: string;
  /** Minor units (D-13), or `null` for a reminder that posts no fee. */
  readonly lateFeeMinor: string | null;
}

let nextLocalKey = 0;

/** A first stage a new policy starts with: a chase a week after the due date, so "New
 * policy" opens on a ladder with something in it rather than a form that cannot be saved
 * until a stage is added by hand. */
export function blankStage(offsetDays = 7): StageDraft {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    offsetDays,
    subject: '',
    body: '',
    lateFeeMinor: null,
  };
}

/** Seeds the editor from a policy's own stages, ordered by `stageNumber` — the ladder's
 * order — rather than by whatever order the server happened to return them in. */
export function stagesFromPolicy(stages: readonly DunningStage[]): StageDraft[] {
  return [...stages]
    .sort((a, b) => a.stageNumber - b.stageNumber)
    .map((stage) => ({
      key: `existing-${String(stage.stageNumber)}`,
      offsetDays: stage.offsetDays,
      subject: stage.subject,
      body: stage.body,
      lateFeeMinor: stage.lateFeeMinor ?? null,
    }));
}

/** `stageNumber` is 1-based array position — see the module comment for why that is safe
 * to derive rather than a field this editor asks the user to type. */
export function stagesToRequest(stages: readonly StageDraft[]): DunningStage[] {
  return stages.map((stage, index) => ({
    stageNumber: index + 1,
    offsetDays: stage.offsetDays,
    subject: stage.subject.trim(),
    body: stage.body,
    lateFeeMinor: stage.lateFeeMinor,
  }));
}
