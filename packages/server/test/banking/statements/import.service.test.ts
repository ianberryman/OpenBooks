import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreateBankStatementImportRequest } from '@openbooks/shared-types';

import type { StatementParseFn } from '../../../src/modules/banking/statements/service';
import {
  createStatementImportHandler,
  previewImport,
  registerStatementImportJob,
  startImport,
} from '../../../src/modules/banking/statements/service';
import type { StatementImportJob } from '../../../src/modules/banking/statements/job';
import { InProcessQueue, setQueueProvider } from '../../../src/providers';
import { uuidToBuffer } from '../../db';
import type { Scene } from '../support';
import {
  fakeParse,
  fileContent,
  importOf,
  lineKey,
  linesOf,
  sceneIn,
  silentLogger,
  throwingParse,
  useServiceDatabase,
  withContext,
  type FileRow,
} from '../support';

/**
 * The statement import service: dedupe, idempotent re-import, and the async path
 * (OB-078; ROADMAP D-42, D-47, D-49; acceptance E1, E10).
 *
 * The parser is faked (`fakeParse` reads a JSON "file"), so every test drives a
 * controlled `ParsedStatement` through the *real* dedupe, the *real* queue, and the
 * *real* persist — spec §11's "no mocks" holds for everything OB-078 owns; only the
 * format reading, which is OB-076/OB-077's, stands in.
 */
const db = useServiceDatabase();

let scene: Scene;

beforeEach(async () => {
  scene = await sceneIn(db);
});

afterEach(() => {
  setQueueProvider(undefined);
});

/** Installs a queue with the import handler registered, and returns it to drive. */
async function wire(parse: StatementParseFn = fakeParse): Promise<InProcessQueue> {
  const queue = new InProcessQueue(silentLogger);
  setQueueProvider(queue);
  await registerStatementImportJob(queue, { parse, logger: silentLogger });
  return queue;
}

function requestFor(content: string): CreateBankStatementImportRequest {
  return {
    bankAccountId: scene.bankAccountUuid,
    format: 'ofx',
    filename: 'statement.ofx',
    content,
  };
}

/** Starts an import and drives the queue to completion, returning the import id. */
async function importToCompletion(queue: InProcessQueue, content: string): Promise<string> {
  const started = await withContext(scene.ctx, () => startImport(requestFor(content), scene.ctx));
  await queue.settled();
  return started.id;
}

const coffee: FileRow = {
  postedDate: '2026-01-05',
  amount: -450n,
  description: 'COFFEE SHOP',
  counterparty: 'Cafe',
  bankReference: null,
};
const rent: FileRow = {
  postedDate: '2026-01-01',
  amount: -120000n,
  description: 'RENT',
  counterparty: 'Landlord',
  bankReference: 'FIT-RENT',
};
const salary: FileRow = {
  postedDate: '2026-01-25',
  amount: 300000n,
  description: 'SALARY',
  counterparty: 'Employer',
  bankReference: 'FIT-PAY',
};

describe('the import is asynchronous (D-47)', () => {
  it('writes the import queued and returns before any line exists', async () => {
    // A queue with no import handler: the job is dropped (and logged), so nothing
    // processes it and the queued row is observable without racing the handler.
    setQueueProvider(new InProcessQueue(silentLogger));

    const started = await withContext(scene.ctx, () =>
      startImport(requestFor(fileContent([rent, salary])), scene.ctx),
    );

    expect(started.status).toBe('queued');
    const record = await importOf(db.app, started.id);
    expect(record).toMatchObject({ status: 'queued', lines_read: null, lines_duplicate: null });
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(0);
  });

  it('parses, dedupes and completes when the worker runs the job (E10 path)', async () => {
    const queue = await wire();
    const content = fileContent([rent, salary, coffee], { closingBalance: 179550n });

    const id = await importToCompletion(queue, content);

    const record = await importOf(db.app, id);
    expect(record).toMatchObject({
      status: 'complete',
      lines_read: 3,
      lines_duplicate: 0,
      // The file's closing balance is a claim from outside, recorded at completion.
      closing_balance_minor: 179550n,
    });
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(3);
  });
});

describe('re-import is idempotent (E1)', () => {
  it('re-importing the same file collapses to the same lines', async () => {
    const queue = await wire();
    const content = fileContent([rent, salary, coffee]);

    const first = await importToCompletion(queue, content);
    const second = await importToCompletion(queue, content);

    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(3);
    // The first import owns every line; the second created nothing.
    expect(await importOf(db.app, first)).toMatchObject({ lines_read: 3, lines_duplicate: 0 });
    expect(await importOf(db.app, second)).toMatchObject({ lines_read: 3, lines_duplicate: 3 });
  });

  it('the file’s row order does not change the stored set', async () => {
    const queue = await wire();

    await importToCompletion(queue, fileContent([rent, salary, coffee]));
    const inOrder = (await linesOf(db.app, scene.bankAccountId)).map(lineKey).sort();

    // A second, independent account importing the same rows shuffled.
    const other = await sceneIn(db);
    const otherReq: CreateBankStatementImportRequest = {
      bankAccountId: other.bankAccountUuid,
      format: 'ofx',
      filename: 'statement.ofx',
      content: fileContent([coffee, rent, salary]),
    };
    await withContext(other.ctx, () => startImport(otherReq, other.ctx));
    await queue.settled();
    const shuffled = (await linesOf(db.app, other.bankAccountId)).map(lineKey).sort();

    expect(shuffled).toEqual(inOrder);
  });

  it('two genuinely identical transactions both survive, and stay two on re-import', async () => {
    const queue = await wire();
    // Same shop, same day, same amount, no bank reference: one fingerprint, two rows.
    const content = fileContent([coffee, { ...coffee }]);

    await importToCompletion(queue, content);
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(2);

    await importToCompletion(queue, content);
    const lines = await linesOf(db.app, scene.bankAccountId);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.occurrence_index).sort()).toEqual([0, 1]);
  });

  it('an overlapping partial re-upload adds only the genuinely new lines', async () => {
    const queue = await wire();
    const march = {
      ...salary,
      postedDate: '2026-01-15',
      description: 'MARCH',
      bankReference: 'M1',
    };
    const april = {
      ...salary,
      postedDate: '2026-01-16',
      description: 'APRIL',
      bankReference: 'A1',
    };

    await importToCompletion(queue, fileContent([rent, salary, coffee]));
    const second = await importToCompletion(queue, fileContent([salary, coffee, march, april]));

    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(5);
    // Of the four rows in the second file, salary and coffee were already present.
    expect(await importOf(db.app, second)).toMatchObject({ lines_read: 4, lines_duplicate: 2 });
  });
});

describe('re-running an interrupted import is safe (D-49)', () => {
  it('reprocessing the same job inserts no duplicate and recomputes the same counts', async () => {
    const queue = await wire();
    const content = fileContent([rent, salary, coffee]);
    const id = await importToCompletion(queue, content);

    const before = await linesOf(db.app, scene.bankAccountId);
    expect(before).toHaveLength(3);

    // Simulate a crash that left the import mid-flight: drop it back to queued with
    // its counts cleared (as chk_bsi_status requires), lines already inserted.
    await db.app
      .updateTable('bank_statement_imports')
      .set({ status: 'queued', lines_read: null, lines_duplicate: null })
      .where('id', '=', uuidToBuffer(id))
      .execute();

    // Re-run the job by hand — the crash-recovery path (a user re-uploading is the
    // same shape). The handler reprocesses because the import is no longer complete.
    const handler = createStatementImportHandler({ parse: fakeParse, logger: silentLogger });
    await handler(jobFor(id, content));

    const after = await linesOf(db.app, scene.bankAccountId);
    expect(after.map(lineKey).sort()).toEqual(before.map(lineKey).sort());
    expect(await importOf(db.app, id)).toMatchObject({
      status: 'complete',
      lines_read: 3,
      lines_duplicate: 0,
    });
  });

  it('re-running an already-complete import is a no-op', async () => {
    const queue = await wire();
    const content = fileContent([rent, salary]);
    const id = await importToCompletion(queue, content);

    const handler = createStatementImportHandler({ parse: fakeParse, logger: silentLogger });
    await handler(jobFor(id, content));

    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(2);
    expect(await importOf(db.app, id)).toMatchObject({ status: 'complete', lines_read: 2 });
  });
});

describe('a file that cannot be read fails the import, and writes no line', () => {
  it('records status failed with a reason', async () => {
    const queue = await wire(throwingParse('unbalanced OFX: <STMTRS> without <BANKACCTFROM>'));

    const id = await importToCompletion(queue, fileContent([rent]));

    const record = await importOf(db.app, id);
    expect(record?.status).toBe('failed');
    expect(record?.failure_reason).toContain('unbalanced OFX');
    expect(record?.lines_read).toBeNull();
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(0);
  });
});

describe('preview parses and dedupes without writing (OB-085)', () => {
  it('predicts new vs duplicate lines and marks the sample, writing nothing', async () => {
    const queue = await wire();
    await importToCompletion(queue, fileContent([rent, salary]));

    // rent and salary are already present; coffee is new.
    const preview = await withContext(scene.ctx, () =>
      previewImport(
        {
          bankAccountId: scene.bankAccountUuid,
          format: 'ofx',
          filename: 'x.ofx',
          content: fileContent([rent, salary, coffee]),
        },
        fakeParse,
        scene.ctx,
      ),
    );

    expect(preview.result).toEqual({ linesRead: 3, linesImported: 1, linesDuplicate: 2 });
    const duplicates = preview.sample.filter((line) => line.isDuplicate);
    expect(duplicates).toHaveLength(2);
    expect(preview.sample.find((line) => line.description === 'COFFEE SHOP')?.isDuplicate).toBe(
      false,
    );

    // Preview wrote nothing: the account still holds only the two imported lines.
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(2);
  });

  it('warns when the file’s account identifier disagrees, never refuses', async () => {
    const matched = await sceneIn(db, { externalAccountId: 'ACCT-1' });

    const same = await withContext(matched.ctx, () =>
      previewImport(
        {
          bankAccountId: matched.bankAccountUuid,
          format: 'ofx',
          filename: 'x.ofx',
          content: fileContent([rent], { externalAccountId: 'ACCT-1' }),
        },
        fakeParse,
        matched.ctx,
      ),
    );
    expect(same.externalAccountMatches).toBe(true);

    const different = await withContext(matched.ctx, () =>
      previewImport(
        {
          bankAccountId: matched.bankAccountUuid,
          format: 'ofx',
          filename: 'x.ofx',
          content: fileContent([rent], { externalAccountId: 'OTHER' }),
        },
        fakeParse,
        matched.ctx,
      ),
    );
    expect(different.externalAccountMatches).toBe(false);
    expect(different.externalAccountId).toBe('OTHER');
  });
});

function jobFor(importId: string, content: string): StatementImportJob {
  return {
    importId,
    bankAccountId: scene.bankAccountUuid,
    format: 'ofx',
    content,
    mapping: null,
    context: {
      requestId: scene.ctx.requestId,
      orgId: scene.ctx.orgId,
      userId: scene.ctx.userId,
      roleId: scene.ctx.roleId,
      actorType: scene.ctx.actorType,
      actorId: scene.ctx.actorId,
    },
  };
}
