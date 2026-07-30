import type { TemplateFrequency, TemplateMaterializationMode } from './queries';

/**
 * The words this screen uses for a template's schedule and its materialization mode —
 * `recurring-invoices/vocabulary.ts`'s shape, sized to what a GL template actually has: no
 * `taxMode` (a GL line carries no tax of its own) and two materialization modes rather than
 * three (a GL journal has no separate approval step the way a sales document does).
 */

const FREQUENCY_UNIT: Readonly<Record<TemplateFrequency, string>> = {
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
  yearly: 'year',
};

const FREQUENCY_LABEL: Readonly<Record<TemplateFrequency, string>> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

/**
 * "Weekly", or "Every 3 months" — `intervalCount` combined with `frequency` the way
 * `RecurringJournalTemplate`'s own description puts it: `frequency: "monthly",
 * intervalCount: 3` is quarterly by another name, spelled the way the template's author
 * meant it, so a plain "Quarterly" would say something the author did not choose to say.
 */
export function cadenceLabel(frequency: TemplateFrequency, intervalCount: number): string {
  if (intervalCount === 1) return FREQUENCY_LABEL[frequency];
  return `Every ${String(intervalCount)} ${FREQUENCY_UNIT[frequency]}s`;
}

export const FREQUENCY_OPTIONS: ReadonlyArray<{ value: TemplateFrequency; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

export const MATERIALIZATION_MODE_LABELS: Readonly<Record<TemplateMaterializationMode, string>> = {
  draft: 'Draft — land for review each cycle',
  posted: 'Posted — post automatically each cycle',
};

export const MATERIALIZATION_MODE_OPTIONS: ReadonlyArray<{
  value: TemplateMaterializationMode;
  label: string;
}> = [
  { value: 'draft', label: MATERIALIZATION_MODE_LABELS.draft },
  { value: 'posted', label: MATERIALIZATION_MODE_LABELS.posted },
];

/**
 * What each mode does, said in full at the control — `recurring-invoices/vocabulary.ts`'s
 * `MATERIALIZATION_MODE_EXPLANATIONS`, for the same reason: the surprising half (`posted`
 * posts a journal unattended, via a system actor, with nobody reviewing it first) is worth
 * stating where the choice is made rather than left for the first cycle to demonstrate.
 */
export const MATERIALIZATION_MODE_EXPLANATIONS: Readonly<
  Record<TemplateMaterializationMode, string>
> = {
  draft:
    'Each cycle lands an editable draft journal, exactly as if it had been started by hand. ' +
    'Nothing posts until someone approves it.',
  posted:
    'Each cycle posts its journal directly under the org’s automation actor — unattended, ' +
    'with nobody reviewing it first.',
};
