/**
 * Payment-processor integration: connecting an org's own Stripe or Square, the
 * D-82/D-104 clearing-account posting model a charge and a payout drive
 * (OB-147), the webhook receiver and polling backstop (OB-148; D-85), and
 * refunds/lean chargeback coding (OB-149; D-84). ROADMAP D-82, D-83, D-84,
 * D-85, D-101, D-103, D-104; migration `0011_payment_processing`.
 *
 * ## Surface
 *
 * | Operation                                    | Permission            |
 * | --------------------------------------------- | ---------------------- |
 * | `connectProcessor(input, ctx)`                 | `processing.write`    |
 * | `listProcessorConnections(ctx)`                | `processing.read`     |
 * | `getProcessorConnection(id, ctx)`              | `processing.read`     |
 * | `deactivateProcessorConnection(id, ctx)`       | `processing.write`    |
 * | `reactivateProcessorConnection(id, ctx)`       | `processing.write`    |
 * | `resolveActiveConnectionForOrg(ctx)`           | `processing.read`     |
 * | `createCheckoutLink(input, ctx)`               | `processing.read` + `invoices.read` |
 * | `loadConnectionProvider(connectionId, ctx)`    | `processing.read`     |
 * | `recordProcessorCharge(input, ctx)`            | composed (see below)  |
 * | `recordProcessorPayout(input, ctx)`            | none — a cursor advance |
 * | `recordProcessorRefund(input, ctx)`            | composed (see below)  |
 * | `recordProcessorChargeback(input, ctx)`        | composed (see below)  |
 * | `handleProcessorWebhook(input, ctx)`           | composed (see below)  |
 * | `recordNormalizedEvent(...)`                   | composed (see below)  |
 * | `registerProcessorPollJob(queue, deps)`        | none — worker wiring  |
 *
 * `recordProcessorCharge`/`recordProcessorRefund`/`recordProcessorChargeback`
 * check nothing of their own: each composes `recordPayment`/`postJournal`
 * (`journals.post`) and `createExternalRef`/`lookupExternalRef`
 * (`integrations.write`/`.read`), every one of which enforces its own
 * permission — the same design `payments.service.ts`'s header argues for
 * `approveInvoice`/`voidInvoice`. In practice every caller is
 * `runAsAutomation`'s Owner-role context (J3), which holds all of them.
 *
 * ## What lives here and what does not
 *
 * `connections.repository.ts` / `connections.service.ts` own `processor_connections`
 * end to end: connect, list, get, (de)activate, and building the
 * `PaymentProcessorProvider` a stored connection resolves to
 * (`loadConnectionProvider`, used by the webhook/poll stream below).
 * `posting.service.ts` owns the D-82/D-84 posting model — clearing a charge,
 * refunding one, coding a chargeback, and advancing the D-85 backstop cursor on
 * a payout. `webhook.service.ts` owns the two-level idempotency (`processor_events`
 * event-level, `external_refs` object-level) and the dispatch by event kind;
 * `poll.job.ts` owns the D-85 daily backstop — redriving events the webhook
 * missed through the identical dedup path, and reconciling the clearing
 * account's ledger balance against the processor's own reported one.
 *
 * Not here: the `/v1` management routes and the connect-a-processor screen
 * (OB-150, OB-151), and the property/E2E suites (OB-152, OB-153) — separate
 * streams that import this module rather than extend it. The public webhook
 * route itself lives in `transport/routes/processing-webhook.ts` (transport
 * holds no business logic, spec §2.4) and calls only `handleProcessorWebhook`.
 */

export type { CreateCheckoutLinkInput } from './connections.service';
export {
  connectProcessor,
  createCheckoutLink,
  deactivateProcessorConnection,
  getProcessorConnection,
  listProcessorConnections,
  loadConnectionProvider,
  reactivateProcessorConnection,
  resolveActiveConnectionForOrg,
} from './connections.service';

export type {
  RecordProcessorChargebackInput,
  RecordProcessorChargebackResult,
  RecordProcessorChargeInput,
  RecordProcessorChargeResult,
  RecordProcessorPayoutInput,
  RecordProcessorPayoutResult,
  RecordProcessorRefundInput,
  RecordProcessorRefundResult,
} from './posting.service';
export {
  recordProcessorCharge,
  recordProcessorChargeback,
  recordProcessorPayout,
  recordProcessorRefund,
} from './posting.service';

export type { HandleWebhookInput, HandleWebhookResult } from './webhook.service';
export { handleProcessorWebhook, recordNormalizedEvent } from './webhook.service';

export { getPayoutSyncConfig, updatePayoutSyncConfig } from './payout-config.service';
export type { SyncPayoutInput, SyncPayoutResult } from './payout-sync.service';
export {
  getPayoutSync,
  listPayoutSyncs,
  postPayoutSync,
  skipPayoutSync,
  syncPayout,
} from './payout-sync.service';

export { PROCESSOR_POLL_QUEUE, registerProcessorPollJob } from './poll.job';
export type { ProcessorPollJobDeps } from './poll.job';
