import { useQuery } from '@tanstack/react-query';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import { cx } from '../lib/cx';
import { thinRequest } from '../lib/thin-client';
import { formatMinorUnits } from '../money/format';

/**
 * The public hosted invoice page — `/i/:token` (OB-131, Phase 1, S4).
 *
 * ## Unauthenticated, and mounted outside everything that assumes a session
 *
 * `publicInvoiceViewSchema`'s header: this is reached by a capability token in the URL,
 * not a session, by whoever holds the link — a customer with no OpenBooks account at
 * all, in the ordinary case. `App.tsx` therefore mounts this route *before*
 * `QueryScopeBoundary` and `AppRoutes`: it never calls `GET /v1/auth/me`, never joins the
 * query cache an org switch clears, and never renders inside `<AppShell>`, whose nav and
 * org switcher presuppose exactly the session this page must not need.
 *
 * ## Mocked, and what is guessed
 *
 * `GET /v1/branding` and `POST /v1/invoices/{id}/send` are named in the ticket;
 * the route this page reads is not. `delivery.ts`'s header states the PDF link as
 * `/public/invoices/{token}/pdf`, so `/public/invoices/{token}` (no suffix) for the JSON
 * view is the same convention applied to the page's own data rather than a fact this
 * stream was given — flag it at integration if F2/S5 chose differently. `pdfUrl` itself
 * is never constructed here: it arrives on the response and is used as given, so a wrong
 * guess about the JSON path does not also risk a wrong PDF link.
 *
 * `PublicInvoiceView` and its nested shapes are hand-mirrored from
 * `packages/shared-types/src/delivery/delivery.ts`'s `publicInvoiceViewSchema` — see
 * `../lib/thin-client.ts` for why they are copied rather than imported. **The one-line
 * swap once F2/S5 land:** delete the interfaces below and `fetchPublicInvoiceView`,
 * import `components['schemas']['PublicInvoiceView']` from `../api` instead, and keep the
 * rendering below unchanged — every field it reads has the same name either way.
 */

interface PublicInvoiceLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
}

interface PublicTaxSummaryRow {
  readonly taxRateName: string | null;
  readonly percentage: string | null;
  readonly net: string;
  readonly tax: string;
}

interface PublicBranding {
  readonly displayName: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly invoiceFooter: string | null;
}

interface PublicInvoiceView {
  readonly documentNumber: string;
  readonly reference: string | null;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly lines: readonly PublicInvoiceLine[];
  readonly totals: { readonly net: string; readonly tax: string; readonly gross: string };
  readonly taxSummary: readonly PublicTaxSummaryRow[];
  readonly memo: string | null;
  readonly customerName: string;
  readonly branding: PublicBranding;
  readonly pdfUrl: string;
}

async function fetchPublicInvoiceView(token: string): Promise<PublicInvoiceView> {
  return thinRequest<PublicInvoiceView>(`/public/invoices/${encodeURIComponent(token)}`, {
    method: 'GET',
    // No cookie is sent, and none is expected: this page's whole authority is the token
    // in the URL, and a session cookie that happened to be present must not extend it —
    // see the module header.
    credentials: 'omit',
  });
}

function publicInvoiceQueryKey(token: string): readonly ['public-invoice', string] {
  return ['public-invoice', token];
}

/**
 * The frame every state of this page renders inside — loading, not-found, and the
 * invoice itself. Deliberately not `<AppShell>`: no nav, no org switcher, no theme
 * toggle, because none of those has a meaning for a visitor holding a mailed link who is
 * never signed in.
 */
function PublicInvoiceShell({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="min-h-screen bg-canvas p-4 text-text sm:p-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">{children}</div>
    </div>
  );
}

export function PublicInvoiceScreen(): ReactElement {
  const { token } = useParams<{ token: string }>();

  const view = useQuery({
    queryKey: publicInvoiceQueryKey(token ?? ''),
    queryFn: async () => fetchPublicInvoiceView(token ?? ''),
    enabled: token !== undefined,
    retry: false,
  });

  if (token === undefined) {
    return (
      <PublicInvoiceShell>
        <p className="text-text-muted">This link is missing its token.</p>
      </PublicInvoiceShell>
    );
  }

  if (view.isPending) {
    return (
      <PublicInvoiceShell>
        <p className="text-text-subtle">Loading…</p>
      </PublicInvoiceShell>
    );
  }

  if (view.isError) {
    return (
      <PublicInvoiceShell>
        {/* No detail beyond this: a wrong token and an expired one must read identically
            to whoever is holding the link, the same reasoning `A7`/`NotFoundError` give
            the authenticated surface — this page has no session to say more to. */}
        <p className="text-text-muted">
          This invoice link is no longer valid, or the invoice could not be found.
        </p>
      </PublicInvoiceShell>
    );
  }

  return <PublicInvoiceDocument view={view.data} />;
}

function addressLines(branding: PublicBranding): readonly string[] {
  const cityLine = [branding.city, branding.region, branding.postalCode]
    .filter((part): part is string => part !== null && part !== '')
    .join(', ');

  return [branding.addressLine1, branding.addressLine2, cityLine || null, branding.country].filter(
    (line): line is string => line !== null && line !== '',
  );
}

function PublicInvoiceDocument({ view }: { readonly view: PublicInvoiceView }): ReactElement {
  const { branding } = view;
  // The org's own colour, inlined as data rather than written as a literal — `CLAUDE.md`'s
  // distinction, and the reason `openbooks/no-raw-color` does not fire on this file: the
  // rule reads source text for colour literals, and there is none here, only a variable
  // that happens to hold one.
  const accentStyle: CSSProperties | undefined =
    branding.brandColor === null ? undefined : { backgroundColor: branding.brandColor };

  return (
    <PublicInvoiceShell>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div aria-hidden className="h-1.5 w-full bg-accent" style={accentStyle} />

        <div className="flex flex-col gap-6 p-6 sm:p-8">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {branding.logoUrl !== null && (
                <img
                  src={branding.logoUrl}
                  alt={`${branding.displayName} logo`}
                  className="h-12 w-auto max-w-40 object-contain"
                />
              )}
              <div className="flex flex-col">
                <span className="font-semibold text-text">{branding.displayName}</span>
                {addressLines(branding).map((line) => (
                  <span key={line} className="text-xs text-text-subtle">
                    {line}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-col items-end text-right">
              <span className="text-lg font-semibold text-text">Invoice {view.documentNumber}</span>
              <span className="text-sm text-text-muted">Issued {view.issueDate}</span>
              <span className="text-sm text-text-muted">Due {view.dueDate}</span>
              {view.reference !== null && (
                <span className="text-xs text-text-subtle">Ref {view.reference}</span>
              )}
            </div>
          </header>

          <div>
            <p className="text-xs font-medium text-text-subtle">Billed to</p>
            <p className="text-sm text-text">{view.customerName}</p>
          </div>

          {view.memo !== null && <p className="text-sm text-text-muted">{view.memo}</p>}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Invoice lines</caption>
              <thead>
                <tr className="text-left text-xs text-text-subtle">
                  <th scope="col" className="p-1 font-medium">
                    Description
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Qty
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Unit price
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Tax
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line, index) => (
                  // No `lineId` on the customer-safe line (`publicInvoiceLineSchema` strips
                  // internal identifiers), so the row is keyed by position in an
                  // immutable, server-ordered array rather than by anything this page
                  // invents.
                  <tr key={index} className="border-t border-border">
                    <td className="p-1 text-text">{line.description}</td>
                    <td className="p-1 text-right font-mono text-text-muted">{line.quantity}</td>
                    <td className="p-1 text-right font-mono tabular-nums text-text">
                      {formatMinorUnits(line.unitAmount)}
                    </td>
                    <td className="p-1 text-right font-mono tabular-nums text-text">
                      {formatMinorUnits(line.taxAmount)}
                    </td>
                    <td className="p-1 text-right font-mono tabular-nums text-text">
                      {formatMinorUnits(line.grossAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <dl className="flex w-full max-w-xs flex-col gap-1">
              <TotalRow label="Net" value={view.totals.net} />
              <TotalRow label="Tax" value={view.totals.tax} />
              <TotalRow label="Total" value={view.totals.gross} emphasis />
            </dl>
          </div>

          {view.taxSummary.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-border pt-3">
              <p className="text-xs font-medium text-text-muted">Tax summary</p>
              <dl className="flex flex-col gap-1">
                {view.taxSummary.map((row) => (
                  <TotalRow
                    key={`${row.taxRateName ?? 'untaxed'}-${row.percentage ?? ''}`}
                    label={
                      row.taxRateName === null
                        ? 'Untaxed'
                        : `${row.taxRateName}` +
                          (row.percentage === null ? '' : ` (${row.percentage}%)`)
                    }
                    value={row.tax}
                  />
                ))}
              </dl>
            </div>
          )}

          <div
            className={cx(
              'flex flex-wrap items-center justify-between gap-3',
              'border-t border-border pt-4',
            )}
          >
            {branding.invoiceFooter !== null && (
              <p className="max-w-prose text-xs text-text-subtle">{branding.invoiceFooter}</p>
            )}
            <a
              href={view.pdfUrl}
              className={cx(
                'ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface',
                'px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover',
              )}
            >
              Download PDF
            </a>
          </div>
        </div>
      </div>
    </PublicInvoiceShell>
  );
}

function TotalRow({
  label,
  value,
  emphasis,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt
        className={
          emphasis === true ? 'text-sm font-semibold text-text' : 'text-sm text-text-muted'
        }
      >
        {label}
      </dt>
      <dd
        className={
          emphasis === true
            ? 'font-mono text-sm font-semibold tabular-nums text-text'
            : 'font-mono text-sm tabular-nums text-text'
        }
      >
        {formatMinorUnits(value)}
      </dd>
    </div>
  );
}
