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

export const EDITOR_TEXT_REFLOW = {
  baseRootFontSize: 16,
  enlargedRootFontSize: 32,
  scale: 2,
  typeRem: {
    body: EDITOR_DENSITY.bodyType / 16,
    label: EDITOR_DENSITY.labelType / 16,
    caption: EDITOR_DENSITY.captionType / 16,
  },
} as const;

export const EDITOR_TEXT_REFLOW_FIT = {
  inspectorTabs: {
    minimumHeight: 52,
    offsetPixels: 31,
    rootMultiplier: 1.25,
  },
  timelineFrame: {
    minimumWidth: 62,
    offsetPixels: -18,
    rootMultiplier: 5,
  },
} as const;

export function editorTypeTiersAtRoot(rootFontSize: number): {
  body: number;
  label: number;
  caption: number;
} {
  if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) {
    throw new Error('Editor root font size must be a positive finite number.');
  }
  return {
    body: rootFontSize * EDITOR_TEXT_REFLOW.typeRem.body,
    label: rootFontSize * EDITOR_TEXT_REFLOW.typeRem.label,
    caption: rootFontSize * EDITOR_TEXT_REFLOW.typeRem.caption,
  };
}

export function editorTextReflowFitAtRoot(rootFontSize: number): {
  inspectorTabsHeight: number;
  timelineFrameWidth: number;
} {
  if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) {
    throw new Error('Editor root font size must be a positive finite number.');
  }
  return {
    inspectorTabsHeight: Math.max(
      EDITOR_TEXT_REFLOW_FIT.inspectorTabs.minimumHeight,
      EDITOR_TEXT_REFLOW_FIT.inspectorTabs.offsetPixels + rootFontSize * EDITOR_TEXT_REFLOW_FIT.inspectorTabs.rootMultiplier,
    ),
    timelineFrameWidth: Math.max(
      EDITOR_TEXT_REFLOW_FIT.timelineFrame.minimumWidth,
      EDITOR_TEXT_REFLOW_FIT.timelineFrame.offsetPixels + rootFontSize * EDITOR_TEXT_REFLOW_FIT.timelineFrame.rootMultiplier,
    ),
  };
}

export const MACOS_EDITOR_WINDOW_CHROME = {
  titleBarStyle: 'hiddenInset',
  // Electron 43.4.0's hiddenInset implementation and WindowButtonsProxy use
  // (12, 11) as the standard buttons' left-top margin. Restating that pinned
  // default makes the acceptance target explicit without repositioning chrome.
  trafficLightPosition: { x: 12, y: 11 },
  trafficLightReservedWidth: 84,
} as const;
