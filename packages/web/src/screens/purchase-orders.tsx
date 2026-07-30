import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../components';
import { PurchaseOrderList } from './purchase-orders/list';
import { OrderFormDialog } from './purchase-orders/order-form';
import {
  useApprovePurchaseOrder,
  useConvertPurchaseOrderToBill,
  useDiscardPurchaseOrder,
  useIntentKey,
  usePurchaseOrderList,
  usePurchaseOrderReferenceData,
} from './purchase-orders/queries';
import type { PurchaseOrderSummary } from './purchase-orders/queries';
import { SendOrderDialog } from './purchase-orders/send-dialog';

/**
 * Purchase orders (D-M3, D-M6, D-M7) — the vendor-facing pre-document that moves
 * `draft → approved → converted` and posts no journal of its own at any stage.
 * `convertPurchaseOrderToBill` is the only door from here into the ledger, and it opens
 * onto a **draft** bill (`packages/web/src/screens/purchases/`) that still needs its own
 * approval — this screen never posts anything directly.
 *
 * ## Two surfaces, `fixed-assets.tsx`'s shape
 *
 * A register (`purchase-orders/list.tsx`) and one dialog for creating or editing a draft
 * (`purchase-orders/order-form.tsx`). There is no third, detail-view surface here the way
 * `fixed-assets.tsx` adds a schedule drill-down — a purchase order has nothing analogous
 * to a depreciation schedule to show, and once approved there is nothing left to edit
 * (`updatePurchaseOrder` answers `purchase_order_approved`), so the row actions (Approve,
 * Convert to bill, Send, Discard) are the whole surface past creation.
 *
 * ## What is read, never derived
 *
 * `status`, `documentNumber` and `totals` all come straight off the response. Approval
 * allocates the gapless number (D-M6); conversion is convert-once and the server's own
 * refusal — `purchase_order_already_converted` — is what actually enforces that, not a
 * client-side guess about whether it has happened yet.
 */
export function PurchaseOrdersScreen(): ReactElement {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<PurchaseOrderSummary | null>(null);
  const [sending, setSending] = useState<PurchaseOrderSummary | null>(null);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reference = usePurchaseOrderReferenceData();
  const list = usePurchaseOrderList(null);
  const intentKey = useIntentKey();

  const approve = useApprovePurchaseOrder();
  const convert = useConvertPurchaseOrderToBill();
  const discard = useDiscardPurchaseOrder();

  const orders = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  function handleApprove(order: PurchaseOrderSummary): void {
    setNotice(null);
    setActionPendingId(order.id);
    approve.mutate(
      { purchaseOrderId: order.id, idempotencyKey: intentKey(`approve:${order.id}`) },
      {
        onSuccess: (approved) => {
          setNotice(`Approved ${approved.documentNumber ?? 'the purchase order'}.`);
        },
        onSettled: () => {
          setActionPendingId(null);
        },
      },
    );
  }

  function handleConvert(order: PurchaseOrderSummary): void {
    setNotice(null);
    setActionPendingId(order.id);
    convert.mutate(
      { purchaseOrderId: order.id, idempotencyKey: intentKey(`convert:${order.id}`) },
      {
        onSuccess: (bill) => {
          setNotice(
            `Converted to draft bill ${bill.documentNumber ?? bill.id} — approve it on the ` +
              'Purchases screen to reach the ledger.',
          );
        },
        onSettled: () => {
          setActionPendingId(null);
        },
      },
    );
  }

  function handleDiscard(): void {
    if (discarding === null) return;
    const order = discarding;
    setActionPendingId(order.id);
    discard.mutate(
      { purchaseOrderId: order.id, idempotencyKey: intentKey(`discard:${order.id}`) },
      {
        onSuccess: () => {
          setNotice(`Discarded ${order.documentNumber ?? 'the draft'}.`);
        },
        onSettled: () => {
          setActionPendingId(null);
          setDiscarding(null);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Purchase orders</h1>
          <p className="max-w-form text-text-muted">
            A non-posting pre-document to a vendor. Approving allocates its number; converting
            builds a draft bill from its lines. Nothing here reaches the ledger until that bill is
            itself approved.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={reference.data === null}
          onClick={() => {
            setEditingId(null);
            setFormOpen(true);
          }}
        >
          New purchase order
        </Button>
      </div>

      {notice !== null && (
        <p
          role="status"
          className="rounded-lg border border-success-border bg-success-soft p-3 text-sm text-success-text"
        >
          {notice}
        </p>
      )}

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {approve.isError && <ErrorBanner error={approve.error} />}
      {convert.isError && <ErrorBanner error={convert.error} />}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading vendors and accounts…</p>
      ) : (
        <>
          <PurchaseOrderList
            orders={orders}
            reference={reference.data}
            loading={list.isPending}
            emptyMessage="No purchase orders yet."
            actionPendingId={actionPendingId}
            onEdit={(order) => {
              setEditingId(order.id);
              setFormOpen(true);
            }}
            onApprove={handleApprove}
            onConvert={handleConvert}
            onSend={(order) => {
              setSending(order);
            }}
            onDiscard={(order) => {
              setDiscarding(order);
            }}
          />

          {list.hasNextPage && (
            <div>
              <Button
                disabled={list.isFetchingNextPage}
                onClick={() => {
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}

          <OrderFormDialog
            orderId={editingId}
            reference={reference.data}
            open={formOpen}
            onOpenChange={(open) => {
              setFormOpen(open);
              if (!open) setEditingId(null);
            }}
          />

          <SendOrderDialog
            order={sending}
            reference={reference.data}
            onOpenChange={(open) => {
              if (!open) setSending(null);
            }}
          />

          <Dialog
            open={discarding !== null}
            onOpenChange={(open) => {
              if (!open) setDiscarding(null);
            }}
          >
            {discarding !== null && (
              <DialogContent
                title={`Discard ${discarding.documentNumber ?? 'this draft'}?`}
                description="Deletes the draft and its lines. Nothing was approved and no number was allocated, so nothing is restated and no gap is left."
                footer={
                  <>
                    <DialogClose asChild>
                      <Button disabled={discard.isPending}>Keep editing</Button>
                    </DialogClose>
                    <Button variant="danger" disabled={discard.isPending} onClick={handleDiscard}>
                      {discard.isPending ? 'Discarding…' : 'Discard'}
                    </Button>
                  </>
                }
              >
                {discard.isError && <ErrorBanner error={discard.error} />}
              </DialogContent>
            )}
          </Dialog>
        </>
      )}
    </div>
  );
}
