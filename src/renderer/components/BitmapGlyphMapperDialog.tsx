import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { bitmapFontCharacterError, minimumBitmapFontLineHeight, type BitmapFont, type BitmapGlyphCapture } from '@aidraw/core';
import { EditorDialog } from './EditorDialog';

export interface BitmapGlyphMappingRequest {
  fontId: string;
  character: string;
  advance: number;
  lineHeight: number;
}

export function BitmapGlyphMapperDialog({
  fonts,
  capture,
  captureError,
  onSubmit,
  onClose,
}: {
  fonts: BitmapFont[];
  capture?: BitmapGlyphCapture;
  captureError?: string;
  onSubmit: (request: BitmapGlyphMappingRequest) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const initialFont = fonts[0];
  const [fontId, setFontId] = useState(fonts[0]?.id ?? '');
  const [character, setCharacter] = useState('A');
  const [advance, setAdvance] = useState(String(capture?.glyph.advance ?? 1));
  const [lineHeight, setLineHeight] = useState(String(initialFont ? Math.max(initialFont.lineHeight, minimumBitmapFontLineHeight(initialFont, capture?.glyph)) : capture?.glyph.rows.length ?? 1));
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const font = fonts.find((entry) => entry.id === fontId) ?? fonts[0];
  const minimumLineHeight = font ? minimumBitmapFontLineHeight(font, capture?.glyph) : capture?.glyph.rows.length ?? 1;

  useEffect(() => {
    if (!capture) return;
    setAdvance(String(capture.glyph.advance));
    setLineHeight(String(Math.max(font?.lineHeight ?? 1, minimumLineHeight)));
  }, [capture, font?.lineHeight, minimumLineHeight]);

  const validationError = useMemo(() => {
    if (captureError) return captureError;
    if (!capture) return 'The glyph capture is unavailable.';
    if (!font) return 'The document has no bitmap font asset.';
    const characterError = bitmapFontCharacterError(character);
    if (characterError) return characterError;
    const advanceValue = Number(advance);
    if (!Number.isInteger(advanceValue) || advanceValue < 1 || advanceValue > 128) return 'Advance must be a whole number from 1 through 128.';
    const lineHeightValue = Number(lineHeight);
    if (!Number.isInteger(lineHeightValue) || lineHeightValue < minimumLineHeight || lineHeightValue > 128) return `Line height must be a whole number from ${minimumLineHeight} through 128.`;
    return undefined;
  }, [advance, capture, captureError, character, font, lineHeight, minimumLineHeight]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (validationError || !font || !capture) return;
    setBusy(true); setSubmitError(undefined);
    try {
      const applied = await onSubmit({ fontId: font.id, character, advance: Number(advance), lineHeight: Number(lineHeight) });
      if (!applied) setSubmitError('The glyph mapping was not applied. The document was left unchanged.');
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'The glyph mapping could not be applied.');
    } finally { setBusy(false); }
  };

  const replacing = Boolean(font?.glyphs[character]);
  return (
    <EditorDialog
      title="Map selection to bitmap glyph"
      description="Selected nonzero indexed cells become a reusable document-font character; the source sprite and palette stay unchanged."
      className="bitmap-glyph-mapper-dialog"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="entry-dialog-body bitmap-glyph-mapper-body">
          <div className="bitmap-glyph-map-fields">
            <label className="dialog-field"><span>Font asset</span><select autoFocus value={font?.id ?? ''} onChange={(event) => { setFontId(event.target.value); setSubmitError(undefined); }}>{fonts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
            <label className="dialog-field"><span>Character</span><input aria-label="Bitmap glyph character" value={character} maxLength={4} onChange={(event) => { setCharacter(event.target.value); setSubmitError(undefined); }} aria-invalid={Boolean(bitmapFontCharacterError(character))} /></label>
            <label className="dialog-field"><span>Advance</span><input aria-label="Bitmap glyph advance" type="number" min={1} max={128} value={advance} onChange={(event) => { setAdvance(event.target.value); setSubmitError(undefined); }} /></label>
            <label className="dialog-field"><span>Line height</span><input aria-label="Bitmap font line height" type="number" min={minimumLineHeight} max={128} value={lineHeight} onChange={(event) => { setLineHeight(event.target.value); setSubmitError(undefined); }} /></label>
          </div>
          {capture && <div className="bitmap-glyph-capture-preview">
            <svg role="img" aria-label={`Captured glyph preview, ${capture.glyph.width} by ${capture.glyph.rows.length} pixels`} viewBox={`0 0 ${capture.glyph.width} ${capture.glyph.rows.length}`} shapeRendering="crispEdges">
              <rect width={capture.glyph.width} height={capture.glyph.rows.length} className="bitmap-glyph-preview-background" />
              {capture.glyph.rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [<rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} className="bitmap-glyph-preview-ink" />] : []))}
            </svg>
            <span><strong>{capture.glyph.width} × {capture.glyph.rows.length}px</strong><small>{capture.selectedCellCount} selected · {capture.inkCellCount} ink · active-frame indices</small></span>
          </div>}
          <p className="bitmap-glyph-map-note">Only selected cells participate. Every nonzero palette index maps to glyph ink; index 0 and unselected holes stay clear.</p>
          {(validationError || submitError) && <p className="entry-dialog-error" role="alert">{validationError ?? submitError}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-modal-button" disabled={busy || Boolean(validationError)}>{busy ? 'Mapping…' : replacing ? 'Replace glyph' : 'Map glyph'}</button>
        </footer>
      </form>
    </EditorDialog>
  );
}
