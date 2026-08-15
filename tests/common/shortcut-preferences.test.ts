import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_ACTIONS,
  assignShortcut,
  defaultShortcutPreferences,
  parseShortcutPreferences,
  shortcutActionForEvent,
  shortcutAriaKeyShortcuts,
  shortcutChordFromEvent,
  shortcutChordLabel,
  shortcutEventMatchesChord,
} from '../../src/common/shortcut-preferences';

const keyEvent = (key: string, overrides: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe('human-local shortcut preferences', () => {
  it('admits only one strict complete conflict-free registry map', () => {
    const defaults = defaultShortcutPreferences();
    expect(Object.keys(defaults.bindings)).toHaveLength(SHORTCUT_ACTIONS.length);
    expect(parseShortcutPreferences(defaults)).toEqual(defaults);

    const partial = structuredClone(defaults) as { bindings: Record<string, string> };
    delete partial.bindings['tool:pixel:wand'];
    expect(() => parseShortcutPreferences(partial)).toThrow('Invalid shortcut preferences.');
    expect(() => parseShortcutPreferences({ bindings: { ...defaults.bindings, unexpected: 'K' } })).toThrow('Invalid shortcut preferences.');
    expect(() => parseShortcutPreferences({ bindings: { ...defaults.bindings, 'tool:pixel:wand': 'Primary+W' } })).toThrow('Invalid shortcut preferences.');
    expect(() => parseShortcutPreferences({ bindings: { ...defaults.bindings, 'tool:pixel:wand': 'E' } })).toThrow('Invalid shortcut preferences.');
  });

  it('refuses collisions and native-menu reservations without swapping or partial mutation', () => {
    const defaults = defaultShortcutPreferences();
    const collision = assignShortcut(defaults, 'tool:illustration:brush', 'E');
    expect(collision).toEqual({
      accepted: false,
      reason: 'E is already assigned to Eraser.',
      conflictingActionId: 'tool:illustration:eraser',
    });
    expect(defaults.bindings['tool:illustration:brush']).toBe('B');

    const native = assignShortcut(defaults, 'toggle-inspector', 'Primary+S');
    expect(native).toEqual({
      accepted: false,
      reason: 'Ctrl/Cmd+S is fixed by the native Save menu command in this checkpoint.',
    });
    for (const chord of [
      'Primary+N', 'Primary+Shift+N',
      'Primary+O', 'Primary+Shift+O',
      'Primary+S', 'Primary+Shift+S',
      'Primary+Z', 'Primary+Shift+Z',
      'Primary+Y', 'Primary+Shift+Y',
      'Primary+C', 'Primary+Shift+C',
      'Primary+X', 'Primary+Shift+X',
      'Primary+V', 'Primary+Shift+V',
      'Primary+A', 'Primary+Shift+A',
    ]) {
      expect(assignShortcut(defaults, 'toggle-inspector', chord)).toMatchObject({ accepted: false });
    }
    expect(assignShortcut(defaults, 'toggle-inspector', 'Primary+Shift+Z')).toEqual({
      accepted: false,
      reason: 'Ctrl/Cmd+Shift+Z is the fixed renderer redo alias in this checkpoint.',
    });
    expect(defaults.bindings['toggle-inspector']).toBe('Primary+Shift+I');
  });

  it('allows the same tool chord in disjoint modes but routes one active action per mode', () => {
    const defaults = defaultShortcutPreferences();
    const assigned = assignShortcut(defaults, 'tool:illustration:brush', 'W');
    expect(assigned.accepted).toBe(true);
    if (!assigned.accepted) return;
    expect(shortcutActionForEvent(assigned.preferences, keyEvent('w'), 'illustration', 'tool')?.id).toBe('tool:illustration:brush');
    expect(shortcutActionForEvent(assigned.preferences, keyEvent('w'), 'pixel', 'tool')?.id).toBe('tool:pixel:wand');
  });

  it('captures bounded cross-platform chords and matches exact modifiers', () => {
    expect(shortcutChordFromEvent(keyEvent('b', { metaKey: true }), 'toggle-inspector')).toEqual({ captured: true, chord: 'Primary+B' });
    expect(shortcutChordFromEvent(keyEvent('b', { ctrlKey: true, shiftKey: true }), 'toggle-inspector')).toEqual({ captured: true, chord: 'Primary+Shift+B' });
    expect(shortcutChordFromEvent(keyEvent('b', { shiftKey: true }), 'tool:pixel:pencil')).toMatchObject({ captured: false });
    expect(shortcutChordFromEvent(keyEvent('s', { ctrlKey: true }), 'toggle-inspector')).toEqual({
      captured: false,
      reason: 'Ctrl/Cmd+S is fixed by the native Save menu command in this checkpoint.',
    });
    expect(shortcutChordFromEvent(keyEvent('b', { ctrlKey: true, altKey: true }), 'toggle-inspector')).toMatchObject({ captured: false });
    expect(shortcutChordFromEvent(keyEvent('b', { ctrlKey: true, metaKey: true }), 'toggle-inspector')).toMatchObject({ captured: false });
    expect(shortcutEventMatchesChord(keyEvent('b', { metaKey: true }), 'Primary+B')).toBe(true);
    expect(shortcutEventMatchesChord(keyEvent('b', { metaKey: true, shiftKey: true }), 'Primary+B')).toBe(false);
    expect(shortcutEventMatchesChord(keyEvent('\\'), 'Backslash')).toBe(true);
    expect(shortcutChordLabel('Primary+Shift+B')).toBe('Ctrl/Cmd + Shift + B');
    expect(shortcutAriaKeyShortcuts('Primary+Shift+B')).toBe('Control+Shift+B Meta+Shift+B');
  });

  it('keeps F1, question mark, focus keys, and native accelerators outside the editable registry', () => {
    const ids = new Set<string>(SHORTCUT_ACTIONS.map((action) => action.id));
    for (const id of ['shortcut-guide', 'open', 'save', 'undo', 'copy', 'select-all-pixels', 'delete', 'clear-pixels']) {
      expect(ids.has(id)).toBe(false);
    }
    expect(ids.has('toggle-inspector')).toBe(true);
  });
});
