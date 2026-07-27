import type { ActorType, InvocationMode } from '@openbooks/plugin-api';
import type { BankImportMappingDefinition, BankStatementFormat } from '@openbooks/shared-types';

/**
 * The statement import job: its queue name and its payload (OB-078; ROADMAP D-47,
 * D-49).
 *
 * A leaf on purpose — it imports nothing from the service — so both sides of the
 * seam can name the queue and the payload without a cycle: `startImport` enqueues,
 * the worker's handler consumes.
 */

/**
 * One queue, named for what rides it. A string rather than an enum because the queue
 * abstraction (`QueueProvider`) keys on a name, and there is one banking job today —
 * a registry of one would be shape built against a single use (spec §8).
 */
export const STATEMENT_IMPORT_QUEUE = 'banking.statement-import';

/**
 * The provenance the job carries so the worker runs under the identity that started
 * the import.
 *
 * Spec §4 keeps scope out of parameters, and this is the sanctioned way it crosses an
 * async boundary: the fields `createRequestContext` needs, captured at enqueue and
 * rebuilt into a real scope in the handler, so the lines and the completion are
 * attributed to the uploader and the provenance chain is preserved rather than
 * re-invented (`deriveContext`'s argument, applied across the queue).
 */
export interface StatementImportJobContext {
  readonly requestId: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly roleId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly invocationMode?: InvocationMode;
}

/**
 * Everything the worker needs to import the file, and nothing it can derive.
 *
 * `content` is the file text inline. That is right for the in-process adapter, where
 * the payload never leaves the process; the hosted (SQS) path — which has a 256 KB
 * message limit — would put the bytes in the storage provider and carry a handle
 * here instead, and that is the one field that changes when the SQS adapter lands.
 *
 * `mapping` is the *resolved* reading: the inline mapping, or a saved one already read
 * back from its id at enqueue, or null for OFX. Resolving it on the request side keeps
 * the worker from having to re-read a mapping row that may have changed since.
 */
export interface StatementImportJob {
  readonly importId: string;
  readonly bankAccountId: string;
  readonly format: BankStatementFormat;
  readonly content: string;
  readonly mapping: BankImportMappingDefinition | null;
  readonly context: StatementImportJobContext;
}
