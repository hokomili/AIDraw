import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createIllustrationDocument, createPixelDocument } from '@aidraw/core';
import { ToolRail } from '../../src/renderer/App';
import { ShortcutReferenceDialog } from '../../src/renderer/components/ShortcutReferenceDialog';
import { assignShortcut, defaultShortcutPreferences } from '../../src/common/shortcut-preferences';
import { useEditorStore } from '../../src/renderer/store';
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
    expect(illustration.at(-1)?.entries.map((entry) => entry.keys[0])).toEqual([
      'V', 'L', 'H', 'Z', 'P', 'N', 'A', 'D', 'B', 'E', '\\', 'R', 'O', 'Y', 'S', 'G', 'C', 'T', 'I',
    ]);
    expect(pixel.at(-1)?.entries.map((entry) => entry.keys[0])).toEqual([
      'V', 'L', 'H', 'Z', 'B', 'E', 'G', 'C', '\\', 'R', 'O', 'W', 'S', 'T', 'Y', 'D', 'U', 'K', 'X', 'I',
    ]);
    expect(illustration.at(-1)?.entries.map((entry) => entry.label)).toEqual([
      'Select', 'Lasso', 'Pan', 'Zoom', 'Pressure pen', 'Vector pencil', 'Bézier path', 'Node editor',
      'Raster brush', 'Eraser', 'Line / arrow', 'Rectangle', 'Ellipse', 'Polygon', 'Star', 'Gradient',
      'Image crop', 'Text', 'Eyedropper',
    ]);
    expect(pixel.at(-1)?.entries.map((entry) => entry.label)).toEqual([
      'Select', 'Lasso', 'Pan', 'Zoom', 'Pixel-perfect pencil', 'Eraser', 'Fill', 'Replace color',
      'Pixel line', 'Pixel rectangle', 'Pixel ellipse', 'Magic wand', 'Stamp', 'Wang terrain', 'Tile object',
      'Ordered dither', 'Lighten', 'Darken', 'Bitmap text', 'Palette picker',
    ]);
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

  it('renders every displayed tool with the same active title and aria-keyshortcuts metadata', () => {
    useEditorStore.setState({
      selectedTool: 'select',
      shortcutPreferences: defaultShortcutPreferences(),
    });
    const illustration = renderToStaticMarkup(createElement(ToolRail, {
      document: createIllustrationDocument('Shortcut rail'),
    }));
    const pixel = renderToStaticMarkup(createElement(ToolRail, {
      document: createPixelDocument('sprite', 'Shortcut rail'),
    }));
    expect((illustration.match(/aria-keyshortcuts=/gu) ?? [])).toHaveLength(19);
    expect((pixel.match(/aria-keyshortcuts=/gu) ?? [])).toHaveLength(20);
    expect(illustration).toContain('title="Node editor (D)"');
    expect(illustration).toContain('title="Image crop (C)"');
    expect(pixel).toContain('title="Replace color (C)"');
    expect(pixel).toContain('title="Tile object (Y)"');
    expect(pixel).toContain('title="Bitmap text (X)"');
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
    expect(app).toContain('aria-keyshortcuts={shortcutAriaKeyShortcuts(shortcutChord)}');
    expect(app).toContain('title={`${tool.label} (${shortcutChordLabel(shortcutChord)})`}');
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
    expect(readme).toContain('exactly 40 eligible bindings: all 39 tools displayed across the illustration (19) and pixel (20) rails plus the renderer-owned inspector toggle');
    expect(readme).toContain('Later still-free new mnemonics are reserved before fallback selection');
    expect(readme).toContain('remaining command/native-menu remapping');
    expect(tracker).toContain('clean and live-synchronized through predecessor base `acbaea140eb37760c542486c097656ef92c214be`');
    expect(tracker).toContain('one exact reviewable source/headless product checkpoint prepared over that predecessor');
    expect(tracker).toContain('all **39 displayed tool activations**—19 illustration and 20 pixel—plus the renderer-owned inspector toggle');
    expect(tracker).toContain('later still-free new mnemonics remain reserved from earlier fallbacks');
    expect(tracker).toContain('remapping beyond the later bounded UX-08 tool/inspector slice');
    expect(tracker).toContain('packaged/native shortcut-remapping acceptance');
    expect(tracker).toContain('do not negate the exact 16 px→32 px root reflow evidence now recorded in UX-09');
    expect(tracker).not.toContain('This bounded **27-path** source/headless candidate');
    expect(testing).toContain('Restore defaults replaces all 40 eligible bindings');
    expect(testing).toContain('Select-`D`/Node-`F`/Crop-`C` migration');
    expect(testing).toContain('remapping beyond the later bounded UX-08 tool/inspector slice');
    expect(testing).toContain('packaged/native shortcut-remapping acceptance');
  });
});
