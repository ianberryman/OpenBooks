/**
 * The component surface OB-047..052 build on. Deliberately short: it covers the primitives
 * the M2 screens were specified against and nothing beyond them (D-24 — "no speculative
 * component library"). A seventh component arrives with the screen that needs it.
 */
export { Button } from './button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './button';

export { Combobox } from './combobox';
export type { ComboboxCreateAction, ComboboxOption, ComboboxProps } from './combobox';

export { LineItemCombobox } from './line-item-combobox';
export type { LineItemComboboxProps } from './line-item-combobox';

export { Dialog, DialogClose, DialogContent, DialogTrigger } from './dialog';
export type { DialogContentProps } from './dialog';

export { ErrorBanner } from './error-banner';
export type { ErrorBannerProps } from './error-banner';

export {
  CONTROL_CLASSES,
  Field,
  FieldError,
  FieldLabel,
  TextInput,
  useFieldControl,
} from './field';
export type { FieldControlProps, FieldProps, TextInputProps } from './field';

export { MoneyInput } from './money-input';
export type { MoneyInputProps } from './money-input';

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './popover';
export type { PopoverContentProps } from './popover';

export { ResponsiveTable } from './responsive-table';
export type { ResponsiveTableProps } from './responsive-table';

export { Select } from './select';
export type { SelectOption, SelectProps } from './select';

/**
 * Read-only amounts go through the same conversion the input uses. Re-exported here so a
 * screen importing from `../components` has no reason to reach for arithmetic of its own
 * (D-13 — the module header in `src/money/format.ts` explains what that arithmetic costs).
 */
export { formatMinorUnits, toMinorUnits, tryToMinorUnits } from '../money/format';
