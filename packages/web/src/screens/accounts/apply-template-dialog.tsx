import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { ChartTemplateId, ChartTemplateSummary } from './accounts-api';
import { useIntentKey } from './intent-key';
import { Refusal, collidingCodes } from './refusal';

/**
 * Applying a starter chart (D-23).
 *
 * Opt-in, and a copy: nothing records which template an org used and there is no upgrade
 * path, so this dialog offers the choice once and describes what it leaves behind rather
 * than what it links to. The account list is deliberately not previewed — `accountCount`
 * is what makes the decision, and a preview is the first step towards treating a copied
 * chart as a thing the org stays related to.
 *
 * The failure worth building for is a code collision, because it is the one a user hits
 * exactly when they have already started: the template is refused *whole*, and every
 * colliding code is named. `Refusal` renders `details.codes` as the list it is; without
 * that the user is told "something already occupies this value" about sixty accounts at
 * once.
 */
export interface ApplyTemplateDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly templates: readonly ChartTemplateSummary[];
  readonly loading: boolean;
  readonly loadError: unknown;
  readonly onApply: (templateId: ChartTemplateId, idempotencyKey: string) => void;
  readonly pending: boolean;
  readonly error: unknown;
}

export function ApplyTemplateDialog({
  onOpenChange,
  templates,
  loading,
  loadError,
  onApply,
  pending,
  error,
}: ApplyTemplateDialogProps): ReactElement {
  const intentKey = useIntentKey();
  const [selected, setSelected] = useState<ChartTemplateId | null>(null);
  const collisions = collidingCodes(error);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent
        title="Apply a starter chart"
        description="The accounts are copied into this organization and are ordinary accounts from that moment on — there is no link back to the template and nothing to upgrade later."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              disabled={selected === null || pending}
              onClick={() => {
                if (selected !== null) onApply(selected, intentKey(`apply:${selected}`));
              }}
            >
              {pending ? 'Applying…' : 'Apply'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error !== null && error !== undefined && (
            <Refusal error={error}>
              {collisions !== null && (
                <p className="text-sm text-text-muted">
                  Nothing was created. Delete or renumber the {collisions.length} account
                  {collisions.length === 1 ? '' : 's'} above and apply again, or add the rest by
                  hand — a template is copied whole or not at all, because a half-applied chart is
                  neither yours nor the template’s.
                </p>
              )}
            </Refusal>
          )}

          {loadError !== null && loadError !== undefined && <ErrorBanner error={loadError} />}
          {loading && <p className="text-sm text-text-subtle">Loading the starter charts…</p>}

          <fieldset className="flex flex-col gap-2">
            <legend className="pb-2 text-sm font-medium text-text">Starter charts</legend>
            {templates.map((template) => (
              <label
                key={template.id}
                className="flex cursor-default items-start gap-3 rounded-md border border-border p-3 hover:bg-surface-hover"
              >
                <input
                  type="radio"
                  name="chart-template"
                  value={template.id}
                  checked={selected === template.id}
                  className="mt-1 accent-accent"
                  onChange={() => {
                    setSelected(template.id);
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-base font-medium text-text">{template.name}</span>
                  <span className="text-sm text-text-muted">{template.description}</span>
                  <span className="text-xs text-text-subtle">{template.accountCount} accounts</span>
                </span>
              </label>
            ))}
            {!loading && templates.length === 0 && (
              <p className="text-sm text-text-subtle">This build ships no starter charts.</p>
            )}
          </fieldset>
        </div>
      </DialogContent>
    </Dialog>
  );
}
