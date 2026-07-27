import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent, ReactElement } from 'react';
import { useId, useState } from 'react';

import { api, expectNoContent, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';
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
import { cx } from '../../lib/cx';
import {
  EmptyRow,
  Notice,
  Pill,
  SettingsSection,
  TABLE_CLASSES,
  TD_CLASSES,
  TH_CLASSES,
} from './section';
import { preconditionOf } from './support';

/**
 * Dimensions — the reporting axes and their values (OB-050; spec §2.5, ROADMAP D-18,
 * D-29).
 *
 * ## The two things this section exists to keep visible
 *
 * **The bound is eight, and archived axes count against it** (D-29). The server refuses
 * the ninth with a `precondition_failed`, and a screen that only relayed that refusal
 * would teach the limit at the moment it is most annoying to learn — after a user has
 * named an axis and typed its code. So the count is on the heading row from the first
 * axis, and the two facts that make the number surprising (archived ones count; deleting
 * is the only way to free a slot, because archiving is not) are stated before the limit is
 * reached rather than in the error that follows it.
 *
 * **Archive and delete are different operations and are never one control.** A value that
 * journal lines carry cannot be deleted — `fk_jld_value` is `ON DELETE RESTRICT`, and the
 * service turns that into `dimension_value_in_use` — and archiving is the only removal
 * available to it. They are not two words for tidying up: deleting an in-use value would
 * restate every sliced report ever run without moving a single amount, which is dangerous
 * precisely because the trial balance would not change. The delete dialog says so before
 * it is pressed, and when the server refuses it offers the archive that would have
 * worked, rather than leaving the user to find a second button.
 */

/**
 * D-29's bound, restated here because `packages/web` consumes the REST API only and
 * `MAX_DIMENSIONS_PER_ORG` lives in `@openbooks/shared-types`, which this package does not
 * depend on. It is advisory in the same sense `permissions` on `GET /v1/auth/me` is: the
 * server is the authority and refuses the ninth axis under a locking count whatever this
 * screen believes. If the two ever disagree, the refusal is still correct and the counter
 * is merely stale.
 */
const MAX_AXES_PER_ORG = 8;

const DIMENSIONS_QUERY_KEY = ['settings', 'dimensions'] as const;
const valuesQueryKey = (dimensionId: string) =>
  ['settings', 'dimensions', dimensionId, 'values'] as const;

/** Axes top out at eight, so one page is every page; values may genuinely be long. */
const PAGE_LIMIT = 200;

type Dimension = components['schemas']['Dimension'];
type DimensionValue = components['schemas']['DimensionValue'];

type AxisDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly dimension: Dimension }
  | { readonly kind: 'delete'; readonly dimension: Dimension };

export function DimensionsSection(): ReactElement {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<AxisDialog | null>(null);
  const [openAxisId, setOpenAxisId] = useState<string | null>(null);

  const dimensions = useQuery({
    queryKey: DIMENSIONS_QUERY_KEY,
    /**
     * No `isActive` filter, deliberately. The bound counts archived axes, so a list that
     * hid them would show "7 of 8" to an org the server will refuse at the next create.
     */
    queryFn: async () =>
      unwrap(await api.GET('/v1/dimensions', { params: { query: { limit: PAGE_LIMIT } } })),
  });

  const invalidateAxes = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: DIMENSIONS_QUERY_KEY });
  };

  const create = useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<{ code: string; name: string; description: string | null }>) =>
      unwrap(
        await api.POST('/v1/dimensions', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidateAxes();
    },
  });

  const rename = useMutation({
    mutationFn: async ({
      idempotencyKey,
      dimensionId,
      ...body
    }: IdempotentVariables<{
      dimensionId: string;
      name: string;
      description: string | null;
    }>) =>
      unwrap(
        await api.PATCH('/v1/dimensions/{dimensionId}', {
          body,
          params: { path: { dimensionId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidateAxes();
    },
  });

  const setArchived = useMutation({
    mutationFn: async ({
      idempotencyKey,
      dimensionId,
      archived,
    }: IdempotentVariables<{ dimensionId: string; archived: boolean }>) => {
      const params = { path: { dimensionId }, header: idempotencyHeader(idempotencyKey) };
      return archived
        ? unwrap(await api.POST('/v1/dimensions/{dimensionId}/archive', { params }))
        : unwrap(await api.POST('/v1/dimensions/{dimensionId}/unarchive', { params }));
    },
    onSuccess: invalidateAxes,
  });

  const remove = useMutation({
    mutationFn: async ({
      idempotencyKey,
      dimensionId,
    }: IdempotentVariables<{ dimensionId: string }>) =>
      expectNoContent(
        await api.DELETE('/v1/dimensions/{dimensionId}', {
          params: { path: { dimensionId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidateAxes();
    },
  });

  const axes = dimensions.data?.items ?? [];
  const openAxis = axes.find((axis) => axis.id === openAxisId);
  const archivedCount = axes.filter((axis) => !axis.isActive).length;
  const atLimit = axes.length >= MAX_AXES_PER_ORG;
  const nearLimit = axes.length >= MAX_AXES_PER_ORG - 2;

  return (
    <SettingsSection
      title="Dimensions"
      description={
        <>
          Reporting axes — department, location, project, funding source — and the values on them. A
          journal line carries at most one value per axis, so a single entry can split rent across
          three departments without becoming three entries.
        </>
      }
      actions={
        <>
          <span className="text-sm text-text-muted">
            {String(axes.length)} of {String(MAX_AXES_PER_ORG)} axes
            {archivedCount > 0 && ` (${String(archivedCount)} archived)`}
          </span>
          <Button
            variant="primary"
            disabled={atLimit || dimensions.isPending}
            onClick={() => {
              create.reset();
              setDialog({ kind: 'create' });
            }}
          >
            New axis
          </Button>
        </>
      }
    >
      {dimensions.isError && (
        <ErrorBanner
          error={dimensions.error}
          onRetry={() => {
            void dimensions.refetch();
          }}
        />
      )}

      {nearLimit && (
        <Notice
          tone={atLimit ? 'warning' : 'info'}
          title={
            atLimit
              ? 'This organization has all eight axes it may define'
              : `${String(MAX_AXES_PER_ORG - axes.length)} more ${
                  MAX_AXES_PER_ORG - axes.length === 1 ? 'axis' : 'axes'
                } can be defined`
          }
        >
          An organization may define eight, and archived ones are counted: an archived axis is still
          joined by every historical report its values slice. Deleting an axis that has no values is
          what frees a slot — archiving is not. If a ninth is needed, it is usually a value on one
          of the eight, or a distinction the chart of accounts already draws.
        </Notice>
      )}

      {setArchived.isError && <ErrorBanner error={setArchived.error} />}

      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Reporting axes</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Code
            </th>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {axes.length === 0 && (
            <EmptyRow columns={4}>
              {dimensions.isPending
                ? 'Loading…'
                : 'No axes yet. Entries can still be posted; they simply cannot be sliced.'}
            </EmptyRow>
          )}
          {axes.map((axis) => (
            <tr key={axis.id}>
              <td className={cx(TD_CLASSES, 'font-mono')}>{axis.code}</td>
              <td className={TD_CLASSES}>
                <span className="text-text">{axis.name}</span>
                {axis.description !== null && axis.description !== '' && (
                  <span className="block text-xs text-text-subtle">{axis.description}</span>
                )}
              </td>
              <td className={TD_CLASSES}>
                <Pill tone={axis.isActive ? 'positive' : 'muted'}>
                  {axis.isActive ? 'Active' : 'Archived'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    aria-expanded={openAxisId === axis.id}
                    onClick={() => {
                      setOpenAxisId(openAxisId === axis.id ? null : axis.id);
                    }}
                  >
                    Values
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      rename.reset();
                      setDialog({ kind: 'rename', dimension: axis });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setArchived.mutate({
                        dimensionId: axis.id,
                        archived: axis.isActive,
                        idempotencyKey: newIdempotencyKey(),
                      });
                    }}
                  >
                    {axis.isActive ? 'Archive' : 'Unarchive'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      remove.reset();
                      setDialog({ kind: 'delete', dimension: axis });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {openAxis !== undefined && <DimensionValues key={openAxis.id} dimension={openAxis} />}

      <AxisFormDialog
        title="New axis"
        description="A code and a name. The code is immutable once created, because reports and cursors are keyed on it."
        open={dialog?.kind === 'create'}
        submitLabel="Create axis"
        pending={create.isPending}
        error={create.error}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={(values) => {
          create.mutate({ ...values, idempotencyKey: newIdempotencyKey() });
        }}
      />

      <AxisFormDialog
        title="Rename axis"
        description="The name and description are the mutable half. The code is not."
        open={dialog?.kind === 'rename'}
        submitLabel="Save"
        pending={rename.isPending}
        error={rename.error}
        initial={dialog?.kind === 'rename' ? dialog.dimension : undefined}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={(values) => {
          if (dialog?.kind !== 'rename') return;
          rename.mutate({
            dimensionId: dialog.dimension.id,
            name: values.name,
            description: values.description,
            idempotencyKey: newIdempotencyKey(),
          });
        }}
      />

      <Dialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent
          title="Delete axis"
          description="Deleting is for an axis that was never used. Archiving is for one that was."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (dialog?.kind !== 'delete') return;
                  remove.mutate({
                    dimensionId: dialog.dimension.id,
                    idempotencyKey: newIdempotencyKey(),
                  });
                }}
              >
                Delete axis
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">
              An axis that still has values cannot be deleted — deleting it would take the values
              reports are grouped by with it, without naming them. Delete the values first, or
              archive the axis instead, which keeps every tag its values carry and stops offering
              the axis for new ones.
            </p>
            {remove.isError && <ErrorBanner error={remove.error} />}
          </div>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

interface AxisFormValues {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
}

interface AxisFormDialogProps {
  readonly title: string;
  readonly description: string;
  readonly open: boolean;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly initial?: Dimension | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (values: AxisFormValues) => void;
}

/**
 * The create and rename forms are one component because they differ only in whether the
 * code is editable — and the code being immutable after creation is the thing worth
 * showing rather than hiding, so the rename form still renders it, disabled.
 */
function AxisFormDialog({
  title,
  description,
  open,
  submitLabel,
  pending,
  error,
  initial,
  onClose,
  onSubmit,
}: AxisFormDialogProps): ReactElement {
  const formId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seeded from the row being renamed the first time this dialog opens for it, rather than
  // in an effect: an effect would also fire while the user is typing and undo their edit.
  const seedKey = open ? (initial?.id ?? 'new') : null;
  if (seedKey !== null && seedKey !== seeded) {
    setSeeded(seedKey);
    setCode(initial?.code ?? '');
    setName(initial?.name ?? '');
    setNote(initial?.description ?? '');
  }
  if (seedKey === null && seeded !== null) setSeeded(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit({ code: code.trim(), name: name.trim(), description: note.trim() || null });
  };

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
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form={formId} disabled={pending}>
              {submitLabel}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
          <Field
            hint={
              initial === undefined ? 'Short, e.g. DEPT. Immutable once created.' : 'Immutable.'
            }
          >
            <FieldLabel>Code</FieldLabel>
            <TextInput
              value={code}
              disabled={initial !== undefined}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Field hint="Optional.">
            <FieldLabel>Description</FieldLabel>
            <TextInput
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
          {error !== null && error !== undefined && <ErrorBanner error={error} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ValueDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly value: DimensionValue }
  | { readonly kind: 'delete'; readonly value: DimensionValue };

function DimensionValues({ dimension }: { readonly dimension: Dimension }): ReactElement {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<ValueDialog | null>(null);
  const [draftCode, setDraftCode] = useState('');
  const [draftName, setDraftName] = useState('');

  const queryKey = valuesQueryKey(dimension.id);

  const values = useQuery({
    queryKey,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/dimensions/{dimensionId}/values', {
          params: { path: { dimensionId: dimension.id }, query: { limit: PAGE_LIMIT } },
        }),
      ),
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const create = useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<{ code: string; name: string }>) =>
      unwrap(
        await api.POST('/v1/dimensions/{dimensionId}/values', {
          body,
          params: {
            path: { dimensionId: dimension.id },
            header: idempotencyHeader(idempotencyKey),
          },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  const rename = useMutation({
    mutationFn: async ({
      idempotencyKey,
      valueId,
      ...body
    }: IdempotentVariables<{ valueId: string; name: string }>) =>
      unwrap(
        await api.PATCH('/v1/dimension-values/{valueId}', {
          body,
          params: { path: { valueId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  const setArchived = useMutation({
    mutationFn: async ({
      idempotencyKey,
      valueId,
      archived,
    }: IdempotentVariables<{ valueId: string; archived: boolean }>) => {
      const params = { path: { valueId }, header: idempotencyHeader(idempotencyKey) };
      return archived
        ? unwrap(await api.POST('/v1/dimension-values/{valueId}/archive', { params }))
        : unwrap(await api.POST('/v1/dimension-values/{valueId}/unarchive', { params }));
    },
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: async ({ idempotencyKey, valueId }: IdempotentVariables<{ valueId: string }>) =>
      expectNoContent(
        await api.DELETE('/v1/dimension-values/{valueId}', {
          params: { path: { valueId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setDialog(null);
      await invalidate();
    },
  });

  /**
   * The refusal that turns a delete into an archive. `dimension_value_in_use` is the
   * server's stable token for "journal lines carry this", which is exactly the case where
   * archiving is the only removal there is — so the dialog stops asking for confirmation
   * and starts offering the operation that will work.
   */
  const inUse = preconditionOf(remove.error) === 'dimension_value_in_use';

  const items = values.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">
          Values on {dimension.name}{' '}
          <span className="font-mono text-xs text-text-subtle">{dimension.code}</span>
        </h3>
        <Button
          disabled={!dimension.isActive}
          onClick={() => {
            create.reset();
            setDraftCode('');
            setDraftName('');
            setDialog({ kind: 'create' });
          }}
        >
          New value
        </Button>
      </div>

      {!dimension.isActive && (
        <Notice tone="info">
          This axis is archived, so it takes no new values and no new tags. Everything already
          tagged with it is untouched and still slices every report it always did.
        </Notice>
      )}

      {values.isError && (
        <ErrorBanner
          error={values.error}
          onRetry={() => {
            void values.refetch();
          }}
        />
      )}
      {setArchived.isError && <ErrorBanner error={setArchived.error} />}

      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Values on {dimension.name}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Code
            </th>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <EmptyRow columns={4}>
              {values.isPending ? 'Loading…' : 'No values on this axis yet.'}
            </EmptyRow>
          )}
          {items.map((value) => (
            <tr key={value.id}>
              <td className={cx(TD_CLASSES, 'font-mono')}>{value.code}</td>
              <td className={TD_CLASSES}>{value.name}</td>
              <td className={TD_CLASSES}>
                <Pill tone={value.isActive ? 'positive' : 'muted'}>
                  {value.isActive ? 'Active' : 'Archived'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      rename.reset();
                      setDraftName(value.name);
                      setDialog({ kind: 'rename', value });
                    }}
                  >
                    Rename
                  </Button>
                  {/*
                    Archive and delete are adjacent and separate, and they stay separate.
                    They are not two words for the same tidy-up: archiving is the only
                    removal a value in use has, and deleting one that is in use is refused
                    by a foreign key rather than by anyone's care.
                  */}
                  <Button
                    size="sm"
                    aria-label={`${value.isActive ? 'Archive' : 'Unarchive'} ${value.name}`}
                    onClick={() => {
                      setArchived.mutate({
                        valueId: value.id,
                        archived: value.isActive,
                        idempotencyKey: newIdempotencyKey(),
                      });
                    }}
                  >
                    {value.isActive ? 'Archive' : 'Unarchive'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Delete ${value.name}`}
                    onClick={() => {
                      remove.reset();
                      setDialog({ kind: 'delete', value });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {values.data?.nextCursor != null && (
        <Notice tone="info">Showing the first {String(PAGE_LIMIT)} values on this axis.</Notice>
      )}

      <ValueFormDialog
        title="New value"
        open={dialog?.kind === 'create'}
        submitLabel="Add value"
        pending={create.isPending}
        error={create.error}
        code={draftCode}
        name={draftName}
        onCodeChange={setDraftCode}
        onNameChange={setDraftName}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={() => {
          create.mutate({
            code: draftCode.trim(),
            name: draftName.trim(),
            idempotencyKey: newIdempotencyKey(),
          });
        }}
      />

      <ValueFormDialog
        title="Rename value"
        open={dialog?.kind === 'rename'}
        submitLabel="Save"
        pending={rename.isPending}
        error={rename.error}
        codeReadOnly={dialog?.kind === 'rename' ? dialog.value.code : ''}
        code={dialog?.kind === 'rename' ? dialog.value.code : ''}
        name={draftName}
        onCodeChange={setDraftCode}
        onNameChange={setDraftName}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={() => {
          if (dialog?.kind !== 'rename') return;
          rename.mutate({
            valueId: dialog.value.id,
            name: draftName.trim(),
            idempotencyKey: newIdempotencyKey(),
          });
        }}
      />

      <Dialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent
          title="Delete value"
          description="Only a value that no journal line and no draft carries can be deleted."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              {inUse ? (
                <Button
                  variant="primary"
                  disabled={setArchived.isPending}
                  onClick={() => {
                    if (dialog?.kind !== 'delete') return;
                    setArchived.mutate({
                      valueId: dialog.value.id,
                      archived: true,
                      idempotencyKey: newIdempotencyKey(),
                    });
                  }}
                >
                  Archive instead
                </Button>
              ) : (
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (dialog?.kind !== 'delete') return;
                    remove.mutate({
                      valueId: dialog.value.id,
                      idempotencyKey: newIdempotencyKey(),
                    });
                  }}
                >
                  Delete value
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">
              Deleting is for a value nothing ever used. If any entry carries it, archiving is the
              only removal available: an archived value keeps every line already tagged with it and
              is simply not offered for a new tag. Deleting one that is in use would restate every
              sliced report ever run without moving a single amount.
            </p>
            {remove.isError && <ErrorBanner error={remove.error} />}
            {inUse && (
              <Notice tone="warning" title="Entries carry this value">
                It cannot be deleted. Archive it instead — nothing already tagged changes, and it
                stops being offered for new tags.
              </Notice>
            )}
            {setArchived.isError && <ErrorBanner error={setArchived.error} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ValueFormDialogProps {
  readonly title: string;
  readonly open: boolean;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly code: string;
  readonly codeReadOnly?: string;
  readonly name: string;
  readonly onCodeChange: (value: string) => void;
  readonly onNameChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}

function ValueFormDialog({
  title,
  open,
  submitLabel,
  pending,
  error,
  code,
  codeReadOnly,
  name,
  onCodeChange,
  onNameChange,
  onClose,
  onSubmit,
}: ValueFormDialogProps): ReactElement {
  const formId = useId();
  const immutable = codeReadOnly !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={title}
        description="A value is a division on this axis. Its code is immutable once created."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form={formId} disabled={pending}>
              {submitLabel}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <Field hint={immutable ? 'Immutable.' : 'Short, e.g. SALES. Immutable once created.'}>
            <FieldLabel>Code</FieldLabel>
            <TextInput
              value={code}
              disabled={immutable}
              onChange={(event) => {
                onCodeChange(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={name}
              onChange={(event) => {
                onNameChange(event.target.value);
              }}
            />
          </Field>
          {error !== null && error !== undefined && <ErrorBanner error={error} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}
