import type {
  Form1099AdapterDeps,
  Form1099Provider,
  Ten99FilingStatus,
  Ten99FormData,
  Ten99SubmitResult,
  Ten99Transmission,
} from '@openbooks/plugin-api';

/**
 * The `manual` e-file transmitter (OB-228, D-228-7): real and deterministic, not a
 * stub bolted on for tests — `payment/fake.ts`'s and `bankfeed/fake.ts`'s reasoning
 * applied to this initiative. IRS IRIS A2A is a network product, so proving the
 * transmission build against it would mean either mocking an HTTP client (spec §11
 * forbids it) or a live sandbox call on every test run. `manual` is what the gate
 * exercises instead: it serialises the year's forms into a fixed-layout flat file the
 * org can file itself and transmits nothing — a third, real implementation of
 * `Form1099Provider` alongside the deferred `iris` one.
 *
 * `buildTransmission` is a pure function of its input — no `Date.now`, no
 * `Math.random` — so the same forms always produce the same bytes, which is what
 * makes a byte-for-byte assertion in a test meaningful.
 */
export function createManualForm1099Provider(_deps: Form1099AdapterDeps): Form1099Provider {
  return {
    name: 'manual',

    buildTransmission({ taxYear, forms }): Promise<Ten99Transmission> {
      const artifact = encodeManualTransmission(taxYear, forms);
      return Promise.resolve({ taxYear, formCount: forms.length, artifact });
    },

    // `manual` never calls out — the org downloads the artifact and files it
    // themselves, so `submit` only reports the terminal state a self-filed
    // transmission starts in.
    submit(_transmission: Ten99Transmission): Promise<Ten99SubmitResult> {
      return Promise.resolve({ providerRef: 'manual', status: 'ready_to_file' });
    },

    getStatus(_providerRef: string): Promise<Ten99FilingStatus> {
      return Promise.resolve('ready_to_file');
    },
  };
}

/**
 * A hand-rolled, deterministic approximation of an IRS IRIS-style fixed-layout flat
 * file: a header line naming the tax year and form count, then one text record per
 * form with its fields newline-joined. The real IRIS record layout (publication
 * 5717) is fixed-width and considerably more involved; this is the shape the
 * `manual` adapter needs to be provably deterministic and byte-stable in the gate,
 * not a claim of IRS conformance — the real transmitter (`iris.ts`) is deferred, and
 * exact layout conformance belongs to that implementation, not this stand-in.
 */
function encodeManualTransmission(taxYear: number, forms: readonly Ten99FormData[]): Uint8Array {
  const header = `IRIS-MANUAL|taxYear=${taxYear}|formCount=${forms.length}`;
  const records = forms.map((form) =>
    [
      form.formType,
      form.boxCode,
      form.amountMinor,
      form.recipientLegalName,
      form.recipientTin ?? '',
      form.recipientAddress ?? '',
    ].join('|'),
  );
  return new TextEncoder().encode([header, ...records].join('\n'));
}
