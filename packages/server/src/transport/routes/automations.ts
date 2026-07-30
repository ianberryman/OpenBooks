import {
  AUTOMATION_TRIGGER_TYPES,
  WORK_ITEM_STATUSES,
  automationPageSchema,
  automationRunResultSchema,
  automationSchema,
  createAutomationRequestSchema,
  pageCursorSchema,
  updateAutomationRequestSchema,
  workItemPageSchema,
  workItemSchema,
} from '@openbooks/shared-types';
import type {
  Automation,
  AutomationPage,
  AutomationRunResult,
  WorkItem,
  WorkItemPage,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import {
  cancelWorkItem,
  createAutomation,
  getAutomation,
  getWorkItem,
  listAutomations,
  listWorkItems,
  runAutomation,
  setAutomationActive,
  updateAutomation,
} from '../../modules/automations';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/automations` and `/v1/work-items` — the REST half of initiative Q (agent work
 * queue; OB-200…210; ROADMAP D-99/D-100/D-119, transport for `modules/automations`).
 *
 * A person composes and owns an automation through this surface: create it, read it
 * back, edit its trigger/actions, flip `isActive` (a separate `workflows.activate`
 * gate from composing it, Q1), and fire it once on demand (`run`). Work items are the
 * queue an automation's `agent_task` actions enqueue; a person can list, inspect, and
 * cancel one here, but only the org's own agent — over MCP, `work_queue.poll` /
 * `work_queue.submit_proposal` — ever leases or resolves one. That MCP half is
 * `modules/mcp/tools.ts`, not this file: this file is the person-facing CRUD, that one
 * is the agent-facing queue protocol.
 *
 * Every permission named below (`workflows.read`/`workflows.write`/
 * `workflows.activate`, `journals.post`) is the service's own gate — `automations`'s
 * module, not repeated here (spec §5, §2.4): this file only maps arguments.
 *
 * ## `activate`/`deactivate`/`run`/`cancel` are their own routes, not a `PATCH` field
 *
 * `isActive` is deliberately absent from `updateAutomationRequestSchema`, the same
 * separation `deactivateAccount` and `deactivateRecurringInvoiceTemplate` already
 * draw: composing an automation (`workflows.write`) and letting it fire
 * (`workflows.activate`) are different privileges, so flipping the flag needs its own
 * gated route rather than riding through the edit a composer already holds. `run` and
 * `cancel` are likewise one-way acts with their own idempotency story — a
 * double-clicked `run` must replay the first firing's `AutomationRunResult` rather
 * than fire twice, and a double-clicked `cancel` must return the same already-cancelled
 * item rather than fail on the state it was trying to reach.
 */

const TAG = 'automations';
const WORK_ITEM_TAG = 'work-items';

const automationParamsSchema = z.strictObject({ automationId: z.uuid() });
const workItemParamsSchema = z.strictObject({ workItemId: z.uuid() });

const listAutomationsWireQuerySchema = z.strictObject({
  isActive: z.stringbool().optional().meta({
    description: 'Only active automations when `true`, only inactive ones when `false`.',
  }),
  triggerType: z.enum(AUTOMATION_TRIGGER_TYPES).optional(),
  limit: pageLimitQuery('automations'),
  cursor: pageCursorSchema.optional(),
});

const listWorkItemsWireQuerySchema = z.strictObject({
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  automationId: z.uuid().optional(),
  limit: pageLimitQuery('work items'),
  cursor: pageCursorSchema.optional(),
});

export function registerAutomationsRoutes(app: App): void {
  app.post(
    '/v1/automations',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createAutomation',
        summary: 'Create an automation',
        description:
          'A trigger and an ordered list of actions (Q1). Created inactive — enabling it to fire ' +
          'needs `workflows.activate`, a separate call to `POST …/activate`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createAutomationRequestSchema,
        response: { 201: automationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createAutomation', request: request.body, successStatus: 201 },
        () => createAutomation(request.body, ctx),
      );

      const automation = idempotentBody<Automation>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/automations/${automation.id}`)
        .send(automation);
    },
  );

  app.get(
    '/v1/automations',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listAutomations',
        summary: 'List automations',
        description: 'One page of automations, ordered by `(created_at, id)`, oldest first.',
        tags: [TAG],
        querystring: listAutomationsWireQuerySchema,
        response: { 200: automationPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<AutomationPage> => {
      const { isActive, triggerType, limit, cursor } = request.query;
      return listAutomations(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
          ...(triggerType === undefined ? {} : { triggerType }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/automations/:automationId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getAutomation',
        summary: 'One automation',
        tags: [TAG],
        params: automationParamsSchema,
        response: { 200: automationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Automation> =>
      getAutomation(request.params.automationId, getContext()),
  );

  app.patch(
    '/v1/automations/:automationId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateAutomation',
        summary: 'Update an automation',
        description:
          'An absent field is unchanged; `trigger` and `actions` replace wholesale. Enabling it to ' +
          'fire is a separate act, gated by `workflows.activate`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: automationParamsSchema,
        body: updateAutomationRequestSchema,
        response: { 200: automationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { automationId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateAutomation',
          request: { automationId, patch: request.body },
          successStatus: 200,
        },
        () => updateAutomation(automationId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Automation>(result));
    },
  );

  /**
   * The two activation routes are registered from a table because they differ in one
   * word (`activateAccount`/`reactivateAccount`'s own reason, `accounts.ts`). Both
   * `run`s close over the boolean `setAutomationActive` takes as its own middle
   * argument, so the table still holds one function reference per row rather than an
   * inline branch at the call site.
   */
  for (const route of [
    {
      path: '/v1/automations/:automationId/activate',
      operationId: 'activateAutomation',
      summary: 'Activate an automation',
      description:
        'Lets the automation fire on its trigger (`workflows.activate`, distinct from composing ' +
        'it). Idempotent: an already-active automation is returned unchanged rather than refused.',
      run: (automationId: string, ctx: RequestContext) =>
        setAutomationActive(automationId, true, ctx),
    },
    {
      path: '/v1/automations/:automationId/deactivate',
      operationId: 'deactivateAutomation',
      summary: 'Deactivate an automation',
      description:
        'The counterpart to activation, so that activation is not a one-way door. Idempotent.',
      run: (automationId: string, ctx: RequestContext) =>
        setAutomationActive(automationId, false, ctx),
    },
  ] as const) {
    app.post(
      route.path,
      {
        onRequest: ORG_SCOPED_WRITE_HOOKS,
        schema: {
          operationId: route.operationId,
          summary: route.summary,
          description: route.description,
          tags: [TAG],
          headers: idempotencyKeyHeaderSchema,
          params: automationParamsSchema,
          response: { 200: automationSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { automationId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { automationId }, successStatus: 200 },
          () => route.run(automationId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<Automation>(result));
      },
    );
  }

  app.post(
    '/v1/automations/:automationId/run',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'runAutomation',
        summary: 'Fire an automation once, on demand',
        description:
          'Runs every action in order and returns what this one firing produced: the count of ' +
          'annotations written and work items enqueued (Q9). A retried call with the same ' +
          '`Idempotency-Key` replays the original `AutomationRunResult` rather than firing twice.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: automationParamsSchema,
        response: { 200: automationRunResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { automationId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'runAutomation', request: { automationId }, successStatus: 200 },
        () => runAutomation(automationId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<AutomationRunResult>(result));
    },
  );

  app.get(
    '/v1/work-items',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listWorkItems',
        summary: 'List work items',
        description: 'One page of work items, ordered by `(created_at, id)`, oldest first.',
        tags: [WORK_ITEM_TAG],
        querystring: listWorkItemsWireQuerySchema,
        response: { 200: workItemPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<WorkItemPage> => {
      const { status, automationId, limit, cursor } = request.query;
      return listWorkItems(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(status === undefined ? {} : { status }),
          ...(automationId === undefined ? {} : { automationId }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/work-items/:workItemId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getWorkItem',
        summary: 'One work item',
        tags: [WORK_ITEM_TAG],
        params: workItemParamsSchema,
        response: { 200: workItemSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<WorkItem> => getWorkItem(request.params.workItemId, getContext()),
  );

  app.post(
    '/v1/work-items/:workItemId/cancel',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'cancelWorkItem',
        summary: 'Cancel a work item',
        description:
          'Withdraws a queued or leased item so no agent picks it up (or finishes acting on it). ' +
          'Idempotent: an already-cancelled item is returned unchanged rather than refused.',
        tags: [WORK_ITEM_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: workItemParamsSchema,
        response: { 200: workItemSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { workItemId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'cancelWorkItem', request: { workItemId }, successStatus: 200 },
        () => cancelWorkItem(workItemId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<WorkItem>(result));
    },
  );
}
