/**
 * Joins class names, dropping the falsy ones.
 *
 * Deliberately *not* `tailwind-merge`. That library resolves conflicting utilities by
 * knowing which ones occupy the same CSS property, and it knows that from a model of
 * Tailwind's default theme — a theme this application clears wholesale (`--*: initial` in
 * `src/styles/tokens.css`). Configuring it to understand the token scales instead is a
 * second description of the theme, kept in sync by hand, and wrong in exactly the cases
 * where it matters.
 *
 * The problem it would solve is real and is handled differently here: components take
 * variant props rather than inviting a caller to override styling through `className`.
 * `className` is for layout at the call site — margin, width, grid placement — which does
 * not conflict with what a component sets on itself.
 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: readonly ClassValue[]): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
