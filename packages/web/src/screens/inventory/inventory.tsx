import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '../../components';
import { StockAdjustmentDialog } from './adjustment-form';
import { ItemFormDialog } from './item-form';
import { ReorderAlertsView } from './reorder';
import { InventorySettingsPanel } from './settings-panel';
import { InventoryStockList } from './valuation';

/**
 * Tracked inventory (OB-224) — the operational hub: on-hand quantity and value by catalog
 * item (each a link into its own movement ledger, `item-detail.tsx`), items at or below
 * their reorder point, and the two writes this milestone offers — registering a tracked
 * item and posting a signed stock adjustment. `fixed-assets.tsx`'s composition shape: a
 * heading and the screen's primary actions above the read models it exists to show.
 *
 * Settings collapses below the operational content by default (`showSettings`) — the
 * shrinkage-account nomination is configured once per org and read rarely, so it does not
 * compete with the stock list and alerts for the first screenful.
 */
export function InventoryScreen(): ReactElement {
  const [adjusting, setAdjusting] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Inventory</h1>
          <p className="max-w-form text-text-muted">
            On-hand quantity and value by item, the items that have fallen to or below their reorder
            point, and each item's own movement history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setCreatingItem(true);
            }}
          >
            New tracked item
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setAdjusting(true);
            }}
          >
            Adjust stock
          </Button>
        </div>
      </div>

      <ReorderAlertsView />

      <InventoryStockList />

      <div className="flex flex-col gap-3">
        <Button
          size="sm"
          onClick={() => {
            setShowSettings((current) => !current);
          }}
          aria-expanded={showSettings}
        >
          {showSettings ? 'Hide inventory settings' : 'Inventory settings'}
        </Button>
        {showSettings && <InventorySettingsPanel />}
      </div>

      <ItemFormDialog
        open={creatingItem}
        onOpenChange={(open) => {
          setCreatingItem(open);
        }}
      />

      <StockAdjustmentDialog
        open={adjusting}
        onOpenChange={(open) => {
          setAdjusting(open);
        }}
      />
    </div>
  );
}
