import type { ChangeEvent, ReactElement } from 'react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { newIdempotencyKey } from '../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
} from '../components';
import type { SelectOption } from '../components';
import { CaptureList } from './bill-captures/capture-list';
import {
  useBillCaptures,
  useCreateBillCapture,
  useDismissBillCapture,
  useInboundBillEmailAddress,
  useReferenceData,
} from './bill-captures/queries';
import type { Bill, CaptureStatus, DocumentCapture } from './bill-captures/queries';
import { ReviewDialog } from './bill-captures/review-dialog';
import {
  isCaptureContentType,
  readCaptureFileAsBase64,
  UnsupportedCaptureTypeError,
} from './bill-captures/upload';
import { Notice } from './settings/section';

/**
 * Bill capture review (OB-189) — the front end for the extraction backend built ahead of
 * it: upload a bill or forward one to the org's inbound address, let extraction read it,
 * then turn what it found into a draft bill in `purchases` (`POST .../draft`, "the same
 * shape as `CreateBillRequest`" per the schema's own description).
 *
 * ## What this screen is not
 *
 * It does not post anything to the ledger. `createDraftFromBillCapture` returns a `draft`
 * bill (D-38's status, unposted) exactly as `purchases`' own "New bill" does — this is a
 * faster way to start that same draft from a document instead of a blank form, and
 * everything after the draft exists (edit further, approve, void) is `purchases`' screen,
 * not this one's. `CaptureList`'s "View in Purchases" link and the notice after a
 * successful review both point there rather than duplicating any of it here.
 *
 * ## Write controls are not hidden by permission (D-25)
 *
 * Matching `dunning.tsx` and `sales.tsx`: nothing here hides Upload, Review or Dismiss
 * because a role lacks the permission. `requirePermission` is enforced service-side, and a
 * caller who lacks it meets the refusal as a `permission_denied` `ErrorBanner`.
 */
const CAPTURE_STATUSES: readonly CaptureStatus[] = [
  'extracting',
  'extracted',
  'failed',
  'drafted',
  'dismissed',
];

function asCaptureStatus(value: string): CaptureStatus | null {
  return CAPTURE_STATUSES.find((status) => status === value) ?? null;
}

const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: 'extracted', label: 'Needs review' },
  { value: 'extracting', label: 'Extracting' },
  { value: 'failed', label: 'Failed' },
  { value: 'drafted', label: 'Drafted' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All statuses' },
];

export function BillCapturesScreen(): ReactElement {
  // `extracted` by default — the review queue, which is the reason this screen exists
  // (the ticket's own framing: "the ones needing review").
  const [status, setStatus] = useState<CaptureStatus | null>('extracted');
  const [reviewing, setReviewing] = useState<DocumentCapture | null>(null);
  const [dismissing, setDismissing] = useState<DocumentCapture | null>(null);
  const [justCreated, setJustCreated] = useState<Bill | null>(null);
  const [uploadError, setUploadError] = useState<unknown>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const captures = useBillCaptures(status);
  const reference = useReferenceData();
  const inboundAddress = useInboundBillEmailAddress();
  const uploadCapture = useCreateBillCapture();
  const dismissCapture = useDismissBillCapture();

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice in a row still fires `onChange`.
    event.target.value = '';
    if (file === undefined) return;

    setUploadError(null);
    setJustCreated(null);

    const contentType = file.type;
    if (!isCaptureContentType(contentType)) {
      setUploadError(new UnsupportedCaptureTypeError(contentType));
      return;
    }

    try {
      const content = await readCaptureFileAsBase64(file);
      await uploadCapture.mutateAsync({
        filename: file.name,
        contentType,
        content,
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      setUploadError(error);
    }
  }

  function handleDismiss(): void {
    if (dismissing === null) return;
    dismissCapture.mutate(
      { captureId: dismissing.id, idempotencyKey: newIdempotencyKey() },
      { onSuccess: () => setDismissing(null) },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Bill captures</h1>
        <div className="flex-1" />
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Bill file"
          accept="application/pdf,image/png,image/jpeg"
          className="hidden"
          onChange={(event) => {
            void handleFile(event);
          }}
        />
        <Button
          variant="primary"
          disabled={uploadCapture.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploadCapture.isPending ? 'Uploading…' : 'Upload a bill'}
        </Button>
      </div>

      {inboundAddress.data !== undefined && (
        <Notice tone="info">
          Bills can also be forwarded to{' '}
          <span className="font-mono text-text">{inboundAddress.data.address}</span> and they appear
          here once extraction has read them.
        </Notice>
      )}

      {uploadError !== null && (
        <ErrorBanner
          error={uploadError}
          onRetry={() => {
            setUploadError(null);
          }}
        />
      )}

      {justCreated !== null && (
        <Notice
          tone="success"
          title="Draft bill created"
          actions={
            <Link
              to="/purchases"
              className="text-sm font-medium underline-offset-2 hover:underline"
            >
              Open in Purchases
            </Link>
          }
        >
          {justCreated.reference !== null &&
            justCreated.reference !== '' &&
            `Vendor’s number ${justCreated.reference}. `}
          Nothing has posted to the ledger yet — approve the draft in Purchases when it is ready.
        </Notice>
      )}

      {captures.error !== null && <ErrorBanner error={captures.error} onRetry={captures.refetch} />}
      {reference.error !== null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}
      {dismissCapture.isError && <ErrorBanner error={dismissCapture.error} />}

      <Field className="w-56">
        <FieldLabel>Status</FieldLabel>
        <Select
          value={status ?? 'all'}
          options={STATUS_FILTER_OPTIONS}
          onValueChange={(value) => {
            setStatus(asCaptureStatus(value));
          }}
        />
      </Field>

      {reference.data === null ? (
        <p className="text-text-subtle">Loading vendors, accounts and tax rates…</p>
      ) : (
        <CaptureList
          items={captures.items}
          isPending={captures.isPending}
          reference={reference.data}
          onReview={(capture) => {
            setJustCreated(null);
            setReviewing(capture);
          }}
          onDismiss={(capture) => {
            dismissCapture.reset();
            setDismissing(capture);
          }}
        />
      )}

      {captures.truncated && (
        <p className="text-xs text-text-subtle">
          Showing the first page. Narrow the status filter to reach the rest.
        </p>
      )}

      {reference.data !== null && (
        <ReviewDialog
          capture={reviewing}
          reference={reference.data}
          onClose={() => setReviewing(null)}
          onCreated={(bill) => {
            setReviewing(null);
            setJustCreated(bill);
          }}
        />
      )}

      <Dialog
        open={dismissing !== null}
        onOpenChange={(open) => {
          if (!open) setDismissing(null);
        }}
      >
        <DialogContent
          title="Dismiss this capture?"
          description={
            'The file and what extraction read from it are kept, but it drops out of the ' +
            'review queue and no draft bill is created from it.'
          }
          footer={
            <>
              <DialogClose asChild>
                <Button>Keep it</Button>
              </DialogClose>
              <Button variant="danger" disabled={dismissCapture.isPending} onClick={handleDismiss}>
                Dismiss capture
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            {dismissing?.filename} — this can be undone only by uploading the document again.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
