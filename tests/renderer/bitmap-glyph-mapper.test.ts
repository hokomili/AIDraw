import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultBitmapFont, type BitmapGlyphCapture } from '@aidraw/core';
import { BitmapGlyphMapperDialog } from '../../src/renderer/components/BitmapGlyphMapperDialog';
import { BitmapGlyphSheetMapperDialog } from '../../src/renderer/components/BitmapGlyphSheetMapperDialog';

const capture: BitmapGlyphCapture = {
  glyph: { width: 3, advance: 4, rows: ['#..', '.#.', '..#'] },
  bounds: { x: 4, y: 2, width: 3, height: 3 },
  selectedCellCount: 5,
  inkCellCount: 3,
};

describe('bitmap glyph mapper', () => {
  it('renders an accessible, bounded selection-to-font mapping preview', () => {
    const markup = renderToStaticMarkup(createElement(BitmapGlyphMapperDialog, {
      fonts: [createDefaultBitmapFont()],
      capture,
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Map selection to bitmap glyph');
    expect(markup).toContain('the source sprite and palette stay unchanged');
    expect(markup).toContain('Bitmap glyph character');
    expect(markup).toContain('Bitmap glyph advance');
    expect(markup).toContain('Bitmap font line height');
    expect(markup).toContain('Captured glyph preview, 3 by 3 pixels');
    expect(markup).toContain('5 selected · 3 ink · active-frame indices');
    expect(markup).toContain('Only selected cells participate');
    expect(markup).toContain('Replace glyph');
    expect(markup.match(/bitmap-glyph-preview-ink/g)).toHaveLength(3);
  });

  it('fails closed when the current selection cannot produce a glyph', () => {
    const markup = renderToStaticMarkup(createElement(BitmapGlyphMapperDialog, {
      fonts: [createDefaultBitmapFont()],
      captureError: 'The selected sprite cells contain no nonzero palette indices.',
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The selected sprite cells contain no nonzero palette indices.');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it('uses the established dialog and density contracts instead of a smaller private control tier', async () => {
    const [component, sheetComponent, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/components/BitmapGlyphMapperDialog.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/components/BitmapGlyphSheetMapperDialog.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(component).toContain('className="secondary-modal-button"');
    expect(component).toContain('className="primary-modal-button"');
    expect(component).toContain('className="dialog-field"');
    expect(sheetComponent).toContain('className="secondary-modal-button"');
    expect(sheetComponent).toContain('className="primary-modal-button"');
    expect(styles).toContain('.secondary-modal-button, .primary-modal-button { min-height: 38px;');
    expect(styles).toMatch(/\.bitmap-glyph-capture-preview strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-glyph-capture-preview small, \.bitmap-glyph-map-note \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.pixel-floating-controls button, .pixel-floating-controls select { height: var(--ui-hit-secondary);');
    expect(styles).toMatch(/\.entry-dialog-body \.bitmap-glyph-sheet-order > textarea \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-glyph-sheet-summary small \{[^}]*font-size: var\(--ui-type-caption\)/);
  });

  it('previews a deterministic row-major sheet including a valid blank glyph', () => {
    const points = Array.from({ length: 8 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4) }));
    const markup = renderToStaticMarkup(createElement(BitmapGlyphSheetMapperDialog, {
      fonts: [createDefaultBitmapFont()],
      points,
      readIndex: (x: number, y: number) => x < 2 && x === y ? 1 : 0,
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Map indexed selection as glyph sheet');
    expect(markup).toContain('uniform row-major cells');
    expect(markup).toContain('Characters in row-major order');
    expect(markup).toContain('Bitmap glyph sheet columns');
    expect(markup).toContain('2 glyphs · 2 × 1 grid');
    expect(markup).toContain('2 × 2px cells · 8 selected · 2 ink · 0 new · 2 replaced · 1 blank');
    expect(markup).toContain('Selected nonzero indices become ink; index 0 and unselected cells are clear.');
    expect(markup).toContain('unused trailing grid cells must contain no selected ink');
    expect(markup).toContain('Map 2 glyphs');
    expect(markup).toContain('A glyph preview, 2 by 2 pixels');
    expect(markup.match(/bitmap-glyph-preview-ink/g)).toHaveLength(2);
  });

  it('refuses a sheet whose current bounds do not divide into the declared grid', () => {
    const markup = renderToStaticMarkup(createElement(BitmapGlyphSheetMapperDialog, {
      fonts: [createDefaultBitmapFont()],
      points: [{ x: 0, y: 0 }, { x: 2, y: 1 }],
      readIndex: () => 1,
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Selection bounds 3 × 2 must divide evenly into 2 columns and 1 row.');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
