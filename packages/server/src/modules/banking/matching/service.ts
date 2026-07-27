import type {
  BankLineProposals,
  BankMatchProposalList,
  BankMatchProposalsRequest,
} from '@openbooks/shared-types';
import { bankMatchProposalsRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { getContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { bufferToUuid, newUuid, tryUuidToBuffer } from '../../../db';
import { parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';
import type { RuleCandidateLine, RuleEvaluator, RuleMatch } from '../rule-evaluator';

import { addCalendarDays } from './dates';
import type {
  CodingHistoryRow,
  LinkCandidateRow,
  OpenDocumentRow,
  StatementLineRow,
} from './repository';
import {
  orgScope,
  selectBankAccounts,
  selectCodingHistory,
  selectLinkCandidates,
  selectOpenBills,
  selectOpenInvoices,
  selectStatementLines,
} from './repository';
import type { ProposalDraft } from './scoring';
import {
  amountReason,
  amountTolerance,
  contactHistoryReason,
  counterpartyReason,
  dateReason,
  descriptionReason,
  namesMatch,
  normalizeText,
  rankProposals,
  referenceMatches,
  referenceReason,
  ruleReason,
} from './scoring';

/**
 * The match proposal engine (OB-079; ROADMAP D-43, D-44, acceptance E3, E10).
 *
 * Given the lines a screen is showing, it returns each line's ranked candidates —
 * best first, at most ten — and it does so **without ever writing** (D-43): it reads
 * candidates from four sources, judges their likeness, orders them, and returns them.
 * Nothing here posts a journal, records a clearing, or stores a proposal. Accepting
 * one is a separate human act in `clearing.ts` (OB-081), which this engine cannot
 * reach and does not import.
 *
 * ## The rule evaluator is injected, exactly like the parser is
 *
 * One of the four sources — a rule that classifies a line (D-44) — arrives through the
 * injected `RuleEvaluator`, the committed seam OB-080 supplies the concrete one for.
 * The engine consumes an *outcome* a rule produced and turns it into a `post_entry`
 * proposal carrying `rule_match` and the rule's id; it never imports the rules service,
 * so nothing a rule returns has a type that can reach the ledger. The evaluator is
 * batched — one call for the whole page — which is E10's constraint, and every other
 * source here is loaded once for the page for the same reason.
 *
 * ## Permission
 *
 * `banking.read`, and only that. A proposal is a read — it computes what *could* be
 * done and commits to nothing — so it takes the same key the statement preview and
 * the line list take. The permission to *act* on a proposal is enforced where the act
 * happens, in `clearing.ts`.
 */

/** What the engine needs beyond a request: the rule evaluator, injected (the D-07 seam shape). */
export interface MatchProposalDeps {
  readonly ruleEvaluator: RuleEvaluator;
}

/**
 * How far around the page's dates a linkable journal may sit. A payment recorded a few
 * weeks before or after the statement line that evidences it is ordinary; the coarse
 * SQL window bounds the candidate set, and the per-line date reason is judged after.
 */
const LINK_DATE_WINDOW_DAYS = 30;

export async function proposeMatches(
  input: BankMatchProposalsRequest,
  deps: MatchProposalDeps,
  ctx: RequestContext = getContext('proposeMatches()'),
): Promise<BankMatchProposalList> {
  const request = parseInput(bankMatchProposalsRequestSchema, input);
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);

  const idBuffers = request.lineIds
    .map((id) => tryUuidToBuffer(id))
    .filter((buffer): buffer is Buffer => buffer !== undefined);

  const lines = await selectStatementLines(db, idBuffers);
  if (lines.length === 0) return { lines: [] };

  const page = await loadPageSources(db, deps, ctx, lines);

  const byLineId = new Map(lines.map((line) => [line.lineId, line]));
  const result: BankLineProposals[] = [];
  for (const lineId of request.lineIds) {
    const line = byLineId.get(lineId);
    // A requested line this org does not hold is absent from `lines` (E9); it is not
    // proposed for, rather than erroring the whole page or confirming it exists.
    if (line === undefined) continue;
    result.push({ lineId, proposals: rankProposals(draftsForLine(line, page)) });
  }

  return { lines: result };
}

// ---------------------------------------------------------------------------
// Loading every source once, for the whole page (E10)
// ---------------------------------------------------------------------------

interface PageSources {
  /** Bank ledger account id (hex) → the account behind each of the page's lines. */
  readonly ledgerByBankAccount: ReadonlyMap<string, Buffer>;
  readonly ruleMatches: ReadonlyMap<string, RuleMatch>;
  readonly linkCandidates: readonly LinkCandidateRow[];
  readonly openInvoices: readonly OpenDocumentRow[];
  readonly openBills: readonly OpenDocumentRow[];
  readonly history: readonly CodingHistoryRow[];
}

async function loadPageSources(
  db: TenantDatabase,
  deps: MatchProposalDeps,
  ctx: RequestContext,
  lines: readonly StatementLineRow[],
): Promise<PageSources> {
  const bankAccounts = await selectBankAccounts(db);
  const ledgerByBankAccount = new Map(
    bankAccounts.map((account) => [account.id.toString('hex'), account.ledgerAccountId]),
  );
  const bankLedgerAccountIds = bankAccounts.map((account) => account.ledgerAccountId);

  const pageLedgerAccountIds = distinctBuffers(
    lines
      .map((line) => ledgerByBankAccount.get(line.bankAccountId.toString('hex')))
      .filter((id): id is Buffer => id !== undefined),
  );

  const ruleLines: RuleCandidateLine[] = lines.map((line) => ({
    lineId: line.lineId,
    bankAccountId: bufferToUuid(line.bankAccountId),
    description: line.description,
    amount: line.amount,
  }));

  const hasInbound = lines.some((line) => line.amount > 0n);
  const hasOutbound = lines.some((line) => line.amount < 0n);

  const [ruleMatches, linkCandidates, openInvoices, openBills, history] = await Promise.all([
    deps.ruleEvaluator.evaluate(ruleLines, ctx),
    loadLinkCandidates(db, lines, pageLedgerAccountIds),
    hasInbound ? selectOpenInvoices(db) : Promise.resolve([]),
    hasOutbound ? selectOpenBills(db) : Promise.resolve([]),
    selectCodingHistory(db, {
      counterparties: distinctStrings(lines.map((line) => line.counterparty)),
      descriptions: distinctStrings(lines.map((line) => line.description)),
      bankLedgerAccountIds,
    }),
  ]);

  return { ledgerByBankAccount, ruleMatches, linkCandidates, openInvoices, openBills, history };
}

async function loadLinkCandidates(
  db: TenantDatabase,
  lines: readonly StatementLineRow[],
  ledgerAccountIds: readonly Buffer[],
): Promise<readonly LinkCandidateRow[]> {
  if (ledgerAccountIds.length === 0) return [];

  let minDate: string | undefined;
  let maxDate: string | undefined;
  let netMin: bigint | undefined;
  let netMax: bigint | undefined;
  for (const line of lines) {
    const tolerance = amountTolerance(line.amount);
    const low = line.amount - tolerance;
    const high = line.amount + tolerance;
    if (minDate === undefined || line.postedDate < minDate) minDate = line.postedDate;
    if (maxDate === undefined || line.postedDate > maxDate) maxDate = line.postedDate;
    if (netMin === undefined || low < netMin) netMin = low;
    if (netMax === undefined || high > netMax) netMax = high;
  }
  if (
    minDate === undefined ||
    maxDate === undefined ||
    netMin === undefined ||
    netMax === undefined
  ) {
    return [];
  }

  return selectLinkCandidates(db, {
    ledgerAccountIds,
    fromDate: addCalendarDays(minDate, -LINK_DATE_WINDOW_DAYS),
    toDate: addCalendarDays(maxDate, LINK_DATE_WINDOW_DAYS),
    netMin,
    netMax,
  });
}

// ---------------------------------------------------------------------------
// Per line: build the candidate drafts from the loaded sources
// ---------------------------------------------------------------------------

interface LineFacts {
  readonly counterpartyNorm: string;
  readonly descriptionNorm: string;
  readonly haystack: string;
}

function factsFor(line: StatementLineRow): LineFacts {
  const counterpartyNorm = normalizeText(line.counterparty);
  const descriptionNorm = normalizeText(line.description);
  return {
    counterpartyNorm,
    descriptionNorm,
    haystack: `${normalizeText(line.bankReference)} ${descriptionNorm}`,
  };
}

function draftsForLine(line: StatementLineRow, page: PageSources): ProposalDraft[] {
  const facts = factsFor(line);
  return [
    ...ruleDraft(line, page),
    ...linkDrafts(line, facts, page),
    ...documentDrafts(line, facts, page),
    ...historyDrafts(line, facts, page),
  ];
}

function ruleDraft(line: StatementLineRow, page: PageSources): ProposalDraft[] {
  const match = page.ruleMatches.get(line.lineId);
  if (match === undefined) return [];
  return [
    {
      id: newUuid(),
      lineId: line.lineId,
      kind: 'post_entry',
      accountId: match.accountId,
      contactId: match.contactId,
      dimensionValueIds: [...match.dimensionValueIds],
      ruleId: match.ruleId,
      reasons: [ruleReason],
    },
  ];
}

function linkDrafts(line: StatementLineRow, facts: LineFacts, page: PageSources): ProposalDraft[] {
  const ledgerAccountId = page.ledgerByBankAccount.get(line.bankAccountId.toString('hex'));
  if (ledgerAccountId === undefined) return [];
  const tolerance = amountTolerance(line.amount);

  const drafts: ProposalDraft[] = [];
  for (const candidate of page.linkCandidates) {
    if (!candidate.ledgerAccountId.equals(ledgerAccountId)) continue;
    const difference = candidate.net - line.amount;
    if (abs(difference) > tolerance) continue;

    const reasons = [amountReason(candidate.net, line.amount)];
    const date = dateReason(candidate.entryDate, line.postedDate);
    if (date !== null) reasons.push(date);
    if (referenceMatches(facts.haystack, candidate.memo)) {
      reasons.push(referenceReason);
    } else if (
      candidate.memo !== null &&
      namesMatch(facts.descriptionNorm, normalizeText(candidate.memo))
    ) {
      reasons.push(descriptionReason);
    }

    drafts.push({
      id: newUuid(),
      lineId: line.lineId,
      kind: 'link_entry',
      journalId: bufferToUuid(candidate.journalId),
      journalDate: candidate.entryDate,
      journalMemo: candidate.memo,
      journalAmount: candidate.net.toString(),
      reasons,
    });
  }
  return drafts;
}

function documentDrafts(
  line: StatementLineRow,
  facts: LineFacts,
  page: PageSources,
): ProposalDraft[] {
  // Direction decides the subledger: money in settles a customer's invoice, money out
  // settles our bill. A zero-amount line settles neither.
  const inbound = line.amount > 0n;
  const outbound = line.amount < 0n;
  if (!inbound && !outbound) return [];

  const documents = inbound ? page.openInvoices : page.openBills;
  const targetType = inbound ? 'invoice' : 'bill';
  const sign = inbound ? 1n : -1n;
  const tolerance = amountTolerance(line.amount);

  const drafts: ProposalDraft[] = [];
  for (const document of documents) {
    const candidateAmount = sign * document.outstanding;
    const difference = candidateAmount - line.amount;
    const amountClose = abs(difference) <= tolerance;
    const counterpartyHit =
      facts.counterpartyNorm.length > 0 &&
      namesMatch(facts.counterpartyNorm, normalizeText(document.contactName));
    const referenceHit =
      referenceMatches(facts.haystack, document.documentNumber) ||
      referenceMatches(facts.haystack, document.reference);

    if (!amountClose && !counterpartyHit && !referenceHit) continue;

    const reasons = [];
    if (amountClose) reasons.push(amountReason(candidateAmount, line.amount));
    if (counterpartyHit) reasons.push(counterpartyReason);
    if (referenceHit) reasons.push(referenceReason);

    drafts.push({
      id: newUuid(),
      lineId: line.lineId,
      kind: 'allocate_document',
      targetType,
      targetId: bufferToUuid(document.documentId),
      documentNumber: document.documentNumber,
      contactId: bufferToUuid(document.contactId),
      contactName: document.contactName,
      outstanding: document.outstanding.toString(),
      reasons,
    });
  }
  return drafts;
}

interface HistoryAccount {
  readonly accountId: Buffer;
  readonly contactId: Buffer | null;
  matchedCounterparty: boolean;
  matchedDescription: boolean;
}

function historyDrafts(
  line: StatementLineRow,
  facts: LineFacts,
  page: PageSources,
): ProposalDraft[] {
  const accounts = new Map<string, HistoryAccount>();
  for (const row of page.history) {
    const byCounterparty =
      facts.counterpartyNorm.length > 0 &&
      normalizeText(row.counterparty) === facts.counterpartyNorm;
    const byDescription = normalizeText(row.description) === facts.descriptionNorm;
    if (!byCounterparty && !byDescription) continue;

    const key = row.accountId.toString('hex');
    const existing = accounts.get(key);
    if (existing === undefined) {
      accounts.set(key, {
        accountId: row.accountId,
        contactId: row.contactId,
        matchedCounterparty: byCounterparty,
        matchedDescription: byDescription,
      });
    } else {
      existing.matchedCounterparty ||= byCounterparty;
      existing.matchedDescription ||= byDescription;
    }
  }

  const drafts: ProposalDraft[] = [];
  for (const account of accounts.values()) {
    const reasons = [contactHistoryReason];
    // The stronger of the two likeness signals, so a coding matched by the very same
    // counterparty carries `counterparty_match` rather than a coincidental description.
    if (account.matchedCounterparty) reasons.push(counterpartyReason);
    else if (account.matchedDescription) reasons.push(descriptionReason);

    drafts.push({
      id: newUuid(),
      lineId: line.lineId,
      kind: 'post_entry',
      accountId: bufferToUuid(account.accountId),
      contactId: account.contactId === null ? null : bufferToUuid(account.contactId),
      // History proposes an account and a contact, not a tagging: a past coding's
      // dimensions belong to that entry, and re-tagging is the user's to do on accept.
      dimensionValueIds: [],
      ruleId: null,
      reasons,
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function distinctBuffers(buffers: readonly Buffer[]): Buffer[] {
  const seen = new Map<string, Buffer>();
  for (const buffer of buffers) seen.set(buffer.toString('hex'), buffer);
  return [...seen.values()];
}

function distinctStrings(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value !== null && value.length > 0) seen.add(value);
  }
  return [...seen];
}
