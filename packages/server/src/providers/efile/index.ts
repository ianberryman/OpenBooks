import type {
  Form1099AdapterDeps,
  Form1099Provider,
  Form1099ProviderKind,
} from '@openbooks/plugin-api';

import { createIrisForm1099Provider } from './iris';
import { createManualForm1099Provider } from './manual';

export type { Form1099AdapterDeps } from '@openbooks/plugin-api';

/**
 * Builds the `Form1099Provider` for one e-file selection (OB-228, D-228-7),
 * mirroring `paymentProcessorFor`/`bankFeedProviderFor`: exhaustive over
 * `Form1099ProviderKind`, so a new transmitter id does not compile until it has
 * an adapter here.
 *
 * Deliberately a function of `(kind, deps)` and not a lazy process-wide
 * accessor — the same reasoning as `paymentProcessorFor`'s own comment: the
 * caller resolves the org's e-file settings (and any decrypted credential) per
 * run, so it constructs one provider per call rather than reusing a single
 * resolved instance.
 */
function defaultForm1099ProviderFor(
  kind: Form1099ProviderKind,
  deps: Form1099AdapterDeps,
): Form1099Provider {
  switch (kind) {
    case 'manual':
      return createManualForm1099Provider(deps);
    case 'iris':
      return createIrisForm1099Provider(deps);
  }
}

type Form1099ProviderFactory = typeof defaultForm1099ProviderFor;

let factory: Form1099ProviderFactory = defaultForm1099ProviderFor;

export function form1099ProviderFor(
  kind: Form1099ProviderKind,
  deps: Form1099AdapterDeps,
): Form1099Provider {
  return factory(kind, deps);
}

/**
 * Installs a substitute factory for the rest of the process, or restores the
 * default — the exact seam `setPaymentProcessorFactory`/
 * `setBankFeedProviderFactory` are, applied to the 1099 e-file selection.
 *
 * Its point is letting a suite exercise a `ten99_form_runs` row whose provider
 * is `'iris'` without touching a network: install a factory that routes every
 * kind to `createManualForm1099Provider`, run the scenario, and restore the
 * default (or pass `undefined`) once it is done — spec §11's "no mocks" kept
 * intact, because what runs underneath is still the real, deterministic
 * `manual` implementation, never a stand-in for IRIS.
 */
export function setForm1099ProviderFactory(value: Form1099ProviderFactory | undefined): void {
  factory = value ?? defaultForm1099ProviderFor;
}

export { createIrisForm1099Provider } from './iris';
export { createManualForm1099Provider } from './manual';
