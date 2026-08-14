export const EDITOR_CONTENT_VIEWPORT = {
  defaultWidth: 1_520,
  defaultHeight: 940,
  minimumWidth: 980,
  minimumHeight: 640,
  compactBreakpointWidth: 1_120,
} as const;

export interface EditorSize {
  width: number;
  height: number;
}

export function editorOuterMinimumSize(outerSize: EditorSize, contentSize: EditorSize): EditorSize {
  return {
    width: EDITOR_CONTENT_VIEWPORT.minimumWidth + Math.max(0, outerSize.width - contentSize.width),
    height: EDITOR_CONTENT_VIEWPORT.minimumHeight + Math.max(0, outerSize.height - contentSize.height),
  };
}

export const EDITOR_DENSITY = {
  bodyType: 12,
  labelType: 11,
  captionType: 10,
  secondaryIcon: 18,
  primaryHitTarget: 38,
  secondaryHitTarget: 32,
  topbarHeight: 56,
  contextHeight: 48,
  statusHeight: 38,
  timelineHeight: 138,
  toolRailWidth: 62,
  sidebarWidth: 318,
  compactSidebarWidth: 286,
} as const;

export const MACOS_EDITOR_WINDOW_CHROME = {
  titleBarStyle: 'hiddenInset',
  // Electron 43.4.0's hiddenInset implementation and WindowButtonsProxy use
  // (12, 11) as the standard buttons' left-top margin. Restating that pinned
  // default makes the acceptance target explicit without repositioning chrome.
  trafficLightPosition: { x: 12, y: 11 },
  trafficLightReservedWidth: 84,
} as const;
