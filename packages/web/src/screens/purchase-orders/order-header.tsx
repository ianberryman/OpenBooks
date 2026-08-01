import type { ReactElement, ReactNode } from 'react';

import { Pill } from '../../components';
import { statusPresentation } from './order-presentation';
import type { PurchaseOrder } from './queries';
import { PLURAL, SINGULAR } from './vocabulary';

/**
 * The breadcrumb + title + status row shared by the read-only detail view, the editor, and the
 * compact mobile view — the AP-side mirror of `estimates/estimate-header.tsx`. There is only one
 * document kind here, so the breadcrumb is one level short: `Purchase orders › …` is the whole
 * trail.
 *
 * `document` is nullable for the same reason it is on the estimate side: the editor's pre-save
 * instant (and a detail view mid-fetch) has nothing yet for `statusPresentation` to read
 * `status` off of, so a null document falls back to a plain "Draft" pill rather than calling
 * that helper with nothing to give it.
 *
 * Unlike the estimate header there is no "Expired" line: a purchase order does not lapse
 * (`expectedDate` is an informational delivery date, not a deadline), so the pill is just the
 * stored `status` — `order-presentation.ts`'s `statusPresentation` takes no `asOf` at all.
 */
export interface OrderHeaderProps {
  readonly document: PurchaseOrder | null;
  readonly actions: ReactNode;
  readonly onNavigateList: () => void;
}

export function OrderHeader({ document, actions, onNavigateList }: OrderHeaderProps): ReactElement {
  const crumb =
    document?.documentNumber != null
      ? `#${document.documentNumber}`
      : `New ${SINGULAR.toLowerCase()}`;
  const heading =
    document?.documentNumber != null
      ? `${SINGULAR} #${document.documentNumber}`
      : `New ${SINGULAR.toLowerCase()}`;
  const presentation = document
    ? statusPresentation(document)
    : { label: 'Draft', tone: 'muted' as const };

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
                {crumb}
              </li>
            </ol>
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-text">{heading}</h1>
            {/* `Pill` takes no className (it is a fixed-shape badge, not a styling primitive) —
                uppercasing the label text is what the mockup's all-caps pill amounts to here. */}
            <Pill tone={presentation.tone}>{presentation.label.toUpperCase()}</Pill>
          </div>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}
