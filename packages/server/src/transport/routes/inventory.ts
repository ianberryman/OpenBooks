import {
  createInventoryAdjustmentRequestSchema,
  inventoryAdjustmentSchema,
  inventoryItemLedgerSchema,
  inventoryValuationQuerySchema,
  inventoryValuationSchema,
  reorderAlertsSchema,
} from '@openbooks/shared-types';
import type { InventoryAdjustment } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  getInventoryItemLedger,
  getInventoryValuation,
  getReorderAlerts,
  postInventoryAdjustment,
} from '../../modules/inventory';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
  wireValue,
} from './support';

/**
 * Tracked inventory & perpetual COGS (initiative INVENTORY, OB-224).
 *
 * Three surfaces, all read/adjust — inventory posts its GL effects as a side effect
 * of approving an invoice or a bill (the AR/AP hooks), not through a route here:
 *
 *  - the **valuation** report (`inventory.read`), a querystring report like the
 *    balance sheet, whose total ties to the inventory-asset account (spec §11);
 *  - the **reorder alerts** view (`inventory.read`);
 *  - the **stock adjustment** document (`inventory.write`), the one write — it posts
 *    a Dr/Cr between the inventory-asset accounts and the org's nominated shrinkage
 *    account plus one movement per line (D-INV-6).
 *
 * A handler maps arguments and nothing else (spec §2.4): no `requirePermission` (each
 * service calls its own, service-layer only, spec §5), and `requireOrgScope` below is
 * org-scope only, not a permission check.
 */

const TAG = 'inventory';

export function registerInventoryRoutes(app: App): void {
  app.get(
    '/v1/reports/inventory-valuation',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getInventoryValuation',
        summary: 'Inventory valuation',
        description:
          'On-hand quantity and value for every tracked item as at `asOf` (default today), with a ' +
          'total that ties to the inventory-asset account balance (the subledger-agreement ' +
          'invariant, spec §11). Each row carries the derived moving-average unit cost and a ' +
          'reorder flag.',
        tags: [TAG],
        querystring: inventoryValuationQuerySchema,
        response: { 200: inventoryValuationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { asOf } = request.query;
      return wireValue(
        await getInventoryValuation({ ...(asOf === undefined ? {} : { asOf }) }, getContext()),
      );
    },
  );

  app.get(
    '/v1/inventory/items/:itemId/movements',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getInventoryItemLedger',
        summary: 'A tracked item’s movement ledger',
        description:
          'Every stock movement for one item — receipts, sales, adjustments, true-ups and ' +
          'reversals — oldest first, each with the running on-hand quantity and value it leaves, ' +
          'and a link to its source document and journal. The append-only audit trail behind the ' +
          'item’s current on-hand.',
        tags: [TAG],
        params: z.strictObject({ itemId: z.uuid() }),
        response: { 200: inventoryItemLedgerSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => wireValue(await getInventoryItemLedger(request.params.itemId, getContext())),
  );

  app.get(
    '/v1/inventory/reorder-alerts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getReorderAlerts',
        summary: 'Reorder alerts',
        description:
          'Every tracked item whose on-hand quantity is at or below its reorder point. A thin ' +
          'read over the same fold the valuation report uses.',
        tags: [TAG],
        response: { 200: reorderAlertsSchema, ...ERROR_RESPONSES },
      },
    },
    async () => wireValue(await getReorderAlerts(getContext())),
  );

  app.post(
    '/v1/inventory/adjustments',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createInventoryAdjustment',
        summary: 'Post a stock adjustment',
        description:
          'Posts a count or write-off: a Dr/Cr between the inventory-asset accounts and the org’s ' +
          'nominated shrinkage account, plus one movement per line, costed on the server at each ' +
          'item’s moving average (D-INV-6). A negative quantity is shrinkage; a positive one is ' +
          'found stock.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createInventoryAdjustmentRequestSchema,
        response: { 201: inventoryAdjustmentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createInventoryAdjustment', request: request.body, successStatus: 201 },
        () => postInventoryAdjustment(request.body, ctx),
      );

      const adjustment = idempotentBody<InventoryAdjustment>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/inventory/adjustments/${adjustment.id}`)
        .send(adjustment);
    },
  );
}
