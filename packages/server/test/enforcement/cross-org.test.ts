import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';

import { runInContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import { getAccount } from '../../src/modules/accounts';
import { reverseJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID, resolveOrgMembership } from '../../src/modules/orgs';
import { getPeriod } from '../../src/modules/periods';
import { generateOpenApiDocument } from '../../src/transport';
import type { App } from '../../src/transport';
import { authorizedWrite, createAccount, registerUser, useV1App } from '../transport/v1-support';
import { contextFor } from './support';

/**
 * **Acceptance A7 — a cross-org read returns nothing and does not leak existence** —
 * as one matrix over every surface that takes a resource id.
 *
 * A7's failure mode is not a single missing check, it is *one* surface out of step
 * with the others: a resource whose route answers `403`, or `404` with a different
 * body, or echoes the id it was asked about, is an oracle for the existence of another
 * tenant's objects. Whether a system has that oracle is a property of the whole
 * surface, so it is asserted as a whole here rather than resource by resource.
 * `test/transport/v1.test.ts` makes the claim for `GET /v1/accounts/{id}` and
 * `test/ledger/posting.test.ts` makes it for accounts and journals at the service
 * layer; those are not rewritten, they are subsumed — the point of consolidating is
 * that a resource type added without a row here is visible, which is what
 * `covers every operation that takes a resource id` below enforces.
 *
 * ## What "does not leak existence" is taken to mean
 *
 * Byte-identical, not merely equal in status. Two `404`s whose bodies differ, or whose
 * `content-type` differs, still distinguish "not yours" from "never existed" to anyone
 * who diffs them — and `resolveOrgMembership` says exactly this about the org
 * switcher, which would otherwise enumerate every tenant in the system. So each row
 * compares the raw body string, the content type, and asserts the real id appears
 * nowhere in the response.
 */
const harness = useV1App();

/** A syntactically valid id that belongs to nobody. Fixed, so a failure is reproducible. */
const NOWHERE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

interface Scene {
  readonly stranger: Awaited<ReturnType<typeof registerUser>>;
  readonly owner: Awaited<ReturnType<typeof registerUser>>;
  readonly accountId: string;
  readonly periodId: string;
  readonly journalId: string;
}

/**
 * Two orgs, and one of every resource type in the first.
 *
 * Built once inside each test rather than in a `beforeAll`, because the harness
 * truncates before every test — and registration hashes a password with Argon2, which
 * is the dominant cost in this file, so the matrix runs as one test over many rows
 * instead of many tests over one row each.
 */
async function scene(app: App): Promise<Scene> {
  const owner = await registerUser(app, { email: 'a7-owner@example.invalid', orgName: 'Owner' });
  const stranger = await registerUser(app, {
    email: 'a7-stranger@example.invalid',
    orgName: 'Stranger',
  });

  const accountId = await createAccount(app, owner, {
    code: '1000',
    name: 'Cash',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenueId = await createAccount(app, owner, {
    code: '4000',
    name: 'Sales',
    type: 'revenue',
    normalBalance: 'credit',
  });

  const year = await app.inject({
    method: 'POST',
    url: '/v1/fiscal-years',
    headers: authorizedWrite(owner, 'a7-year'),
    payload: { fiscalYear: 2026 },
  });
  const periodId = year.json<{ periods: { id: string }[] }>().periods[0]?.id;

  const posted = await app.inject({
    method: 'POST',
    url: '/v1/journals',
    headers: authorizedWrite(owner, 'a7-journal'),
    payload: {
      date: '2026-03-31',
      lines: [
        { accountId, side: 'debit', amount: '150000' },
        { accountId: revenueId, side: 'credit', amount: '150000' },
      ],
    },
  });
  const journalId = posted.json<{ journalId: string }>().journalId;

  if (periodId === undefined) throw new Error(`fiscal year setup failed: ${year.body}`);
  if (posted.statusCode !== 201) throw new Error(`journal setup failed: ${posted.body}`);

  return { owner, stranger, accountId, periodId, journalId };
}

/**
 * One row of the matrix: an operation, and how a resource id reaches it.
 *
 * Keyed by `operationId` rather than by method and path so the coverage check below can
 * compare this table against the published OpenAPI document directly — the same
 * identifier the generated client (OB-024) names its methods after.
 */
interface Surface {
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** `%s` is replaced by the id under test. */
  readonly path: string;
  readonly id: (scene: Scene) => string;
  /** A body, with `%s` replaced the same way. Absent for GET and DELETE. */
  readonly payload?: (id: string) => Record<string, unknown>;
}

/**
 * Ordered so the control pass — the owner calling each of these on their own
 * resources — can run straight through without a row invalidating the next: rename,
 * deactivate, and reactivate all leave the account in place, and `deleteAccount` comes
 * after them (and is refused, because the account carries postings, which is still not
 * a `404`). The leak pass is order-independent, since every row answers the same way.
 */
const SURFACES: readonly Surface[] = [
  { operationId: 'getAccount', method: 'GET', path: '/v1/accounts/%s', id: (s) => s.accountId },
  {
    operationId: 'updateAccount',
    method: 'PATCH',
    path: '/v1/accounts/%s',
    id: (s) => s.accountId,
    payload: () => ({ name: 'Renamed' }),
  },
  {
    operationId: 'deactivateAccount',
    method: 'POST',
    path: '/v1/accounts/%s/deactivate',
    id: (s) => s.accountId,
  },
  {
    operationId: 'reactivateAccount',
    method: 'POST',
    path: '/v1/accounts/%s/reactivate',
    id: (s) => s.accountId,
  },
  {
    operationId: 'deleteAccount',
    method: 'DELETE',
    path: '/v1/accounts/%s',
    id: (s) => s.accountId,
  },
  {
    operationId: 'closeFiscalPeriod',
    method: 'POST',
    path: '/v1/fiscal-periods/%s/close',
    id: (s) => s.periodId,
  },
  {
    operationId: 'reopenFiscalPeriod',
    method: 'POST',
    path: '/v1/fiscal-periods/%s/reopen',
    id: (s) => s.periodId,
  },
  {
    operationId: 'reverseJournal',
    method: 'POST',
    path: '/v1/journals/%s/reverse',
    id: (s) => s.journalId,
    payload: () => ({ date: '2026-04-30' }),
  },
  {
    /**
     * The one row whose id travels in the body rather than the path, which is why the
     * coverage check below names it explicitly: a body-carried id is no less an
     * existence oracle, and this is the surface an org switcher would use to walk every
     * tenant in the system.
     */
    operationId: 'switchActiveOrg',
    method: 'POST',
    path: '/v1/orgs/active',
    id: (s) => s.owner.orgId,
    payload: (id) => ({ orgId: id }),
  },
];

/** What every row must report. Deviations are the leak. */
interface Verdict {
  readonly crossOrg: number;
  readonly nonexistent: number;
  readonly identicalBody: boolean;
  readonly identicalContentType: boolean;
  readonly echoesId: boolean;
  /**
   * The control, and it is not optional: a row whose path is misspelled answers Fastify's
   * own `404` to both requests, with identical bodies and no echoed id, and passes every
   * other field in this record while testing nothing. Asserting that the *owner* does not
   * get a `404` is what makes the stranger's `404` a statement about ownership.
   */
  readonly ownerGetsNotFound: boolean;
}

const SEALED: Verdict = {
  crossOrg: 404,
  nonexistent: 404,
  identicalBody: true,
  identicalContentType: true,
  echoesId: false,
  ownerGetsNotFound: false,
};

async function ask(
  app: App,
  session: Awaited<ReturnType<typeof registerUser>>,
  surface: Surface,
  id: string,
  key: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: surface.method,
    url: surface.path.replace('%s', id),
    // Every write here is idempotency-guarded, and a distinct key per request is
    // required: the same key with a different body is an `idempotency_key_conflict`,
    // which would replace the answer under test with a different one.
    headers: authorizedWrite(session, key),
    ...(surface.payload === undefined ? {} : { payload: surface.payload(id) }),
  });
}

describe('A7 across every surface that takes a resource id', () => {
  it('answers a cross-org id exactly as it answers one that never existed', async () => {
    const app = harness.app();
    const built = await scene(app);

    const leaks = new Map<string, Omit<Verdict, 'ownerGetsNotFound'>>();
    for (const surface of SURFACES) {
      const real = surface.id(built);
      const crossOrg = await ask(
        app,
        built.stranger,
        surface,
        real,
        `a7-cross-${surface.operationId}`,
      );
      const nonexistent = await ask(
        app,
        built.stranger,
        surface,
        NOWHERE,
        `a7-none-${surface.operationId}`,
      );

      leaks.set(surface.operationId, {
        crossOrg: crossOrg.statusCode,
        nonexistent: nonexistent.statusCode,
        identicalBody: crossOrg.body === nonexistent.body,
        identicalContentType:
          crossOrg.headers['content-type'] === nonexistent.headers['content-type'],
        echoesId: crossOrg.body.includes(real),
      });
    }

    // The control pass, last because it mutates the owner's own data. Run after the
    // leak pass so nothing it changes can influence the answers above.
    const verdicts: Record<string, Verdict> = {};
    for (const surface of SURFACES) {
      const owned = await ask(
        app,
        built.owner,
        surface,
        surface.id(built),
        `a7-owner-${surface.operationId}`,
      );
      verdicts[surface.operationId] = {
        ...(leaks.get(surface.operationId) as Omit<Verdict, 'ownerGetsNotFound'>),
        ownerGetsNotFound: owned.statusCode === 404,
      };
    }

    // One assertion over the whole matrix: a failure names the operation that leaks and
    // shows that the others do not, which is the information needed to fix it.
    expect(verdicts).toEqual(
      Object.fromEntries(SURFACES.map((surface) => [surface.operationId, SEALED])),
    );
  });

  /**
   * The converse. Without it the matrix above is only as complete as whoever last
   * added a route remembered to make it.
   *
   * Compared against the *generated* OpenAPI document rather than a hand-kept list,
   * because that document is derived from the registered routes — so a new
   * `/v1/{thing}/{id}` route appears here the moment it is registered, and this test
   * names it as uncovered before it can ship as a leak.
   */
  it('covers every operation that takes a resource id', async () => {
    const document = JSON.parse(await generateOpenApiDocument(harness.app())) as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };

    const templated = Object.entries(document.paths)
      .filter(([path]) => path.includes('{'))
      .flatMap(([, item]) => Object.values(item).map((operation) => operation.operationId))
      .sort();

    const covered = SURFACES.map((surface) => surface.operationId).sort();

    // `switchActiveOrg` is in the matrix but not in `templated`: its id is in the body,
    // so no path template names it. Subtracted here rather than special-cased in the
    // table, so the equality below stays a plain statement about path-templated
    // operations.
    expect(covered.filter((operationId) => operationId !== 'switchActiveOrg')).toEqual(templated);
    expect(covered).toContain('switchActiveOrg');
  });
});

/**
 * The same claim one layer down, for the reads that have no route.
 *
 * `getPeriod` is exported from the periods module and is not reachable over HTTP in M1
 * — journal and period *reads* are M2's general-ledger surface — so the matrix above
 * cannot see it, and it is exactly the kind of function a new route will be built on.
 * `getAccount`, `reverseJournal`, and `resolveOrgMembership` are included even though
 * two of them are already covered by `test/ledger/posting.test.ts`, because the value
 * of a matrix is that it is complete: a fifth resource type with no row is obvious
 * here and would not be obvious spread across four files.
 *
 * Compared through `toWireError`, which is what decides the response body for every
 * transport — so equality here is equality on the wire, for HTTP today and for MCP in
 * M5.
 */
describe('A7 at the service layer, including the reads with no route', () => {
  it('gives cross-org and nonexistent ids the same wire error', async () => {
    const app = harness.app();
    const built = await scene(app);
    const ctx = contextFor(built.stranger.orgId, OWNER_ROLE_ID, built.stranger.userId);

    const reads: readonly {
      readonly resource: string;
      readonly read: (id: string) => Promise<unknown>;
    }[] = [
      { resource: 'account', read: (id) => getAccount(id, ctx) },
      { resource: 'fiscal_period', read: (id) => getPeriod({ periodId: id }) },
      {
        resource: 'journal',
        read: (id) =>
          reverseJournal(
            { journalId: id, date: '2026-04-30', actorType: 'user', actorId: ctx.actorId },
            ctx,
          ),
      },
      { resource: 'org', read: (id) => resolveOrgMembership(built.stranger.userId, id) },
    ];

    const ids: Record<string, string> = {
      account: built.accountId,
      fiscal_period: built.periodId,
      journal: built.journalId,
      org: built.owner.orgId,
    };

    const verdicts: Record<string, unknown> = {};
    for (const { resource, read } of reads) {
      const attempt = async (id: string): Promise<unknown> =>
        runInContext(ctx, () => read(id)).then(
          () => 'did not throw',
          (error: unknown) => toWireError(error),
        );

      const crossOrg = await attempt(ids[resource] as string);
      const nonexistent = await attempt(NOWHERE);

      verdicts[resource] = {
        crossOrg,
        // Serialized before comparing, because the claim is that the two are
        // indistinguishable *on the wire* — which is a claim about the bytes, not about
        // two error objects being the same object.
        matchesNonexistent: JSON.stringify(crossOrg) === JSON.stringify(nonexistent),
      };
    }

    expect(verdicts).toEqual(
      Object.fromEntries(
        Object.keys(ids).map((resource) => [
          resource,
          {
            // The `resource` name in `details` is the *asked-about kind*, never the
            // asked-about object, so it carries no existence information — and having
            // it differ per resource is what makes each pair's equality meaningful
            // rather than an artefact of one shared message.
            crossOrg: {
              code: 'not_found',
              status: 404,
              message: `No such ${resource}.`,
              details: { resource },
            },
            matchesNonexistent: true,
          },
        ]),
      ),
    );
  });
});
