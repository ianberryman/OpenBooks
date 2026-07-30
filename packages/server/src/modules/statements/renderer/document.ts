import type { ReportBasis } from '@openbooks/shared-types';
import { fromMinorString, toDecimalString } from '@openbooks/shared-types/money';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import { InternalError } from '../../../errors';
import type { BalanceSheet, ProfitAndLoss, StatementOfCashFlows } from '../../reports';

import type { StatementPackageBranding, StatementPackageRenderInput } from './types';

/**
 * Builds the pdfmake document definition for one statement package — the pure,
 * printer-free half of the renderer (OB-195; ROADMAP P5), mirroring
 * `delivery/renderer/document.ts`'s split for the same reason: a plain function
 * of `StatementPackageRenderInput` can be asserted on directly, in a way PDF
 * bytes (glyph ids in a subsetted font) cannot.
 *
 * Draws, in order: a branded cover page (letterhead, title, period, basis,
 * generation date), then the P&L, the balance sheet, and the statement of cash
 * flows, each starting its own page. Every account table prints every row the
 * report returned, in the report's own code order — no row is hidden for being
 * zero, matching every other statement in this codebase (`balances.repository.ts`'s
 * "the core returns the whole chart" convention).
 */

const DEFAULT_ACCENT_COLOR = '#1a1a1a';
const MUTED_TEXT_COLOR = '#555555';

/**
 * Cents string → displayed decimal string. Routed through
 * `fromMinorString`/`toDecimalString` rather than `Number(cents) / 100`
 * (CLAUDE.md, D-13) for `delivery/renderer/document.ts#formatMoney`'s exact
 * reason: a report row's `amount` is a TS string with no runtime guarantee at
 * this boundary, and `fromMinorString` is what actually checks it is canonical
 * minor units — including the sign, since a report row can be negative.
 */
function formatMoney(cents: string): string {
  return toDecimalString(fromMinorString(cents));
}

/**
 * pdfkit (via pdfmake) embeds only PNG and JPEG. Sniffed from the magic bytes
 * rather than trusted from a caller-supplied mime type — `logo` on the contract
 * is bare `Uint8Array`, the same as `InvoiceRenderInput.logo`, and for the same
 * reason (`delivery/renderer/document.ts`'s copy of this function).
 */
function detectImageMimeType(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (isPng) return 'image/png';

  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  throw new Error(
    'Logo bytes are neither a PNG nor a JPEG signature — pdfmake embeds only these two formats.',
  );
}

function logoDataUri(bytes: Uint8Array): string {
  const mimeType = detectImageMimeType(bytes);
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** The address block under the org name, one line per non-empty part. */
function addressLines(branding: StatementPackageBranding): string[] {
  const cityRegion = [branding.city, branding.region]
    .filter((part): part is string => part !== null)
    .join(', ');

  const candidates: (string | null)[] = [
    branding.addressLine1,
    branding.addressLine2,
    cityRegion === '' ? null : cityRegion,
    branding.postalCode,
    branding.country,
  ];

  return candidates.filter((line): line is string => line !== null);
}

function basisLabel(basis: ReportBasis): string {
  return basis === 'cash' ? 'Cash basis' : 'Accrual basis';
}

function letterheadBlock(input: StatementPackageRenderInput): Content {
  const { branding } = input;

  const nameAndAddress: Content = {
    stack: [
      { text: branding.displayName, style: 'orgName' },
      ...addressLines(branding).map((line): Content => ({ text: line, style: 'orgAddress' })),
    ],
  };

  if (input.logo === undefined) {
    return { columns: [nameAndAddress], margin: [0, 0, 0, 20] };
  }

  return {
    columns: [nameAndAddress, { image: 'logo', width: 100, alignment: 'right' }],
    margin: [0, 0, 0, 20],
  };
}

/** The cover page: letterhead, title, the period and basis this bundle covers, and when it ran. */
function coverPage(input: StatementPackageRenderInput): Content {
  return {
    stack: [
      letterheadBlock(input),
      { text: 'Financial Statements', style: 'coverTitle', margin: [0, 100, 0, 8] },
      { text: `${input.periodStart} to ${input.periodEnd}`, style: 'coverSubtitle' },
      { text: basisLabel(input.basis), style: 'coverSubtitle' },
      { text: `Generated ${input.generatedAt}`, style: 'coverMeta', margin: [0, 40, 0, 0] },
    ],
    pageBreak: 'after',
  };
}

function sectionHeading(text: string): Content {
  return { text, style: 'sectionTitle', pageBreak: 'before', margin: [0, 0, 0, 4] };
}

function subsectionHeading(text: string): Content {
  return { text, style: 'subsectionTitle', margin: [0, 12, 0, 4] };
}

/** The minimal row shape every statement's account rows share. */
interface AccountRow {
  readonly code: string;
  readonly name: string;
  readonly amount: string;
}

function accountRowsTable(rows: readonly AccountRow[]): Content {
  const header: Content[] = ['Code', 'Account', 'Amount'].map((text): Content => ({
    text,
    style: 'tableHeader',
  }));

  const body: Content[][] = rows.map((row): Content[] => [
    { text: row.code },
    { text: row.name },
    { text: formatMoney(row.amount), alignment: 'right' },
  ]);

  return {
    table: { headerRows: 1, widths: ['auto', '*', 'auto'], body: [header, ...body] },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 4],
  };
}

/** A label/amount line under a table — mirrors `delivery/renderer/document.ts`'s `totalsRow`. */
function summaryLine(label: string, cents: string, style: string): Content {
  return {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: ['auto', 'auto'],
          body: [
            [
              { text: label, style },
              { text: formatMoney(cents), alignment: 'right', style },
            ],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 0, 0, 4],
  };
}

function accountSection(title: string, rows: readonly AccountRow[], total: string): Content[] {
  return [
    subsectionHeading(title),
    accountRowsTable(rows),
    summaryLine(`Total ${title.toLowerCase()}`, total, 'totalsLabel'),
  ];
}

/**
 * `getProfitAndLoss`/`getBalanceSheet` are called with no `groupBy` (P5 covers a
 * whole org's period, not a sliced one), so the core always returns exactly one
 * group — "the sole group of an unsliced report" (`ProfitAndLossGroup.key`'s own
 * doc comment). A second or zero-length group here would mean this renderer was
 * handed a sliced report it never asked the service layer to produce.
 */
function onlyGroup<T>(groups: readonly T[]): T {
  const [group, second] = groups;
  if (group === undefined || second !== undefined) {
    throw new InternalError(
      `A statement package report returned ${groups.length} groups; this renderer only ever ` +
        'requests an unsliced report and expects exactly one.',
    );
  }
  return group;
}

function profitAndLossSection(pl: ProfitAndLoss): Content[] {
  const group = onlyGroup(pl.groups);

  return [
    sectionHeading(`Profit & Loss — ${basisLabel(pl.basis)}`),
    ...accountSection('Revenue', group.revenue.rows, group.revenue.total),
    ...accountSection('Expenses', group.expenses.rows, group.expenses.total),
    summaryLine('Net income', pl.totals.netIncome, 'totalsGrand'),
  ];
}

function balanceSheetSection(bs: BalanceSheet): Content[] {
  const group = onlyGroup(bs.groups);

  return [
    sectionHeading(`Balance Sheet — as at ${bs.asOf}`),
    ...accountSection('Assets', group.assets.rows, bs.totals.assets),
    ...accountSection('Liabilities', group.liabilities.rows, bs.totals.liabilities),
    ...accountSection('Equity', group.equity.rows, bs.totals.equity),
    summaryLine('Prior year earnings', bs.totals.priorYearEarnings, 'totalsLabel'),
    summaryLine('Current year earnings', bs.totals.currentYearEarnings, 'totalsLabel'),
    summaryLine('Total liabilities & equity', bs.totals.liabilitiesAndEquity, 'totalsGrand'),
  ];
}

function cashFlowSection(
  cf: StatementOfCashFlows,
  periodStart: string,
  periodEnd: string,
): Content[] {
  return [
    sectionHeading(`Statement of Cash Flows — ${periodStart} to ${periodEnd}`),
    summaryLine('Opening cash', cf.openingCash, 'totalsLabel'),
    summaryLine('Net income', cf.netIncome, 'totalsLabel'),
    summaryLine('Adjustments to reconcile net income to cash', cf.adjustments, 'totalsLabel'),
    summaryLine('Net change in cash', cf.netChangeInCash, 'totalsLabel'),
    summaryLine('Closing cash', cf.closingCash, 'totalsGrand'),
  ];
}

export function buildStatementPackageDocDefinition(
  input: StatementPackageRenderInput,
): TDocumentDefinitions {
  const accentColor = input.branding.brandColor ?? DEFAULT_ACCENT_COLOR;

  const content: Content[] = [
    coverPage(input),
    ...profitAndLossSection(input.profitAndLoss),
    ...balanceSheetSection(input.balanceSheet),
    ...cashFlowSection(input.cashFlow, input.periodStart, input.periodEnd),
  ];

  return {
    info: { title: `Financial Statements ${input.periodStart} to ${input.periodEnd}` },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    ...(input.logo === undefined ? {} : { images: { logo: logoDataUri(input.logo) } }),
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#1a1a1a' },
    styles: {
      orgName: { fontSize: 16, bold: true, color: accentColor },
      orgAddress: { fontSize: 9, color: MUTED_TEXT_COLOR },
      coverTitle: { fontSize: 24, bold: true, color: accentColor },
      coverSubtitle: { fontSize: 12, color: MUTED_TEXT_COLOR },
      coverMeta: { fontSize: 9, color: MUTED_TEXT_COLOR },
      sectionTitle: { fontSize: 16, bold: true, color: accentColor },
      subsectionTitle: { fontSize: 11, bold: true },
      tableHeader: { bold: true, fontSize: 9, color: '#ffffff', fillColor: accentColor },
      totalsLabel: { fontSize: 10 },
      totalsGrand: { fontSize: 11, bold: true },
    },
    content,
  };
}
