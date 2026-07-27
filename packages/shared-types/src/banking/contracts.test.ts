import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as banking from '../banking';

import { BANKING_PRECONDITIONS, BANKING_RESOURCES } from './refusals';

/**
 * The M4 banking wire contracts (OB-075).
 *
 * Four things here are worth a test rather than a comment, and each of them is
 * invisible until it costs a whole ticket to rediscover.
 *
 *  1. **The `id` rule.** A `.meta({ id })` added before OB-084's routes publishes an
 *     unreachable component and A10 fails the build in a ticket that touched no
 *     schemas. M3's copy of this test asserted the empty set until OB-067; this one
 *     does the same until OB-084.
 *  2. **The absences.** No update shape for a statement line (D-42, E2) and no
 *     auto-post anywhere on the matching path (D-43, E3). Both erode by one
 *     plausible field at a time, and neither shows up in any other test.
 *  3. **The refusal vocabulary.** Every token machine-branchable, in AP's register,
 *     and disjoint from M3's — OB-092 is one divergence and this file is what keeps
 *     it from becoming two.
 *  4. **Round-tripping.** Every exported schema parses its own output, and the table
 *     that proves it is asserted to be complete — so a schema added without a sample
 *     fails here rather than being silently untested.
 */

const zodTypes = (module: Record<string, unknown>): [string, z.ZodType][] =>
  Object.entries(module).filter((entry): entry is [string, z.ZodType] => {
    const [, value] = entry;
    return value instanceof z.ZodType;
  });

const UUID = (n: number): string => `00000000-0000-4000-8000-00000000000${String(n)}`;

const DATE = '2026-03-31';
const TIMESTAMP = '2026-03-31T09:00:00Z';

const LINE_FACTS = {
  postedDate: DATE,
  valueDate: null,
  amount: '-450',
  description: 'CARD PAYMENT TO COFFEE SHOP',
  counterparty: null,
  bankReference: null,
  occurrenceIndex: 0,
  fingerprint: 'ZmluZ2VycHJpbnQ',
};

const CLEARING = {
  id: UUID(1),
  lineId: UUID(2),
  method: 'post_entry',
  clearedJournalId: UUID(3),
  clearedAmount: '-450',
  differenceAmount: '0',
  differenceAccountId: null,
  differenceJournalId: null,
  paymentId: null,
  reconciliationSessionId: null,
  clearedByUserId: UUID(4),
  clearedAt: TIMESTAMP,
};

const LINE = {
  id: UUID(2),
  bankAccountId: UUID(5),
  importId: UUID(6),
  ...LINE_FACTS,
  clearing: CLEARING,
  createdAt: TIMESTAMP,
};

const MAPPING_DEFINITION = {
  hasHeaderRow: true,
  delimiter: ',',
  dateOrder: 'dmy',
  amountConvention: 'signed',
  columns: {
    postedDate: 0,
    description: 1,
    amount: 2,
    debit: null,
    credit: null,
    valueDate: null,
    counterparty: null,
    bankReference: null,
  },
};

const MAPPING = {
  id: UUID(7),
  name: 'Barclays current',
  definition: MAPPING_DEFINITION,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const IMPORT_RESULT = { linesRead: 42, linesImported: 40, linesDuplicate: 2 };

const STATEMENT_IMPORT = {
  id: UUID(6),
  bankAccountId: UUID(5),
  format: 'csv',
  filename: 'march.csv',
  mappingId: UUID(7),
  status: 'complete',
  result: IMPORT_RESULT,
  failureReason: null,
  statementClosingBalance: '150000',
  externalAccountId: null,
  importedByUserId: UUID(4),
  createdAt: TIMESTAMP,
};

const BANK_ACCOUNT = {
  id: UUID(5),
  accountId: UUID(8),
  name: 'Barclays Current',
  institutionName: 'Barclays',
  externalAccountId: null,
  feedSource: 'file',
  isActive: true,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const RULE_CONDITION = {
  description: { mode: 'contains', value: 'COFFEE SHOP' },
  direction: 'outbound',
};

const RULE_OUTCOME = { accountId: UUID(9), dimensionValueIds: [] };

const RULE = {
  id: UUID(1),
  name: 'Coffee is entertaining',
  priority: 10,
  isActive: true,
  condition: RULE_CONDITION,
  outcome: RULE_OUTCOME,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const REASON = { code: 'amount_exact', amountDifference: null, dayDifference: null };

const PROPOSAL = {
  id: UUID(1),
  lineId: UUID(2),
  rank: 1,
  reasons: [REASON],
  kind: 'post_entry',
  accountId: UUID(9),
  contactId: null,
  dimensionValueIds: [],
  ruleId: UUID(1),
};

const BALANCES = {
  openingBalance: '100000',
  clearedBalance: '150000',
  statementClosingBalance: '150000',
  difference: '0',
  bookBalance: '150000',
  unclearedAmount: '0',
};

const SESSION_EVENT = {
  id: UUID(1),
  sessionId: UUID(2),
  type: 'finalised',
  reason: null,
  actorUserId: UUID(4),
  statementClosingBalance: '150000',
  occurredAt: TIMESTAMP,
};

const SESSION_SUMMARY = {
  id: UUID(2),
  bankAccountId: UUID(5),
  startDate: '2026-03-01',
  endDate: DATE,
  state: 'finalised',
  balances: BALANCES,
  clearedLineCount: 40,
  unclearedLineCount: 0,
  finalisedAt: TIMESTAMP,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const SESSION = { ...SESSION_SUMMARY, events: [SESSION_EVENT] };

const RECONCILING_ITEM = {
  journalId: UUID(6),
  date: DATE,
  amount: '-1500',
  description: 'Cheque 1042',
  reference: null,
};

const UNCLEARED_STATEMENT_LINE = {
  lineId: UUID(7),
  date: '2026-03-20',
  amount: '2000',
  description: 'BANK CHARGES',
  reference: null,
};

const REPORT = {
  sessionId: UUID(2),
  bankAccountId: UUID(5),
  startDate: '2026-03-01',
  endDate: DATE,
  state: 'finalised',
  balances: BALANCES,
  reconcilingItems: [RECONCILING_ITEM],
  unclearedStatementLines: [UNCLEARED_STATEMENT_LINE],
};

const page = (item: unknown): unknown => ({ items: [item], nextCursor: null });

/**
 * One valid value per exported schema. The completeness assertion below is what
 * makes this a contract rather than a spot check: a schema added to the module
 * without a sample here fails, so "every schema round-trips" stays true rather than
 * becoming "every schema somebody remembered round-trips".
 */
const SAMPLES: Readonly<Record<string, unknown>> = {
  bankLineAmountSchema: '-450',
  bankLineDirectionSchema: 'outbound',

  bankAccountSchema: BANK_ACCOUNT,
  bankAccountPageSchema: page(BANK_ACCOUNT),
  bankFeedSourceSchema: 'file',
  createBankAccountRequestSchema: { accountId: UUID(8), name: 'Barclays Current' },
  updateBankAccountRequestSchema: { name: 'Barclays Current Account' },
  listBankAccountsQuerySchema: { isActive: true },

  bankStatementFormatSchema: 'ofx',
  bankDateOrderSchema: 'dmy',
  bankAmountConventionSchema: 'signed',
  bankImportColumnsSchema: MAPPING_DEFINITION.columns,
  bankImportMappingDefinitionSchema: MAPPING_DEFINITION,
  bankImportMappingSchema: MAPPING,
  bankImportMappingPageSchema: page(MAPPING),
  createBankImportMappingRequestSchema: { name: 'Barclays', definition: MAPPING_DEFINITION },
  updateBankImportMappingRequestSchema: { name: 'Barclays plc' },
  listBankImportMappingsQuerySchema: {},
  bankStatementImportStatusSchema: 'processing',
  bankStatementImportResultSchema: IMPORT_RESULT,
  bankStatementImportSchema: STATEMENT_IMPORT,
  bankStatementImportPageSchema: page(STATEMENT_IMPORT),
  bankStatementImportQueuedSchema: { id: UUID(6), bankAccountId: UUID(5), status: 'queued' },
  createBankStatementImportRequestSchema: {
    bankAccountId: UUID(5),
    format: 'csv',
    filename: 'march.csv',
    content: 'date,description,amount\n31/03/2026,COFFEE,-4.50\n',
    mapping: MAPPING_DEFINITION,
    saveMappingAs: 'Barclays',
  },
  listBankStatementImportsQuerySchema: { bankAccountId: UUID(5) },
  previewBankStatementImportRequestSchema: {
    bankAccountId: UUID(5),
    format: 'ofx',
    filename: 'march.qfx',
    content: '<OFX></OFX>',
  },
  bankStatementImportPreviewSchema: {
    format: 'csv',
    headers: ['Date', 'Description', 'Amount'],
    result: IMPORT_RESULT,
    sample: [{ ...LINE_FACTS, isDuplicate: false }],
    statementStart: '2026-03-01',
    statementEnd: DATE,
    statementClosingBalance: '150000',
    externalAccountId: null,
    externalAccountMatches: null,
  },

  bankLineFingerprintSchema: 'ZmluZ2VycHJpbnQ',
  bankStatementLineDraftSchema: { ...LINE_FACTS, isDuplicate: false },
  bankStatementLineSchema: LINE,
  bankStatementLinePageSchema: page(LINE),
  listBankStatementLinesQuerySchema: { bankAccountId: UUID(5), cleared: false },

  bankRuleMatchModeSchema: 'contains',
  bankRuleConditionSchema: RULE_CONDITION,
  bankRuleOutcomeSchema: RULE_OUTCOME,
  bankRuleSchema: RULE,
  bankRulePageSchema: page(RULE),
  createBankRuleRequestSchema: { name: 'Coffee', condition: RULE_CONDITION, outcome: RULE_OUTCOME },
  updateBankRuleRequestSchema: { isActive: false },
  listBankRulesQuerySchema: { isActive: true },

  bankMatchReasonCodeSchema: 'amount_exact',
  bankMatchReasonSchema: REASON,
  bankMatchProposalSchema: PROPOSAL,
  bankLineProposalsSchema: { lineId: UUID(2), proposals: [PROPOSAL] },
  bankMatchProposalsRequestSchema: { lineIds: [UUID(2)] },
  bankMatchProposalListSchema: { lines: [{ lineId: UUID(2), proposals: [PROPOSAL] }] },

  bankClearingMethodSchema: 'post_entry',
  bankLineClearingSchema: CLEARING,
  clearBankStatementLineRequestSchema: { method: 'post_entry', accountId: UUID(9) },
  removeBankLineClearingRequestSchema: { date: DATE },

  reconciliationSessionStateSchema: 'open',
  reconciliationEventTypeSchema: 'reopened',
  reconciliationBalancesSchema: BALANCES,
  reconciliationSessionEventSchema: SESSION_EVENT,
  reconciliationSessionSchema: SESSION,
  reconciliationSessionSummarySchema: SESSION_SUMMARY,
  reconciliationSessionPageSchema: page(SESSION_SUMMARY),
  createReconciliationSessionRequestSchema: {
    bankAccountId: UUID(5),
    endDate: DATE,
    statementClosingBalance: '150000',
  },
  updateReconciliationSessionRequestSchema: { statementClosingBalance: '150100' },
  reopenReconciliationSessionRequestSchema: { reason: 'The bank restated a fee.' },
  listReconciliationSessionsQuerySchema: { bankAccountId: UUID(5), state: 'open' },

  reconcilingItemSchema: RECONCILING_ITEM,
  unclearedStatementLineSchema: UNCLEARED_STATEMENT_LINE,
  reconciliationReportSchema: REPORT,
};

describe('what M4 publishes as an OpenAPI component', () => {
  /**
   * `jsonSchemaTransformObject` copies every schema carrying an `id` out of zod's
   * global registry into `components.schemas` whether or not a route references it,
   * so an `id` added before its route publishes a component nothing can reach and
   * fails A10. OB-075 held the empty line for all of M4; OB-084 added the routes and
   * the ids in the same diff, and this is now the published catalogue — the pin that
   * catches a schema published without a route to reach it, or a route added without
   * its component.
   *
   * The absences are as deliberate as the presences. Enums and list-query schemas
   * never carry ids (an enum inlines identically in a generated client; a querystring
   * is emitted as individual `parameters`), and three routed-nowhere shapes stay
   * unpublished: `updateBankImportMappingRequestSchema` (no mapping-update route) and
   * the `bankStatementImport…` read pair (the import-poll surface is a follow-up).
   */
  it('publishes exactly the components OB-084’s routes reach', () => {
    const publishedIds = zodTypes(banking)
      .map(([, schema]) => z.globalRegistry.get(schema)?.id)
      .filter((id): id is string => id !== undefined)
      .sort();

    expect(publishedIds).toEqual(
      [
        'BankAccount',
        'BankAccountPage',
        'CreateBankAccountRequest',
        'UpdateBankAccountRequest',
        'BankImportColumns',
        'BankImportMappingDefinition',
        'BankImportMapping',
        'BankImportMappingPage',
        'CreateBankImportMappingRequest',
        'BankStatementImportResult',
        'BankStatementImport',
        'BankStatementImportPage',
        'CreateBankStatementImportRequest',
        'BankStatementImportQueued',
        'PreviewBankStatementImportRequest',
        'BankStatementImportPreview',
        'BankStatementLineDraft',
        'BankStatementLine',
        'BankStatementLinePage',
        'BankRuleCondition',
        'BankRuleOutcome',
        'BankRule',
        'BankRulePage',
        'CreateBankRuleRequest',
        'UpdateBankRuleRequest',
        'BankMatchReason',
        'BankMatchProposal',
        'BankLineProposals',
        'BankMatchProposalsRequest',
        'BankMatchProposalList',
        'BankLineClearing',
        'ClearBankStatementLineRequest',
        'RemoveBankLineClearingRequest',
        'ReconciliationBalances',
        'ReconciliationSessionEvent',
        'ReconciliationSession',
        'ReconciliationSessionSummary',
        'ReconciliationSessionPage',
        'CreateReconciliationSessionRequest',
        'UpdateReconciliationSessionRequest',
        'ReopenReconciliationSessionRequest',
        'ReconcilingItem',
        'UnclearedStatementLine',
        'ReconciliationReport',
      ].sort(),
    );
  });

  /**
   * The test above checks the *exported* schemas' own ids; this checks what they
   * *reach*, via `toJSONSchema`, which emits a `$defs` entry for every registered
   * schema it descends into. Banking may publish its own components, but beyond them
   * it must reference only M1's scalars — `MinorUnits` and `CalendarDate` from
   * `wire.ts`, `PageCursor` from the page envelope. Anything else foreign is a nested
   * `id` this module published by accident.
   */
  it('references only M1’s scalars beyond its own components', () => {
    const own = new Set(
      zodTypes(banking)
        .map(([, schema]) => z.globalRegistry.get(schema)?.id)
        .filter((id): id is string => id !== undefined),
    );

    const reachable = new Set<string>();
    for (const [, schema] of zodTypes(banking)) {
      for (const io of ['input', 'output'] as const) {
        const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as {
          $defs?: Record<string, unknown>;
        };
        for (const id of Object.keys(json.$defs ?? {})) {
          reachable.add(id);
        }
      }
    }

    const foreign = [...reachable].filter((id) => !own.has(id)).sort();
    expect(foreign).toEqual(['CalendarDate', 'MinorUnits', 'PageCursor']);
  });
});

describe('the shapes that must be impossible', () => {
  it('takes money as cents and nothing else (D-13)', () => {
    expect(bankingSchema('bankStatementLineSchema').safeParse(LINE).success).toBe(true);
    // A decimal amount, which `fromMinorString` refuses and a pattern that merely
    // agreed with it today would not.
    expect(
      bankingSchema('bankStatementLineSchema').safeParse({ ...LINE, amount: '-4.50' }).success,
    ).toBe(false);
    // A JSON number, which is an IEEE-754 double in every mainstream parser.
    expect(
      bankingSchema('bankStatementLineSchema').safeParse({ ...LINE, amount: -450 }).success,
    ).toBe(false);
    expect(
      bankingSchema('reconciliationBalancesSchema').safeParse({ ...BALANCES, difference: '0.00' })
        .success,
    ).toBe(false);
  });

  /**
   * D-42, E2: a statement line is what the bank said and is never modified. The way
   * this decision is lost is a wave-2 ticket adding a `memo` or a `category` to the
   * line rather than to a row that references it, so both halves are asserted — no
   * update *shape*, and no update *field* smuggled onto the line itself.
   */
  it('offers no way to modify a statement line (D-42, E2)', () => {
    const lineMutators = Object.keys(banking).filter((name) =>
      /^update.*(StatementLine|Line)/.test(name),
    );
    expect(lineMutators).toEqual([]);

    // `strictObject`, so a client sending a field the bank did not say is told.
    expect(
      bankingSchema('bankStatementLineSchema').safeParse({ ...LINE, memo: 'mine' }).success,
    ).toBe(false);
    expect(
      bankingSchema('bankStatementLineSchema').safeParse({ ...LINE, updatedAt: TIMESTAMP }).success,
    ).toBe(false);
    expect(
      bankingSchema('bankStatementLineSchema').safeParse({ ...LINE, description: undefined })
        .success,
    ).toBe(false);
  });

  /**
   * D-43, E3: matching proposes, a human posts. A proposal carries a rank and no
   * score, and nothing in the module offers to accept one on the user's behalf.
   *
   * `score` is asserted by name and not merely covered by `strictObject`, because it
   * is the field this decision actually lost once — the schema carried a `score`
   * column and the wire a `rank`, and the column is what an auto-accept threshold
   * would have been built on. An absence nobody tests is a field that comes back.
   */
  it('offers no way for the server to post on its own (D-43, E3)', () => {
    const autoPosters = Object.keys(banking).filter((name) =>
      /auto|threshold|confidence|score/i.test(name),
    );
    expect(autoPosters).toEqual([]);

    expect(bankingSchema('bankMatchProposalSchema').safeParse(PROPOSAL).success).toBe(true);
    expect(
      bankingSchema('bankMatchProposalSchema').safeParse({ ...PROPOSAL, score: 970 }).success,
    ).toBe(false);
    expect(
      bankingSchema('bankMatchProposalSchema').safeParse({ ...PROPOSAL, confidence: 0.97 }).success,
    ).toBe(false);
    expect(
      bankingSchema('bankMatchProposalSchema').safeParse({ ...PROPOSAL, autoAccept: true }).success,
    ).toBe(false);
  });

  /**
   * The bank-account side of the same habit. `defaultImportMappingId` was on this
   * contract and came off it: persisting it closes a `bank_accounts ⇄
   * bank_import_mappings` foreign-key cycle, and neither escape is available —
   * an unenforced id is a dangling reference, and no composite tenant key in this
   * schema can be `ON DELETE SET NULL`. OB-076 reaches for the most recently used
   * mapping instead. Asserted rather than commented, because a field removed for a
   * reason a screen does not know is a field a screen re-adds.
   */
  it('gives a bank account no default import mapping', () => {
    expect(Object.keys(BANK_ACCOUNT)).not.toContain('defaultImportMappingId');
    expect(
      bankingSchema('bankAccountSchema').safeParse({
        ...BANK_ACCOUNT,
        defaultImportMappingId: UUID(7),
      }).success,
    ).toBe(false);
    expect(
      bankingSchema('updateBankAccountRequestSchema').safeParse({
        defaultImportMappingId: UUID(7),
      }).success,
    ).toBe(false);
  });

  /**
   * E7: reconciliation and fiscal-period close are independent locks. A `periodId`
   * on a session is how they would first come to be conflated, and it would read as
   * harmless.
   */
  it('never lets a reconciliation session name a fiscal period (E7)', () => {
    expect(bankingSchema('reconciliationSessionSchema').safeParse(SESSION).success).toBe(true);
    expect(
      bankingSchema('reconciliationSessionSchema').safeParse({ ...SESSION, periodId: UUID(3) })
        .success,
    ).toBe(false);
  });

  /** D-46: the balance is the ledger account's, and there is no peer to it here. */
  it('never lets a bank account carry a balance (D-46)', () => {
    expect(bankingSchema('bankAccountSchema').safeParse(BANK_ACCOUNT).success).toBe(true);
    expect(
      bankingSchema('bankAccountSchema').safeParse({ ...BANK_ACCOUNT, balance: '150000' }).success,
    ).toBe(false);
  });

  /** A rule that matches everything out-ranks every genuine proposal on a statement. */
  it('refuses a bank rule with an empty condition (D-44)', () => {
    expect(bankingSchema('bankRuleConditionSchema').safeParse(RULE_CONDITION).success).toBe(true);
    expect(bankingSchema('bankRuleConditionSchema').safeParse({}).success).toBe(false);
    // A condition naming only a bank account scopes but does not match — it would
    // match every line on the account, and it is also the DB CHECK, so accepting it
    // on the wire would turn a save into a 500. It must be refused as an empty one is.
    expect(
      bankingSchema('bankRuleConditionSchema').safeParse({ bankAccountId: UUID(5) }).success,
    ).toBe(false);
  });

  /** A CSV needs exactly one reading of its columns; an OFX names its own fields. */
  it('refuses an import with no reading of the file, or two (D-41)', () => {
    const csv = {
      bankAccountId: UUID(5),
      format: 'csv',
      filename: 'march.csv',
      content: 'a,b,c\n',
    };

    expect(
      bankingSchema('previewBankStatementImportRequestSchema').safeParse({
        ...csv,
        mapping: MAPPING_DEFINITION,
      }).success,
    ).toBe(true);
    expect(bankingSchema('previewBankStatementImportRequestSchema').safeParse(csv).success).toBe(
      false,
    );
    expect(
      bankingSchema('previewBankStatementImportRequestSchema').safeParse({
        ...csv,
        mappingId: UUID(7),
        mapping: MAPPING_DEFINITION,
      }).success,
    ).toBe(false);
    expect(
      bankingSchema('previewBankStatementImportRequestSchema').safeParse({
        ...csv,
        format: 'ofx',
        mappingId: UUID(7),
      }).success,
    ).toBe(false);
  });

  /** The convention decides which columns may be present, and it is checkable. */
  it('ties the amount columns to the amount convention', () => {
    expect(
      bankingSchema('bankImportMappingDefinitionSchema').safeParse(MAPPING_DEFINITION).success,
    ).toBe(true);
    expect(
      bankingSchema('bankImportMappingDefinitionSchema').safeParse({
        ...MAPPING_DEFINITION,
        amountConvention: 'debit_credit_columns',
      }).success,
    ).toBe(false);
    expect(
      bankingSchema('bankImportMappingDefinitionSchema').safeParse({
        ...MAPPING_DEFINITION,
        amountConvention: 'debit_credit_columns',
        columns: { ...MAPPING_DEFINITION.columns, amount: null, debit: 2, credit: 3 },
      }).success,
    ).toBe(true);
  });

  /** A clearing request names one thing to do, and the other two do not parse into it. */
  it('makes a clearing that means two things unrepresentable (E4)', () => {
    expect(
      bankingSchema('clearBankStatementLineRequestSchema').safeParse({
        method: 'link_entry',
        journalId: UUID(3),
      }).success,
    ).toBe(true);
    expect(
      bankingSchema('clearBankStatementLineRequestSchema').safeParse({
        method: 'link_entry',
        journalId: UUID(3),
        accountId: UUID(9),
      }).success,
    ).toBe(false);
    expect(
      bankingSchema('clearBankStatementLineRequestSchema').safeParse({ method: 'post_entry' })
        .success,
    ).toBe(false);
  });

  /** E6 asks for a record of who and when; why is the part nobody can reconstruct. */
  it('will not reopen a session without a reason (E6)', () => {
    expect(
      bankingSchema('reopenReconciliationSessionRequestSchema').safeParse({
        reason: 'Fee restated',
      }).success,
    ).toBe(true);
    expect(bankingSchema('reopenReconciliationSessionRequestSchema').safeParse({}).success).toBe(
      false,
    );
    expect(
      bankingSchema('reopenReconciliationSessionRequestSchema').safeParse({ reason: '   ' })
        .success,
    ).toBe(false);
  });
});

describe('the refusal vocabulary', () => {
  /**
   * A restatement of `assertIdentifierToken`'s pattern in `packages/server/src/errors/
   * base.ts`, in the sense `MINOR_UNITS_WIRE_PATTERN` is a restatement: that function
   * is the authority and it throws at construction, so a token that fails it is a
   * 500 discovered when the refusal is first hit — which is the refusal path, the
   * one least likely to be exercised by hand.
   */
  const IDENTIFIER_TOKEN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

  it('is machine-branchable, everywhere', () => {
    const tokens = [...Object.values(BANKING_PRECONDITIONS), ...Object.values(BANKING_RESOURCES)];

    expect(tokens.filter((token) => !IDENTIFIER_TOKEN.test(token))).toEqual([]);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  /**
   * OB-092 records one divergence — AR and AP spelling four shared facts differently
   * — and says the AP spelling wins. It is pinned rather than fixed, deliberately.
   * What this asserts is the thing that would make it worse: banking must not
   * introduce a *third* name for a fact M3 already names.
   */
  it('does not respell anything M3 already says', () => {
    const M3_TOKENS = [
      'document_allocated',
      'document_already_approved',
      'document_already_void',
      'document_approved',
      'document_has_allocations',
      'document_not_approved',
      'document_not_draft',
    ];

    const collisions = Object.values(BANKING_PRECONDITIONS).filter((token) =>
      M3_TOKENS.some((m3) => m3 === token || token.endsWith(m3.replace(/^document/, ''))),
    );

    expect(collisions).toEqual([]);
  });
});

describe('every schema round-trips', () => {
  it('has a sample for each of them, and no sample for a schema that is gone', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      zodTypes(banking)
        .map(([name]) => name)
        .sort(),
    );
  });

  it('parses its own output', () => {
    for (const [name, schema] of zodTypes(banking)) {
      const first = schema.safeParse(SAMPLES[name]);
      expect(first.success, `${name} rejected its own sample: ${first.error?.message ?? ''}`).toBe(
        true,
      );

      if (first.success) {
        const second = schema.safeParse(first.data);
        expect(second.success, `${name} rejected its own output`).toBe(true);
        expect(second.success ? second.data : undefined).toEqual(first.data);
      }
    }
  });
});

/**
 * Reaches a schema by name so a test can say what it is asserting about without the
 * file importing forty symbols it uses once. A missing name fails loudly here rather
 * than as `undefined.safeParse`.
 */
function bankingSchema(name: string): z.ZodType {
  const found = zodTypes(banking).find(([exported]) => exported === name);
  if (found === undefined) {
    throw new Error(`No exported schema named ${name}.`);
  }
  return found[1];
}
