import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  bitmapFontCreationError,
  bitmapFontDeletionError,
  bitmapFontGlyphEditError,
  bitmapFontRenameError,
  orderedBitmapFontCharacters,
  resolveBitmapFontCharacter,
  resolveBitmapFontId,
  toggleBitmapGlyphCell,
  type BitmapFont,
  type BitmapGlyph,
} from '@aidraw/core';
import {
  bitmapGlyphGridKeyAction,
  cancelBitmapGlyphDimensionDraft,
  commitBitmapGlyphDimensionDraft,
  createBitmapGlyphCellFocusRegistry,
  createBitmapGlyphDimensionDraft,
  updateBitmapGlyphDimensionDraft,
  type BitmapGlyphDimensionAxis,
  type BitmapGlyphDimensionDraftState,
} from '../bitmap-font-editor';
import { EditorDialog } from './EditorDialog';

export interface BitmapFontCreationRequest {
  name: string;
  lineHeight: number;
}

export interface BitmapFontRenameRequest {
  expectedFont: BitmapFont;
  name: string;
}

export interface BitmapFontGlyphEditRequest {
  expectedFont: BitmapFont;
  character: string;
  glyph: BitmapGlyph;
  lineHeight: number;
}

export interface BitmapFontGlyphDeleteRequest {
  expectedFont: BitmapFont;
  character: string;
}

function characterLabel(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const code = `U+${codePoint.toString(16).toUpperCase().padStart(codePoint <= 0xffff ? 4 : 6, '0')}`;
  return /^\s$/u.test(character) || codePoint < 0x20 || codePoint === 0x7f ? code : `${character} · ${code}`;
}

export function BitmapFontLibraryDialog({
  fonts,
  selectedFontId,
  onSelectedFontChange,
  onCreate,
  onDelete,
  onRename,
  onEditGlyph,
  onDeleteGlyph,
  onClose,
}: {
  fonts: BitmapFont[];
  selectedFontId?: string;
  onSelectedFontChange: (fontId: string) => void;
  onCreate: (request: BitmapFontCreationRequest) => boolean | Promise<boolean>;
  onDelete: (fontId: string) => boolean | Promise<boolean>;
  onRename: (request: BitmapFontRenameRequest) => boolean | Promise<boolean>;
  onEditGlyph: (request: BitmapFontGlyphEditRequest) => boolean | Promise<boolean>;
  onDeleteGlyph: (request: BitmapFontGlyphDeleteRequest) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const resolvedFontId = resolveBitmapFontId(fonts, selectedFontId);
  const font = fonts.find((entry) => entry.id === resolvedFontId);
  const initialCharacter = font ? resolveBitmapFontCharacter(font) : '';
  const initialGlyph = initialCharacter && font ? font.glyphs[initialCharacter] : undefined;
  const [name, setName] = useState(`Font ${fonts.length + 1}`);
  const [lineHeight, setLineHeight] = useState('8');
  const [renameName, setRenameName] = useState(font?.name ?? '');
  const [selectedCharacter, setSelectedCharacter] = useState(initialCharacter);
  const [glyphEdit, setGlyphEdit] = useState<BitmapGlyphDimensionDraftState | undefined>(() => initialGlyph ? createBitmapGlyphDimensionDraft(initialGlyph) : undefined);
  const [glyphAdvance, setGlyphAdvance] = useState(initialGlyph ? String(initialGlyph.advance) : '');
  const [glyphLineHeight, setGlyphLineHeight] = useState(font ? String(font.lineHeight) : '');
  const [glyphFocus, setGlyphFocus] = useState({ x: 0, y: 0 });
  const glyphCellFocusRegistry = useRef(createBitmapGlyphCellFocusRegistry<HTMLButtonElement>());
  const [busy, setBusy] = useState<'create' | 'delete-font' | 'rename' | 'edit-glyph' | 'delete-glyph'>();
  const [deleteFontArmed, setDeleteFontArmed] = useState(false);
  const [deleteGlyphArmed, setDeleteGlyphArmed] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const resolvedCharacter = font ? resolveBitmapFontCharacter(font, selectedCharacter) : '';
  const glyph = font && resolvedCharacter ? font.glyphs[resolvedCharacter] : undefined;
  const characters = useMemo(() => font ? orderedBitmapFontCharacters(font) : [], [font]);
  const lineHeightValue = Number(lineHeight);
  const createError = useMemo(() => bitmapFontCreationError(fonts, name, lineHeightValue), [fonts, lineHeightValue, name]);
  const deleteError = font ? bitmapFontDeletionError(fonts, font.id) : 'The document has no available bitmap font.';
  const renameError = font ? bitmapFontRenameError(font, renameName) : 'The selected bitmap font no longer exists.';
  const currentFontId = font?.id;
  const currentFontName = font?.name ?? '';
  const glyphDraft = glyphEdit?.glyph;
  const glyphWidth = glyphEdit?.width ?? '';
  const glyphHeight = glyphEdit?.height ?? '';

  const glyphCandidate = useMemo<{ glyph?: BitmapGlyph; lineHeight?: number; error?: string }>(() => {
    if (!font || !glyph || !glyphDraft || !resolvedCharacter) return {};
    const advance = Number(glyphAdvance); const nextLineHeight = Number(glyphLineHeight);
    try {
      if (glyphWidth !== String(glyphDraft.width) || glyphHeight !== String(glyphDraft.rows.length)) return { error: 'Commit or cancel the width and height drafts before applying glyph changes.' };
      const candidate = { ...glyphDraft, advance };
      return { glyph: candidate, lineHeight: nextLineHeight, error: bitmapFontGlyphEditError(font, resolvedCharacter, candidate, nextLineHeight) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The bitmap glyph metrics are invalid.' };
    }
  }, [font, glyph, glyphAdvance, glyphDraft, glyphHeight, glyphLineHeight, glyphWidth, resolvedCharacter]);

  useEffect(() => {
    if (resolvedFontId && resolvedFontId !== selectedFontId) onSelectedFontChange(resolvedFontId);
  }, [onSelectedFontChange, resolvedFontId, selectedFontId]);

  useEffect(() => {
    setDeleteFontArmed(false);
    setDeleteGlyphArmed(false);
    setActionError(undefined);
    setRenameName(currentFontName);
  }, [currentFontId, currentFontName]);

  useEffect(() => {
    setSelectedCharacter(resolvedCharacter);
    const current = resolvedCharacter && font ? font.glyphs[resolvedCharacter] : undefined;
    setGlyphEdit(current ? createBitmapGlyphDimensionDraft(current) : undefined);
    setGlyphAdvance(current ? String(current.advance) : '');
    setGlyphLineHeight(font ? String(font.lineHeight) : '');
    setGlyphFocus({ x: 0, y: 0 });
    setDeleteGlyphArmed(false);
    setActionError(undefined);
  }, [font, resolvedCharacter]);

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

  const removeFont = async () => {
    if (!font || deleteError) return;
    if (!deleteFontArmed) { setDeleteFontArmed(true); setActionError(undefined); return; }
    setBusy('delete-font'); setActionError(undefined);
    try {
      const applied = await onDelete(font.id);
      if (applied) onClose();
      else setActionError('The bitmap font was not deleted. The document was left unchanged.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The bitmap font could not be deleted.');
    } finally { setBusy(undefined); }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (!font || renameError) return;
    setBusy('rename'); setActionError(undefined);
    try {
      if (!await onRename({ expectedFont: structuredClone(font), name: renameName.trim() })) setActionError('The bitmap font was not renamed. Review the current library and try again.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The bitmap font could not be renamed.');
    } finally { setBusy(undefined); }
  };

  const editGlyph = async (event: FormEvent) => {
    event.preventDefault();
    if (!font || !glyphCandidate.glyph || glyphCandidate.lineHeight === undefined || glyphCandidate.error || !resolvedCharacter) return;
    setBusy('edit-glyph'); setActionError(undefined);
    try {
      if (!await onEditGlyph({ expectedFont: structuredClone(font), character: resolvedCharacter, glyph: glyphCandidate.glyph, lineHeight: glyphCandidate.lineHeight })) setActionError('The bitmap glyph was not changed. Review the current mapping and try again.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The bitmap glyph could not be changed.');
    } finally { setBusy(undefined); }
  };

  const removeGlyph = async () => {
    if (!font || !resolvedCharacter) return;
    if (!deleteGlyphArmed) { setDeleteGlyphArmed(true); setActionError(undefined); return; }
    setBusy('delete-glyph'); setActionError(undefined);
    try {
      if (!await onDeleteGlyph({ expectedFont: structuredClone(font), character: resolvedCharacter })) setActionError('The bitmap glyph was not deleted. Review the current mapping and try again.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The bitmap glyph could not be deleted.');
    } finally { setBusy(undefined); }
  };

  const updateDimension = (axis: BitmapGlyphDimensionAxis, value: string) => {
    setGlyphEdit((current) => current ? updateBitmapGlyphDimensionDraft(current, axis, value) : current);
    setActionError(undefined);
  };

  const commitDimension = (axis: BitmapGlyphDimensionAxis) => {
    if (!glyphEdit) return;
    const result = commitBitmapGlyphDimensionDraft(glyphEdit, axis);
    setGlyphEdit(result.state);
    setGlyphFocus((current) => ({
      x: Math.min(current.x, result.state.glyph.width - 1),
      y: Math.min(current.y, result.state.glyph.rows.length - 1),
    }));
    setActionError(result.error);
  };

  const handleDimensionKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, axis: BitmapGlyphDimensionAxis) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDimension(axis);
    } else if (event.key === 'Escape' && glyphEdit) {
      event.preventDefault();
      setGlyphEdit(cancelBitmapGlyphDimensionDraft(glyphEdit, axis));
      setActionError(undefined);
    }
  };

  const toggleGlyphCell = (x: number, y: number) => {
    setGlyphEdit((current) => current ? { ...current, glyph: toggleBitmapGlyphCell(current.glyph, x, y) } : current);
    setActionError(undefined);
  };

  const handleGlyphCellKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, x: number, y: number) => {
    if (!glyphDraft) return;
    const action = bitmapGlyphGridKeyAction({ x, y, width: glyphDraft.width, height: glyphDraft.rows.length, key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    if (!action) return;
    event.preventDefault();
    if (action.activate) {
      if (!event.repeat) toggleGlyphCell(x, y);
      return;
    }
    setGlyphFocus({ x: action.x, y: action.y });
    glyphCellFocusRegistry.current.focus(action.x, action.y);
  };

  return (
    <EditorDialog
      title="Bitmap font assets"
      description="Create, rename, inspect, edit, or remove reusable document fonts and mapped Unicode glyphs through undoable library changes."
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
          {font && <form className="bitmap-font-rename-form" onSubmit={(event) => void rename(event)}>
            <label className="dialog-field"><span>Font name</span><input aria-label="Rename selected bitmap font" maxLength={200} value={renameName} onChange={(event) => { setRenameName(event.target.value); setActionError(undefined); }} /></label>
            <button type="submit" className="secondary-modal-button" disabled={Boolean(renameError) || Boolean(busy)}>{busy === 'rename' ? 'Renaming…' : 'Apply font name'}</button>
          </form>}
          <p>Deleting this asset does not change text already painted into cels; those pixels are rasterized and have no live font reference.</p>
          <button type="button" className="bitmap-font-delete-button" disabled={Boolean(deleteError) || Boolean(busy)} onClick={() => void removeFont()}>
            {busy === 'delete-font' ? 'Deleting…' : deleteFontArmed ? `Confirm delete ${font?.name ?? 'font'}` : 'Delete selected font'}
          </button>
          {deleteFontArmed && !deleteError && <p className="bitmap-font-delete-confirmation" role="alert">Undo restores the exact prior font library. Existing cel pixels remain unchanged.</p>}
          {deleteError && <p className="bitmap-font-library-guidance">{deleteError}</p>}
        </section>

        <form className="bitmap-font-create-form" onSubmit={(event) => void create(event)}>
          <div className="bitmap-font-create-heading">
            <strong>Create empty font</strong>
            <small>No bundled glyphs are copied. Map characters with Glyph or Glyph sheet afterward.</small>
          </div>
          <div className="bitmap-font-create-fields">
            <label className="dialog-field"><span>Font name</span><input aria-label="New bitmap font name" maxLength={200} value={name} onChange={(event) => { setName(event.target.value); setActionError(undefined); }} /></label>
            <label className="dialog-field"><span>Line height</span><input aria-label="New bitmap font line height" type="number" min={1} max={128} value={lineHeight} onChange={(event) => { setLineHeight(event.target.value); setActionError(undefined); }} /></label>
          </div>
          {createError && <p className="entry-dialog-error" role="alert">{createError}</p>}
          <button type="submit" className="primary-modal-button" disabled={Boolean(createError) || Boolean(busy)}>{busy === 'create' ? 'Creating…' : 'Create empty font'}</button>
        </form>

        <section className="bitmap-font-glyph-editor" aria-labelledby="bitmap-font-glyph-editor-title">
          <div className="bitmap-font-glyph-heading">
            <div><strong id="bitmap-font-glyph-editor-title">Mapped glyph editor</strong><small>Choose one existing Unicode mapping. Ink cells are dark; clear cells are light.</small></div>
            {font && <span>{characters.length} mapped</span>}
          </div>
          {!font || !characters.length || !glyph || !glyphDraft ? <div className="bitmap-font-empty-glyphs"><strong>This font has no mapped glyphs.</strong><span>Use Glyph or Glyph sheet on a sprite selection to add the first mapping.</span></div> : <>
            <label className="dialog-field bitmap-font-character-field"><span>Mapped character</span><select aria-label="Selected mapped Unicode character" value={resolvedCharacter} onChange={(event) => setSelectedCharacter(event.target.value)}>{characters.map((character) => <option key={character} value={character}>{characterLabel(character)}</option>)}</select></label>
            <form className="bitmap-font-glyph-form" onSubmit={(event) => void editGlyph(event)}>
              <div className="bitmap-font-glyph-metrics">
                <label><span>Width</span><input aria-label="Bitmap glyph width" type="number" min={1} max={64} value={glyphWidth} onChange={(event) => updateDimension('width', event.target.value)} onBlur={() => commitDimension('width')} onKeyDown={(event) => handleDimensionKeyDown(event, 'width')} /></label>
                <label><span>Height</span><input aria-label="Bitmap glyph height" type="number" min={1} max={64} value={glyphHeight} onChange={(event) => updateDimension('height', event.target.value)} onBlur={() => commitDimension('height')} onKeyDown={(event) => handleDimensionKeyDown(event, 'height')} /></label>
                <label><span>Advance</span><input aria-label="Bitmap glyph advance" type="number" min={1} max={128} value={glyphAdvance} onChange={(event) => { setGlyphAdvance(event.target.value); setActionError(undefined); }} /></label>
                <label><span>Line height</span><input aria-label="Bitmap font line height" type="number" min={1} max={128} value={glyphLineHeight} onChange={(event) => { setGlyphLineHeight(event.target.value); setActionError(undefined); }} /></label>
              </div>
              <p className="bitmap-font-glyph-resize-note">Press Enter or leave a width or height field to resize from the top-left; Escape cancels that draft. Expansion adds clear cells; shrinking clips right or bottom cells.</p>
              <div className="bitmap-font-glyph-grid-scroll">
                <div className="bitmap-font-glyph-grid" role="grid" aria-label={`Monochrome bitmap for ${characterLabel(resolvedCharacter)}`} aria-describedby="bitmap-font-glyph-grid-help" aria-rowcount={glyphDraft.rows.length} aria-colcount={glyphDraft.width} style={{ gridTemplateColumns: `repeat(${glyphDraft.width}, var(--ui-hit-secondary))` }}>
                  {glyphDraft.rows.map((row, y) => <div key={y} className="bitmap-font-glyph-row" role="row" aria-rowindex={y + 1}>{[...row].map((cell, x) => <button
                    key={`${x}:${y}`}
                    type="button"
                    role="gridcell"
                    aria-colindex={x + 1}
                    className={cell === '#' ? 'is-ink' : ''}
                    aria-label={`Row ${y + 1}, column ${x + 1}: ${cell === '#' ? 'ink' : 'clear'}`}
                    aria-pressed={cell === '#'}
                    tabIndex={glyphFocus.x === x && glyphFocus.y === y ? 0 : -1}
                    ref={glyphCellFocusRegistry.current.refFor(x, y)}
                    onFocus={() => setGlyphFocus({ x, y })}
                    onKeyDown={(event) => handleGlyphCellKeyDown(event, x, y)}
                    onClick={() => toggleGlyphCell(x, y)}
                  />)}</div>)}
                </div>
              </div>
              <p id="bitmap-font-glyph-grid-help" className="bitmap-font-glyph-resize-note">Tab enters the grid once. Arrow keys move by cell, Home and End move within a row, Control or Command with Home or End moves to a grid corner, and Space or Enter toggles the focused cell.</p>
              {glyphCandidate.error && <p className="bitmap-font-library-guidance">{glyphCandidate.error}</p>}
              <div className="bitmap-font-glyph-actions">
                <button type="submit" className="primary-modal-button" disabled={Boolean(glyphCandidate.error) || Boolean(busy)}>{busy === 'edit-glyph' ? 'Applying…' : 'Apply glyph changes'}</button>
                <button type="button" className="bitmap-font-delete-button" disabled={Boolean(busy)} onClick={() => void removeGlyph()}>{busy === 'delete-glyph' ? 'Deleting…' : deleteGlyphArmed ? `Confirm delete ${characterLabel(resolvedCharacter)}` : 'Delete glyph mapping'}</button>
              </div>
              {deleteGlyphArmed && <p className="bitmap-font-delete-confirmation" role="alert">This font may remain empty. Already-rasterized cel pixels are not changed.</p>}
            </form>
          </>}
        </section>
        {actionError && <p className="entry-dialog-error bitmap-font-library-action-error" role="alert">{actionError}</p>}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary-modal-button" onClick={onClose}>Close</button></footer>
    </EditorDialog>
  );
}
