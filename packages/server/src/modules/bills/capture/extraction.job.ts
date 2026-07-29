import type {
  ActorType,
  ExtractedBill,
  InvocationMode,
  QueueProvider,
} from '@openbooks/plugin-api';
import { fromMinorString, toMinorString, toMinorUnits } from '@openbooks/shared-types/money';
import { quantityFromString, quantityToString } from '@openbooks/shared-types/tax';

import type { TenantDatabase } from '../../../db';
import { tryUuidToBuffer } from '../../../db';
import type { Logger } from '../../../logging';
import { documentExtractionProvider, storageProvider } from '../../../providers';
import { namesMatch, normalizeText } from '../../banking/matching/scoring';
import { runAsAutomation } from '../../scheduling';

import type {
  DocumentCaptureRow,
  ExtractedFieldsPatch,
  VendorContactRow,
} from './capture.repository';
import {
  markCaptureExtracted,
  markCaptureFailed,
  orgScope,
  selectActiveVendorContacts,
  selectCaptureById,
} from './capture.repository';

/**
 * The document-extraction job: its queue name, its payload, and the worker's one
 * line of wiring (initiative O, OB-186/OB-188).
 *
 * `job.ts`'s convention in `banking/statements` and `invoicing/dunning` is a pure
 * leaf carrying only the queue name and the payload type, imported one-way by a
 * service or a worker that holds the handler. This file folds the handler in too,
 * because the pinned contract names the file this way and there is exactly one
 * caller of `documentExtractionProvider()` and `storageProvider()` in this
 * module — the handler below — so nothing is gained by splitting it into a
 * second file the way the statement import's larger `service.ts` earns its split.
 * `capture.service.ts` imports `DOCUMENT_EXTRACTION_QUEUE` and the payload type
 * from here to enqueue; nothing here imports `capture.service.ts`, so the
 * dependency stays one-way.
 */

export const DOCUMENT_EXTRACTION_QUEUE = 'bills.document-extraction';

/**
 * The provenance the job carries for correlation (`StatementImportJobContext`'s
 * shape). Unlike the statement import, the handler below does **not** rebuild a
 * `RequestContext` from this — it runs under `runAsAutomation(orgId, …)`, per the
 * pinned contract, so every write is attributed to the automation actor rather
 * than to whoever uploaded the document. The fields still travel so a failure log
 * can be joined back to the request that started it.
 */
export interface DocumentExtractionJobContext {
  readonly requestId: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly roleId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly invocationMode?: InvocationMode;
}

/** Carries the storage **key**, never the bytes — `statements/job.ts`'s reasoning applies verbatim. */
export interface DocumentExtractionJob {
  readonly captureId: string;
  readonly orgId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly context: DocumentExtractionJobContext;
}

export interface DocumentExtractionDeps {
  readonly logger: Logger;
}

/**
 * Waits for the capture row to become visible, bounded — `awaitImportVisible`'s
 * reason exactly: the row is inserted inside the request's idempotency
 * transaction and this job can be enqueued and consumed (in-process) before that
 * transaction commits.
 */
async function awaitCaptureVisible(
  db: TenantDatabase,
  id: Buffer,
): Promise<DocumentCaptureRow | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const row = await selectCaptureById(db, id);
    if (row !== undefined) return row;
    await delay(25);
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const FAILURE_REASON_MAX_LENGTH = 512;

/** A short, storable reason for the `failed` state (`extraction_error` is VARCHAR(512)). */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The document could not be extracted.';
  return message.length > FAILURE_REASON_MAX_LENGTH
    ? message.slice(0, FAILURE_REASON_MAX_LENGTH)
    : message;
}

/**
 * Re-parses every amount and quantity the provider returned through the shared
 * primitives before anything is stored.
 *
 * The wire schema (`documentCaptureSchema`) is applied to whatever `toDocumentCapture`
 * assembles from `extraction_json` on the way back out, so a malformed string here —
 * from a buggy adapter, never from a client — would otherwise surface as a 500 on
 * an ordinary `getCapture`, long after the job that wrote it has finished. Round-tripping
 * through `fromMinorString`/`quantityFromString` here means a bad value fails the
 * *job*, landing the capture in `failed` with a reason, which is the outcome D-13
 * and `resolveLines` (`ap-documents.service.ts`) both choose for money shaped wrong.
 */
function normalizeExtraction(extracted: ExtractedBill): ExtractedBill {
  return {
    vendorName: extracted.vendorName,
    issueDate: extracted.issueDate,
    reference: extracted.reference,
    totalMinor:
      extracted.totalMinor === null ? null : toMinorString(fromMinorString(extracted.totalMinor)),
    taxMinor:
      extracted.taxMinor === null ? null : toMinorString(fromMinorString(extracted.taxMinor)),
    lines: extracted.lines.map((line) => ({
      description: line.description,
      quantity: quantityToString(quantityFromString(line.quantity)),
      unitAmountMinor: toMinorString(fromMinorString(line.unitAmountMinor)),
    })),
  };
}

/** Exactly one active vendor matches, or `null` for a human to resolve (the pinned contract's rule). */
async function resolveVendorMatch(
  db: TenantDatabase,
  vendorName: string | null,
): Promise<Buffer | null> {
  if (vendorName === null) return null;
  const needle = normalizeText(vendorName);
  if (needle.length === 0) return null;

  const vendors: readonly VendorContactRow[] = await selectActiveVendorContacts(db);
  const matches = vendors.filter((vendor) =>
    namesMatch(needle, normalizeText(vendor.display_name)),
  );
  if (matches.length !== 1) return null;

  const [only] = matches;
  return only === undefined ? null : only.id;
}

function toExtractedPatch(
  extracted: ExtractedBill,
  matchedContactId: Buffer | null,
): ExtractedFieldsPatch {
  return {
    vendorName: extracted.vendorName,
    matchedContactId,
    issueDate: extracted.issueDate,
    reference: extracted.reference,
    totalMinor:
      extracted.totalMinor === null ? null : toMinorUnits(fromMinorString(extracted.totalMinor)),
    extractionJson: JSON.stringify(extracted),
  };
}

/**
 * The extraction handler, over any `DocumentExtractionDeps`.
 *
 * `documentExtractionProvider()` and `storageProvider()` are resolved here,
 * inside the handler, rather than injected — the pinned contract names them as
 * process-wide accessors and every existing job (`statements/service.ts`'s
 * `deps.parse`) injects only what a test needs to control, which for this job is
 * the logger; a test that needs a controlled extraction result installs a fake
 * provider through `setDocumentExtractionProvider` (the sanctioned seam) rather
 * than a second `deps` field.
 */
export function createDocumentExtractionHandler(
  deps: DocumentExtractionDeps,
): (job: DocumentExtractionJob) => Promise<void> {
  return (job) =>
    runAsAutomation(job.orgId, 'document-extraction', async (ctx) => {
      const db = orgScope(ctx);

      const id = tryUuidToBuffer(job.captureId);
      if (id === undefined) {
        deps.logger.warn(
          { captureId: job.captureId, requestId: job.context.requestId },
          'Extraction job carried a malformed capture id; skipping.',
        );
        return;
      }

      const row = await awaitCaptureVisible(db, id);
      if (row === undefined) {
        // Never became visible: rolled back, or the wrong scope. Nothing to do and
        // nothing to fail — `awaitImportVisible`'s reasoning (`statements/service.ts`).
        deps.logger.warn(
          { captureId: job.captureId, requestId: job.context.requestId },
          'Extraction job for an unknown capture; skipping.',
        );
        return;
      }
      if (row.status !== 'extracting') {
        // Already processed — a redelivered message or a re-run after a restart
        // (D-49). Re-running an already-settled job must be a no-op.
        return;
      }

      let extracted: ExtractedBill;
      try {
        const body = await storageProvider().get(job.storageKey);
        const raw = await documentExtractionProvider().extract({
          body,
          contentType: job.contentType,
        });
        extracted = normalizeExtraction(raw);
      } catch (error) {
        await markCaptureFailed(db, id, failureReason(error), new Date());
        deps.logger.warn(
          { captureId: job.captureId, requestId: job.context.requestId, err: error },
          'Document extraction failed.',
        );
        return;
      }

      const matchedContactId = await resolveVendorMatch(db, extracted.vendorName);
      await markCaptureExtracted(db, id, toExtractedPatch(extracted, matchedContactId), new Date());
    });
}

/**
 * Registers the extraction handler on a queue — the worker's (and, under the
 * in-process adapter, the api's) one line of wiring. `registerStatementImportJob`'s
 * shape exactly; event-driven rather than riding the daily tick (`registerDailyTask`
 * is for `recurring`/`dunning`, not this).
 */
export async function registerDocumentExtractionJob(
  queue: QueueProvider,
  deps: DocumentExtractionDeps,
): Promise<void> {
  await queue.subscribe(DOCUMENT_EXTRACTION_QUEUE, createDocumentExtractionHandler(deps));
}
