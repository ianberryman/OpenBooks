import type { TemplateFrequency, TemplateMaterializationMode, TemplateTaxMode } from './queries';

/**
 * The words this screen uses for a template's schedule and its two mode flags — `sales/
 * vocabulary.tsx`'s shape, sized to what a template actually has (no computed `status`,
 * unlike a document — a template is simply active or not).
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
 * `RecurringInvoiceTemplate`'s own description puts it: `frequency: "monthly",
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
  approved: 'Approved — post automatically each cycle',
};

export const MATERIALIZATION_MODE_OPTIONS: ReadonlyArray<{
  value: TemplateMaterializationMode;
  label: string;
}> = [
  { value: 'draft', label: MATERIALIZATION_MODE_LABELS.draft },
  { value: 'approved', label: MATERIALIZATION_MODE_LABELS.approved },
];

/**
 * What each mode does, said in full at the control — `sales/vocabulary.tsx`'s
 * `TAX_MODE_EXPLANATIONS`, for the same reason: the surprising half (`approved` posts a
 * journal unattended, via a system actor, with nobody reviewing it first) is worth stating
 * where the choice is made rather than left for the first cycle to demonstrate.
 */
export const MATERIALIZATION_MODE_EXPLANATIONS: Readonly<
  Record<TemplateMaterializationMode, string>
> = {
  draft:
    'Each cycle lands an editable draft invoice, exactly as if it had been started by hand. ' +
    'Nothing posts until someone approves it.',
  approved:
    'Each cycle posts its journal and allocates its number automatically, through the same ' +
    'path a human approval uses — unattended, with nobody reviewing it first.',
};

export const TAX_MODE_LABELS: Readonly<Record<TemplateTaxMode, string>> = {
  exclusive: 'Prices exclude tax',
  inclusive: 'Prices include tax',
};

export const TAX_MODE_OPTIONS: ReadonlyArray<{ value: TemplateTaxMode; label: string }> = [
  { value: 'exclusive', label: TAX_MODE_LABELS.exclusive },
  { value: 'inclusive', label: TAX_MODE_LABELS.inclusive },
];

export const TAX_MODE_EXPLANATIONS: Readonly<Record<TemplateTaxMode, string>> = {
  exclusive: 'Each unit price is a net amount, and its tax is added on top.',
  inclusive: 'Each unit price already contains its tax, and the net is extracted from within.',
};
