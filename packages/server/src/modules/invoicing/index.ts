/**
 * Invoicing automation — recurring invoices (OB-128) and dunning (OB-129), Phase 4.
 *
 * Both are standing instructions the daily tick (OB-127) drives: a recurring template calls
 * `createInvoice`/`approveInvoice` unattended, a dunning policy sends a reminder for an overdue
 * invoice. Each shares the `invoices.*` permissions rather than owning its own — whoever may
 * raise or send an invoice by hand may automate it — and each exposes the worker's side of its
 * seam (`register*Job` + its queue), the one call the worker adds to consume the tick's fan-out,
 * restating `registerStatementImportJob`'s shape. Transport lives in `transport/routes/`.
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

export * from './dunning';
