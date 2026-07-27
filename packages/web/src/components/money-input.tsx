import type { ReactElement } from 'react';
import { useState } from 'react';

import { cx } from '../lib/cx';
import { formatMinorUnits, tryToMinorUnits } from '../money/format';
import { CONTROL_CLASSES, useFieldControl } from './field';

/**
 * An amount field whose value is, at every moment, the **wire** value: a string of minor
 * units (ROADMAP D-13).
 *
 * ## The thing this component exists to make impossible
 *
 * `cents / 100` and `Number(text) * 100`. Neither appears here and neither may appear in a
 * screen, because both are inexact — `Number('1.115') * 100` is 111.49999999999999 and
 * rounds to 111, one cent short, in a journal line that will still balance because the
 * other side was computed the same way. The conversion in both directions is string
 * manipulation in `src/money/format.ts`; this component is the only caller a screen needs.
 *
 * `openbooks/no-float-money` is type-aware and scoped to the server packages, where money
 * is a branded `bigint`. Over here the wire type is `string`, so there is no brand to key
 * on and no lint rule to lean on — which is exactly why the arithmetic is confined to one
 * component rather than left to each form.
 *
 * ## Draft text and committed value
 *
 * The input holds its own text while it is being typed, because the canonical form is not
 * a fixed point of typing: normalizing on every keystroke turns `"5"` into `"5.00"` and
 * puts the caret behind the decimals, so the next digit lands in the wrong place. The
 * draft is normalized on blur instead, which is the moment the user is finished.
 */
export interface MoneyInputProps {
  /** Minor units as they travel on the wire — `"150000"` is 1500.00. `null` is empty. */
  readonly value: string | null;
  /**
   * `null` while the field is empty **or** unparseable, so a caller cannot mistake an
   * in-progress `"1."` for a committed amount. `invalid` distinguishes the two.
   */
  readonly onValueChange: (value: string | null) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly 'aria-label'?: string;
  readonly className?: string | undefined;
}

export function MoneyInput({
  value,
  onValueChange,
  placeholder = '0.00',
  disabled,
  name,
  className,
  ...rest
}: MoneyInputProps): ReactElement {
  const control = useFieldControl();
  const [draft, setDraft] = useState<string | null>(null);

  const committed = value === null ? '' : formatMinorUnits(value);
  const text = draft ?? committed;
  const invalid = draft !== null && draft.trim() !== '' && tryToMinorUnits(draft) === null;

  return (
    <input
      {...control}
      {...rest}
      name={name}
      /**
       * `inputMode="decimal"` and `type="text"`, never `type="number"`.
       *
       * A number input silently discards what it cannot parse — reading `.value` after a
       * paste of `"1,500.00"` gives `""` with no event to notice it by — and it carries a
       * scroll-wheel gesture that changes the amount when the user was scrolling the page.
       * On an amount that becomes a posted journal line, both are unacceptable.
       */
      type="text"
      inputMode="decimal"
      autoComplete="off"
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      aria-invalid={invalid || control['aria-invalid']}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        onValueChange(next.trim() === '' ? null : tryToMinorUnits(next));
      }}
      onBlur={() => {
        /**
         * The draft is dropped, not corrected. Rewriting `"1.005"` to `"1.01"` would be a
         * rounding decision made silently on the user's behalf, which is the one thing
         * `toMinorUnits` refuses to do; leaving the text as typed keeps the error visible
         * next to the message about it.
         */
        if (draft === null) return;
        if (draft.trim() === '') {
          setDraft(null);
          return;
        }
        const minor = tryToMinorUnits(draft);
        setDraft(minor === null ? draft : null);
        if (minor !== null) onValueChange(minor);
      }}
      className={cx(
        CONTROL_CLASSES,
        // Tabular figures and right alignment: a column of amounts is compared by eye, and
        // proportional digits make a mis-keyed magnitude the same width as a correct one.
        'border-border text-right font-mono tabular-nums',
        className,
      )}
    />
  );
}
