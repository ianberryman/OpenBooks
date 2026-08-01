import type { ReactElement, ReactNode } from 'react';

import { Pill } from '../../components';
import { isOverdue, statusPresentation } from './invoice-list';
import type { SalesDocument, SalesDocumentKind } from './queries';
import { vocabularyFor } from './vocabulary';

/**
 * The breadcrumb + title + status row shared by the read-only detail, the editor, and the
 * compact receipt view (`mobile-document-view.tsx`) — the AR mirror of
 * `purchases/document-editor.tsx`'s inline header block (~L564-617), pulled out because
 * three sales screens now render it rather than one.
 *
 * `document` is nullable so the editor can pass it before the first save: a fresh draft has
 * no number yet, and `statusPresentation` needs a real document to read `status` and
 * `settlement` off of, so a null document falls back to a plain "Draft" pill rather than
 * calling that helper with nothing to give it.
 */
export interface DocumentHeaderProps {
  readonly kind: SalesDocumentKind;
  readonly document: SalesDocument | null;
  readonly asOf: string;
  readonly actions: ReactNode;
  readonly onNavigateList: () => void;
}

export function DocumentHeader({
  kind,
  document,
  asOf,
  actions,
  onNavigateList,
}: DocumentHeaderProps): ReactElement {
  const vocabulary = vocabularyFor(kind);
  const title =
    document?.documentNumber != null
      ? `#${document.documentNumber}`
      : `New ${vocabulary.singular.toLowerCase()}`;
  const presentation = document
    ? statusPresentation(document, asOf)
    : { label: 'Draft', tone: 'muted' as const };
  const pastDue = document !== null && isOverdue(document, asOf);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1.5 text-xs uppercase text-text-subtle">
              <li>
                <button type="button" onClick={onNavigateList} className="hover:underline">
                  Sales
                </button>
              </li>
              <li aria-hidden>›</li>
              <li>
                <button type="button" onClick={onNavigateList} className="hover:underline">
                  {vocabulary.plural}
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
              {document?.documentNumber ?? `New ${vocabulary.singular.toLowerCase()}`}
            </h1>
            {/* `Pill` takes no className (it is a fixed-shape badge, not a styling
                primitive) — uppercasing the label text is what the mockup's all-caps
                pill amounts to here. */}
            <Pill tone={presentation.tone}>{presentation.label.toUpperCase()}</Pill>
            {pastDue && <span className="text-sm font-semibold text-danger-text">Past due</span>}
          </div>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}
