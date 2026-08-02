/**
 * @openbooks/plugin-api — the internal module contract (spec §8).
 *
 * Every module is written against this package and nothing else in the tree;
 * plugin-api itself depends on no other workspace package, enforced by
 * dependency-cruiser (`plugin-api-is-a-leaf`).
 *
 * Unstable at 0.x, and not as a formality. The surface here was designed against
 * essentially one module — the ledger kernel — so spec §8's own conclusion
 * applies: it will not be right until four to six modules have stressed it, and
 * M2 (chart of accounts, contacts, dimensions) and M3 (subledgers, payment
 * application) are where the mistakes will surface. Expect churn; do not defend
 * the first design. The package stays private and unpublished until then.
 */

export { ACTOR_TYPES, INVOCATION_MODES, isActorType, isInvocationMode } from './actor';
export type { ActorProvenance, ActorType, InvocationMode } from './actor';

export type { OperationContext } from './context';

export type { CalendarDate, Instant, MinorUnits } from './primitives';

export { JOURNAL_SIDES, POSTING_SERVICE } from './posting';
export type {
  JournalLineInput,
  JournalSide,
  PostJournalInput,
  PostedJournal,
  PostedJournalLine,
  PostingService,
  ReverseJournalInput,
} from './posting';

export type {
  BillApprovedV1,
  BillApprovedV1Payload,
  CreditNoteApprovedV1,
  CreditNoteApprovedV1Payload,
  EventBus,
  EventEnvelope,
  EventHandler,
  EventOf,
  InvoiceApprovedV1,
  InvoiceApprovedV1Payload,
  JournalPostedV1,
  JournalPostedV1Payload,
  JournalReversedV1,
  JournalReversedV1Payload,
  OpenBooksEvent,
  OpenBooksEventInput,
  OpenBooksEventName,
  PaymentRecordedV1,
  PaymentRecordedV1Payload,
  ReconciliationFinalisedV1,
  ReconciliationFinalisedV1Payload,
} from './events';

export type { ServiceRegistry, ServiceToken } from './registry';

export type { ModuleMigration } from './migrations';

export type { PermissionDefinition, PermissionKey } from './permissions';

export { TOOL_EXECUTION_MODES } from './mcp';
export type {
  McpToolContext,
  McpToolDefinition,
  McpToolOutcome,
  ToolExecutionMode,
  ToolProposal,
} from './mcp';

export { HTTP_METHODS } from './routes';
export type { HttpMethod, RouteDefinition } from './routes';

export type {
  BankFeedAccountRef,
  BankFeedProvider,
  BankFeedSource,
  BankFeedTransaction,
  DocumentExtractionProvider,
  EmailProvider,
  ExtractedBill,
  ExtractedBillLine,
  Form1099AdapterDeps,
  Form1099Provider,
  Form1099ProviderKind,
  InboundEmailAttachment,
  InboundEmailMessage,
  InboundMailProvider,
  NormalizedProcessorEvent,
  PaymentProcessorProvider,
  PayoutBreakdown,
  PayoutBreakdownResult,
  PayoutCategoryAmount,
  PayoutReportResult,
  PayoutReportingCategory,
  ProcessorCheckoutLink,
  ProcessorKind,
  Providers,
  QueueProvider,
  SecretsProvider,
  StorageProvider,
  Ten99FilingStatus,
  Ten99FormData,
  Ten99SubmitResult,
  Ten99Transmission,
} from './providers';

export type { EventSubscription, ModuleDefinition, ModuleHost } from './module';

/**
 * Lets a host refuse a module built against an incompatible contract. Meaningful
 * only once this package is published; inside the monorepo every module compiles
 * against the same source.
 */
export const PLUGIN_API_VERSION = '0.0.0' as const;
