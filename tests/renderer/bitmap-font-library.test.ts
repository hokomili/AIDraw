import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultBitmapFont, createEmptyBitmapFont, toggleBitmapGlyphCell, type BitmapFont, type BitmapGlyph } from '@aidraw/core';
import { BitmapFontLibraryDialog } from '../../src/renderer/components/BitmapFontLibraryDialog';
import {
  bitmapGlyphGridKeyAction,
  cancelBitmapGlyphDimensionDraft,
  commitBitmapGlyphDimensionDraft,
  createBitmapGlyphCellFocusRegistry,
  createBitmapGlyphDimensionDraft,
  updateBitmapGlyphDimensionDraft,
} from '../../src/renderer/bitmap-font-editor';

const editCallbacks = {
  onRename: async () => true,
  onEditGlyph: async () => true,
  onDeleteGlyph: async () => true,
};

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
      ...editCallbacks,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Bitmap font assets');
    expect(markup).toContain('Selected bitmap font asset');
    expect(markup).toContain('Dialogue');
    expect(markup).toContain('0 glyphs · 12px line height');
    expect(markup).toContain('Create empty font');
    expect(markup).toContain('No bundled glyphs are copied.');
    expect(markup).toContain('Delete selected font');
    expect(markup).toContain('Mapped glyph editor');
    expect(markup).toContain('This font has no mapped glyphs.');
    expect(markup).toContain('Apply font name');
    expect(markup).toContain('text already painted into cels');
    expect(markup).toContain('rasterized and have no live font reference');
  });

  it('fails visibly closed for last-font deletion and full-library creation', () => {
    const only = createDefaultBitmapFont();
    const lastMarkup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: [only], selectedFontId: only.id, onSelectedFontChange: () => undefined,
      onCreate: async () => true, onDelete: async () => true, ...editCallbacks, onClose: () => undefined,
    }));
    expect(lastMarkup).toContain('Keep at least one bitmap font. Create another font before deleting this one.');
    expect(lastMarkup).toMatch(/<button[^>]*class="bitmap-font-delete-button"[^>]*disabled=""/);

    const full = Array.from({ length: 64 }, (_, index) => ({ ...createDefaultBitmapFont(), id: `bitmap-font-${index}`, name: `Font ${index + 1}` }));
    const fullMarkup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: full, selectedFontId: full[0].id, onSelectedFontChange: () => undefined,
      onCreate: async () => true, onDelete: async () => true, ...editCallbacks, onClose: () => undefined,
    }));
    expect(fullMarkup).toContain('Bitmap font libraries are limited to 64 fonts. Delete one before creating another.');
    expect(fullMarkup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Create empty font/);
  });

  it('renders the exact mapped Unicode grid and toggles cells immutably', () => {
    const font = createDefaultBitmapFont();
    const markup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: [font], selectedFontId: font.id, onSelectedFontChange: () => undefined,
      onCreate: async () => true, onDelete: async () => true, ...editCallbacks, onClose: () => undefined,
    }));
    expect(markup).toContain('Selected mapped Unicode character');
    expect(markup).toContain('Monochrome bitmap for U+0020');
    expect(markup.match(/role="gridcell"/g)).toHaveLength(21);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(20);
    expect(markup).toContain('Bitmap glyph width');
    expect(markup).toContain('Bitmap glyph height');
    expect(markup).toContain('Bitmap glyph advance');
    expect(markup).toContain('Bitmap font line height');
    expect(markup).toContain('Delete glyph mapping');

    const glyph = { width: 2, advance: 3, rows: ['#.', '.#'] };
    const toggled = toggleBitmapGlyphCell(glyph, 1, 0);
    expect(toggled).toEqual({ width: 2, advance: 3, rows: ['##', '.#'] });
    expect(glyph).toEqual({ width: 2, advance: 3, rows: ['#.', '.#'] });
    expect(() => toggleBitmapGlyphCell(glyph, 2, 0)).toThrow(/outside/);
  });

  it('keeps multi-digit dimension drafts non-destructive until commit and cancels invalid input', () => {
    const glyph: BitmapGlyph = { width: 64, advance: 64, rows: ['#'.repeat(64)] };
    let state = createBitmapGlyphDimensionDraft(glyph);
    const originalEditBuffer = state.glyph;

    state = updateBitmapGlyphDimensionDraft(state, 'width', '3');
    expect(state.width).toBe('3');
    expect(state.glyph).toBe(originalEditBuffer);
    expect(state.glyph.rows[0]).toBe('#'.repeat(64));

    state = updateBitmapGlyphDimensionDraft(state, 'width', '32');
    expect(state.glyph).toBe(originalEditBuffer);
    const committed = commitBitmapGlyphDimensionDraft(state, 'width');
    expect(committed.error).toBeUndefined();
    expect(committed.state.width).toBe('32');
    expect(committed.state.glyph).toEqual({ width: 32, advance: 64, rows: ['#'.repeat(32)] });

    const invalidDraft = updateBitmapGlyphDimensionDraft(createBitmapGlyphDimensionDraft(glyph), 'width', '');
    const invalidCommit = commitBitmapGlyphDimensionDraft(invalidDraft, 'width');
    expect(invalidCommit.error).toMatch(/left unchanged/);
    expect(invalidCommit.state.width).toBe('64');
    expect(invalidCommit.state.glyph).toBe(invalidDraft.glyph);
    expect(invalidCommit.state.glyph.rows[0]).toBe('#'.repeat(64));

    const cancelled = cancelBitmapGlyphDimensionDraft(updateBitmapGlyphDimensionDraft(createBitmapGlyphDimensionDraft(glyph), 'width', '2'), 'width');
    expect(cancelled.width).toBe('64');
    expect(cancelled.glyph.rows[0]).toBe('#'.repeat(64));
  });

  it('keeps one maximum-grid tab stop and resolves bounded keyboard navigation and activation', () => {
    const maximumGlyph: BitmapGlyph = { width: 64, advance: 64, rows: Array.from({ length: 64 }, () => '.'.repeat(64)) };
    const font: BitmapFont = { id: 'bitmap-font-maximum', name: 'Maximum grid', lineHeight: 64, glyphs: { M: maximumGlyph } };
    const markup = renderToStaticMarkup(createElement(BitmapFontLibraryDialog, {
      fonts: [font], selectedFontId: font.id, onSelectedFontChange: () => undefined,
      onCreate: async () => true, onDelete: async () => true, ...editCallbacks, onClose: () => undefined,
    }));
    expect(markup.match(/role="gridcell"/g)).toHaveLength(4_096);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(4_095);
    expect(markup).toContain('aria-rowcount="64"');
    expect(markup).toContain('aria-colcount="64"');

    expect(bitmapGlyphGridKeyAction({ x: 0, y: 0, width: 64, height: 64, key: 'ArrowLeft' })).toEqual({ x: 0, y: 0 });
    expect(bitmapGlyphGridKeyAction({ x: 5, y: 7, width: 64, height: 64, key: 'ArrowDown' })).toEqual({ x: 5, y: 8 });
    expect(bitmapGlyphGridKeyAction({ x: 5, y: 7, width: 64, height: 64, key: 'Home' })).toEqual({ x: 0, y: 7 });
    expect(bitmapGlyphGridKeyAction({ x: 5, y: 7, width: 64, height: 64, key: 'End' })).toEqual({ x: 63, y: 7 });
    expect(bitmapGlyphGridKeyAction({ x: 5, y: 7, width: 64, height: 64, key: 'Home', ctrlKey: true })).toEqual({ x: 0, y: 0 });
    expect(bitmapGlyphGridKeyAction({ x: 5, y: 7, width: 64, height: 64, key: 'End', metaKey: true })).toEqual({ x: 63, y: 63 });
    const activation = bitmapGlyphGridKeyAction({ x: 63, y: 63, width: 64, height: 64, key: ' ' });
    expect(activation).toEqual({ x: 63, y: 63, activate: true });
    expect(toggleBitmapGlyphCell(maximumGlyph, activation!.x, activation!.y).rows[63][63]).toBe('#');
  });

  it('keeps logical focus targets intact through width expansion and shrink cleanup', () => {
    const registry = createBitmapGlyphCellFocusRegistry<{ focus: () => void }>();
    const oldLowerRef = registry.refFor(0, 1);
    const insertedTopRef = registry.refFor(2, 0);
    expect(registry.refFor(0, 1)).toBe(oldLowerRef);
    expect(registry.refFor(2, 0)).toBe(insertedTopRef);

    const oldLowerNode = { focus: vi.fn() };
    const insertedTopNode = { focus: vi.fn() };
    oldLowerRef(oldLowerNode);
    insertedTopRef(insertedTopNode);
    oldLowerRef(null);

    const expandedAction = bitmapGlyphGridKeyAction({ x: 1, y: 0, width: 3, height: 2, key: 'ArrowRight' });
    expect(expandedAction).toEqual({ x: 2, y: 0 });
    expect(registry.focus(expandedAction!.x, expandedAction!.y)).toBe(true);
    expect(insertedTopNode.focus).toHaveBeenCalledOnce();

    const narrowedLowerNode = { focus: vi.fn() };
    oldLowerRef(narrowedLowerNode);
    insertedTopRef(null);
    const narrowedAction = bitmapGlyphGridKeyAction({ x: 0, y: 0, width: 2, height: 2, key: 'ArrowDown' });
    expect(narrowedAction).toEqual({ x: 0, y: 1 });
    expect(registry.focus(narrowedAction!.x, narrowedAction!.y)).toBe(true);
    expect(narrowedLowerNode.focus).toHaveBeenCalledOnce();
  });

  it('binds every new field and action to named controls and shared density tokens', async () => {
    const [component, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/components/BitmapFontLibraryDialog.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(component).toContain('aria-label="Selected bitmap font asset"');
    expect(component).toContain('aria-label="New bitmap font name"');
    expect(component).toContain('aria-label="New bitmap font line height"');
    expect(component).toContain('aria-label="Rename selected bitmap font"');
    expect(component).toContain('role="gridcell"');
    expect(component).toContain('tabIndex={glyphFocus.x === x && glyphFocus.y === y ? 0 : -1}');
    expect(component).toContain('className="bitmap-font-delete-button"');
    expect(component).toContain('className="primary-modal-button"');
    expect(styles).toMatch(/\.bitmap-font-delete-button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.bitmap-font-create-form \.primary-modal-button \{[^}]*min-height: var\(--ui-hit-primary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-font-library-current select, \.bitmap-font-create-fields input \{[^}]*height: var\(--ui-hit-primary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.bitmap-font-row > button, \.bitmap-font-import \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.bitmap-font-glyph-grid \[role="gridcell"\] \{[^}]*width: var\(--ui-hit-secondary\)[^}]*height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.bitmap-font-glyph-actions \.primary-modal-button \{[^}]*min-height: var\(--ui-hit-primary\)[^}]*font-size: var\(--ui-type-label\)/);
  });
});
