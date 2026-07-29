import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';
import { Button, Combobox, ErrorBanner, Field, FieldLabel } from '../../components';
import { Notice, SettingsSection } from './section';

/**
 * The org's early-pay discount nominations (OB-136, OB-140; ROADMAP D-79, D-106, D-107).
 *
 * Mirrors the shape a control-account nomination would take — two independently usable
 * pickers, a single `PATCH` that lands both in one transaction — because D-107 makes the
 * two the same *kind* of setting: neither is guessable from a chart-template code, and
 * both live in `org_accounting_settings` for the reason `settings/discount-accounts.ts`'s
 * server-side header gives at length.
 *
 * `given` is the account an early-pay discount **debits** when this org gives one to a
 * *customer* — narrowed to `expense` accounts, the type the server's own
 * `discountAccountType` enforces (`multi-entry-dialog.tsx`'s mirror of the same rule).
 * `received` is the account it **credits** when a *vendor* gives one to this org —
 * narrowed to `revenue`. The narrowing is a convenience; the server is the authority.
 *
 * ## Why one Save button and not two
 *
 * The wire is one `PATCH` carrying both fields, and "changing one moves future postings
 * only" is a fact about the whole write, not about either field alone — a single save
 * keeps that true rather than implying two independent transactions where there is one.
 */

type DiscountAccounts = components['schemas']['DiscountAccounts'];
type Account = components['schemas']['Account'];

const DISCOUNT_ACCOUNTS_QUERY_KEY = ['settings', 'discount-accounts'] as const;
const ACCOUNTS_QUERY_KEY = ['settings', 'discount-accounts', 'accounts'] as const;

/** Every active account tops out well under this in practice; a chart large enough to
 *  need a second page here would need one for every other picker in the app too. */
const PAGE_LIMIT = 200;

async function collectActiveAccounts(): Promise<readonly Account[]> {
  const items: Account[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = unwrap(
      await api.GET('/v1/accounts', {
        params: {
          query: {
            isActive: 'true',
            limit: PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      }),
    );
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

export function DiscountAccountsSection(): ReactElement {
  const queryClient = useQueryClient();

  const discountAccounts = useQuery({
    queryKey: DISCOUNT_ACCOUNTS_QUERY_KEY,
    queryFn: async (): Promise<DiscountAccounts> =>
      unwrap(await api.GET('/v1/settings/discount-accounts')),
  });

  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: collectActiveAccounts,
  });

  const update = useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<{
      discountGivenAccountId?: string | null;
      discountReceivedAccountId?: string | null;
    }>) =>
      unwrap(
        await api.PATCH('/v1/settings/discount-accounts', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(DISCOUNT_ACCOUNTS_QUERY_KEY, saved);
    },
  });

  const givenOptions = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((account) => account.type === 'expense')
        .map((account) => ({ value: account.id, label: account.name, detail: account.code })),
    [accounts.data],
  );
  const receivedOptions = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((account) => account.type === 'revenue')
        .map((account) => ({ value: account.id, label: account.name, detail: account.code })),
    [accounts.data],
  );

  // Seeded from the fetched nominations the first time they arrive, then edited freely —
  // `dimensions.tsx`'s `AxisFormDialog` seeding pattern, applied to a section rather than a
  // dialog because there is no open/close moment here to key the seed on.
  const [seeded, setSeeded] = useState(false);
  const [given, setGiven] = useState<string | null>(null);
  const [received, setReceived] = useState<string | null>(null);

  if (!seeded && discountAccounts.data !== undefined) {
    setSeeded(true);
    setGiven(discountAccounts.data.discountGivenAccountId);
    setReceived(discountAccounts.data.discountReceivedAccountId);
  }

  const dirty =
    discountAccounts.data !== undefined &&
    (given !== discountAccounts.data.discountGivenAccountId ||
      received !== discountAccounts.data.discountReceivedAccountId);

  return (
    <SettingsSection
      title="Discount accounts"
      description={
        <>
          Which of the organization&rsquo;s own accounts an early-pay discount posts to (D-79) — the
          account it debits when this org gives one to a customer, and the account it credits when a
          vendor gives one to this org. Either may be left unset; an org that only invoices never
          needs the second.
        </>
      }
    >
      {discountAccounts.isError && (
        <ErrorBanner
          error={discountAccounts.error}
          onRetry={() => {
            void discountAccounts.refetch();
          }}
        />
      )}
      {accounts.isError && (
        <ErrorBanner
          error={accounts.error}
          onRetry={() => {
            void accounts.refetch();
          }}
        />
      )}
      {update.isError && <ErrorBanner error={update.error} />}
      {update.isSuccess && !dirty && (
        <Notice tone="success">
          Saved. This moves future discounts only — nothing already posted is restated.
        </Notice>
      )}

      <div className="flex flex-wrap gap-4">
        <Field
          className="w-72"
          hint="Debited when this org gives a customer an early-pay discount. An expense account."
        >
          <FieldLabel>Discount given</FieldLabel>
          <Combobox
            value={given}
            options={givenOptions}
            placeholder="Search expense accounts…"
            emptyMessage="No active expense accounts."
            onValueChange={setGiven}
          />
        </Field>
        <Field
          className="w-72"
          hint="Credited when a vendor gives this org an early-pay discount. A revenue account."
        >
          <FieldLabel>Discount received</FieldLabel>
          <Combobox
            value={received}
            options={receivedOptions}
            placeholder="Search revenue accounts…"
            emptyMessage="No active revenue accounts."
            onValueChange={setReceived}
          />
        </Field>
      </div>

      <div>
        <Button
          variant="primary"
          disabled={!dirty || update.isPending}
          onClick={() => {
            update.mutate({
              discountGivenAccountId: given,
              discountReceivedAccountId: received,
              idempotencyKey: newIdempotencyKey(),
            });
          }}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </SettingsSection>
  );
}
