import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldError,
  FieldLabel,
  TextInput,
  formatMoney,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { useCreateInventoryAdjustment, useInventoryValuation, useIntentKey } from './queries';
import type { CreateInventoryAdjustmentRequest, InventoryAdjustment } from './queries';

/**
 * The stock-adjustment form (OB-224) — the one write this screen offers, alongside the two
 * read-only reports (`valuation.tsx`, `reorder.tsx`). Each line names a catalog item and a
 * signed decimal quantity: negative is shrinkage or a write-off, positive is a found-stock
 * correction.
 *
 * ## Nothing here prices the movement
 *
 * A line's `valueDelta` is the server's costing, read off the posted `InventoryAdjustment`
 * and never estimated client-side — `fixed-assets/asset-form.tsx`'s discipline toward a
 * depreciation schedule it does not compute, applied to a costing method this screen has no
 * opinion about.
 *
 * ## The item picker's source
 *
 * Options come from the valuation report's rows (`useInventoryValuation(null)`), not a
 * catalog fetch — the valuation report already lists every item this org tracks stock for,
 * and a second fetch of the same set through the catalog endpoint would be a second source
 * of truth for "what counts as an inventory item" that could drift from the first.
 */

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

interface AdjustmentLineState {
  readonly key: string;
  readonly catalogItemId: string | null;
  readonly quantityDelta: string;
}

let nextLineKey = 0;

function blankLine(): AdjustmentLineState {
  nextLineKey += 1;
  return { key: `line-${String(nextLineKey)}`, catalogItemId: null, quantityDelta: '' };
}

/** A row nobody has touched. Dropped on save rather than complained about — an unused
 *  trailing row is not an error, it is an unused row (`purchases/editor-state.ts`'s
 *  `isUntouched`, the same shape). */
function isUntouched(line: AdjustmentLineState): boolean {
  return line.catalogItemId === null && line.quantityDelta.trim() === '';
}

/** A signed decimal: optional sign, and at least one digit on one side of the point. No
 *  thousands separators — this is a quantity, not a formatted display value. */
const QUANTITY_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** True for "0", "-0.00", ".0" and the empty string — every spelling of no movement at
 *  all. Matched as text rather than parsed as a float, for D-13's reason applied to a
 *  quantity instead of money: a decimal this large should never round-trip through
 *  `Number`. */
function isZeroQuantity(text: string): boolean {
  return /^[+-]?0*\.?0*$/.test(text.trim());
}

type LineProblem = 'item' | 'duplicateItem' | 'quantity' | 'zeroQuantity';

const LINE_PROBLEM_MESSAGES: Readonly<Record<LineProblem, string>> = {
  item: 'Choose an item.',
  duplicateItem: 'This item already has a line above — combine them into one.',
  quantity: 'Enter a quantity, e.g. 12.5 or -2.',
  zeroQuantity: 'Enter a non-zero quantity — zero adjusts nothing.',
};

function duplicateItemIds(lines: readonly AdjustmentLineState[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.catalogItemId === null) continue;
    counts.set(line.catalogItemId, (counts.get(line.catalogItemId) ?? 0) + 1);
  }
  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id),
  );
}

function lineProblem(
  line: AdjustmentLineState,
  duplicates: ReadonlySet<string>,
): LineProblem | null {
  if (line.catalogItemId === null) return 'item';
  if (duplicates.has(line.catalogItemId)) return 'duplicateItem';
  const trimmed = line.quantityDelta.trim();
  if (trimmed === '' || !QUANTITY_PATTERN.test(trimmed)) return 'quantity';
  if (isZeroQuantity(trimmed)) return 'zeroQuantity';
  return null;
}

interface StateProblems {
  readonly date: boolean;
  readonly noLines: boolean;
  /** Keyed by `AdjustmentLineState.key`. */
  readonly lines: ReadonlyMap<string, LineProblem>;
}

function problemsIn(date: string, lines: readonly AdjustmentLineState[]): StateProblems {
  const duplicates = duplicateItemIds(lines);
  const problems = new Map<string, LineProblem>();
  let sendable = 0;

  for (const line of lines) {
    if (isUntouched(line)) continue;
    const problem = lineProblem(line, duplicates);
    if (problem === null) sendable += 1;
    else problems.set(line.key, problem);
  }

  return {
    date: date.trim() === '',
    noLines: sendable === 0 && problems.size === 0,
    lines: problems,
  };
}

function hasProblems(problems: StateProblems): boolean {
  return problems.date || problems.noLines || problems.lines.size > 0;
}

function lineErrorMessage(
  problems: StateProblems,
  serverLineErrors: ReadonlyMap<string, string>,
  key: string,
): string | undefined {
  const problem = problems.lines.get(key);
  return problem === undefined ? serverLineErrors.get(key) : LINE_PROBLEM_MESSAGES[problem];
}

function toCreateRequest(
  adjustmentDate: string,
  memo: string,
  lines: readonly AdjustmentLineState[],
): CreateInventoryAdjustmentRequest {
  const trimmedMemo = memo.trim();
  return {
    adjustmentDate,
    ...(trimmedMemo === '' ? {} : { memo: trimmedMemo }),
    lines: lines
      .filter((line) => !isUntouched(line))
      .map((line) => ({
        // Non-null and pattern-valid by construction: `problemsIn` gates the submit
        // button, so this is reached only once every remaining line has passed it. The
        // `?? ''` is unreachable filler, written so a bug here fails the server's
        // validator loudly rather than silently sending a plausible-looking id.
        catalogItemId: line.catalogItemId ?? '',
        quantityDelta: line.quantityDelta.trim(),
      })),
  };
}

export interface StockAdjustmentDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function StockAdjustmentDialog({
  open,
  onOpenChange,
}: StockAdjustmentDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Rendered only while open, so a second opening always starts from a blank form
          rather than the previous adjustment's posted result. */}
      {open && (
        <StockAdjustmentContent
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function StockAdjustmentContent({ onClose }: { readonly onClose: () => void }): ReactElement {
  const formId = useId();
  const [adjustmentDate, setAdjustmentDate] = useState<string>(today);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<readonly AdjustmentLineState[]>(() => [blankLine()]);
  const [posted, setPosted] = useState<InventoryAdjustment | null>(null);

  const itemsReport = useInventoryValuation(null);
  const create = useCreateInventoryAdjustment();
  const intentKey = useIntentKey();

  const itemOptions = useMemo<ComboboxOption[]>(
    () =>
      (itemsReport.data?.rows ?? []).map((row) => ({
        value: row.catalogItemId,
        label: row.name,
        ...(row.code === null ? {} : { detail: row.code }),
      })),
    [itemsReport.data],
  );

  const problems = problemsIn(adjustmentDate, lines);
  const error: unknown = create.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  /**
   * Server field messages arrive keyed by the dotted path `ValidationIssue` uses, and the
   * index in `lines.N.…` is an index into the array that was **sent** — which drops the
   * untouched rows. Walked in the same order rather than assumed equal to the row index,
   * `purchases/document-editor.tsx`'s `serverLineErrors` reason: a blank row above a real
   * one would otherwise shift every message by one.
   */
  const serverLineErrors = useMemo(() => {
    const messages = new Map<string, string>();
    let sentIndex = 0;
    for (const line of lines) {
      if (isUntouched(line)) continue;
      for (const field of ['catalogItemId', 'quantityDelta']) {
        const message = fieldErrors[`lines.${String(sentIndex)}.${field}`];
        if (message !== undefined && !messages.has(line.key)) messages.set(line.key, message);
      }
      sentIndex += 1;
    }
    return messages;
  }, [lines, fieldErrors]);

  function editLine(key: string, patch: Partial<AdjustmentLineState>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: string): void {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  function resetForm(): void {
    setAdjustmentDate(today());
    setMemo('');
    setLines([blankLine()]);
    setPosted(null);
  }

  function submit(): void {
    if (hasProblems(problems) || create.isPending) return;
    const body = toCreateRequest(adjustmentDate, memo, lines);
    create.mutate(
      { ...body, idempotencyKey: intentKey(`create:${JSON.stringify(body)}`) },
      {
        onSuccess: (adjustment) => {
          setPosted(adjustment);
        },
      },
    );
  }

  if (posted !== null) {
    return <PostedAdjustment adjustment={posted} onAdjustAgain={resetForm} onDone={onClose} />;
  }

  return (
    <DialogContent
      title="Adjust stock"
      description="Each line moves one item's on-hand quantity by a signed amount. The server prices the movement; nothing here estimates it."
      className="max-w-2xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={create.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={create.isPending || hasProblems(problems)}
          >
            {create.isPending ? 'Posting…' : 'Post adjustment'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error !== undefined && error !== null && <ErrorBanner error={error} />}

        <div className="flex flex-wrap gap-4">
          <Field className="w-48" error={fieldErrors['adjustmentDate']}>
            <FieldLabel>Adjustment date</FieldLabel>
            <TextInput
              type="date"
              value={adjustmentDate}
              disabled={create.isPending}
              onChange={(event) => {
                setAdjustmentDate(event.target.value);
              }}
            />
          </Field>

          <Field className="min-w-64 flex-1" error={fieldErrors['memo']} hint="Optional.">
            <FieldLabel>Memo</FieldLabel>
            <TextInput
              value={memo}
              disabled={create.isPending}
              placeholder="e.g. Cycle count correction"
              onChange={(event) => {
                setMemo(event.target.value);
              }}
            />
          </Field>
        </div>

        {itemsReport.isError && (
          <ErrorBanner
            error={itemsReport.error}
            onRetry={() => {
              void itemsReport.refetch();
            }}
          />
        )}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-text">Lines</span>
          {lines.map((line) => (
            <AdjustmentLineRow
              key={line.key}
              line={line}
              itemOptions={itemOptions}
              itemsLoading={itemsReport.isPending}
              disabled={create.isPending}
              removable={lines.length > 1}
              error={lineErrorMessage(problems, serverLineErrors, line.key)}
              onChange={(patch) => {
                editLine(line.key, patch);
              }}
              onRemove={() => {
                removeLine(line.key);
              }}
            />
          ))}
          <div>
            <Button
              disabled={create.isPending}
              onClick={() => {
                setLines((current) => [...current, blankLine()]);
              }}
            >
              Add line
            </Button>
          </div>
          {problems.noLines && (
            <FieldError>Add at least one line with an item and a non-zero quantity.</FieldError>
          )}
          {fieldErrors['lines'] !== undefined && <FieldError>{fieldErrors['lines']}</FieldError>}
        </div>
      </form>
    </DialogContent>
  );
}

function AdjustmentLineRow({
  line,
  itemOptions,
  itemsLoading,
  disabled,
  removable,
  error,
  onChange,
  onRemove,
}: {
  readonly line: AdjustmentLineState;
  readonly itemOptions: readonly ComboboxOption[];
  readonly itemsLoading: boolean;
  readonly disabled: boolean;
  readonly removable: boolean;
  readonly error: string | undefined;
  readonly onChange: (patch: Partial<AdjustmentLineState>) => void;
  readonly onRemove: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-56 flex-1">
          <Combobox
            aria-label="Item"
            options={itemOptions}
            value={line.catalogItemId}
            disabled={disabled || itemsLoading}
            placeholder={itemsLoading ? 'Loading items…' : 'Search items…'}
            emptyMessage="No inventory items."
            onValueChange={(value) => {
              onChange({ catalogItemId: value });
            }}
          />
        </div>
        <div className="w-32">
          <TextInput
            aria-label="Quantity change"
            inputMode="decimal"
            placeholder="e.g. -2"
            value={line.quantityDelta}
            disabled={disabled}
            onChange={(event) => {
              onChange({ quantityDelta: event.target.value });
            }}
            className="text-right font-mono tabular-nums"
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Remove line"
          disabled={disabled || !removable}
          onClick={onRemove}
        >
          ✕
        </Button>
      </div>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </div>
  );
}

function PostedAdjustment({
  adjustment,
  onAdjustAgain,
  onDone,
}: {
  readonly adjustment: InventoryAdjustment;
  readonly onAdjustAgain: () => void;
  readonly onDone: () => void;
}): ReactElement {
  return (
    <DialogContent
      title="Stock adjustment posted"
      description={`Dated ${adjustment.adjustmentDate}. Each line's value is the server's cost for the quantity moved.`}
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={onAdjustAgain}>Post another</Button>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {adjustment.lines.map((line) => (
            <li
              key={line.catalogItemId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-2"
            >
              <span className="text-text">{line.name}</span>
              <span className="font-mono tabular-nums text-text-muted">{line.quantityDelta}</span>
              <span className="font-mono tabular-nums text-text">
                {formatMoney(line.valueDelta)}
              </span>
            </li>
          ))}
        </ul>
        {adjustment.memo !== null && adjustment.memo !== '' && (
          <p className="text-sm text-text-muted">{adjustment.memo}</p>
        )}
      </div>
    </DialogContent>
  );
}
