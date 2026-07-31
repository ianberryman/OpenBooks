import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';

/** An `open`/`closed`, `active`/`archived`, `pending`/`accepted` marker. */
export type PillTone = 'neutral' | 'positive' | 'muted' | 'negative';

const PILL_CLASSES: Readonly<Record<PillTone, string>> = {
  neutral: 'border-border bg-surface-sunken text-text-muted',
  positive: 'border-success-border bg-success-soft text-success-text',
  muted: 'border-border bg-surface-sunken text-text-subtle',
  negative: 'border-danger-border bg-danger-soft text-danger-text',
};

export function Pill({
  tone,
  children,
}: {
  readonly tone: PillTone;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        PILL_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}
