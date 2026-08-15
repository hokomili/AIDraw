import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShortcutReferenceDialog } from '../../src/renderer/components/ShortcutReferenceDialog';
import { assignShortcut, defaultShortcutPreferences } from '../../src/common/shortcut-preferences';
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
    const defaults = defaultShortcutPreferences();
    const illustration = shortcutSections('illustration', defaults);
    const pixel = shortcutSections('pixel', defaults);
    const illustrationEntries = illustration.flatMap((section) => section.entries);
    const pixelEntries = pixel.flatMap((section) => section.entries);
    expect(new Set(illustrationEntries.map((entry) => entry.id)).size).toBe(illustrationEntries.length);
    expect(illustrationEntries.map((entry) => entry.label)).toContain('Edit selected illustration text');
    expect(illustrationEntries.map((entry) => entry.label)).not.toContain('Select all finite pixel cells');
    expect(pixelEntries.map((entry) => entry.label)).toContain('Select all finite pixel cells');
    expect(pixelEntries.map((entry) => entry.label)).not.toContain('Edit selected illustration text');
    expect(illustration.at(-1)).toMatchObject({ title: 'Illustration tools' });
    expect(illustration.at(-1)?.entries.map((entry) => entry.keys[0])).toEqual(['V', 'L', 'H', 'Z', 'P', 'N', 'A', 'B', 'E', '\\', 'R', 'O', 'T', 'I']);
    expect(pixel.at(-1)?.entries.map((entry) => entry.keys[0])).toEqual(['V', 'L', 'H', 'Z', 'B', 'E', 'G', 'W', 'I']);
    expect(illustrationEntries.map((entry) => entry.label)).toContain('Move through focused document tabs');
    expect(illustrationEntries.map((entry) => entry.label)).toContain('Move through the open All documents menu');
    expect(illustrationEntries.find((entry) => entry.id === 'open')).toMatchObject({ fixedReason: expect.stringContaining('native application menu') });
    expect(illustrationEntries.find((entry) => entry.id === 'redo')).toMatchObject({
      fixedReason: 'Ctrl/Cmd+Y is fixed by the native menu; Ctrl/Cmd+Shift+Z is the fixed renderer redo alias.',
    });
  });

  it('filters by every command, category, and key term without mutating the catalog', () => {
    const sections = shortcutSections('pixel', defaultShortcutPreferences());
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

  it('renders a bounded searchable guide with editable and native-fixed truth', () => {
    const defaults = defaultShortcutPreferences();
    const remapped = assignShortcut(defaults, 'tool:illustration:brush', 'Q');
    expect(remapped.accepted).toBe(true);
    if (!remapped.accepted) return;
    const markup = renderToStaticMarkup(createElement(ShortcutReferenceDialog, {
      mode: 'illustration',
      preferences: remapped.preferences,
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Keyboard shortcuts');
    expect(markup).toContain('current illustration workspace');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('maxLength="100"');
    expect(markup).toContain('Press F1 or ?');
    expect(markup).toContain('native menu and existing renderer handlers');
    expect(markup).toContain('Ctrl/Cmd+Shift+Z is the renderer-owned redo alias');
    expect(markup).toContain('Restore shortcut defaults');
    expect(markup).toContain('Change Raster brush shortcut, currently Q');
    expect(markup).toContain('<kbd>Ctrl/Cmd + S</kbd>');
    expect(markup).toContain('<kbd>Q</kbd>');
    expect(markup).toContain('role="status"');
  });

  it('wires the guide, skip route, tool metadata, and named canvas target into the editor', async () => {
    const [app, main, illustration, pixel] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8'),
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
    expect(app).toContain('aria-keyshortcuts={shortcutChord ? shortcutAriaKeyShortcuts(shortcutChord) : undefined}');
    expect(app).toContain('shortcutActionForEvent(shortcutPreferences, event, mode, "tool")');
    expect(app).toContain('shortcutActionForEvent(shortcutState.shortcutPreferences, event, shortcutMode, "application")?.id === "toggle-inspector"');
    expect(main).toContain("{ label: 'Open…', accelerator: 'CmdOrCtrl+O'");
    expect(main).toContain("{ label: 'Save', accelerator: 'CmdOrCtrl+S'");
    expect(main).toContain("{ label: 'Undo My Last Action', accelerator: 'CmdOrCtrl+Z'");
    const fixedRendererLetters = [...new Set(
      [...app.matchAll(/event\.key\.toLowerCase\(\) === "([a-z])"/gu)].map((match) => match[1]),
    )].sort();
    expect(fixedRendererLetters).toEqual(['a', 'c', 'o', 's', 'v', 'x', 'y', 'z']);
    const defaults = defaultShortcutPreferences();
    for (const letter of fixedRendererLetters) {
      expect(assignShortcut(defaults, 'toggle-inspector', `Primary+${letter.toUpperCase()}`)).toMatchObject({ accepted: false });
      expect(assignShortcut(defaults, 'toggle-inspector', `Primary+Shift+${letter.toUpperCase()}`)).toMatchObject({ accepted: false });
    }
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

  it('keeps current public and tracker truth aligned with the bounded remapping surface', async () => {
    const [readme, tracker, testing] = await Promise.all([
      readFile(new URL('../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(readme).toContain('exactly 24 implemented bindings: 23 mode-scoped illustration/pixel tools plus the renderer-owned inspector toggle');
    expect(readme).toContain('remaining command/native-menu remapping');
    expect(tracker).toContain('clean and live-synchronized through base `dd0aad0b39652b2af425f7c63fa32aac94f7a5ea`');
    expect(tracker).toContain('tilemap Map setup disclosure');
    expect(tracker).toContain('23 already implemented mode-scoped tool bindings plus the renderer-owned inspector toggle');
    expect(tracker).toContain('remapping beyond the later bounded UX-08 tool/inspector slice');
    expect(tracker).toContain('packaged/native shortcut-remapping acceptance');
    expect(tracker).not.toContain('This bounded **27-path** source/headless candidate');
    expect(testing).toContain('remapping beyond the later bounded UX-08 tool/inspector slice');
    expect(testing).toContain('packaged/native shortcut-remapping acceptance');
  });
});
