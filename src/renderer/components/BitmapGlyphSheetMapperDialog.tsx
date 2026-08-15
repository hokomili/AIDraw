import { useMemo, useState, type FormEvent } from 'react';
import { mapBitmapFontGlyphSheet, type BitmapFont, type BitmapGlyphSheetMapping } from '@aidraw/core';
import { EditorDialog } from './EditorDialog';

export interface BitmapGlyphSheetMappingRequest {
  fontId: string;
  characters: string;
  columns: number;
  advance?: number;
  lineHeight?: number;
}

function displayCharacter(character: string): string {
  if (character === ' ') return 'Space';
  if (character === '\t') return 'Tab';
  return character;
}

export function BitmapGlyphSheetMapperDialog({
  fonts,
  points,
  readIndex,
  onSubmit,
  onClose,
}: {
  fonts: BitmapFont[];
  points: ReadonlyArray<{ x: number; y: number }>;
  readIndex: (x: number, y: number) => number;
  onSubmit: (request: BitmapGlyphSheetMappingRequest) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const [fontId, setFontId] = useState(fonts[0]?.id ?? '');
  const [characters, setCharacters] = useState('AB');
  const [columns, setColumns] = useState('2');
  const [advance, setAdvance] = useState('');
  const [lineHeight, setLineHeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const font = fonts.find((entry) => entry.id === fontId) ?? fonts[0];
  const result = useMemo<{ mapping?: BitmapGlyphSheetMapping; error?: string }>(() => {
    if (!font) return { error: 'The document has no bitmap font asset.' };
    try {
      return {
        mapping: mapBitmapFontGlyphSheet(
          font,
          points,
          readIndex,
          characters,
          Number(columns),
          advance === '' ? undefined : Number(advance),
          lineHeight === '' ? undefined : Number(lineHeight),
        ),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The selected glyph sheet could not be mapped.' };
    }
  }, [advance, characters, columns, font, lineHeight, points, readIndex]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!font || !result.mapping) return;
    setBusy(true); setSubmitError(undefined);
    try {
      const applied = await onSubmit({
        fontId: font.id,
        characters,
        columns: Number(columns),
        advance: advance === '' ? undefined : Number(advance),
        lineHeight: lineHeight === '' ? undefined : Number(lineHeight),
      });
      if (!applied) setSubmitError('The glyph-sheet mapping was not applied. The document was left unchanged.');
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'The glyph-sheet mapping could not be applied.');
    } finally { setBusy(false); }
  };

  return (
    <EditorDialog
      title="Map indexed selection as glyph sheet"
      description="Divide one reviewed active-frame selection into uniform row-major cells and map the explicit character order into an existing document font. The source sprite, palette, frame, and selection stay unchanged."
      className="bitmap-glyph-mapper-dialog bitmap-glyph-sheet-mapper-dialog"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="entry-dialog-body bitmap-glyph-mapper-body">
          <div className="bitmap-glyph-map-fields">
            <label className="dialog-field"><span>Font asset</span><select autoFocus value={font?.id ?? ''} onChange={(event) => { setFontId(event.target.value); setSubmitError(undefined); }}>{fonts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
            <label className="dialog-field"><span>Columns</span><input aria-label="Bitmap glyph sheet columns" type="number" min={1} max={Math.max(1, [...characters].length)} value={columns} onChange={(event) => { setColumns(event.target.value); setSubmitError(undefined); }} /></label>
            <label className="dialog-field bitmap-glyph-sheet-order"><span>Characters in row-major order</span><textarea aria-label="Bitmap glyph sheet character order" rows={2} maxLength={512} value={characters} onChange={(event) => { setCharacters(event.target.value); setSubmitError(undefined); }} /></label>
            <label className="dialog-field"><span>Shared advance <small>blank = cell width</small></span><input aria-label="Bitmap glyph sheet advance" type="number" min={1} max={128} placeholder="Cell width" value={advance} onChange={(event) => { setAdvance(event.target.value); setSubmitError(undefined); }} /></label>
            <label className="dialog-field"><span>Line height <small>blank = safe minimum</small></span><input aria-label="Bitmap glyph sheet line height" type="number" min={1} max={128} placeholder="Font/cell minimum" value={lineHeight} onChange={(event) => { setLineHeight(event.target.value); setSubmitError(undefined); }} /></label>
          </div>
          {result.mapping && <>
            <div className="bitmap-glyph-sheet-summary">
              <strong>{result.mapping.characterCount} glyphs · {result.mapping.columns} × {result.mapping.rows} grid</strong>
              <small>{result.mapping.cellWidth} × {result.mapping.cellHeight}px cells · {result.mapping.selectedCellCount} selected · {result.mapping.inkCellCount} ink · {result.mapping.newGlyphCount} new · {result.mapping.replacedGlyphCount} replaced · {result.mapping.blankGlyphCount} blank</small>
            </div>
            <div className="bitmap-glyph-sheet-preview" aria-label="First mapped bitmap glyphs">
              {result.mapping.mappings.slice(0, 8).map((mapping) => <figure key={mapping.character}>
                <svg role="img" aria-label={`${displayCharacter(mapping.character)} glyph preview, ${mapping.glyph.width} by ${mapping.glyph.rows.length} pixels`} viewBox={`0 0 ${mapping.glyph.width} ${mapping.glyph.rows.length}`} shapeRendering="crispEdges">
                  <rect width={mapping.glyph.width} height={mapping.glyph.rows.length} className="bitmap-glyph-preview-background" />
                  {mapping.glyph.rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [<rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} className="bitmap-glyph-preview-ink" />] : []))}
                </svg>
                <figcaption><strong>{displayCharacter(mapping.character)}</strong><small>{mapping.inkCellCount} ink · {mapping.replaced ? 'replace' : 'new'}</small></figcaption>
              </figure>)}
            </div>
          </>}
          <p className="bitmap-glyph-map-note">Cells are interpreted only by the entered order and column count. Selected nonzero indices become ink; index 0 and unselected cells are clear. Blank mapped cells are valid, but unused trailing grid cells must contain no selected ink.</p>
          {(result.error || submitError) && <p className="entry-dialog-error" role="alert">{result.error ?? submitError}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-modal-button" disabled={busy || !result.mapping}>{busy ? 'Mapping…' : result.mapping ? `Map ${result.mapping.characterCount} glyphs` : 'Map glyph sheet'}</button>
        </footer>
      </form>
    </EditorDialog>
  );
}
