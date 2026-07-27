import { useMutation, useQuery } from '@tanstack/react-query';
import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, presentApiError, unwrap } from '../api';
import type { IdempotentVariables, components } from '../api';
import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';
import type { OrgMembership } from './identity';

type ChartTemplateSummary = components['schemas']['ChartTemplateSummary'];
type CreateOrgRequest = components['schemas']['CreateOrgRequest'];

const CHART_TEMPLATES_QUERY_KEY = ['chart-templates'] as const;

/**
 * The value of the "no starter chart" option, which is the one selected on arrival.
 *
 * D-23 makes the starter chart opt-in, and a preselected template is not opt-in — it is a
 * chart that arrives uninvited, which the decision describes as a chart the user then
 * deletes account by account. It is a real option rather than a placeholder so that the
 * default is something the user can see they chose.
 */
const NO_CHART_TEMPLATE = 'none';

const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const FISCAL_YEAR_OPTIONS = MONTHS.map((label, index) => ({
  value: String(index + 1),
  label,
}));

export interface CreateOrgFormProps {
  /**
   * Whether to offer the starter charts.
   *
   * `GET /v1/chart-templates` is org-scoped (`requireOrgScope`, and it takes
   * `accounts.read`), so a user creating their *first* organization cannot be shown the
   * list — they have no org to read it under. Rather than guess at the ids, that flow gets
   * D-23's default of no chart and the accounts screen applies one later.
   */
  readonly canListChartTemplates: boolean;
  readonly submitLabel: string;
  readonly onCreated: (membership: OrgMembership) => void;
}

export function CreateOrgForm({
  canListChartTemplates,
  submitLabel,
  onCreated,
}: CreateOrgFormProps): ReactElement {
  const [name, setName] = useState('');
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState('1');
  const [chartTemplateId, setChartTemplateId] = useState<string>(NO_CHART_TEMPLATE);

  const templates = useQuery({
    queryKey: CHART_TEMPLATES_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/chart-templates')).templates,
    enabled: canListChartTemplates,
  });

  const create = useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateOrgRequest>) =>
      unwrap(
        await api.POST('/v1/orgs', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: onCreated,
  });

  /**
   * The selected template is looked up in the list rather than narrowed from the select's
   * string, so `chartTemplateId` is the id the API declared and no cast stands between the
   * two. "No starter chart" simply matches nothing, and the field is then absent from the
   * body — which is what makes the default *no chart* and not an empty one.
   */
  const chosenTemplate: ChartTemplateSummary | undefined = (templates.data ?? []).find(
    (template) => template.id === chartTemplateId,
  );

  const presented = create.isError ? presentApiError(create.error) : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    create.mutate({
      name,
      fiscalYearStartMonth: Number(fiscalYearStartMonth),
      ...(chosenTemplate === undefined ? {} : { chartTemplateId: chosenTemplate.id }),
      // One key per intent: minted on submit, carried in the variables, so a resubmitted
      // form claims the same key rather than making a second organization (OB-028).
      idempotencyKey: newIdempotencyKey(),
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Field error={presented?.fieldErrors['name']}>
        <FieldLabel>Organization name</FieldLabel>
        <TextInput
          value={name}
          autoComplete="organization"
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>

      <Field
        error={presented?.fieldErrors['fiscalYearStartMonth']}
        hint="The month the books start each year."
      >
        <FieldLabel>Fiscal year starts in</FieldLabel>
        <Select
          value={fiscalYearStartMonth}
          onValueChange={setFiscalYearStartMonth}
          options={FISCAL_YEAR_OPTIONS}
        />
      </Field>

      {templates.data !== undefined && templates.data.length > 0 && (
        <Field hint="A copy, not a link — the accounts are ordinary accounts from then on.">
          <FieldLabel>Starter chart of accounts</FieldLabel>
          <Select
            value={chartTemplateId}
            onValueChange={setChartTemplateId}
            options={[
              { value: NO_CHART_TEMPLATE, label: 'No starter chart' },
              ...templates.data.map((template) => ({
                value: template.id,
                label: `${template.name} (${String(template.accountCount)} accounts)`,
              })),
            ]}
          />
        </Field>
      )}

      {presented !== null && <ErrorBanner error={create.error} />}

      <Button type="submit" variant="primary" disabled={create.isPending}>
        {submitLabel}
      </Button>
    </form>
  );
}
