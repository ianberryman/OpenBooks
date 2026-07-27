import type { ChangeEvent, ReactElement } from 'react';
import { useMemo, useState } from 'react';

import {
  Button,
  Combobox,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
  TextInput,
} from '../../components';
import { newIdempotencyKey } from '../../api';
import { cx } from '../../lib/cx';
import { ImportProgress } from './import-progress';
import { MappingEditor, initialMappingDraft, toDefinition } from './mapping-editor';
import type { ColumnOption, MappingDraft } from './mapping-editor';
import { ImportPreview } from './preview';
import type { BankStatementFormat } from './queries';
import {
  useBankAccountOptions,
  useBankImportMappings,
  usePreviewImport,
  useSaveMapping,
  useStartImport,
} from './queries';

/**
 * Import a bank statement from a file (OB-085; ROADMAP D-41, D-42, D-49, acceptance E1).
 *
 * ## The shape of the task
 *
 * A statement is uploaded as text — CSV or OFX, both text, so there is no multipart
 * (D-41) — read client-side with `FileReader` and sent as a string in the JSON body. A
 * CSV needs a column mapping, because a bank's file has no fixed layout; an OFX names its
 * own fields and needs none. The mapping is where the domain's two traps live, and the
 * editor encodes them (`mapping-editor.tsx`): the date order is stated rather than guessed,
 * and under separate debit/credit columns the *credit* column is the money coming in.
 *
 * ## Preview, then import, then poll
 *
 * Preview is synchronous and writes nothing: it shows the parsed rows with a duplicate
 * marker on each already-present line, which is E1 made visible before anything is
 * committed. Import is async (D-49) — start-import returns a queued handle and the parse
 * runs on the worker — so the screen polls the handle to completion and reports the E1
 * counts. Because re-import is idempotent, a second upload is safe rather than dangerous,
 * and the copy throughout says so.
 */

const FORMATS: readonly { readonly value: BankStatementFormat; readonly label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'ofx', label: 'OFX / QFX' },
];

const BUILD = 'build';

export function BankImportScreen(): ReactElement {
  const accounts = useBankAccountOptions();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [format, setFormat] = useState<BankStatementFormat>('csv');
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [mappingSource, setMappingSource] = useState<string>(BUILD);
  const [draft, setDraft] = useState<MappingDraft>(initialMappingDraft);
  const [saveAsName, setSaveAsName] = useState('');
  const [importId, setImportId] = useState<string | null>(null);

  const mappings = useBankImportMappings(accountId);
  const previewMutation = usePreviewImport();
  const startMutation = useStartImport();
  const saveMutation = useSaveMapping();

  const preview = previewMutation.data ?? null;

  /**
   * The columns the file offers, enumerated from its first line for assignment.
   *
   * A display aid only: the real parse is the server's (preview and import). Splitting the
   * first line lets the user assign fields to columns without counting commas — headers
   * when the file has them, `Column N` when it does not.
   */
  const columnOptions = useMemo<readonly ColumnOption[]>(
    () => (content === null ? [] : enumerateColumns(content, draft.delimiter, draft.hasHeaderRow)),
    [content, draft.delimiter, draft.hasHeaderRow],
  );

  const definition = useMemo(() => toDefinition(draft), [draft]);

  function resetDownstream(): void {
    previewMutation.reset();
    startMutation.reset();
    setImportId(null);
  }

  function selectAccount(id: string | null): void {
    setAccountId(id);
    setMappingSource(BUILD);
    resetDownstream();
  }

  function selectFormat(next: BankStatementFormat): void {
    setFormat(next);
    resetDownstream();
  }

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const reader = new FileReader();
    reader.onload = () => {
      setContent(typeof reader.result === 'string' ? reader.result : '');
      setFileName(file.name);
      resetDownstream();
    };
    // Text, never binary: both formats D-41 accepts are text, and the wire body is a string.
    reader.readAsText(file);
  }

  function editDraft(next: MappingDraft): void {
    setDraft(next);
    previewMutation.reset();
  }

  /**
   * How this upload should be read — exactly one reading, per the contract.
   *
   * OFX carries its own field names, so it takes neither a mapping nor a mapping id; a CSV
   * takes exactly one. `null` means "not ready" (a CSV whose mapping is still incomplete),
   * which is what disables preview and import.
   */
  const reading = useMemo<{
    mapping?: ReturnType<typeof toDefinition>;
    mappingId?: string;
  } | null>(() => {
    if (format === 'ofx') return {};
    if (mappingSource !== BUILD) return { mappingId: mappingSource };
    return definition === null ? null : { mapping: definition };
  }, [format, mappingSource, definition]);

  const ready = accountId !== null && content !== null && reading !== null;

  function runPreview(): void {
    if (accountId === null || content === null || fileName === null || reading === null) return;
    previewMutation.mutate({
      bankAccountId: accountId,
      format,
      filename: fileName,
      content,
      ...reading,
      idempotencyKey: newIdempotencyKey(),
    });
  }

  function runImport(): void {
    if (accountId === null || content === null || fileName === null || reading === null) return;
    startMutation.mutate(
      {
        bankAccountId: accountId,
        format,
        filename: fileName,
        content,
        ...reading,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (queued) => {
          setImportId(queued.id);
        },
      },
    );
  }

  function saveMapping(): void {
    if (accountId === null || definition === null || saveAsName.trim() === '') return;
    saveMutation.mutate(
      {
        bankAccountId: accountId,
        name: saveAsName.trim(),
        definition,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (mapping) => {
          // Switch to the saved mapping so the next preview and the import send its id —
          // the round-trip that OB-076's reuse is: build once, save, then reuse by id.
          setMappingSource(mapping.id);
          setSaveAsName('');
          previewMutation.reset();
        },
      },
    );
  }

  function startOver(): void {
    setContent(null);
    setFileName(null);
    setMappingSource(BUILD);
    setDraft(initialMappingDraft());
    setSaveAsName('');
    resetDownstream();
  }

  const savedOptions = [
    { value: BUILD, label: 'Build a new mapping' },
    ...(mappings.data ?? []).map((mapping) => ({ value: mapping.id, label: mapping.name })),
  ];
  const usingSaved = mappingSource !== BUILD;
  const selectedSaved = (mappings.data ?? []).find((mapping) => mapping.id === mappingSource);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Import a bank statement</h1>
        <p className="max-w-form text-text-muted">
          Upload a CSV or OFX file. Re-importing an overlapping statement is safe — rows already on
          the account are recognised and skipped, never doubled.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-72">
          <FieldLabel>Bank account</FieldLabel>
          <Combobox
            value={accountId}
            placeholder="Choose an account…"
            options={accounts.map((account) => ({
              value: account.id,
              label: account.name,
              ...(account.institutionName === null ? {} : { detail: account.institutionName }),
            }))}
            onValueChange={selectAccount}
          />
        </Field>

        <Field className="w-40">
          <FieldLabel>Format</FieldLabel>
          <Select
            value={format}
            options={FORMATS}
            onValueChange={(next) => {
              selectFormat(next as BankStatementFormat);
            }}
          />
        </Field>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">File</span>
          <input
            type="file"
            accept=".csv,.ofx,.qfx,text/csv,text/plain"
            onChange={onFile}
            className={cx(
              'block text-sm text-text-muted',
              'file:mr-3 file:rounded-md file:border file:border-border file:bg-surface',
              'file:px-3 file:py-1.5 file:text-text hover:file:bg-surface-hover',
            )}
          />
        </label>

        {fileName !== null && <p className="text-sm text-text-subtle">{fileName}</p>}
      </div>

      {content !== null && format === 'csv' && (
        <div className="flex flex-col gap-3">
          <Field className="w-72">
            <FieldLabel>Column mapping</FieldLabel>
            <Select
              value={mappingSource}
              options={savedOptions}
              onValueChange={(next) => {
                setMappingSource(next);
                previewMutation.reset();
              }}
            />
          </Field>

          {usingSaved ? (
            <p className="rounded-lg border border-border bg-surface p-3 text-sm text-text-muted">
              Reading this file with the saved mapping
              {selectedSaved === undefined ? '' : ` “${selectedSaved.name}”`}. Choose “Build a new
              mapping” to change how the columns are read.
            </p>
          ) : (
            <>
              <MappingEditor columns={columnOptions} value={draft} onChange={editDraft} />

              <div className="flex flex-wrap items-end gap-3">
                <Field
                  className="w-72"
                  hint="Reuse this layout on next month’s upload from this bank."
                >
                  <FieldLabel>Save this mapping as</FieldLabel>
                  <TextInput
                    value={saveAsName}
                    placeholder="e.g. Barclays Current"
                    onChange={(event) => {
                      setSaveAsName(event.target.value);
                    }}
                  />
                </Field>
                <Button
                  disabled={
                    definition === null || saveAsName.trim() === '' || saveMutation.isPending
                  }
                  onClick={saveMapping}
                >
                  {saveMutation.isPending ? 'Saving…' : 'Save mapping for reuse'}
                </Button>
              </div>
            </>
          )}

          {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}
        </div>
      )}

      {content !== null && format === 'ofx' && (
        <p className="rounded-lg border border-border bg-surface p-3 text-sm text-text-muted">
          OFX files name their own fields, so no column mapping is needed. Preview to see the rows
          that would be imported.
        </p>
      )}

      {importId === null && (
        <>
          <div className="flex gap-2">
            <Button disabled={!ready || previewMutation.isPending} onClick={runPreview}>
              {previewMutation.isPending ? 'Reading…' : 'Preview'}
            </Button>
            <Button
              variant="primary"
              disabled={!ready || preview === null || startMutation.isPending}
              onClick={runImport}
            >
              {startMutation.isPending ? 'Starting…' : 'Import'}
            </Button>
          </div>

          {previewMutation.isError && (
            <ErrorBanner error={previewMutation.error} onRetry={runPreview} />
          )}
          {startMutation.isError && <ErrorBanner error={startMutation.error} onRetry={runImport} />}

          {preview !== null && <ImportPreview preview={preview} />}
        </>
      )}

      {importId !== null && (
        <ImportProgress importId={importId} onDone={startOver} onImportAnother={startOver} />
      )}
    </div>
  );
}

const NEWLINE = /\r\n|\r|\n/;

/**
 * The file's first non-empty line, split by the chosen delimiter, as column options.
 *
 * Header text when the file has a header row; `Column N` (1-based label, 0-based value)
 * when it does not. A blank header cell falls back to `Column N` too, so an unnamed column
 * is still selectable.
 */
function enumerateColumns(
  content: string,
  delimiter: string,
  hasHeaderRow: boolean,
): readonly ColumnOption[] {
  const line = content.split(NEWLINE).find((row) => row.trim() !== '');
  if (line === undefined) return [];
  return line.split(delimiter).map((cell, index) => {
    const header = cell.trim();
    return {
      index,
      label: hasHeaderRow && header !== '' ? header : `Column ${index + 1}`,
    };
  });
}
