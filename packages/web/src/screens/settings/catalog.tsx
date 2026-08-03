import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../../api';
import {
  Button,
  ErrorBanner,
  Field,
  FieldLabel,
  Pill,
  ResponsiveTable,
  Select,
  TextInput,
  formatMoney,
} from '../../components';
import { cx } from '../../lib/cx';
import { CatalogItemDialog } from './catalog-item-dialog';
import type { CatalogDirection, CatalogItem, CatalogItemFilters } from './catalog-queries';
import {
  useCatalogItemList,
  useDeactivateCatalogItem,
  useReactivateCatalogItem,
} from './catalog-queries';
import { EmptyRow, SettingsSection, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from './section';

/**
 * The item catalog (initiative Catalog, D-CAT-1…5): a list-plus-form of reusable, priced
 * items a document line can be selected from, mirroring `payment-terms.tsx`/`dimensions.tsx`'s
 * shape — a bounded catalog with create, edit and a one-way deactivation, not a paged view of
 * transactional data.
 *
 * ## Deactivate, not delete
 *
 * An item any line already cites cannot be deleted — the FK is `ON DELETE RESTRICT` (D-CAT-5)
 * — so the only removal offered is deactivation, which keeps every line that named it and
 * stops the item being offered for a new one. It is reversible (Reactivate), so it needs no
 * confirmation the way an irreversible delete would.
 */

type DirectionFilter = 'all' | CatalogDirection;
type StatusFilter = 'active' | 'all';

const DIRECTION_FILTER_OPTIONS = [
  { value: 'all', label: 'Sales and purchase' },
  { value: 'sales', label: 'Sales' },
  { value: 'purchase', label: 'Purchase' },
];

const STATUS_FILTER_OPTIONS = [
  { value: 'active', label: 'Active only' },
  { value: 'all', label: 'Active and archived' },
];

const DIRECTION_LABELS: Readonly<Record<CatalogDirection, string>> = {
  sales: 'Sales',
  purchase: 'Purchase',
  inventory: 'Inventory',
};

type CatalogDialog =
  { readonly kind: 'create' } | { readonly kind: 'edit'; readonly item: CatalogItem };

export function CatalogSection(): ReactElement {
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<CatalogDialog | null>(null);

  const filters: CatalogItemFilters = {
    direction: directionFilter === 'all' ? null : directionFilter,
    isActive: statusFilter === 'active' ? true : null,
    q: search,
  };

  const list = useCatalogItemList(filters);
  const deactivate = useDeactivateCatalogItem();
  const reactivate = useReactivateCatalogItem();

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <SettingsSection
      title="Items"
      description={
        <>
          Reusable, priced items a document line can be selected from &mdash; a convenience that
          seeds the line&rsquo;s description, price, account and tax, and never binds it. A thing
          you both buy and sell is two items, one per direction.
        </>
      }
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setDialog({ kind: 'create' });
          }}
        >
          New item
        </Button>
      }
    >
      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}
      {deactivate.isError && <ErrorBanner error={deactivate.error} />}
      {reactivate.isError && <ErrorBanner error={reactivate.error} />}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-56">
          <FieldLabel>Direction</FieldLabel>
          <Select
            value={directionFilter}
            options={DIRECTION_FILTER_OPTIONS}
            onValueChange={(value) => {
              setDirectionFilter(
                value === 'sales' ? 'sales' : value === 'purchase' ? 'purchase' : 'all',
              );
            }}
          />
        </Field>
        <Field className="w-56">
          <FieldLabel>Show</FieldLabel>
          <Select
            value={statusFilter}
            options={STATUS_FILTER_OPTIONS}
            onValueChange={(value) => {
              setStatusFilter(value === 'all' ? 'all' : 'active');
            }}
          />
        </Field>
        <Field className="min-w-48 flex-1">
          <FieldLabel>Search</FieldLabel>
          <TextInput
            value={search}
            placeholder="Name or code"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </Field>
      </div>

      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Catalog items</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Name
              </th>
              <th scope="col" className={TH_CLASSES}>
                Code
              </th>
              <th scope="col" className={TH_CLASSES}>
                Direction
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Default price
              </th>
              <th scope="col" className={TH_CLASSES}>
                Status
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <EmptyRow columns={6}>
                {list.isPending
                  ? 'Loading…'
                  : 'No items yet. Lines are typed by hand until one exists.'}
              </EmptyRow>
            )}
            {items.map((item) => (
              <tr key={item.id}>
                <td className={TD_CLASSES}>{item.name}</td>
                <td className={cx(TD_CLASSES, 'font-mono')}>
                  {item.code === null ? <span className="text-text-subtle">—</span> : item.code}
                </td>
                <td className={TD_CLASSES}>{DIRECTION_LABELS[item.direction]}</td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {item.defaultUnitAmount === null ? (
                    <span className="text-text-subtle">—</span>
                  ) : (
                    formatMoney(item.defaultUnitAmount)
                  )}
                </td>
                <td className={TD_CLASSES}>
                  <Pill tone={item.isActive ? 'positive' : 'muted'}>
                    {item.isActive ? 'Active' : 'Archived'}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      onClick={() => {
                        setDialog({ kind: 'edit', item });
                      }}
                    >
                      Edit
                    </Button>
                    {item.isActive ? (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Archive ${item.name}`}
                        disabled={deactivate.isPending}
                        onClick={() => {
                          deactivate.mutate({
                            catalogItemId: item.id,
                            idempotencyKey: newIdempotencyKey(),
                          });
                        }}
                      >
                        Archive
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        aria-label={`Reactivate ${item.name}`}
                        disabled={reactivate.isPending}
                        onClick={() => {
                          reactivate.mutate({
                            catalogItemId: item.id,
                            idempotencyKey: newIdempotencyKey(),
                          });
                        }}
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

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

      <CatalogItemDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        item={dialog?.kind === 'edit' ? dialog.item : null}
      />
    </SettingsSection>
  );
}
