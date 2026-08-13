import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShortcutReferenceDialog } from '../../src/renderer/components/ShortcutReferenceDialog';
import {
  filterShortcutSections,
  shortcutHelpRequested,
  shortcutSections,
  toolRailFocusIndex,
} from '../../src/renderer/shortcuts';

const keyEvent = (key: string, overrides: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe('keyboard shortcut reference', () => {
  it('builds mode-specific, unique shortcut entries from the active tool catalog', () => {
    const illustration = shortcutSections('illustration', [
      { id: 'select', label: 'Select', shortcut: 'V' },
      { id: 'brush', label: 'Raster brush', shortcut: 'B' },
    ]);
    const pixel = shortcutSections('pixel', [{ id: 'fill', label: 'Fill', shortcut: 'G' }]);
    const illustrationEntries = illustration.flatMap((section) => section.entries);
    const pixelEntries = pixel.flatMap((section) => section.entries);
    expect(new Set(illustrationEntries.map((entry) => entry.id)).size).toBe(illustrationEntries.length);
    expect(illustrationEntries.map((entry) => entry.label)).toContain('Edit selected illustration text');
    expect(illustrationEntries.map((entry) => entry.label)).not.toContain('Select all finite pixel cells');
    expect(pixelEntries.map((entry) => entry.label)).toContain('Select all finite pixel cells');
    expect(pixelEntries.map((entry) => entry.label)).not.toContain('Edit selected illustration text');
    expect(illustration.at(-1)).toMatchObject({ title: 'Illustration tools' });
    expect(illustration.at(-1)?.entries.map((entry) => entry.keys[0])).toEqual(['V', 'B']);
  });

  it('filters by every command, category, and key term without mutating the catalog', () => {
    const sections = shortcutSections('pixel', [{ id: 'brush', label: 'Pixel brush', shortcut: 'B' }]);
    const originalCount = sections.flatMap((section) => section.entries).length;
    expect(filterShortcutSections(sections, 'save').flatMap((section) => section.entries).map((entry) => entry.id)).toEqual(['save', 'save-as']);
    expect(filterShortcutSections(sections, 'finite pixel').flatMap((section) => section.entries).map((entry) => entry.id)).toEqual(['select-all-pixels']);
    expect(filterShortcutSections(sections, 'missing command')).toEqual([]);
    expect(sections.flatMap((section) => section.entries)).toHaveLength(originalCount);
  });

  it('recognizes only the unmodified help keys and wraps vertical tool-rail focus', () => {
    expect(shortcutHelpRequested(keyEvent('F1'))).toBe(true);
    expect(shortcutHelpRequested(keyEvent('?', { shiftKey: true }))).toBe(true);
    expect(shortcutHelpRequested(keyEvent('?', { shiftKey: false }))).toBe(true);
    expect(shortcutHelpRequested(keyEvent('F1', { ctrlKey: true }))).toBe(false);
    expect(toolRailFocusIndex('ArrowDown', 2, 3)).toBe(0);
    expect(toolRailFocusIndex('ArrowUp', 0, 3)).toBe(2);
    expect(toolRailFocusIndex('Home', 2, 3)).toBe(0);
    expect(toolRailFocusIndex('End', 0, 3)).toBe(2);
    expect(toolRailFocusIndex('Enter', 0, 3)).toBeUndefined();
    expect(toolRailFocusIndex('ArrowDown', -1, 0)).toBeUndefined();
  });

  it('renders a bounded searchable guide that states its fixed, mode-local scope', () => {
    const markup = renderToStaticMarkup(createElement(ShortcutReferenceDialog, {
      mode: 'illustration',
      tools: [{ id: 'brush', label: 'Raster brush', shortcut: 'B' }],
      onClose: () => undefined,
    }));
    expect(markup).toContain('Keyboard shortcuts');
    expect(markup).toContain('current illustration workspace');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('maxLength="100"');
    expect(markup).toContain('Press F1 or ?');
    expect(markup).toContain('not remappable in this checkpoint');
    expect(markup).toContain('<kbd>Ctrl/Cmd + S</kbd>');
    expect(markup).toContain('<kbd>B</kbd>');
    expect(markup).toContain('role="status"');
  });

  it('wires the guide, skip route, tool metadata, and named canvas target into the editor', async () => {
    const [app, illustration, pixel] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('shortcutHelpRequested(event)');
    expect(app).toContain('globalThis.document.querySelector(\'[aria-modal="true"]\')');
    expect(app).toContain('aria-label="Keyboard shortcuts"');
    expect(app).toContain('aria-keyshortcuts="F1 ?"');
    expect(app).toContain('className="skip-to-canvas"');
    expect(app).toContain('getElementById("aidraw-canvas")?.focus()');
    expect(app).toContain('toolRailFocusIndex(event.key, currentIndex, buttons.length)');
    expect(app).toContain('role="toolbar" aria-orientation="vertical"');
    expect(app).toContain('tabIndex={rovingToolId === tool.id ? 0 : -1}');
    expect(app).toContain('aria-keyshortcuts={tool.shortcut}');
    expect((app.match(/querySelector\('\[aria-modal="true"\]'\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(app).toContain('setCreating(event.shiftKey ? "sprite" : "illustration")');
    expect(app).toContain('getState().save(event.shiftKey)');
    expect(app).toContain('getState().open()');
    expect(app).toContain('getState().undo()');
    expect(app).toContain('getState().redo()');
    expect(app).toContain('"aidraw:pixel-selection-command"');
    expect(illustration).toContain("event.key === 'Enter' && tool === 'select'");
    expect(pixel).toContain("event.key === 'Escape'");
    for (const source of [illustration, pixel]) {
      expect(source).toContain('id="aidraw-canvas"');
      expect(source).toContain('aria-describedby="aidraw-canvas-keyboard-help"');
    }
  });
});
