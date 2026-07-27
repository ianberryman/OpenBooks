import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { uuidToBuffer } from '../../src/db';
import { toWireError } from '../../src/errors';
import {
  CHART_TEMPLATE_IDS,
  createAccount,
  listChartTemplates,
  updateAccount,
} from '../../src/modules/accounts';
import { createContact } from '../../src/modules/contacts';
import {
  createDimension,
  createDimensionValue,
  setJournalLineDimensions,
} from '../../src/modules/dimensions';
import { createDraft, listDrafts, updateDraft } from '../../src/modules/drafts';
import { postJournal } from '../../src/modules/ledger';
import { changeMemberRole, inviteMember } from '../../src/modules/members';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { getBalanceSheet, getGeneralLedger, getProfitAndLoss } from '../../src/modules/reports';
import { generateOpenApiDocument } from '../../src/transport';
import { newUuid } from '../db';
import { captureEmail } from '../members/support';
import { useServiceDatabase } from '../permissions/support';
import { buildTestApp } from '../transport/harness';
import { contextFor } from './support';

/**
 * **B11 / A7 — the ids that travel in a body or a query, not in a path.**
 *
 * `cross-org.test.ts` holds the A7 line for every operation addressed by
 * `/v1/{thing}/{id}`, derived from the path templates in the generated OpenAPI
 * document. This file is the complement, and the complement is the half that is
 * easy to miss: a *reference* — the parent an account is filed under, the contact a
 * draft line is with, the dimension a report is sliced by, the role a member is
 * moved to — is every bit as much an existence oracle as a path parameter, and it
 * has no `{brace}` in a route to make it visible.
 *
 * The coverage check below closes that by the same mechanism, one level deeper: it
 * walks the document's request bodies and query parameters for anything named like
 * an id, and requires each to be a row here or an entry in `EXEMPT` with a reason.
 * A new `POST /v1/things` whose body names a `contactId` fails this file before it
 * can ship as a leak.
 *
 * ## What "the same answer" is taken to mean
 *
 * `toWireError` output, compared as bytes, exactly as
 * `A7 at the service layer` does. Status codes are the weakest possible form of the
 * claim — two `404`s that differ in their `details` still tell an enumerator which
 * ids are real — and comparing what the error serializer produces is comparing what
 * every transport will send, HTTP today and MCP in M5.
 */
const db = useServiceDatabase();

captureEmail();

/** A syntactically valid id that belongs to nobody. Fixed, so a failure reproduces. */
const NOWHERE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const DATE = '2026-01-15';

/** One org's resources, as seen by whoever owns them. */
interface Org {
  readonly ctx: RequestContext;
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly accountId: string;
  readonly revenueId: string;
  readonly contactId: string;
  readonly dimensionId: string;
  readonly dimensionValueId: string;
  readonly draftId: string;
  readonly journalLineId: string;
  /** A custom role in this org, which no other org may assign. */
  readonly customRoleId: string;
}

interface Scene {
  readonly caller: Org;
  readonly stranger: Org;
}

async function org(label: string): Promise<Org> {
  const record = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: record.id, userId: user.id });

  const period = await db.factories.fiscalPeriod({ orgId: record.id });
  const cash = await db.factories.account({
    orgId: record.id,
    code: '1000',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenue = await db.factories.account({
    orgId: record.id,
    code: '4000',
    type: 'revenue',
    normalBalance: 'credit',
  });

  const ctx = contextFor(record.uuid, OWNER_ROLE_ID, user.uuid);

  const posted = await runInContext(ctx, () =>
    postJournal(
      {
        date: period.startDate,
        actorType: 'user',
        actorId: user.uuid,
        lines: [
          { accountId: cash.uuid, side: 'debit', amount: 150000n },
          { accountId: revenue.uuid, side: 'credit', amount: 150000n },
        ],
      },
      ctx,
    ),
  );
  const line = posted.lines[0];
  if (line === undefined) throw new Error(`${label} setup posted no lines`);

  const contact = await runInContext(ctx, () => createContact({ displayName: 'Acme' }, ctx));
  const dimension = await runInContext(ctx, () =>
    createDimension({ code: 'DEPT', name: 'Department' }, ctx),
  );
  const value = await runInContext(ctx, () =>
    createDimensionValue(dimension.id, { code: 'SALES', name: 'Sales' }, ctx),
  );
  const draft = await runInContext(ctx, () => createDraft({ entryDate: period.startDate }, ctx));

  /**
   * A custom role, inserted directly because spec §5 defers the role editor to v2 —
   * there is no API that creates one. It is here because `roles` is the one table
   * `tenantDb` deliberately does not scope (its `org_id` is nullable and NULL means a
   * shared system role), so the org predicate is written by hand in two repositories,
   * and a hand-written predicate is one somebody can drop. `permissions.repository.ts`
   * says what dropping it costs: "a role id becomes a cross-tenant capability".
   */
  const customRoleId = newUuid();
  await db.migrator
    .insertInto('roles')
    .values({
      id: uuidToBuffer(customRoleId),
      org_id: record.id,
      code: `custom-${customRoleId.slice(0, 8)}`,
      name: 'Custom',
      description: 'A custom role, for the cross-tenant role-id assertion.',
      is_system: 0,
    })
    .execute();

  return {
    ctx,
    orgUuid: record.uuid,
    orgId: record.id,
    userUuid: user.uuid,
    accountId: cash.uuid,
    revenueId: revenue.uuid,
    contactId: contact.id,
    dimensionId: dimension.id,
    dimensionValueId: value.id,
    draftId: draft.id,
    journalLineId: line.lineId,
    customRoleId,
  };
}

/**
 * Removed rather than left behind: `roles` is a seeded table and the harness never
 * truncates it, so a custom role outlives its org and every later test in the
 * container.
 */
async function dropCustomRoles(scene: Scene): Promise<void> {
  const ids = [scene.caller.customRoleId, scene.stranger.customRoleId].map((id) =>
    uuidToBuffer(id),
  );

  // The `inviteMember` control issues a real invitation against the caller's own
  // custom role, and `fk_org_invites_role` is `ON DELETE RESTRICT` — correctly, since
  // an invitation naming a deleted role could not be accepted.
  await db.migrator.deleteFrom('org_invites').where('role_id', 'in', ids).execute();

  await db.migrator.deleteFrom('roles').where('id', 'in', ids).execute();
}

async function scene(): Promise<Scene> {
  return { caller: await org('caller'), stranger: await org('stranger') };
}

/**
 * One reference: an operation, the field an id reaches it through, and how to reach
 * it with an arbitrary id.
 *
 * `operationId` is null for a reference the wire does not carry yet. Both of them
 * are lines on `postJournal`: `JournalLineInput` grew a contact and its tags with
 * OB-059, and `JournalLineRequestInput` — the wire shape — has not. They are asserted
 * anyway, because M5's MCP tools reach this service without going through the route
 * schema, so "no route exposes it" is not a reason the id cannot arrive.
 */
interface Reference {
  readonly operationId: string | null;
  readonly field: string;
  /** `id` is the id under test; `nonce` disambiguates rows that create something. */
  readonly reach: (id: string, scene: Scene, nonce: string) => Promise<unknown>;
}

const REFERENCES: readonly Reference[] = [
  {
    operationId: 'createAccount',
    field: 'parentAccountId',
    reach: (id, s, nonce) =>
      createAccount(
        {
          code: `70${nonce}`,
          name: 'Child',
          type: 'asset',
          normalBalance: 'debit',
          parentAccountId: id,
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateAccount',
    field: 'parentAccountId',
    reach: (id, s) => updateAccount(s.caller.revenueId, { parentAccountId: id }, s.caller.ctx),
  },
  {
    operationId: 'createDraft',
    field: 'accountId',
    reach: (id, s) =>
      createDraft(
        { entryDate: DATE, lines: [{ accountId: id, side: 'debit', amount: '100' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createDraft',
    field: 'contactId',
    reach: (id, s) =>
      createDraft(
        {
          entryDate: DATE,
          lines: [{ accountId: s.caller.accountId, side: 'debit', amount: '100', contactId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createDraft',
    field: 'dimensionValueIds',
    reach: (id, s) =>
      createDraft(
        {
          entryDate: DATE,
          lines: [
            {
              accountId: s.caller.accountId,
              side: 'debit',
              amount: '100',
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateDraft',
    field: 'accountId',
    reach: (id, s) =>
      updateDraft(
        s.caller.draftId,
        { lines: [{ accountId: id, side: 'debit', amount: '100' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateDraft',
    field: 'contactId',
    reach: (id, s) =>
      updateDraft(
        s.caller.draftId,
        {
          lines: [{ accountId: s.caller.accountId, side: 'debit', amount: '100', contactId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateDraft',
    field: 'dimensionValueIds',
    reach: (id, s) =>
      updateDraft(
        s.caller.draftId,
        {
          lines: [
            {
              accountId: s.caller.accountId,
              side: 'debit',
              amount: '100',
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'setJournalLineDimensions',
    field: 'valueIds',
    reach: (id, s) =>
      setJournalLineDimensions(s.caller.journalLineId, { valueIds: [id] }, s.caller.ctx),
  },
  {
    operationId: 'postJournal',
    field: 'accountId',
    reach: (id, s) =>
      postJournal(
        {
          date: DATE,
          actorType: 'user',
          actorId: s.caller.userUuid,
          lines: [
            { accountId: id, side: 'debit', amount: 100n },
            { accountId: s.caller.revenueId, side: 'credit', amount: 100n },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: null,
    field: 'postJournal.lines.contactId',
    reach: (id, s) =>
      postJournal(
        {
          date: DATE,
          actorType: 'user',
          actorId: s.caller.userUuid,
          lines: [
            { accountId: s.caller.accountId, side: 'debit', amount: 100n, contactId: id },
            { accountId: s.caller.revenueId, side: 'credit', amount: 100n },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: null,
    field: 'postJournal.lines.dimensionValueIds',
    reach: (id, s) =>
      postJournal(
        {
          date: DATE,
          actorType: 'user',
          actorId: s.caller.userUuid,
          lines: [
            {
              accountId: s.caller.accountId,
              side: 'debit',
              amount: 100n,
              dimensionValueIds: [id],
            },
            { accountId: s.caller.revenueId, side: 'credit', amount: 100n },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'changeMemberRole',
    field: 'roleId',
    reach: (id, s) => changeMemberRole({ userId: s.caller.userUuid, roleId: id }, s.caller.ctx),
  },
  {
    operationId: 'inviteMember',
    field: 'roleId',
    reach: (id, s, nonce) =>
      inviteMember({ email: `x${nonce}@openbooks.test`, roleId: id }, s.caller.ctx),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'accountId',
    reach: (id, s) => getGeneralLedger({ accountId: id }, s.caller.ctx),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'contactId',
    reach: (id, s) =>
      getGeneralLedger({ accountId: s.caller.accountId, contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'dimensions.dimensionId',
    reach: (id, s) =>
      getGeneralLedger(
        {
          accountId: s.caller.accountId,
          dimensions: [{ dimensionId: id, includeUnassigned: true }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'dimensions.valueIds',
    reach: (id, s) =>
      getGeneralLedger(
        {
          accountId: s.caller.accountId,
          dimensions: [{ dimensionId: s.caller.dimensionId, valueIds: [id] }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'contactId',
    reach: (id, s) => getProfitAndLoss({ contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'dimensions.dimensionId',
    reach: (id, s) =>
      getProfitAndLoss(
        { dimensions: [{ dimensionId: id, includeUnassigned: true }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'dimensions.valueIds',
    reach: (id, s) =>
      getProfitAndLoss(
        { dimensions: [{ dimensionId: s.caller.dimensionId, valueIds: [id] }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'groupBy',
    reach: (id, s) => getProfitAndLoss({ groupBy: id }, s.caller.ctx),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'contactId',
    reach: (id, s) => getBalanceSheet({ asOf: DATE, contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'dimensions.dimensionId',
    reach: (id, s) =>
      getBalanceSheet(
        { asOf: DATE, dimensions: [{ dimensionId: id, includeUnassigned: true }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'dimensions.valueIds',
    reach: (id, s) =>
      getBalanceSheet(
        { asOf: DATE, dimensions: [{ dimensionId: s.caller.dimensionId, valueIds: [id] }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'groupBy',
    reach: (id, s) => getBalanceSheet({ asOf: DATE, groupBy: id }, s.caller.ctx),
  },
];

/** The id in the stranger's org that each row is asked about. */
function crossOrgId(reference: Reference, s: Scene): string {
  const stranger = s.stranger;
  switch (reference.field) {
    case 'parentAccountId':
    case 'accountId':
      return stranger.accountId;
    case 'contactId':
    case 'postJournal.lines.contactId':
      return stranger.contactId;
    case 'dimensionValueIds':
    case 'valueIds':
    case 'postJournal.lines.dimensionValueIds':
      return stranger.dimensionValueId;
    case 'dimensions.dimensionId':
    case 'groupBy':
      return stranger.dimensionId;
    case 'dimensions.valueIds':
      return stranger.dimensionValueId;
    case 'roleId':
      return stranger.customRoleId;
    default:
      throw new Error(`no cross-org id defined for ${reference.field}`);
  }
}

/**
 * Query parameters that carry ids under a name no `…Id` pattern can see.
 *
 * The three reports take their dimension slice as a structured filter, JSON-encoded
 * into one parameter (`src/transport/routes/reports.ts` argues why), so `dimensions`
 * holds a `dimensionId` and a list of `valueIds` and `groupBy` holds a bare
 * dimension id. Listed by hand because a pattern cannot find them — which is the
 * whole reason they are the references most likely to be forgotten.
 */
const STRUCTURED_ID_PARAMS: readonly string[] = [
  'getBalanceSheet.dimensions.dimensionId',
  'getBalanceSheet.dimensions.valueIds',
  'getBalanceSheet.groupBy',
  'getGeneralLedger.dimensions.dimensionId',
  'getGeneralLedger.dimensions.valueIds',
  'getProfitAndLoss.dimensions.dimensionId',
  'getProfitAndLoss.dimensions.valueIds',
  'getProfitAndLoss.groupBy',
];

/**
 * References that are deliberately not rows here, each with the reason.
 *
 * An exemption is a claim that no cross-org id exists for the field, or that the
 * field is covered elsewhere — never that it was inconvenient.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // The chart templates are process constants (`CHART_TEMPLATES`), identical in every
  // org, so there is no per-org template and no cross-org id to ask about. Asserted
  // as such by `chart templates are the same in every org` below.
  'applyChartTemplate.templateId': 'a process constant, not a tenant row',
  'createOrg.chartTemplateId': 'a process constant, not a tenant row',
  'register.chartTemplateId': 'a process constant, not a tenant row',
  // The invite token is the credential; the caller is not a member of the org yet, so
  // there is no membership from which a cross-org read could be made. Covered by
  // `test/members/invites.service.test.ts`.
  'acceptInvite.orgId': 'reached by token, before any membership exists',
  // Already a row in `cross-org.test.ts` — the one there whose id travels in the body.
  'switchActiveOrg.orgId': 'covered by cross-org.test.ts',
  // A filter, not a lookup: see `a cross-org filter value is not an oracle` below.
  'listDrafts.createdByUserId': 'a filter over the caller’s own org, asserted separately',
};

/** What every row must report. Anything else is the leak. */
interface Verdict {
  readonly status: number;
  readonly code: string;
  readonly matchesNonexistent: boolean;
  readonly echoesId: boolean;
  /** The control: the caller's *own* id through the same field must not 404. */
  readonly ownIdIsNotFound: boolean;
}

const SEALED = {
  status: 404,
  code: 'not_found',
  matchesNonexistent: true,
  echoesId: false,
  ownIdIsNotFound: false,
} as const satisfies Verdict;

/** The id in the caller's own org, for the control pass. */
function ownId(reference: Reference, s: Scene): string {
  return crossOrgId(reference, { caller: s.caller, stranger: s.caller });
}

async function attempt(
  reference: Reference,
  s: Scene,
  id: string,
  nonce: string,
): Promise<unknown> {
  return runInContext(s.caller.ctx, () => reference.reach(id, s, nonce)).then(
    () => 'did not throw',
    (error: unknown) => toWireError(error),
  );
}

const key = (reference: Reference): string =>
  reference.operationId === null ? reference.field : `${reference.operationId}.${reference.field}`;

describe('B11 — a cross-org id in a body or a query answers as a nonexistent one', () => {
  it('gives every reference the same wire error for both', async () => {
    const s = await scene();
    try {
      const verdicts: Record<string, unknown> = {};
      for (const [index, reference] of REFERENCES.entries()) {
        const real = crossOrgId(reference, s);
        const cross = await attempt(reference, s, real, `c${String(index)}`);
        const nowhere = await attempt(reference, s, NOWHERE, `n${String(index)}`);
        const own = await attempt(reference, s, ownId(reference, s), `o${String(index)}`);

        const wire = cross as { status?: number; code?: string };
        verdicts[key(reference)] = {
          status: wire.status ?? 0,
          code: wire.code ?? 'did not throw',
          // Serialized before comparing, because the claim is about the bytes a
          // caller receives and not about two error objects being one object.
          matchesNonexistent: JSON.stringify(cross) === JSON.stringify(nowhere),
          echoesId: JSON.stringify(cross).includes(real),
          ownIdIsNotFound:
            typeof own === 'object' && own !== null && (own as { status?: number }).status === 404,
        };
      }

      expect(verdicts).toEqual(
        Object.fromEntries(REFERENCES.map((reference) => [key(reference), SEALED])),
      );
    } finally {
      await dropCustomRoles(s);
    }
  });

  /**
   * The converse, by the mechanism `cross-org.test.ts` established for path
   * parameters: derived from the generated document, so a reference added to the API
   * without a row is named here rather than discovered later.
   */
  it('covers every id-shaped field the API accepts in a body or a query', async () => {
    const built = await buildTestApp();
    try {
      const document = JSON.parse(await generateOpenApiDocument(built.app)) as OpenApiDocument;
      const declared = [...idBearingFields(document), ...STRUCTURED_ID_PARAMS].sort();

      const covered = [
        ...REFERENCES.filter((reference) => reference.operationId !== null).map(key),
        ...Object.keys(EXEMPT),
      ];

      expect([...new Set(covered)].sort()).toEqual([...new Set(declared)].sort());
      // An exemption is a claim that a field needs no row, so holding both would let
      // a row rot behind a reason saying it does not exist.
      const rows = new Set(
        REFERENCES.filter((reference) => reference.operationId !== null).map(key),
      );
      expect(Object.keys(EXEMPT).filter((field) => rows.has(field))).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  /**
   * `listDrafts?createdByUserId=` is the one id-shaped field that is a *filter*
   * rather than a lookup, and a filter must not 404 — a 404 would say the id names
   * nobody, which is precisely the existence statement A7 forbids. The safe answer
   * is the one an empty result gives, so that is what is asserted: a stranger's user
   * id and an id belonging to nobody produce the same empty page.
   */
  it('answers a cross-org filter value exactly as it answers an unknown one', async () => {
    const s = await scene();
    try {
      const forStranger = await runInContext(s.caller.ctx, () =>
        listDrafts({ createdByUserId: s.stranger.userUuid }, s.caller.ctx),
      );
      const forNobody = await runInContext(s.caller.ctx, () =>
        listDrafts({ createdByUserId: NOWHERE }, s.caller.ctx),
      );

      expect(JSON.stringify(forStranger)).toBe(JSON.stringify(forNobody));
      expect(forStranger.items).toHaveLength(0);
    } finally {
      await dropCustomRoles(s);
    }
  });

  /**
   * The chart templates, which the ticket lists among M2's resources and which have
   * no cross-org id by construction: they are `CHART_TEMPLATES`, a process constant.
   * Stated as a test rather than as a comment, because the moment a template becomes
   * a tenant row it acquires an id worth enumerating, and this is what notices.
   */
  it('offers every org the identical set of chart templates', async () => {
    const s = await scene();
    try {
      const mine = await runInContext(s.caller.ctx, () => listChartTemplates(s.caller.ctx));
      const theirs = await runInContext(s.stranger.ctx, () => listChartTemplates(s.stranger.ctx));

      expect(JSON.stringify(mine)).toBe(JSON.stringify(theirs));

      // And the ids are the compile-time constant, not rows: there is no table a
      // template could belong to an org through, which is what makes "no cross-org
      // id exists" a statement about the schema rather than about two fixtures
      // happening to agree.
      expect(mine.map((template) => template.id).sort()).toEqual([...CHART_TEMPLATE_IDS].sort());
    } finally {
      await dropCustomRoles(s);
    }
  });
});

interface OpenApiDocument {
  readonly paths: Record<
    string,
    Record<
      string,
      {
        readonly operationId: string;
        readonly parameters?: readonly { readonly in: string; readonly name: string }[];
        readonly requestBody?: {
          readonly content?: Record<string, { readonly schema?: JsonSchema }>;
        };
      }
    >
  >;
  readonly components: { readonly schemas: Record<string, JsonSchema> };
}

interface JsonSchema {
  readonly $ref?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
}

const ID_SHAPED = /Ids?$/;

/** `operationId.field` for every id-shaped body property and query parameter. */
function idBearingFields(document: OpenApiDocument): readonly string[] {
  const found: string[] = [];

  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item)) {
      const fields = new Set<string>();
      const seen = new Set<string>();

      const walk = (schema: JsonSchema | undefined): void => {
        if (schema === undefined) return;
        if (schema.$ref !== undefined) {
          if (seen.has(schema.$ref)) return;
          seen.add(schema.$ref);
          walk(document.components.schemas[schema.$ref.split('/').pop() as string]);
          return;
        }
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
          if (ID_SHAPED.test(name)) fields.add(name);
          walk(property);
        }
        walk(schema.items);
        for (const branch of [
          ...(schema.allOf ?? []),
          ...(schema.oneOf ?? []),
          ...(schema.anyOf ?? []),
        ]) {
          walk(branch);
        }
      };

      walk(operation.requestBody?.content?.['application/json']?.schema);
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === 'query' && ID_SHAPED.test(parameter.name)) fields.add(parameter.name);
      }

      for (const field of fields) found.push(`${operation.operationId}.${field}`);
    }
  }

  return found;
}
