import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, Select } from '../components';
import { BudgetGrid } from './budgets/grid';
import {
  budgetsForSlice,
  useBudgetList,
  useDimensionValues,
  useDimensions,
  useFiscalPeriods,
  useIntentKey,
  usePlAccounts,
  useSetBudgets,
} from './budgets/queries';
import type { SetBudgetsRequest } from './budgets/queries';

/**
 * Budgets (OB-180…184; ROADMAP D-N1…D-N6) — entering and editing the figures the
 * budget-vs-actual report (`reports/*`, owned by another author and not touched here)
 * compares actuals against.
 *
 * ## One period, one slice, one grid
 *
 * A budget slot is `(account, period, optional dimension value)` — `Budget`'s own words —
 * so this screen is organized the same way: pick the period, optionally narrow to one
 * dimension value, and the grid underneath is every P&L account's figure for exactly that
 * slot. Only revenue and expense accounts are budgeted in v1 (D-N2); asset, liability and
 * equity accounts never appear in the grid because `usePlAccounts` never fetches them into
 * it.
 *
 * ## Why the grid is a batch, not a row of independent saves
 *
 * `setBudgets` is a single batch upsert (D-N5) — enter a whole period's revenue and expense
 * targets in one sitting and send them together, the natural shape of building a budget
 * rather than committing to a ledger entry at a time. One idempotency key covers the whole
 * batch, minted once at the press of Save (`useIntentKey`), so a retry after a dropped
 * response replays the same batch rather than risking a second one with a fresh key.
 */

/**
 * Radix warns on an empty-string `Select` value (`components/select.tsx`'s own note), so
 * "no dimension chosen" needs a real sentinel rather than `''`.
 */
const NO_DIMENSION = 'none';

export function BudgetsScreen(): ReactElement {
  const periods = useFiscalPeriods();
  const accounts = usePlAccounts();
  const dimensions = useDimensions();

  const [periodId, setPeriodId] = useState<string | null>(null);
  const [dimensionId, setDimensionId] = useState<string | null>(null);
  const [dimensionValueId, setDimensionValueId] = useState<string | null>(null);
  const [saveVersion, setSaveVersion] = useState(0);
  const [pendingEntries, setPendingEntries] = useState<ReadonlyMap<string, string>>(new Map());

  const dimensionValues = useDimensionValues(dimensionId);
  const list = useBudgetList({ periodId });
  const setBudgets = useSetBudgets();
  const intentKey = useIntentKey();

  const slice = useMemo(
    () => budgetsForSlice(list.data?.items ?? [], dimensionValueId),
    [list.data, dimensionValueId],
  );

  const periodOptions = useMemo(
    () =>
      (periods.data?.periods ?? []).map((period) => ({
        value: period.id,
        label: period.status === 'closed' ? `${period.name} — closed` : period.name,
      })),
    [periods.data],
  );

  const dimensionOptions = useMemo(
    () => [
      { value: NO_DIMENSION, label: 'Account total (no dimension)' },
      ...dimensions.map((dimension) => ({ value: dimension.id, label: dimension.name })),
    ],
    [dimensions],
  );

  const dimensionValueOptions = useMemo(
    () => dimensionValues.map((value) => ({ value: value.id, label: value.name })),
    [dimensionValues],
  );

  const gridReady = periodId !== null && (dimensionId === null || dimensionValueId !== null);
  const canSave = gridReady && pendingEntries.size > 0 && !setBudgets.isPending;

  function submit(): void {
    if (!gridReady || periodId === null) return;

    const entries: SetBudgetsRequest['entries'] = [...pendingEntries].map(
      ([accountId, amount]) => ({
        accountId,
        periodId,
        amount,
        ...(dimensionValueId === null ? {} : { dimensionValueId }),
      }),
    );
    if (entries.length === 0) return;

    setBudgets.mutate(
      {
        entries,
        idempotencyKey: intentKey(
          `set-budgets:${periodId}:${dimensionValueId ?? 'total'}:${JSON.stringify(entries)}`,
        ),
      },
      {
        onSuccess: () => {
          setPendingEntries(new Map());
          setSaveVersion((version) => version + 1);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Budgets</h1>
        <p className="max-w-form text-text-muted">
          Targets for one fiscal period's revenue and expense accounts, optionally scoped to one
          dimension value. Posts no journal — the budget-vs-actual report compares these figures to
          what actually posted.
        </p>
      </div>

      {periods.isError && (
        <ErrorBanner
          error={periods.error}
          onRetry={() => {
            void periods.refetch();
          }}
        />
      )}
      {accounts.error != null && <ErrorBanner error={accounts.error} onRetry={accounts.refetch} />}
      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}
      {setBudgets.isError && <ErrorBanner error={setBudgets.error} />}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-64">
          <FieldLabel>Fiscal period</FieldLabel>
          <Select
            value={periodId}
            options={periodOptions}
            placeholder="Choose a period…"
            onValueChange={(value) => {
              // `BudgetGrid`'s key includes `periodId`, so this alone remounts it with a
              // fresh seed; `pendingEntries` is reset here because it belongs to the screen,
              // not the grid, and would otherwise describe amounts for a period the user has
              // already left.
              setPeriodId(value);
              setPendingEntries(new Map());
            }}
          />
        </Field>

        <Field className="w-64">
          <FieldLabel>Dimension</FieldLabel>
          <Select
            value={dimensionId ?? NO_DIMENSION}
            options={dimensionOptions}
            onValueChange={(value) => {
              const nextDimensionId = value === NO_DIMENSION ? null : value;
              setDimensionId(nextDimensionId);
              setDimensionValueId(null);
              setPendingEntries(new Map());
            }}
          />
        </Field>

        {dimensionId !== null && (
          <Field className="w-64">
            <FieldLabel>Value</FieldLabel>
            <Select
              value={dimensionValueId}
              options={dimensionValueOptions}
              placeholder="Choose a value…"
              onValueChange={(value) => {
                setDimensionValueId(value);
                setPendingEntries(new Map());
              }}
            />
          </Field>
        )}

        <Button variant="primary" className="ml-auto" disabled={!canSave} onClick={submit}>
          {setBudgets.isPending ? 'Saving…' : 'Save budgets'}
        </Button>
      </div>

      {!gridReady && periodId !== null && dimensionId !== null && (
        <p className="text-text-subtle">Choose a value to budget for that dimension.</p>
      )}

      {periodId === null && <p className="text-text-subtle">Choose a fiscal period to begin.</p>}

      {gridReady && (accounts.data === null || list.data === undefined) && !list.isError && (
        <p className="text-text-subtle">Loading…</p>
      )}

      {gridReady && accounts.data !== null && list.data !== undefined && (
        <BudgetGrid
          // Remounted on the slice and on every successful save, both for the reason
          // `grid.tsx`'s own header gives: the amounts are draft state seeded once from
          // `budgets`, and a slice change or a completed save each need a fresh seed rather
          // than a diff against the previous one.
          key={`${periodId}:${dimensionValueId ?? 'total'}:${String(saveVersion)}`}
          accounts={accounts.data}
          budgets={slice}
          disabled={setBudgets.isPending}
          onDirtyChange={setPendingEntries}
        />
      )}
    </div>
  );
}
