import type { FormEvent, ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
} from '../../components';
import type { DunningPolicy, DunningStage } from './queries';
import { StageEditor } from './stage-editor';
import { blankStage, stagesFromPolicy, stagesToRequest } from './stage-state';
import type { StageDraft } from './stage-state';

/**
 * The one form for creating and editing a policy — `dimensions.tsx`'s
 * `AxisFormDialog`/`ValueFormDialog` shape: create and edit differ only in what seeds the
 * fields and what the submit label says, so they are one component rather than two forms
 * that would drift on every field but the one that actually differs.
 */
export interface PolicyFormDialogProps {
  readonly title: string;
  readonly description: string;
  readonly open: boolean;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly error: unknown;
  /** `undefined` creates; a policy seeds an edit. */
  readonly initial?: DunningPolicy | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (values: { name: string; stages: readonly DunningStage[] }) => void;
}

export function PolicyFormDialog({
  title,
  description,
  open,
  submitLabel,
  pending,
  error,
  initial,
  onClose,
  onSubmit,
}: PolicyFormDialogProps): ReactElement {
  const formId = useId();
  const [name, setName] = useState('');
  const [stages, setStages] = useState<readonly StageDraft[]>([]);
  const [seeded, setSeeded] = useState<string | null>(null);

  /**
   * Seeded the first time this dialog opens for a given policy (or for "new"), rather than
   * in an effect — `dimensions.tsx`'s `AxisFormDialog` states the reason: an effect would
   * also fire while the user is typing and undo their edit.
   */
  const seedKey = open ? (initial?.id ?? 'new') : null;
  if (seedKey !== null && seedKey !== seeded) {
    setSeeded(seedKey);
    setName(initial?.name ?? '');
    setStages(initial === undefined ? [blankStage()] : stagesFromPolicy(initial.stages));
  }
  if (seedKey === null && seeded !== null) setSeeded(null);

  const fieldErrors = presentApiError(error).fieldErrors;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit({ name: name.trim(), stages: stagesToRequest(stages) });
  }

  // A ladder with nothing in it is refused by the server (`stages` has `min(1)`), and
  // saying so here — rather than only after the round trip — is `dimensions.tsx`'s own
  // reason for stating the eight-axis bound before the ninth is attempted.
  const canSubmit = name.trim() !== '' && stages.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={title}
        description={description}
        className="max-w-3xl"
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form={formId} disabled={pending || !canSubmit}>
              {submitLabel}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          <Field error={fieldErrors['name']}>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <StageEditor
            stages={stages}
            fieldErrors={fieldErrors}
            disabled={pending}
            onChange={setStages}
          />

          {error !== null && error !== undefined && <ErrorBanner error={error} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}
