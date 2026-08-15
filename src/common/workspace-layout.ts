import { EDITOR_CONTENT_VIEWPORT, EDITOR_DENSITY } from './editor-layout';

export const MIN_INSPECTOR_EXPANDED_WIDTH = 260;
export const MAX_INSPECTOR_EXPANDED_WIDTH = 520;
export const INSPECTOR_RESIZE_KEYBOARD_STEP = 8;
export const INSPECTOR_RESIZE_KEYBOARD_LARGE_STEP = 32;

export interface WorkspaceLayoutPreferences {
  inspectorCollapsed: boolean;
  inspectorExpandedWidth: number;
  mapSetupExpanded: boolean;
}

export const DEFAULT_WORKSPACE_LAYOUT_PREFERENCES: Readonly<WorkspaceLayoutPreferences> = Object.freeze({
  inspectorCollapsed: false,
  inspectorExpandedWidth: EDITOR_DENSITY.sidebarWidth,
  mapSetupExpanded: false,
});

export const MINIMUM_EDITOR_CANVAS_WIDTH = EDITOR_CONTENT_VIEWPORT.minimumWidth
  - EDITOR_DENSITY.toolRailWidth
  - EDITOR_DENSITY.compactSidebarWidth;

const WORKSPACE_LAYOUT_PREFERENCE_KEYS = new Set(['inspectorCollapsed', 'inspectorExpandedWidth', 'mapSetupExpanded']);

/** Strictly admit one complete renderer-independent human workspace layout value. */
export function parseWorkspaceLayoutPreferences(value: unknown): WorkspaceLayoutPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace layout preferences.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== WORKSPACE_LAYOUT_PREFERENCE_KEYS.size
    || keys.some((key) => !WORKSPACE_LAYOUT_PREFERENCE_KEYS.has(key))
    || typeof source.inspectorCollapsed !== 'boolean'
    || typeof source.mapSetupExpanded !== 'boolean'
    || !Number.isInteger(source.inspectorExpandedWidth)
    || (source.inspectorExpandedWidth as number) < MIN_INSPECTOR_EXPANDED_WIDTH
    || (source.inspectorExpandedWidth as number) > MAX_INSPECTOR_EXPANDED_WIDTH) {
    throw new Error('Invalid workspace layout preferences.');
  }
  return {
    inspectorCollapsed: source.inspectorCollapsed,
    inspectorExpandedWidth: source.inspectorExpandedWidth as number,
    mapSetupExpanded: source.mapSetupExpanded,
  };
}

export function clampInspectorExpandedWidth(value: number): number {
  const finite = Number.isFinite(value) ? Math.round(value) : DEFAULT_WORKSPACE_LAYOUT_PREFERENCES.inspectorExpandedWidth;
  return Math.max(MIN_INSPECTOR_EXPANDED_WIDTH, Math.min(MAX_INSPECTOR_EXPANDED_WIDTH, finite));
}

export function resetInspectorLayoutPreferences(
  preferences: WorkspaceLayoutPreferences,
): WorkspaceLayoutPreferences {
  return {
    ...preferences,
    inspectorCollapsed: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES.inspectorCollapsed,
    inspectorExpandedWidth: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES.inspectorExpandedWidth,
  };
}

/**
 * Compute the presentation-only inspector width. Compact clamping never mutates
 * the wider durable preference that will be restored in a roomier viewport.
 */
export function effectiveInspectorWidth(savedWidth: number, viewportWidth: number): number {
  const admittedSavedWidth = clampInspectorExpandedWidth(savedWidth);
  const admittedViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : EDITOR_CONTENT_VIEWPORT.defaultWidth;
  const canvasPreservingMaximum = Math.max(0, admittedViewportWidth - EDITOR_DENSITY.toolRailWidth - MINIMUM_EDITOR_CANVAS_WIDTH);
  const presentationMaximum = admittedViewportWidth <= EDITOR_CONTENT_VIEWPORT.compactBreakpointWidth
    ? Math.min(EDITOR_DENSITY.compactSidebarWidth, canvasPreservingMaximum)
    : canvasPreservingMaximum;
  return Math.min(admittedSavedWidth, presentationMaximum);
}

/** The inspector's left edge moves opposite its width. */
export function inspectorWidthAfterPointerMove(
  startWidth: number,
  startClientX: number,
  currentClientX: number,
  maximumEffectiveWidth = MAX_INSPECTOR_EXPANDED_WIDTH,
): number {
  const maximum = clampInspectorExpandedWidth(maximumEffectiveWidth);
  return Math.min(maximum, clampInspectorExpandedWidth(startWidth + startClientX - currentClientX));
}

export function inspectorWidthAfterKeyboardMove(
  currentWidth: number,
  key: string,
  shiftKey = false,
  maximumEffectiveWidth = MAX_INSPECTOR_EXPANDED_WIDTH,
): number | undefined {
  const maximum = clampInspectorExpandedWidth(maximumEffectiveWidth);
  if (key === 'Home') return MIN_INSPECTOR_EXPANDED_WIDTH;
  if (key === 'End') return maximum;
  const step = shiftKey ? INSPECTOR_RESIZE_KEYBOARD_LARGE_STEP : INSPECTOR_RESIZE_KEYBOARD_STEP;
  if (key === 'ArrowLeft') return Math.min(maximum, clampInspectorExpandedWidth(currentWidth + step));
  if (key === 'ArrowRight') return Math.min(maximum, clampInspectorExpandedWidth(currentWidth - step));
  return undefined;
}

export function inspectorToggleShortcutRequested(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): boolean {
  return !event.altKey
    && event.shiftKey
    && (event.ctrlKey || event.metaKey)
    && event.key.toLowerCase() === 'i';
}
