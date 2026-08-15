import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultBitmapFont, type BitmapGlyphCapture } from '@aidraw/core';
import { BitmapGlyphMapperDialog } from '../../src/renderer/components/BitmapGlyphMapperDialog';

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
    const [component, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/components/BitmapGlyphMapperDialog.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(component).toContain('className="secondary-modal-button"');
    expect(component).toContain('className="primary-modal-button"');
    expect(component).toContain('className="dialog-field"');
    expect(styles).toContain('.secondary-modal-button, .primary-modal-button { min-height: 38px;');
    expect(styles).toMatch(/\.bitmap-glyph-capture-preview strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-glyph-capture-preview small, \.bitmap-glyph-map-note \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.pixel-floating-controls button, .pixel-floating-controls select { height: var(--ui-hit-secondary);');
  });
});
