import type { QueueProvider } from '@openbooks/plugin-api';
import type {
  BankImportMappingDefinition,
  BankStatementFormat,
  BankStatementImportPreview,
  BankStatementLineDraft,
  CreateBankStatementImportRequest,
  PreviewBankStatementImportRequest,
} from '@openbooks/shared-types';
import {
  BANK_IMPORT_PREVIEW_ROWS,
  createBankStatementImportRequestSchema,
  previewBankStatementImportRequestSchema,
} from '@openbooks/shared-types';
import { createHash } from 'node:crypto';

import type { RequestContext } from '../../../context';
import { createRequestContext, getContext, runInContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { bufferToUuid, newUuidBuffer, tryUuidToBuffer } from '../../../db';
import { PreconditionFailedError, ValidationError, assertFound, parseInput } from '../../../errors';
import type { Logger } from '../../../logging';
import { queueProvider } from '../../../providers';
import { requirePermission } from '../../permissions';
import type { ParsedStatement, ParsedStatementRow } from '../parser';

import type { FingerprintedRow } from './fingerprint';
import { fingerprintRows } from './fingerprint';
import type { StatementImportJob, StatementImportJobContext } from './job';
import { STATEMENT_IMPORT_QUEUE } from './job';
import type { NewLineRow } from './repository';
import {
  BANK_ACCOUNT_RESOURCE,
  IMPORT_MAPPING_RESOURCE,
  STATEMENT_IMPORT_RESOURCE,
  countLinesByImport,
  existingFingerprintCounts,
  insertLinesIgnore,
  insertQueuedImport,
  markImportComplete,
  markImportFailed,
  markImportProcessing,
  orgScope,
  selectBankAccount,
  selectImportStatus,
  selectMappingDefinition,
} from './repository';

/**
 * The statement import service (OB-078; ROADMAP D-41, D-42, D-47; acceptance E1, E10).
 *
 * The three entry points, and the seam between them:
 *
 *  - `previewImport` parses and dedupes **without writing**, to populate the
 *    column-mapping screen (OB-085). Synchronous, because it runs in the request.
 *  - `startImport` writes the import row `queued` and enqueues a job carrying the
 *    file, then returns. Parsing a 5,000-line statement does not belong in a request
 *    (D-47), so the request ends before a single line is read (E10).
 *  - `processStatementImport` is the worker's half: parse → dedupe → insert the new
 *    lines → set `complete` with the counts, or `failed` with a reason.
 *
 * ## Everything here is safe to run twice, on purpose (D-49)
 *
 * The in-process queue does not survive a restart, so an interrupted import is
 * re-run — in practice by the user re-uploading the same file, which E1 makes
 * harmless. So `processStatementImport` skips an import that is already `complete`,
 * and the persist step is idempotent on `(fingerprint, occurrence_index)`: a
 * duplicated run inserts no new line and recomputes the same counts. The dedupe is
 * therefore also the crash-recovery story.
 *
 * ## The parser is injected, not imported here (the wave-1 seam)
 *
 * This module never imports the concrete CSV/OFX parsers — the barrel `../index.ts`
 * dispatches to them, and it is the one file that does. `previewImport` and the job
 * handler take a `StatementParseFn` instead, so the dedupe and the async lifecycle
 * are testable against a controlled `ParsedStatement` while the sibling parsers
 * (OB-076, OB-077) are still being written.
 */

/**
 * Bytes in, bank facts out. The service's view of the format dispatch (`../parser.ts`),
 * so that neither this file nor its tests reach the concrete parsers.
 */
export type StatementParseFn = (args: {
  readonly format: BankStatementFormat;
  readonly raw: Uint8Array;
  readonly mapping: BankImportMappingDefinition | null;
}) => ParsedStatement;

/** Everything the worker's import handler needs, injected (D-07's seam shape). */
export interface StatementImportDeps {
  readonly parse: StatementParseFn;
  readonly logger: Logger;
}

/** What `startImport` returns: a handle to poll, not a finished import. */
export interface StartedImport {
  readonly id: string;
  readonly bankAccountId: string;
  readonly status: 'queued';
}

// ---------------------------------------------------------------------------
// Preview — synchronous, writes nothing
// ---------------------------------------------------------------------------

/**
 * What importing this file would do, without doing it.
 *
 * ## It parses the whole file, and the counts are exact because of that
 *
 * A row cap here would make `linesRead` a lie, and the duplicate prediction with it —
 * the one number a preview exists to show. The file is already bounded by
 * `BANK_STATEMENT_CONTENT_MAX_LENGTH` on the way in (`imports.ts`), and that bound,
 * not a row limit, is what protects the request; only the *sample* is capped, at
 * `BANK_IMPORT_PREVIEW_ROWS`, because a screen needs to see a mistake, not a page of
 * data.
 *
 * `linesDuplicate` is a prediction, not a promise: another import landing between the
 * preview and the real upload changes what is already present, which is why the real
 * import reports its own counts rather than a client reusing these.
 */
export async function previewImport(
  input: PreviewBankStatementImportRequest,
  parse: StatementParseFn,
  ctx: RequestContext = getContext('previewImport()'),
): Promise<BankStatementImportPreview> {
  const request = parseInput(previewBankStatementImportRequestSchema, input);
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  const bankAccount = assertFound(
    await selectBankAccount(
      db,
      assertFound(tryUuidToBuffer(request.bankAccountId), BANK_ACCOUNT_RESOURCE),
    ),
    BANK_ACCOUNT_RESOURCE,
  );

  const mapping = await resolveReading(db, request);
  const parsed = parse({ format: request.format, raw: encode(request.content), mapping });

  const fingerprinted = fingerprintRows(parsed.rows);
  const existing = await existingFingerprintCounts(
    db,
    bankAccount.id,
    distinctFingerprints(fingerprinted),
  );

  const isDuplicate = (line: FingerprintedRow): boolean =>
    line.occurrenceIndex < (existing.get(line.fingerprint) ?? 0);

  const linesRead = fingerprinted.length;
  const linesImported = fingerprinted.filter((line) => !isDuplicate(line)).length;

  const sample = [...fingerprinted]
    .sort((a, b) => a.fileIndex - b.fileIndex)
    .slice(0, BANK_IMPORT_PREVIEW_ROWS)
    .map((line) => toDraft(line, isDuplicate(line)));

  const range = statementDateRange(parsed.rows);
  const bankExternalId = bankAccount.external_account_id;

  return {
    format: request.format,
    // The parser seam (`ParsedStatement`) yields bank facts, not the raw header row,
    // so a header-aware preview is OB-085's with OB-076's CSV reader. Null here means
    // "not carried", which is also the honest answer for OFX and a headerless CSV.
    headers: null,
    result: {
      linesRead,
      linesImported,
      linesDuplicate: linesRead - linesImported,
    },
    sample,
    statementStart: range.start,
    statementEnd: range.end,
    statementClosingBalance:
      parsed.closingBalance === null ? null : parsed.closingBalance.toString(),
    externalAccountId: parsed.externalAccountId,
    externalAccountMatches:
      parsed.externalAccountId === null || bankExternalId === null
        ? null
        : parsed.externalAccountId === bankExternalId,
  };
}

// ---------------------------------------------------------------------------
// Start — writes the queued row, enqueues the job, returns
// ---------------------------------------------------------------------------

export async function startImport(
  input: CreateBankStatementImportRequest,
  ctx: RequestContext = getContext('startImport()'),
): Promise<StartedImport> {
  const request = parseInput(createBankStatementImportRequestSchema, input);
  await requirePermission(ctx, 'banking.import');

  const importedBy = requireImportingUser(ctx);
  const db = orgScope(ctx);

  const bankAccountId = assertFound(tryUuidToBuffer(request.bankAccountId), BANK_ACCOUNT_RESOURCE);
  const bankAccount = assertFound(
    await selectBankAccount(db, bankAccountId),
    BANK_ACCOUNT_RESOURCE,
  );
  if (bankAccount.is_active !== 1) {
    throw new PreconditionFailedError(
      'bank_account_archived',
      'This bank account has been deactivated, so a statement cannot be imported into it. ' +
        'Reactivate it first, or import into the account that is still in use.',
    );
  }

  const mapping = await resolveReading(db, request);
  // `saveMappingAs` persists the inline mapping under a name, and that is OB-076's —
  // it owns `bank_import_mappings` writes and the "saved column mappings" feature. So
  // `mapping_id` records a *named* mapping the caller chose (resolved by id), and an
  // inline mapping is recorded as null here; the row still parses correctly because
  // the resolved definition travels in the job.
  const mappingId = isPresent(request.mappingId)
    ? (tryUuidToBuffer(request.mappingId) ?? null)
    : null;

  const content = request.content;
  const importId = newUuidBuffer();

  await insertQueuedImport(db, {
    id: importId,
    bankAccountId,
    format: request.format,
    filename: request.filename,
    fileHash: sha256Hex(content),
    mappingId,
    importedByUserId: importedBy,
  });

  // The queue is the process-wide seam (`queueProvider()`), the same shape
  // `outboundEmail()` is: a test installs an `InProcessQueue` it also holds, so it can
  // drive the job and watch the lines land. Enqueuing is where the request ends and
  // the 5,000-line parse moves off it (D-47).
  const job: StatementImportJob = {
    importId: bufferToUuid(importId),
    bankAccountId: request.bankAccountId,
    format: request.format,
    content,
    mapping,
    context: jobContextOf(ctx),
  };
  await queueProvider().enqueue(STATEMENT_IMPORT_QUEUE, job);

  return { id: bufferToUuid(importId), bankAccountId: request.bankAccountId, status: 'queued' };
}

// ---------------------------------------------------------------------------
// Process — the worker's half
// ---------------------------------------------------------------------------

/** The import handler, over any `ParsedStatement` source and logger. */
export function createStatementImportHandler(
  deps: StatementImportDeps,
): (job: StatementImportJob) => Promise<void> {
  return (job) => processStatementImport(job, deps);
}

/**
 * Registers the import handler on a queue — the worker's one line of wiring.
 *
 * The worker calls this with the real parser dispatch and blocks; a test calls it
 * with a controlled parser on an `InProcessQueue` it drives. Either way the handler
 * that `startImport` enqueues to is the same code.
 */
export async function registerStatementImportJob(
  queue: QueueProvider,
  deps: StatementImportDeps,
): Promise<void> {
  await queue.subscribe(STATEMENT_IMPORT_QUEUE, createStatementImportHandler(deps));
}

/**
 * Parse → dedupe → insert → complete, under the context that started the import.
 *
 * The provenance chain is preserved: the job carries who started it, and the work
 * runs in a context reconstructed from that, so the lines and the completion are
 * attributed to the uploader rather than to a nameless worker.
 */
export async function processStatementImport(
  job: StatementImportJob,
  deps: StatementImportDeps,
): Promise<void> {
  await runInContext(contextFromJob(job.context), async () => {
    const db = orgScope(getContext('processStatementImport()'));
    const importId = assertImportId(job.importId);

    const status = await selectImportStatus(db, importId);
    if (status === undefined) {
      // The row is not visible in this org scope — it never existed here, or was
      // addressed with the wrong context. Nothing to do and nothing to fail; a
      // completed import that already ran is the common benign case and is caught
      // by the branch below.
      deps.logger.warn({ importId: job.importId }, 'Import job for an unknown import; skipping.');
      return;
    }
    if (status.status === 'complete') {
      // Already done. Re-running a completed import must be a no-op (D-49).
      return;
    }

    await markImportProcessing(db, importId);

    let parsed: ParsedStatement;
    try {
      parsed = deps.parse({
        format: job.format,
        raw: encode(job.content),
        mapping: job.mapping,
      });
    } catch (error) {
      await markImportFailed(db, importId, failureReason(error));
      deps.logger.warn(
        { importId: job.importId, err: error },
        'Statement import failed while parsing.',
      );
      return;
    }

    const bankAccountId = assertBankAccountId(job.bankAccountId);
    try {
      await persistLines(db, importId, bankAccountId, parsed);
    } catch (error) {
      await markImportFailed(db, importId, failureReason(error));
      deps.logger.error(
        { importId: job.importId, err: error },
        'Statement import failed while persisting lines.',
      );
    }
  });
}

/**
 * The dedupe and the write, in one transaction (E1).
 *
 * `insert max(0, k − n) rows at indexes n … k−1` (D-42): a row is new iff its
 * occurrence index is at least the count this account already holds for its
 * fingerprint. `INSERT IGNORE` makes that idempotent under a re-run or a concurrent
 * overlapping import, and `linesImported` is read back from `import_id` so it is the
 * count of what this import actually contributed rather than what this call planned.
 * The lines and the `complete` status commit together.
 */
async function persistLines(
  db: TenantDatabase,
  importId: Buffer,
  bankAccountId: Buffer,
  parsed: ParsedStatement,
): Promise<void> {
  const fingerprinted = fingerprintRows(parsed.rows);

  await db.transaction(async (trx) => {
    const existing = await existingFingerprintCounts(
      trx,
      bankAccountId,
      distinctFingerprints(fingerprinted),
    );

    const planned: NewLineRow[] = fingerprinted
      .filter((line) => line.occurrenceIndex >= (existing.get(line.fingerprint) ?? 0))
      .map((line) => ({
        id: newUuidBuffer(),
        bankAccountId,
        importId,
        postedDate: line.row.postedDate,
        valueDate: line.row.valueDate,
        description: line.row.description,
        counterparty: line.row.counterparty,
        amountMinor: line.row.amount,
        bankReference: line.row.bankReference,
        fingerprint: line.fingerprint,
        occurrenceIndex: line.occurrenceIndex,
      }));

    await insertLinesIgnore(trx, planned);

    const linesRead = fingerprinted.length;
    const linesImported = await countLinesByImport(trx, importId);

    await markImportComplete(trx, importId, {
      linesRead,
      linesDuplicate: linesRead - linesImported,
      closingBalance: parsed.closingBalance,
      externalAccountId: parsed.externalAccountId,
    });
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the request's chosen reading into a mapping definition, or null for OFX.
 *
 * The schema's `hasExactlyOneReading` refinement has already guaranteed a CSV carries
 * exactly one of `mappingId`/`mapping` and an OFX carries neither, so this only has to
 * turn a named mapping back into a definition — a 404 (E9) if the id names no row this
 * org can see.
 */
async function resolveReading(
  db: TenantDatabase,
  request: {
    readonly mappingId?: string | null | undefined;
    readonly mapping?: BankImportMappingDefinition | null | undefined;
  },
): Promise<BankImportMappingDefinition | null> {
  if (isPresent(request.mapping)) return request.mapping;
  if (!isPresent(request.mappingId)) return null;

  const id = assertFound(tryUuidToBuffer(request.mappingId), IMPORT_MAPPING_RESOURCE);
  return assertFound(await selectMappingDefinition(db, id), IMPORT_MAPPING_RESOURCE);
}

/** Neither absent (`undefined`) nor explicitly cleared (`null`). */
function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function toDraft(line: FingerprintedRow, isDuplicate: boolean): BankStatementLineDraft {
  return {
    postedDate: line.row.postedDate,
    valueDate: line.row.valueDate,
    amount: line.row.amount.toString(),
    description: line.row.description,
    counterparty: line.row.counterparty,
    bankReference: line.row.bankReference,
    occurrenceIndex: line.occurrenceIndex,
    fingerprint: line.fingerprint,
    isDuplicate,
  };
}

function distinctFingerprints(lines: readonly FingerprintedRow[]): string[] {
  return [...new Set(lines.map((line) => line.fingerprint))];
}

function statementDateRange(rows: readonly ParsedStatementRow[]): {
  readonly start: string | null;
  readonly end: string | null;
} {
  // ISO `YYYY-MM-DD` sorts chronologically as a string, so min/max are string
  // comparisons and no Date is constructed — a calendar date has no moment (D-13's
  // sibling, the DATE-as-string codegen override).
  let start: string | null = null;
  let end: string | null = null;
  for (const row of rows) {
    if (start === null || row.postedDate < start) start = row.postedDate;
    if (end === null || row.postedDate > end) end = row.postedDate;
  }
  return { start, end };
}

const FAILURE_REASON_MAX_LENGTH = 512;

/** A short, storable reason for the `failed` state (`failure_reason` is VARCHAR(512)). */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The statement could not be imported.';
  return message.length > FAILURE_REASON_MAX_LENGTH
    ? message.slice(0, FAILURE_REASON_MAX_LENGTH)
    : message;
}

/**
 * The user an import is recorded against.
 *
 * `bank_statement_imports.imported_by_user_id` is `NOT NULL` and references `users`,
 * so a caller with no user identity — an automation acting outside a member session —
 * has nothing to record one as. `requireRecordingUser` in payments refuses the same
 * way for the same reason, and this follows it.
 */
function requireImportingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('An import is recorded by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot import a statement. An import is the ' +
          'one point where data from outside enters, and it is attributed to the person who did it.',
      },
    ]);
  }
  return userId;
}

function jobContextOf(ctx: RequestContext): StatementImportJobContext {
  return {
    requestId: ctx.requestId,
    orgId: ctx.orgId,
    userId: ctx.userId,
    roleId: ctx.roleId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
  };
}

function contextFromJob(context: StatementImportJobContext): RequestContext {
  return createRequestContext({
    requestId: context.requestId,
    orgId: context.orgId,
    userId: context.userId,
    roleId: context.roleId,
    actorType: context.actorType,
    actorId: context.actorId,
    ...(context.invocationMode === undefined ? {} : { invocationMode: context.invocationMode }),
  });
}

function assertImportId(importId: string): Buffer {
  return assertFound(tryUuidToBuffer(importId), STATEMENT_IMPORT_RESOURCE);
}

function assertBankAccountId(bankAccountId: string): Buffer {
  return assertFound(tryUuidToBuffer(bankAccountId), BANK_ACCOUNT_RESOURCE);
}

function encode(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
