import { describe, expect, it } from 'vitest';
import { EDITOR_CONTENT_VIEWPORT, EDITOR_DENSITY } from '../../src/common/editor-layout';
import {
  DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
  INSPECTOR_RESIZE_KEYBOARD_LARGE_STEP,
  INSPECTOR_RESIZE_KEYBOARD_STEP,
  MAX_INSPECTOR_EXPANDED_WIDTH,
  MINIMUM_EDITOR_CANVAS_WIDTH,
  MIN_INSPECTOR_EXPANDED_WIDTH,
  effectiveInspectorWidth,
  inspectorToggleShortcutRequested,
  inspectorWidthAfterKeyboardMove,
  inspectorWidthAfterPointerMove,
  parseWorkspaceLayoutPreferences,
  resetInspectorLayoutPreferences,
} from '../../src/common/workspace-layout';

describe('workspace layout preference contract', () => {
  it('strictly admits one complete bounded workspace preference', () => {
    expect(DEFAULT_WORKSPACE_LAYOUT_PREFERENCES).toEqual({
      inspectorCollapsed: false,
      inspectorExpandedWidth: EDITOR_DENSITY.sidebarWidth,
      mapSetupExpanded: false,
    });
    expect(parseWorkspaceLayoutPreferences({ inspectorCollapsed: true, inspectorExpandedWidth: 472, mapSetupExpanded: true })).toEqual({
      inspectorCollapsed: true,
      inspectorExpandedWidth: 472,
      mapSetupExpanded: true,
    });
    for (const value of [
      null,
      [],
      {},
      { inspectorCollapsed: false },
      { inspectorCollapsed: true, inspectorExpandedWidth: 472 },
      { inspectorCollapsed: 'false', inspectorExpandedWidth: 318, mapSetupExpanded: false },
      { inspectorCollapsed: false, inspectorExpandedWidth: 318.5, mapSetupExpanded: false },
      { inspectorCollapsed: false, inspectorExpandedWidth: MIN_INSPECTOR_EXPANDED_WIDTH - 1, mapSetupExpanded: false },
      { inspectorCollapsed: false, inspectorExpandedWidth: MAX_INSPECTOR_EXPANDED_WIDTH + 1, mapSetupExpanded: false },
      { inspectorCollapsed: false, inspectorExpandedWidth: 318, mapSetupExpanded: 'false' },
      { inspectorCollapsed: false, inspectorExpandedWidth: 318, mapSetupExpanded: false, extra: true },
    ]) expect(() => parseWorkspaceLayoutPreferences(value)).toThrow('Invalid workspace layout preferences.');
  });

  it('clamps only effective compact presentation while retaining the wider saved preference', () => {
    expect(MINIMUM_EDITOR_CANVAS_WIDTH).toBe(632);
    expect(effectiveInspectorWidth(EDITOR_DENSITY.sidebarWidth, EDITOR_CONTENT_VIEWPORT.defaultWidth)).toBe(318);
    expect(effectiveInspectorWidth(EDITOR_DENSITY.sidebarWidth, EDITOR_CONTENT_VIEWPORT.compactBreakpointWidth)).toBe(286);
    expect(effectiveInspectorWidth(EDITOR_DENSITY.sidebarWidth, EDITOR_CONTENT_VIEWPORT.minimumWidth)).toBe(286);
    expect(effectiveInspectorWidth(MAX_INSPECTOR_EXPANDED_WIDTH, EDITOR_CONTENT_VIEWPORT.minimumWidth)).toBe(286);
    expect(effectiveInspectorWidth(MAX_INSPECTOR_EXPANDED_WIDTH, EDITOR_CONTENT_VIEWPORT.defaultWidth)).toBe(520);
    expect(EDITOR_CONTENT_VIEWPORT.minimumWidth - EDITOR_DENSITY.toolRailWidth - effectiveInspectorWidth(520, 980)).toBe(MINIMUM_EDITOR_CANVAS_WIDTH);
  });

  it('resets only the inspector fields while preserving the Map setup disclosure choice', () => {
    expect(resetInspectorLayoutPreferences({
      inspectorCollapsed: true,
      inspectorExpandedWidth: 472,
      mapSetupExpanded: true,
    })).toEqual({
      inspectorCollapsed: false,
      inspectorExpandedWidth: EDITOR_DENSITY.sidebarWidth,
      mapSetupExpanded: true,
    });
  });

  it('uses deterministic bounded pointer and keyboard resize semantics', () => {
    expect(inspectorWidthAfterPointerMove(318, 800, 758)).toBe(360);
    expect(inspectorWidthAfterPointerMove(318, 800, 900)).toBe(MIN_INSPECTOR_EXPANDED_WIDTH);
    expect(inspectorWidthAfterPointerMove(500, 800, 700)).toBe(MAX_INSPECTOR_EXPANDED_WIDTH);
    expect(inspectorWidthAfterKeyboardMove(318, 'ArrowLeft')).toBe(318 + INSPECTOR_RESIZE_KEYBOARD_STEP);
    expect(inspectorWidthAfterKeyboardMove(318, 'ArrowRight', true)).toBe(318 - INSPECTOR_RESIZE_KEYBOARD_LARGE_STEP);
    expect(inspectorWidthAfterKeyboardMove(318, 'Home')).toBe(MIN_INSPECTOR_EXPANDED_WIDTH);
    expect(inspectorWidthAfterKeyboardMove(318, 'End')).toBe(MAX_INSPECTOR_EXPANDED_WIDTH);
    expect(inspectorWidthAfterKeyboardMove(318, 'Enter')).toBeUndefined();
  });

  it('starts compact resize intent from the shown width without rewriting an unpresentable saved width', () => {
    const shown = effectiveInspectorWidth(MAX_INSPECTOR_EXPANDED_WIDTH, EDITOR_CONTENT_VIEWPORT.minimumWidth);
    expect(shown).toBe(286);
    expect(inspectorWidthAfterPointerMove(shown, 800, 808, shown)).toBe(278);
    expect(inspectorWidthAfterPointerMove(shown, 800, 792, shown)).toBe(shown);
    expect(inspectorWidthAfterKeyboardMove(shown, 'ArrowRight', false, shown)).toBe(278);
    expect(inspectorWidthAfterKeyboardMove(shown, 'ArrowLeft', false, shown)).toBe(shown);
    expect(inspectorWidthAfterKeyboardMove(shown, 'Home', false, shown)).toBe(MIN_INSPECTOR_EXPANDED_WIDTH);
    expect(inspectorWidthAfterKeyboardMove(shown, 'End', false, shown)).toBe(shown);

    const partlyExpandable = 280;
    expect(inspectorWidthAfterPointerMove(partlyExpandable, 800, 790, shown)).toBe(shown);
    expect(inspectorWidthAfterKeyboardMove(partlyExpandable, 'ArrowLeft', false, shown)).toBe(shown);
  });

  it('recognizes only the named modified inspector shortcut', () => {
    const event = (overrides: Partial<Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>>) => ({
      key: 'i', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides,
    });
    expect(inspectorToggleShortcutRequested(event({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(inspectorToggleShortcutRequested(event({ metaKey: true, shiftKey: true, key: 'I' }))).toBe(true);
    expect(inspectorToggleShortcutRequested(event({ ctrlKey: true }))).toBe(false);
    expect(inspectorToggleShortcutRequested(event({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(inspectorToggleShortcutRequested(event({ ctrlKey: true, shiftKey: true, key: 'l' }))).toBe(false);
  });
});
