import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '../../components';
import { StockAdjustmentDialog } from './adjustment-form';
import { ReorderAlertsView } from './reorder';
import { InventoryValuationView } from './valuation';

/**
 * Tracked inventory (OB-224) — on-hand quantity and value by catalog item, items at or
 * below their reorder point, and the one write this milestone offers: a signed stock
 * adjustment. `fixed-assets.tsx`'s composition shape: a heading and a primary action above
 * the read models the screen exists to show.
 *
 * There is no list of raw stock movements here (D-M2's precedent for "no separate ledger
 * view" applies the same way it does on `fixed-assets`) — the valuation report is a
 * snapshot of the current position, `reorder.tsx` is the same position filtered to what
 * needs acting on, and an adjustment's effect is read back as its posted `valueDelta`
 * rather than accumulated client-side.
 */
export function InventoryScreen(): ReactElement {
  const [adjusting, setAdjusting] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Inventory</h1>
          <p className="max-w-form text-text-muted">
            On-hand quantity and value by item, and the items that have fallen to or below their
            reorder point.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setAdjusting(true);
          }}
        >
          Adjust stock
        </Button>
      </div>

      <ReorderAlertsView />

      <InventoryValuationView />

      <StockAdjustmentDialog
        open={adjusting}
        onOpenChange={(open) => {
          setAdjusting(open);
        }}
      />
    </div>
  );
}
