/**
 * Recurring invoices: template CRUD and the materialisation engine (OB-128;
 * ROADMAP D-75, D-76).
 *
 * | Operation                                    | Permission        |
 * | --------------------------------------------- | ----------------- |
 * | `createRecurringInvoiceTemplate(input, ctx)`   | `invoices.write`  |
 * | `getRecurringInvoiceTemplate(id, ctx)`         | `invoices.read`   |
 * | `listRecurringInvoiceTemplates(query, ctx)`    | `invoices.read`   |
 * | `updateRecurringInvoiceTemplate(id, input, ctx)` | `invoices.write` |
 * | `deactivateRecurringInvoiceTemplate(id, ctx)`  | `invoices.write`  |
 *
 * Templates share `invoices.*` rather than owning a permission of their own: a
 * template is nothing but a standing instruction to call `createInvoice` (and,
 * for an auto-approving one, `approveInvoice`) unattended, so whoever may raise
 * an invoice by hand may also automate raising it.
 *
 * `registerRecurringJob` and `RECURRING_SWEEP_QUEUE` are the worker's side of the
 * seam (`engine.ts`, `job.ts`): the daily tick (OB-127) enqueues onto the queue
 * this module names, and `registerRecurringJob` is the one call the worker adds
 * to consume it — `registerStatementImportJob`'s shape, restated here.
 *
 * There are no routes here. Transport is `transport/routes/recurring-invoices.ts`.
 */

export {
  createRecurringInvoiceTemplate,
  deactivateRecurringInvoiceTemplate,
  getRecurringInvoiceTemplate,
  listRecurringInvoiceTemplates,
  updateRecurringInvoiceTemplate,
} from './recurring/recurring.service';

export { advance, registerRecurringJob } from './recurring/engine';
export type { RecurringEngineDeps } from './recurring/engine';

export { RECURRING_SWEEP_QUEUE } from './recurring/job';
export type { RecurringSweepPayload } from './recurring/job';
