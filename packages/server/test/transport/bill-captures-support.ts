import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import type { Logger } from '../../src/logging';
import { registerDocumentExtractionJob } from '../../src/modules/bills';
import {
  createDeterministicExtractionProvider,
  createDevInboundMailProvider,
  InProcessQueue,
  setDocumentExtractionProvider,
  setInboundMailProvider,
  setQueueProvider,
} from '../../src/providers';

/**
 * Provider seams for the OCR bill-capture transport suite
 * (`bill-captures.http.test.ts`), a deliberate duplicate of
 * `test/bills/capture/support.ts`'s choices — that file's own header explains
 * why: another suite's fixtures, kept separate so this one does not break when
 * that one is edited.
 *
 * `useV1App()` (`v1-support.ts`) already installs storage and outbound email for
 * the whole `/v1` surface. What a capture additionally needs, and no other `/v1`
 * route touches, is the document-extraction adapter, the inbound-mail parser,
 * and a queue that actually runs the extraction job in-process rather than
 * leaving it enqueued.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

/**
 * Installs the deterministic extraction adapter and the `dev` inbound-mail
 * adapter for the whole file, and a fresh `InProcessQueue` — with the
 * extraction job registered — before every test, exactly as
 * `test/bills/capture/support.ts#useExtractionQueue` does: one queue instance
 * per test, so a job left pending by one test cannot bleed into the next.
 */
export function useCaptureProviders(): () => InProcessQueue {
  beforeAll(() => {
    setDocumentExtractionProvider(createDeterministicExtractionProvider());
    setInboundMailProvider(createDevInboundMailProvider());
  });

  afterAll(() => {
    setDocumentExtractionProvider(undefined);
    setInboundMailProvider(undefined);
  });

  let current: InProcessQueue | undefined;

  beforeEach(async () => {
    const installed = new InProcessQueue(silentLogger);
    setQueueProvider(installed);
    await registerDocumentExtractionJob(installed, { logger: silentLogger });
    current = installed;
  });

  afterEach(() => {
    setQueueProvider(undefined);
    current = undefined;
  });

  return () => {
    if (current === undefined) {
      throw new Error("useCaptureProviders()'s beforeEach has not run yet.");
    }
    return current;
  };
}

/** One line item in the deterministic extraction format (`providers/extraction/deterministic.ts`). */
export interface DeterministicLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmountMinor: string;
}

export interface DeterministicFields {
  readonly vendor?: string;
  readonly date?: string;
  readonly reference?: string;
  readonly tax?: string;
  readonly total?: string;
  readonly lines?: readonly DeterministicLine[];
}

/** Renders the `key: value` / `line: a | b | c` text the deterministic adapter parses. */
export function deterministicDocument(fields: DeterministicFields): string {
  const rows: string[] = [];
  if (fields.vendor !== undefined) rows.push(`vendor: ${fields.vendor}`);
  if (fields.date !== undefined) rows.push(`date: ${fields.date}`);
  if (fields.reference !== undefined) rows.push(`reference: ${fields.reference}`);
  if (fields.tax !== undefined) rows.push(`tax: ${fields.tax}`);
  if (fields.total !== undefined) rows.push(`total: ${fields.total}`);
  for (const line of fields.lines ?? []) {
    rows.push(`line: ${line.description} | ${line.quantity} | ${line.unitAmountMinor}`);
  }
  return rows.join('\n');
}
