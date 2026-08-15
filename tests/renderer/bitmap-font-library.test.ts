import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultBitmapFont, createEmptyBitmapFont } from '@aidraw/core';
import { BitmapFontLibraryDialog } from '../../src/renderer/components/BitmapFontLibraryDialog';

describe('bitmap font library dialog', () => {
  it('presents a named empty-font creation and undoable future-asset deletion boundary', () => {
    const defaultFont = createDefaultBitmapFont();
    const emptyFont = createEmptyBitmapFont([defaultFont], { id: 'bitmap-font-empty', name: 'Dialogue', lineHeight: 12 }).font;
    const markup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: [defaultFont, emptyFont],
      selectedFontId: emptyFont.id,
      onSelectedFontChange: () => undefined,
      onCreate: async () => true,
      onDelete: async () => true,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Bitmap font assets');
    expect(markup).toContain('Selected bitmap font asset');
    expect(markup).toContain('Dialogue');
    expect(markup).toContain('0 glyphs · 12px line height');
    expect(markup).toContain('Create empty font');
    expect(markup).toContain('No bundled glyphs are copied.');
    expect(markup).toContain('Delete selected font');
    expect(markup).toContain('text already painted into cels');
    expect(markup).toContain('rasterized and have no live font reference');
  });

  it('fails visibly closed for last-font deletion and full-library creation', () => {
    const only = createDefaultBitmapFont();
    const lastMarkup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: [only], selectedFontId: only.id, onSelectedFontChange: () => undefined,
      onCreate: async () => true, onDelete: async () => true, onClose: () => undefined,
    }));
    expect(lastMarkup).toContain('Keep at least one bitmap font. Create another font before deleting this one.');
    expect(lastMarkup).toMatch(/<button[^>]*class="bitmap-font-delete-button"[^>]*disabled=""/);

    const full = Array.from({ length: 64 }, (_, index) => ({ ...createDefaultBitmapFont(), id: `bitmap-font-${index}`, name: `Font ${index + 1}` }));
    const fullMarkup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: full, selectedFontId: full[0].id, onSelectedFontChange: () => undefined,
      onCreate: async () => true, onDelete: async () => true, onClose: () => undefined,
    }));
    expect(fullMarkup).toContain('Bitmap font libraries are limited to 64 fonts. Delete one before creating another.');
    expect(fullMarkup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Create empty font/);
  });

  it('binds every new field and action to named controls and shared density tokens', async () => {
    const [component, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/components/BitmapFontLibraryDialog.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(component).toContain('aria-label="Selected bitmap font asset"');
    expect(component).toContain('aria-label="New bitmap font name"');
    expect(component).toContain('aria-label="New bitmap font line height"');
    expect(component).toContain('className="bitmap-font-delete-button"');
    expect(component).toContain('className="primary-modal-button"');
    expect(styles).toMatch(/\.bitmap-font-delete-button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.bitmap-font-create-form \.primary-modal-button \{[^}]*min-height: var\(--ui-hit-primary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-font-library-current select, \.bitmap-font-create-fields input \{[^}]*height: var\(--ui-hit-primary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-font-row > button, \.bitmap-font-import \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
  });
});
