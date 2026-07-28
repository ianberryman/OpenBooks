import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import { useEffect, useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
import { Button, ErrorBanner, Field, FieldLabel, TextInput } from '../../components';
import { fetchBranding, patchBranding, uploadBrandingLogo } from './branding-client';
import type { OrgBranding, UpdateOrgBrandingRequest } from './branding-client';
import { Notice, SettingsSection } from './section';

/**
 * Branding — the letterhead an org's invoices are printed under (OB-131, Phase 1, S4).
 *
 * ## One record, edited in place
 *
 * Unlike the other three settings sections, there is no list and no dialog: `GET
 * /v1/branding` always answers one row, so the form *is* the section rather than something
 * a "New…" button opens. `logoStorageKey` is the one field the form never sends directly —
 * it is written by `uploadBrandingLogo` (the upload path) or cleared by the "Remove logo"
 * button, never typed.
 *
 * ## Patch semantics are the thing worth getting right here
 *
 * `updateOrgBrandingRequestSchema`: an absent field is left alone, and an explicit `null`
 * clears a nullable one. `buildBrandingPatch` below is what keeps the request that thin —
 * it diffs the edited form against the row last read from the server and sends only what
 * changed, translating a field the user cleared to `null` rather than to an absent key
 * (which would be a no-op) or to `''` (which the server would store literally). Save is
 * disabled while the diff is empty, for the reason `document-editor.tsx`'s "Save draft"
 * is: a request with nothing to say should not be sent to find that out.
 *
 * `displayName` is the one field with no null state (branding.ts's reason: an invoice
 * printed under no name is not one anyone can act on), so it is diffed as a plain string
 * and clearing it is left to the server's `min(1)` refusal rather than caught here.
 */
const BRANDING_QUERY_KEY = ['settings', 'branding'] as const;

// An example of the value this field accepts — a hex colour is exactly what the org
// types here — shown in the hint and placeholder. Not a themed style literal (it never
// colours anything in the UI), so the token rule (D-24) does not apply to it.
// eslint-disable-next-line openbooks/no-raw-color -- example text for a hex input, not a style
const BRAND_COLOR_EXAMPLE = '#1a1a1a';

interface BrandingFormState {
  readonly displayName: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
  readonly email: string;
  readonly phone: string;
  readonly website: string;
  readonly taxNumber: string;
  readonly brandColor: string;
  readonly invoiceFooter: string;
}

function stateFromBranding(branding: OrgBranding): BrandingFormState {
  return {
    displayName: branding.displayName,
    addressLine1: branding.addressLine1 ?? '',
    addressLine2: branding.addressLine2 ?? '',
    city: branding.city ?? '',
    region: branding.region ?? '',
    postalCode: branding.postalCode ?? '',
    country: branding.country ?? '',
    email: branding.email ?? '',
    phone: branding.phone ?? '',
    website: branding.website ?? '',
    taxNumber: branding.taxNumber ?? '',
    brandColor: branding.brandColor ?? '',
    invoiceFooter: branding.invoiceFooter ?? '',
  };
}

/** `''` typed into a nullable field means "clear it"; unchanged means "say nothing". */
function diffNullable(entered: string, loaded: string | null): string | null | undefined {
  const trimmed = entered.trim();
  const value = trimmed === '' ? null : trimmed;
  return value === loaded ? undefined : value;
}

function buildBrandingPatch(
  loaded: OrgBranding,
  state: BrandingFormState,
): UpdateOrgBrandingRequest {
  const displayName = state.displayName.trim();
  const addressLine1 = diffNullable(state.addressLine1, loaded.addressLine1);
  const addressLine2 = diffNullable(state.addressLine2, loaded.addressLine2);
  const city = diffNullable(state.city, loaded.city);
  const region = diffNullable(state.region, loaded.region);
  const postalCode = diffNullable(state.postalCode, loaded.postalCode);
  const country = diffNullable(state.country, loaded.country);
  const email = diffNullable(state.email, loaded.email);
  const phone = diffNullable(state.phone, loaded.phone);
  const website = diffNullable(state.website, loaded.website);
  const taxNumber = diffNullable(state.taxNumber, loaded.taxNumber);
  const brandColor = diffNullable(state.brandColor, loaded.brandColor);
  const invoiceFooter = diffNullable(state.invoiceFooter, loaded.invoiceFooter);

  return {
    ...(displayName === loaded.displayName ? {} : { displayName }),
    ...(addressLine1 === undefined ? {} : { addressLine1 }),
    ...(addressLine2 === undefined ? {} : { addressLine2 }),
    ...(city === undefined ? {} : { city }),
    ...(region === undefined ? {} : { region }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(country === undefined ? {} : { country }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(website === undefined ? {} : { website }),
    ...(taxNumber === undefined ? {} : { taxNumber }),
    ...(brandColor === undefined ? {} : { brandColor }),
    ...(invoiceFooter === undefined ? {} : { invoiceFooter }),
  };
}

export function BrandingSection(): ReactElement {
  const queryClient = useQueryClient();

  const branding = useQuery({ queryKey: BRANDING_QUERY_KEY, queryFn: fetchBranding });

  // Seeded from the loaded row the first time it arrives, and again after a save changes
  // `updatedAt` — the same technique `dimensions.tsx`'s `AxisFormDialog` uses, and for the
  // same reason: an effect would also fire while the user is typing and undo the edit.
  const [state, setState] = useState<BrandingFormState | null>(null);
  const [seededAt, setSeededAt] = useState<string | null>(null);
  if (branding.data !== undefined && branding.data.updatedAt !== seededAt) {
    setSeededAt(branding.data.updatedAt);
    setState(stateFromBranding(branding.data));
  }

  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (logoPreviewUrl !== null) URL.revokeObjectURL(logoPreviewUrl);
    };
  }, [logoPreviewUrl]);

  const save = useMutation({
    mutationFn: async (variables: {
      readonly patch: UpdateOrgBrandingRequest;
      readonly idempotencyKey: string;
    }) => patchBranding(variables.patch, variables.idempotencyKey),
    onSuccess: (updated) => {
      queryClient.setQueryData(BRANDING_QUERY_KEY, updated);
    },
  });

  const uploadLogo = useMutation({
    mutationFn: async (variables: { readonly file: File; readonly idempotencyKey: string }) =>
      uploadBrandingLogo(variables.file, variables.idempotencyKey),
    onSuccess: (updated) => {
      queryClient.setQueryData(BRANDING_QUERY_KEY, updated);
      setLogoFile(null);
      setLogoPreviewUrl((previous) => {
        if (previous !== null) URL.revokeObjectURL(previous);
        return null;
      });
    },
  });

  const removeLogo = useMutation({
    mutationFn: async (idempotencyKey: string) =>
      patchBranding({ logoStorageKey: null }, idempotencyKey),
    onSuccess: (updated) => {
      queryClient.setQueryData(BRANDING_QUERY_KEY, updated);
    },
  });

  const busy = save.isPending || uploadLogo.isPending || removeLogo.isPending;

  const patch =
    branding.data !== undefined && state !== null ? buildBrandingPatch(branding.data, state) : {};
  const dirty = Object.keys(patch).length > 0;

  const presented = save.isError ? presentApiError(save.error) : null;
  const fieldErrors = presented?.fieldErrors ?? {};

  function edit(next: Partial<BrandingFormState>): void {
    setState((current) => (current === null ? current : { ...current, ...next }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!dirty) return;
    save.mutate({ patch, idempotencyKey: newIdempotencyKey() });
  }

  function handleLogoChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;
    setLogoFile(file);
    setLogoPreviewUrl((previous) => {
      if (previous !== null) URL.revokeObjectURL(previous);
      return file === null ? null : URL.createObjectURL(file);
    });
  }

  return (
    <SettingsSection
      title="Branding"
      description={
        <>
          The letterhead every invoice is printed and hosted under — the org&rsquo;s name, address,
          contact details, accent colour and logo. Changes here are not retroactive: a sent invoice
          keeps the letterhead it was sent with, frozen at send time.
        </>
      }
    >
      {branding.isError && (
        <ErrorBanner
          error={branding.error}
          onRetry={() => {
            void branding.refetch();
          }}
        />
      )}

      {branding.isPending && <p className="text-text-subtle">Loading…</p>}

      {branding.data !== undefined && state !== null && (
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-wrap gap-4">
            <Field className="min-w-64 flex-1" error={fieldErrors['displayName']}>
              <FieldLabel>Display name</FieldLabel>
              <TextInput
                value={state.displayName}
                disabled={busy}
                onChange={(event) => {
                  edit({ displayName: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-48 flex-1" error={fieldErrors['taxNumber']} hint="Optional.">
              <FieldLabel>Tax number</FieldLabel>
              <TextInput
                value={state.taxNumber}
                disabled={busy}
                onChange={(event) => {
                  edit({ taxNumber: event.target.value });
                }}
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <Field className="min-w-64 flex-1" error={fieldErrors['addressLine1']} hint="Optional.">
              <FieldLabel>Address line 1</FieldLabel>
              <TextInput
                value={state.addressLine1}
                disabled={busy}
                onChange={(event) => {
                  edit({ addressLine1: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-64 flex-1" error={fieldErrors['addressLine2']} hint="Optional.">
              <FieldLabel>Address line 2</FieldLabel>
              <TextInput
                value={state.addressLine2}
                disabled={busy}
                onChange={(event) => {
                  edit({ addressLine2: event.target.value });
                }}
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <Field className="min-w-40 flex-1" error={fieldErrors['city']} hint="Optional.">
              <FieldLabel>City</FieldLabel>
              <TextInput
                value={state.city}
                disabled={busy}
                onChange={(event) => {
                  edit({ city: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-40 flex-1" error={fieldErrors['region']} hint="Optional.">
              <FieldLabel>Region</FieldLabel>
              <TextInput
                value={state.region}
                disabled={busy}
                onChange={(event) => {
                  edit({ region: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-32 flex-1" error={fieldErrors['postalCode']} hint="Optional.">
              <FieldLabel>Postal code</FieldLabel>
              <TextInput
                value={state.postalCode}
                disabled={busy}
                onChange={(event) => {
                  edit({ postalCode: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-40 flex-1" error={fieldErrors['country']} hint="Optional.">
              <FieldLabel>Country</FieldLabel>
              <TextInput
                value={state.country}
                disabled={busy}
                onChange={(event) => {
                  edit({ country: event.target.value });
                }}
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <Field className="min-w-64 flex-1" error={fieldErrors['email']} hint="Optional.">
              <FieldLabel>Email</FieldLabel>
              <TextInput
                type="email"
                value={state.email}
                disabled={busy}
                onChange={(event) => {
                  edit({ email: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-48 flex-1" error={fieldErrors['phone']} hint="Optional.">
              <FieldLabel>Phone</FieldLabel>
              <TextInput
                value={state.phone}
                disabled={busy}
                onChange={(event) => {
                  edit({ phone: event.target.value });
                }}
              />
            </Field>

            <Field className="min-w-48 flex-1" error={fieldErrors['website']} hint="Optional.">
              <FieldLabel>Website</FieldLabel>
              <TextInput
                value={state.website}
                disabled={busy}
                onChange={(event) => {
                  edit({ website: event.target.value });
                }}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <Field
              className="w-40"
              error={fieldErrors['brandColor']}
              hint={`Six-digit hex, e.g. ${BRAND_COLOR_EXAMPLE}. Optional.`}
            >
              <FieldLabel>Brand colour</FieldLabel>
              <TextInput
                value={state.brandColor}
                placeholder={BRAND_COLOR_EXAMPLE}
                disabled={busy}
                onChange={(event) => {
                  edit({ brandColor: event.target.value });
                }}
              />
            </Field>
            {/^#[0-9a-fA-F]{6}$/u.test(state.brandColor) && (
              <span
                aria-hidden
                className="mb-1.5 h-9 w-9 shrink-0 rounded-md border border-border"
                style={{ backgroundColor: state.brandColor }}
              />
            )}
          </div>

          <Field className="max-w-2xl" error={fieldErrors['invoiceFooter']} hint="Optional.">
            <FieldLabel>Invoice footer</FieldLabel>
            <TextInput
              value={state.invoiceFooter}
              placeholder="Payment instructions, bank details, a thank-you…"
              disabled={busy}
              onChange={(event) => {
                edit({ invoiceFooter: event.target.value });
              }}
            />
          </Field>

          {presented !== null && <ErrorBanner error={save.error} />}
          {save.isSuccess && !dirty && <Notice tone="success">Saved.</Notice>}

          <div className="flex items-center gap-2 border-t border-border pt-4">
            <span className="text-sm text-text-subtle">
              {dirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <div className="flex-1" />
            <Button type="submit" variant="primary" disabled={busy || !dirty}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      )}

      {branding.data !== undefined && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-text">Logo</h3>
          <p className="max-w-prose text-sm text-text-muted">
            {branding.data.logoStorageKey === null
              ? 'No logo uploaded yet. It prints at the head of every invoice and the hosted ' +
                'page a customer opens.'
              : 'A logo is on file.'}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {logoPreviewUrl !== null && (
              // The preview of the file just chosen, not of what the server holds: this
              // client has no URL for the stored logo (`logoStorageKey` is an object-store
              // key, not a link — see `branding-client.ts`), only for the one about to be
              // uploaded.
              <img
                src={logoPreviewUrl}
                alt="Selected logo preview"
                className="h-12 w-auto max-w-40 rounded-md border border-border object-contain"
              />
            )}

            <Field hint="PNG, JPG or SVG.">
              <FieldLabel>Logo file</FieldLabel>
              <TextInput type="file" accept="image/*" disabled={busy} onChange={handleLogoChange} />
            </Field>

            <Button
              disabled={busy || logoFile === null}
              onClick={() => {
                if (logoFile === null) return;
                uploadLogo.mutate({ file: logoFile, idempotencyKey: newIdempotencyKey() });
              }}
            >
              {uploadLogo.isPending ? 'Uploading…' : 'Upload logo'}
            </Button>

            {branding.data.logoStorageKey !== null && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  removeLogo.mutate(newIdempotencyKey());
                }}
              >
                {removeLogo.isPending ? 'Removing…' : 'Remove logo'}
              </Button>
            )}
          </div>

          {uploadLogo.isError && <ErrorBanner error={uploadLogo.error} />}
          {removeLogo.isError && <ErrorBanner error={removeLogo.error} />}
        </div>
      )}
    </SettingsSection>
  );
}
