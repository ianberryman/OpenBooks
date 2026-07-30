import { z } from 'zod';

import { createDraftRequestSchema } from '../drafts/drafts';
import { calendarDateSchema, pageQueryShape, pageSchema } from '../wire';

/**
 * Automations — agent work queue, MCP-only (initiative Q, M6; OB-200…210; ROADMAP
 * D-99/D-100/D-119, for `0018_automations`).
 *
 * An automation is a trigger + an ordered list of actions the user composes and owns.
 * Two action types ship (D-119): `annotate` (a deterministic note) and `agent_task`
 * (enqueues a work item — the AI seam). OpenBooks never calls a model (D-100): the
 * org's own agent polls the queue over MCP and submits a proposal back, which lands
 * as an ordinary `journal_drafts` row in the existing `agents.review` queue.
 *
 * The `/v1` request/response schemas carry `.meta({ id })` (they become OpenAPI
 * components); the two MCP tool schemas at the foot do NOT — the MCP surface is
 * documented by `tools/list`, not `openapi.json`, and an `id` would pollute the REST
 * component set for a schema no route references.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const AUTOMATION_TRIGGER_TYPES = ['manual', 'scheduled', 'event'] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const AUTOMATION_SCHEDULE_CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type AutomationScheduleCadence = (typeof AUTOMATION_SCHEDULE_CADENCES)[number];

export const AUTOMATION_ACTION_TYPES = ['annotate', 'agent_task'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const WORK_ITEM_STATUSES = ['queued', 'leased', 'proposed', 'failed', 'cancelled'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

// ── Trigger ──────────────────────────────────────────────────────────────────

const automationNameSchema = z.string().trim().min(1).max(200);

/**
 * A trigger, discriminated on `type`. The service splits it into the `trigger_type`
 * column and the `trigger_config` JSON. `manual` carries nothing; `scheduled` names a
 * cadence the daily sweep matches; `event` names a bus event (e.g. `bill.approved.v1`)
 * the change-feed subscriber matches.
 */
export const automationTriggerSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('manual') }),
    z.strictObject({
      type: z.literal('scheduled'),
      cadence: z.enum(AUTOMATION_SCHEDULE_CADENCES),
    }),
    z.strictObject({
      type: z.literal('event'),
      eventName: z.string().trim().min(1).max(80).meta({
        description: 'The bus event that fires this automation, e.g. `bill.approved.v1`.',
      }),
    }),
  ])
  .meta({
    id: 'AutomationTrigger',
    description:
      'What fires the automation: `manual` (a run request), `scheduled` (a cadence the daily ' +
      'sweep matches), or `event` (a change-feed event name). Q2.',
  });

export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * One action, discriminated on `type`. `annotate` is the trivial deterministic action
 * (an append-only note); `agent_task` enqueues a work item carrying the prompt the org's
 * agent reads. The union is open by construction — a later action type (an outbound
 * webhook, D-119) is a new member, not a reshape.
 */
export const automationActionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('annotate'),
      note: z.string().trim().min(1).max(512).meta({
        description: 'The note this action appends to the firing (append-only). D-119.',
      }),
    }),
    z.strictObject({
      type: z.literal('agent_task'),
      prompt: z.string().trim().min(1).max(2000).meta({
        description: 'The instruction enqueued for the org’s agent to act on (Q3). Never posts.',
      }),
      sourceKind: z.string().trim().min(1).max(60).default('automation').meta({
        description: 'A label for what kind of work this is, carried onto the work item.',
      }),
    }),
  ])
  .meta({
    id: 'AutomationAction',
    description:
      'One step of an automation. `annotate` writes a note; `agent_task` enqueues a work item ' +
      'for the org’s MCP agent (D-119). Actions run in list order (Q9).',
  });

export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationActionsSchema = z.array(automationActionSchema).min(1).max(20).meta({
  id: 'AutomationActions',
  description: 'The ordered actions an automation runs on each firing.',
});

// ── Automation: create / update / response ────────────────────────────────────

export const createAutomationRequestSchema = z
  .strictObject({
    name: automationNameSchema.meta({ description: 'The automation’s own label.' }),
    trigger: automationTriggerSchema,
    actions: automationActionsSchema,
  })
  .meta({
    id: 'CreateAutomationRequest',
    description:
      'Creates an automation: a trigger and an ordered list of actions (Q1). Created inactive — ' +
      'enabling it to fire needs `workflows.activate`.',
  });

export type CreateAutomationRequest = z.infer<typeof createAutomationRequestSchema>;

/**
 * Partial update of an automation's composition. `actions`/`trigger`, when present,
 * replace wholesale. Enabling/disabling is deliberately NOT here: `is_active` is flipped
 * only through the dedicated activate/deactivate routes, gated by `workflows.activate`
 * (owner-only), so a composer holding `workflows.write` cannot enable their own
 * automation — a real separation of duties, the reserved compose-vs-activate split.
 */
export const updateAutomationRequestSchema = z
  .strictObject({
    name: automationNameSchema.optional(),
    trigger: automationTriggerSchema.optional(),
    actions: automationActionsSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateAutomationRequest',
    description:
      'Partial update of an automation’s composition (name, trigger, actions). An absent field ' +
      'is unchanged; `trigger` and `actions` replace wholesale. Enabling it to fire is a ' +
      'separate act, gated by `workflows.activate`.',
  });

export type UpdateAutomationRequest = z.infer<typeof updateAutomationRequestSchema>;

export const automationSchema = z
  .strictObject({
    id: z.uuid(),
    name: automationNameSchema,
    isActive: z.boolean().meta({
      description: 'Whether the automation fires. Flipped through `workflows.activate`.',
    }),
    trigger: automationTriggerSchema,
    actions: automationActionsSchema,
    lastFiredRunDate: calendarDateSchema.nullable().meta({
      description:
        'The run date of the most recent scheduled firing, or null. The once-per-cycle guard ' +
        'for a scheduled trigger (cf. a recurring template’s `lastRunDate`).',
    }),
  })
  .meta({
    id: 'Automation',
    description: 'A user-composed automation: a trigger and an ordered list of actions (Q1).',
  });

export type Automation = z.infer<typeof automationSchema>;

export const listAutomationsQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
  triggerType: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
});

/** Input type: `limit` carries a `.default()`, so parsed output differs. */
export type ListAutomationsQuery = z.input<typeof listAutomationsQuerySchema>;

export const automationPageSchema = pageSchema(automationSchema, {
  id: 'AutomationPage',
  description: 'One page of automations, oldest first by creation.',
});

export type AutomationPage = z.infer<typeof automationPageSchema>;

/** The effect of firing an automation once (Q9): the annotations and work items it produced. */
export const automationRunResultSchema = z
  .strictObject({
    runToken: z.uuid().meta({
      description: 'Ties this firing’s annotations and work items together.',
    }),
    annotationsWritten: z.int().min(0),
    workItemsEnqueued: z.int().min(0),
  })
  .meta({
    id: 'AutomationRunResult',
    description:
      'What one firing produced: the count of annotations written and work items enqueued.',
  });

export type AutomationRunResult = z.infer<typeof automationRunResultSchema>;

// ── Work items ────────────────────────────────────────────────────────────────

/** A work item’s context is producer-defined JSON — opaque to the API, read by the agent. */
export const workItemContextSchema = z.record(z.string(), z.unknown());

export const workItemSchema = z
  .strictObject({
    id: z.uuid(),
    automationId: z.uuid().nullable(),
    sourceKind: z.string(),
    sourceRef: z.string().nullable(),
    prompt: z.string(),
    context: workItemContextSchema,
    status: z.enum(WORK_ITEM_STATUSES),
    attempts: z.int().min(0),
    flagged: z.boolean(),
    proposedDraftId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The `journal_drafts` row the agent’s proposal landed as (Q4), or null before a ' +
          'submission. A human posts it through the `agents.review` queue — Q never posts.',
      }),
    agentModel: z.string().nullable().meta({
      description: 'The model the agent reported using (agent-attested provenance, Q6/D-100).',
    }),
    leasedBy: z.string().nullable(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    submittedAt: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'WorkItem',
    description:
      'One unit of agent work: a prompt + context, a status lifecycle, and (once submitted) the ' +
      'draft and provenance a human reviews (Q5/Q6). Never auto-posts (Q4).',
  });

export type WorkItem = z.infer<typeof workItemSchema>;

export const listWorkItemsQuerySchema = z.strictObject({
  ...pageQueryShape,
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  automationId: z.uuid().optional(),
});

export type ListWorkItemsQuery = z.input<typeof listWorkItemsQuerySchema>;

export const workItemPageSchema = pageSchema(workItemSchema, {
  id: 'WorkItemPage',
  description: 'One page of work items, oldest first by creation.',
});

export type WorkItemPage = z.infer<typeof workItemPageSchema>;

// ── MCP tool schemas (no `.meta({ id })` — MCP is not in openapi.json) ─────────

/**
 * `work_queue.poll` input. `leaseSeconds` is how long the returned lease is held before
 * it expires and the item re-queues (Q7). Optional; the server applies a default.
 */
export const pollWorkQueueInputSchema = z.strictObject({
  leaseSeconds: z.int().min(30).max(3600).optional(),
});

export type PollWorkQueueInput = z.infer<typeof pollWorkQueueInputSchema>;

/** A leased work item handed to the agent by `work_queue.poll`. */
export const workQueueLeaseSchema = z.strictObject({
  workItemId: z.uuid(),
  prompt: z.string(),
  context: workItemContextSchema,
  sourceKind: z.string(),
  sourceRef: z.string().nullable(),
  leaseToken: z.uuid(),
  leaseExpiresAt: z.iso.datetime(),
});

export type WorkQueueLease = z.infer<typeof workQueueLeaseSchema>;

/**
 * `work_queue.poll` result. `item` is null when the queue is empty — an empty queue is a
 * success with no work, never a 404 (D-118): the MCP surface must not read as disconnected.
 */
export const pollWorkQueueResultSchema = z.strictObject({
  item: workQueueLeaseSchema.nullable(),
});

export type PollWorkQueueResult = z.infer<typeof pollWorkQueueResultSchema>;

/**
 * `work_queue.submitProposal` input. `draft` is the same `CreateDraftRequest` a human
 * composing an entry uses — it lands a `journal_drafts` row (Q4). `leaseToken` proves the
 * agent still holds the item; a stale lease is a typed `lease_expired`, HTTP 200 (D-118).
 * `model` is agent-attested provenance (Q6/D-100).
 */
export const submitProposalInputSchema = z.strictObject({
  leaseToken: z.uuid(),
  draft: createDraftRequestSchema,
  model: z.string().trim().min(1).max(200).optional(),
});

export type SubmitProposalInput = z.infer<typeof submitProposalInputSchema>;
