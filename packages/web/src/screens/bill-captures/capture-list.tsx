import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { Button, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { PillTone } from '../settings/section';
import type { CaptureStatus, DocumentCapture, ReferenceData } from './queries';

/**
 * A page of captures — the review queue and the settled ones alike, depending on the
 * status filter the screen above holds.
 *
 * `EmptyRow`, `Pill` and the table class strings come from `settings/section.tsx` rather
 * than being redrawn here. That module is explicit about not being a component library
 * (D-24 — "a seventh shared component arrives with the screen that needs it") but these
 * four are presentational atoms with no settings-specific behaviour, and importing them is
 * cheaper than a fourth copy of the same table chrome `dimensions.tsx`, `dunning/
 * policy-list.tsx` and `purchases/document-list.tsx` each already carry a version of.
 */
export interface CaptureListProps {
  readonly items: readonly DocumentCapture[];
  readonly isPending: boolean;
  readonly reference: ReferenceData;
  readonly onReview: (capture: DocumentCapture) => void;
  readonly onDismiss: (capture: DocumentCapture) => void;
}

const STATUS_LABELS: Readonly<Record<CaptureStatus, string>> = {
  extracting: 'Extracting…',
  extracted: 'Needs review',
  failed: 'Failed',
  drafted: 'Drafted',
  dismissed: 'Dismissed',
};

const STATUS_TONES: Readonly<Record<CaptureStatus, PillTone>> = {
  extracting: 'neutral',
  extracted: 'positive',
  failed: 'negative',
  drafted: 'muted',
  dismissed: 'muted',
};

const SOURCE_LABELS: Readonly<Record<DocumentCapture['source'], string>> = {
  upload: 'Upload',
  email: 'Email',
};

function formatCreatedAt(iso: string): string {
  // The calendar date a person reads at a glance, in their own timezone-naive form — the
  // `createdAt` instant carries a time nobody triaging a queue needs.
  return iso.slice(0, 10);
}

function vendorNameOf(capture: DocumentCapture, reference: ReferenceData): string {
  if (capture.matchedContactId !== null) {
    const matched = reference.vendorsById.get(capture.matchedContactId);
    if (matched !== undefined) return matched.displayName;
  }
  return capture.extractedVendorName ?? '—';
}

export function CaptureList({
  items,
  isPending,
  reference,
  onReview,
  onDismiss,
}: CaptureListProps): ReactElement {
  return (
    <table className={TABLE_CLASSES}>
      <caption className="sr-only">Bill captures</caption>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASSES}>
            File
          </th>
          <th scope="col" className={TH_CLASSES}>
            Source
          </th>
          <th scope="col" className={TH_CLASSES}>
            Status
          </th>
          <th scope="col" className={TH_CLASSES}>
            Vendor
          </th>
          <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
            Total
          </th>
          <th scope="col" className={TH_CLASSES}>
            Received
          </th>
          <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 && (
          <EmptyRow columns={7}>
            {isPending
              ? 'Loading…'
              : 'No captures match this filter. Upload a bill, or forward one to the address above.'}
          </EmptyRow>
        )}
        {items.map((capture) => (
          <tr key={capture.id}>
            <td className={TD_CLASSES}>
              <span className="text-text">{capture.filename}</span>
            </td>
            <td className={TD_CLASSES}>{SOURCE_LABELS[capture.source]}</td>
            <td className={TD_CLASSES}>
              <Pill tone={STATUS_TONES[capture.status]}>{STATUS_LABELS[capture.status]}</Pill>
              {capture.status === 'failed' && capture.extractionError !== null && (
                <span className="mt-1 block max-w-64 text-xs text-text-subtle">
                  {capture.extractionError}
                </span>
              )}
            </td>
            <td className={TD_CLASSES}>{vendorNameOf(capture, reference)}</td>
            <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
              {capture.extractedTotalMinor === null
                ? '—'
                : formatMinorUnits(capture.extractedTotalMinor)}
            </td>
            <td className={cx(TD_CLASSES, 'font-mono text-text-muted')}>
              {formatCreatedAt(capture.createdAt)}
            </td>
            <td className={cx(TD_CLASSES, 'text-right')}>
              <div className="flex items-center justify-end gap-1">
                {capture.status === 'extracted' && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onReview(capture);
                    }}
                  >
                    Review
                  </Button>
                )}
                {(capture.status === 'extracted' || capture.status === 'failed') && (
                  <Button
                    size="sm"
                    onClick={() => {
                      onDismiss(capture);
                    }}
                  >
                    Dismiss
                  </Button>
                )}
                {capture.status === 'drafted' && (
                  <Link
                    to="/purchases"
                    className="text-xs font-medium text-accent underline-offset-2 hover:underline"
                  >
                    View in Purchases
                  </Link>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
