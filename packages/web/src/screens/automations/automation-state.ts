import type {
  Automation,
  AutomationAction,
  AutomationScheduleCadence,
  AutomationTrigger,
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from './queries';

/**
 * The form's own model of an automation, and the conversion to the create/update requests
 * that store it.
 *
 * The trigger follows `recurring-invoices/template-state.ts`'s shape (a form-local draft,
 * converted to the wire union at submission) and the action list follows
 * `dunning/stage-state.ts`'s (an array whose own order *is* the meaning — `AutomationActions`'
 * own words: "Actions run in list order").
 */

export type TriggerDraft =
  | { readonly type: 'manual' }
  | { readonly type: 'scheduled'; readonly cadence: AutomationScheduleCadence }
  | { readonly type: 'event'; readonly eventName: string };

/**
 * One action row.
 *
 * `key` is the React identity — an action carries no id at all on the wire, only its
 * position in the list, the same reason `StageDraft.key` (`dunning/stage-state.ts`) is
 * minted locally rather than read off the server: reordering must not remount a row the
 * user is mid-edit on.
 */
export type ActionDraft =
  | { readonly key: string; readonly type: 'annotate'; readonly note: string }
  | {
      readonly key: string;
      readonly type: 'agent_task';
      readonly prompt: string;
      readonly sourceKind: string;
    };

export interface AutomationFormState {
  readonly name: string;
  readonly trigger: TriggerDraft;
  readonly actions: readonly ActionDraft[];
}

let nextLocalKey = 0;

export function blankAnnotateAction(): ActionDraft {
  nextLocalKey += 1;
  return { key: `new-${String(nextLocalKey)}`, type: 'annotate', note: '' };
}

export function blankAgentTaskAction(): ActionDraft {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    type: 'agent_task',
    prompt: '',
    sourceKind: 'automation',
  };
}

/** A new automation starts with one blank annotate action — `dunning/stage-state.ts`'s
 * `blankStage` reasoning: a form that cannot be saved until a row is added by hand is worse
 * than one seeded with something to edit or remove. */
export function blankFormState(): AutomationFormState {
  return { name: '', trigger: { type: 'manual' }, actions: [blankAnnotateAction()] };
}

function triggerFromWire(trigger: AutomationTrigger): TriggerDraft {
  if (trigger.type === 'scheduled') return { type: 'scheduled', cadence: trigger.cadence };
  if (trigger.type === 'event') return { type: 'event', eventName: trigger.eventName };
  return { type: 'manual' };
}

function actionFromWire(action: AutomationAction, index: number): ActionDraft {
  if (action.type === 'agent_task') {
    return {
      key: `existing-${String(index)}`,
      type: 'agent_task',
      prompt: action.prompt,
      sourceKind: action.sourceKind,
    };
  }
  return { key: `existing-${String(index)}`, type: 'annotate', note: action.note };
}

export function stateFromAutomation(automation: Automation): AutomationFormState {
  return {
    name: automation.name,
    trigger: triggerFromWire(automation.trigger),
    actions: automation.actions.map(actionFromWire),
  };
}

/** Whether an action row has everything its wire shape requires. */
export function actionIsComplete(action: ActionDraft): boolean {
  if (action.type === 'annotate') return action.note.trim() !== '';
  return action.prompt.trim() !== '' && action.sourceKind.trim() !== '';
}

/** Whether the trigger row has everything its wire shape requires — only `event` has a
 * field that can be typed empty; `scheduled`'s cadence is always one of a fixed set. */
export function triggerIsComplete(trigger: TriggerDraft): boolean {
  return trigger.type !== 'event' || trigger.eventName.trim() !== '';
}

/**
 * Whether the form has enough to submit: a name, a complete trigger, and at least one
 * complete action. Checked here rather than left entirely to the server, because a
 * validation round trip for "this automation has no actions" is a worse teacher than a
 * disabled button — `recurring-invoices/template-state.ts`'s `formIsComplete` reasoning.
 */
export function formIsComplete(state: AutomationFormState): boolean {
  if (state.name.trim() === '') return false;
  if (!triggerIsComplete(state.trigger)) return false;
  if (state.actions.length === 0) return false;
  return state.actions.every(actionIsComplete);
}

function toTriggerInput(trigger: TriggerDraft): AutomationTrigger {
  if (trigger.type === 'scheduled') return { type: 'scheduled', cadence: trigger.cadence };
  if (trigger.type === 'event') return { type: 'event', eventName: trigger.eventName.trim() };
  return { type: 'manual' };
}

function toActionInput(action: ActionDraft): AutomationAction {
  // Not reachable through the submit button (`formIsComplete` gates it), but an incomplete
  // action that slipped through would rather throw here than send a request the schema will
  // refuse with a message naming a field this form does not show a value for —
  // `recurring-invoices/template-state.ts`'s `toLineInput` reasoning.
  if (!actionIsComplete(action)) {
    throw new Error('Cannot serialize an incomplete automation action.');
  }
  if (action.type === 'agent_task') {
    return {
      type: 'agent_task',
      prompt: action.prompt.trim(),
      sourceKind: action.sourceKind.trim(),
    };
  }
  return { type: 'annotate', note: action.note.trim() };
}

export function toCreateRequest(state: AutomationFormState): CreateAutomationRequest {
  return {
    name: state.name.trim(),
    trigger: toTriggerInput(state.trigger),
    actions: state.actions.map(toActionInput),
  };
}

/**
 * The whole editable composition, every time — `trigger` and `actions` replace wholesale
 * (`UpdateAutomationRequest`'s own words: "replace wholesale"), and there is no per-field
 * diff the way `contacts/contact-form.tsx` computes one. `isActive` is deliberately absent:
 * it is written only through `POST …/activate` and `POST …/deactivate`, gated
 * `workflows.activate`, never through this form — the reserved compose-vs-activate split
 * `queries.ts`' `useActivateAutomation` documents.
 */
export function toUpdateRequest(state: AutomationFormState): UpdateAutomationRequest {
  return {
    name: state.name.trim(),
    trigger: toTriggerInput(state.trigger),
    actions: state.actions.map(toActionInput),
  };
}
