import type { ReactElement, ReactNode } from 'react';

import { Pill } from '../../components';
import { isExpired, statusPresentation } from './estimate-presentation';
import type { Estimate } from './queries';
import { PLURAL, SINGULAR } from './vocabulary';

/**
 * The breadcrumb + title + status row shared by the read-only detail view, the editor, and
 * the compact mobile view — the estimates mirror of `sales/document-header.tsx`'s
 * `DocumentHeader` (estimates redesign, AGENT E-LEAVES; consumed by AGENT E-DETAIL and
 * AGENT E-EDITOR). There is only one document kind here, so the breadcrumb is one level
 * shorter than the sales version's `Sales › Invoices › …` — `Estimates › …` is the whole
 * trail.
 *
 * `document` is nullable for the same reason it is on the sales side: the editor's pre-save
 * instant (and a detail view mid-fetch) has nothing yet for `statusPresentation` to read
 * `status`/`convertedInvoiceId`/`expiryDate` off of, so a null document falls back to a
 * plain "Draft" pill rather than calling that helper with nothing to give it.
 */
export interface EstimateHeaderProps {
  readonly document: Estimate | null;
  readonly asOf: string;
  readonly actions: ReactNode;
  readonly onNavigateList: () => void;
}

export function EstimateHeader({
  document,
  asOf,
  actions,
  onNavigateList,
}: EstimateHeaderProps): ReactElement {
  const title =
    document?.documentNumber != null
      ? `#${document.documentNumber}`
      : `New ${SINGULAR.toLowerCase()}`;
  const presentation = document
    ? statusPresentation(document, asOf)
    : { label: 'Draft', tone: 'muted' as const };
  const expired = document !== null && isExpired(document, asOf);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1.5 text-xs uppercase text-text-subtle">
              <li>
                <button type="button" onClick={onNavigateList} className="hover:underline">
                  {PLURAL}
                </button>
              </li>
              <li aria-hidden>›</li>
              <li aria-current="page" className="text-text">
                {title}
              </li>
            </ol>
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-text">
              {document?.documentNumber ?? `New ${SINGULAR.toLowerCase()}`}
            </h1>
            {/* `Pill` takes no className (it is a fixed-shape badge, not a styling
                primitive) — uppercasing the label text is what the mockup's all-caps
                pill amounts to here. */}
            <Pill tone={presentation.tone}>{presentation.label.toUpperCase()}</Pill>
            {expired && <span className="text-sm font-semibold text-danger-text">Expired</span>}
          </div>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}
