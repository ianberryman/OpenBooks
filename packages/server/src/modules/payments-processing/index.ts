/**
 * Payment-processor integration: connecting an org's own Stripe or Square, and
 * the D-82/D-104 clearing-account posting model a charge and a payout drive
 * (OB-147; ROADMAP D-82, D-83, D-101, D-103, D-104; migration
 * `0011_payment_processing`).
 *
 * ## Surface
 *
 * | Operation                                  | Permission            |
 * | ------------------------------------------- | ---------------------- |
 * | `connectProcessor(input, ctx)`               | `processing.write`    |
 * | `listProcessorConnections(ctx)`              | `processing.read`     |
 * | `getProcessorConnection(id, ctx)`            | `processing.read`     |
 * | `deactivateProcessorConnection(id, ctx)`     | `processing.write`    |
 * | `reactivateProcessorConnection(id, ctx)`     | `processing.write`    |
 * | `createCheckoutLink(input, ctx)`             | `processing.read` + `invoices.read` |
 * | `loadConnectionProvider(connectionId, ctx)`  | `processing.read`     |
 * | `recordProcessorCharge(input, ctx)`          | composed (see below)  |
 * | `recordProcessorPayout(input, ctx)`          | none — a cursor advance |
 *
 * `recordProcessorCharge` checks nothing of its own: it composes `recordPayment`
 * (`payments_received.write`), `createExternalRef`/`lookupExternalRef`
 * (`integrations.write`/`.read`), and `postJournal` (`journals.post`), each of
 * which enforces its own permission — the same design `payments.service.ts`'s
 * header argues for `approveInvoice`/`voidInvoice`. In practice every caller is
 * `runAsAutomation`'s Owner-role context (J3), which holds all of them.
 *
 * ## What lives here and what does not
 *
 * `connections.repository.ts` / `connections.service.ts` own `processor_connections`
 * end to end: connect, list, get, (de)activate, and building the
 * `PaymentProcessorProvider` a stored connection resolves to
 * (`loadConnectionProvider`, exported for the webhook/poll stream). `posting.service.ts`
 * owns the D-82 posting model — clearing a charge, and advancing the D-85 backstop
 * cursor on a payout.
 *
 * Not here: the webhook route and the poll job (OB-148), refunds and chargeback
 * coding (OB-149), the `/v1` routes and the connect-a-processor screen (OB-150,
 * OB-151), and the property/E2E suites (OB-152, OB-153) — all separate streams
 * that import this module rather than extend it. `processor_events` — the
 * webhook/poll event log and its own idempotency guard — is OB-148's table; this
 * module never reads or writes it.
 *
 * No routes live here, for the same reason `payments/index.ts` states of its own
 * module: transport is a later ticket's.
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
} from './connections.service';

export type {
  RecordProcessorChargeInput,
  RecordProcessorChargeResult,
  RecordProcessorPayoutInput,
  RecordProcessorPayoutResult,
} from './posting.service';
export { recordProcessorCharge, recordProcessorPayout } from './posting.service';
