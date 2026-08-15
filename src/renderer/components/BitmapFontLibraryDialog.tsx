import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  bitmapFontCreationError,
  bitmapFontDeletionError,
  resolveBitmapFontId,
  type BitmapFont,
} from '@aidraw/core';
import { EditorDialog } from './EditorDialog';

export interface BitmapFontCreationRequest {
  name: string;
  lineHeight: number;
}

export function BitmapFontLibraryDialog({
  fonts,
  selectedFontId,
  onSelectedFontChange,
  onCreate,
  onDelete,
  onClose,
}: {
  fonts: BitmapFont[];
  selectedFontId?: string;
  onSelectedFontChange: (fontId: string) => void;
  onCreate: (request: BitmapFontCreationRequest) => boolean | Promise<boolean>;
  onDelete: (fontId: string) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const resolvedFontId = resolveBitmapFontId(fonts, selectedFontId);
  const font = fonts.find((entry) => entry.id === resolvedFontId);
  const [name, setName] = useState(`Font ${fonts.length + 1}`);
  const [lineHeight, setLineHeight] = useState('8');
  const [busy, setBusy] = useState<'create' | 'delete'>();
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const lineHeightValue = Number(lineHeight);
  const createError = useMemo(() => bitmapFontCreationError(fonts, name, lineHeightValue), [fonts, lineHeightValue, name]);
  const deleteError = font ? bitmapFontDeletionError(fonts, font.id) : 'The document has no available bitmap font.';

  useEffect(() => {
    if (resolvedFontId && resolvedFontId !== selectedFontId) onSelectedFontChange(resolvedFontId);
  }, [onSelectedFontChange, resolvedFontId, selectedFontId]);

  useEffect(() => {
    setDeleteArmed(false);
    setActionError(undefined);
  }, [resolvedFontId]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (createError) return;
    setBusy('create'); setActionError(undefined);
    try {
      const applied = await onCreate({ name: name.trim(), lineHeight: lineHeightValue });
      if (applied) onClose();
      else setActionError('The empty bitmap font was not created. The document was left unchanged.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The empty bitmap font could not be created.');
    } finally { setBusy(undefined); }
  };

  const remove = async () => {
    if (!font || deleteError) return;
    if (!deleteArmed) { setDeleteArmed(true); setActionError(undefined); return; }
    setBusy('delete'); setActionError(undefined);
    try {
      const applied = await onDelete(font.id);
      if (applied) onClose();
      else setActionError('The bitmap font was not deleted. The document was left unchanged.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The bitmap font could not be deleted.');
    } finally { setBusy(undefined); }
  };

  return (
    <EditorDialog
      title="Bitmap font assets"
      description="Create an empty reusable document font or remove a future font asset through one undoable library change."
      className="bitmap-font-library-dialog"
      onClose={onClose}
    >
      <div className="bitmap-font-library-body">
        <section className="bitmap-font-library-current" aria-labelledby="bitmap-font-library-current-title">
          <div>
            <strong id="bitmap-font-library-current-title">Current font</strong>
            <small>{fonts.length} of 64 document fonts</small>
          </div>
          <label className="dialog-field">
            <span>Selected font asset</span>
            <select aria-label="Selected bitmap font asset" value={resolvedFontId} onChange={(event) => onSelectedFontChange(event.target.value)}>
              {fonts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
          {font && <div className="bitmap-font-library-summary">
            <strong>{font.name}</strong>
            <small>{Object.keys(font.glyphs).length} glyphs · {font.lineHeight}px line height</small>
          </div>}
          <p>Deleting this asset does not change text already painted into cels; those pixels are rasterized and have no live font reference.</p>
          <button type="button" className="bitmap-font-delete-button" disabled={Boolean(deleteError) || Boolean(busy)} onClick={() => void remove()}>
            {busy === 'delete' ? 'Deleting…' : deleteArmed ? `Confirm delete ${font?.name ?? 'font'}` : 'Delete selected font'}
          </button>
          {deleteArmed && !deleteError && <p className="bitmap-font-delete-confirmation" role="alert">Undo restores the exact prior font library. Existing cel pixels remain unchanged.</p>}
          {deleteError && <p className="bitmap-font-library-guidance">{deleteError}</p>}
        </section>

        <form className="bitmap-font-create-form" onSubmit={(event) => void create(event)}>
          <div className="bitmap-font-create-heading">
            <strong>Create empty font</strong>
            <small>No bundled glyphs are copied. Map characters with Glyph or Glyph sheet afterward.</small>
          </div>
          <div className="bitmap-font-create-fields">
            <label className="dialog-field"><span>Font name</span><input autoFocus aria-label="New bitmap font name" maxLength={200} value={name} onChange={(event) => { setName(event.target.value); setActionError(undefined); }} /></label>
            <label className="dialog-field"><span>Line height</span><input aria-label="New bitmap font line height" type="number" min={1} max={128} value={lineHeight} onChange={(event) => { setLineHeight(event.target.value); setActionError(undefined); }} /></label>
          </div>
          {createError && <p className="entry-dialog-error" role="alert">{createError}</p>}
          <button type="submit" className="primary-modal-button" disabled={Boolean(createError) || Boolean(busy)}>{busy === 'create' ? 'Creating…' : 'Create empty font'}</button>
        </form>
        {actionError && <p className="entry-dialog-error bitmap-font-library-action-error" role="alert">{actionError}</p>}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Close</button></footer>
    </EditorDialog>
  );
}
