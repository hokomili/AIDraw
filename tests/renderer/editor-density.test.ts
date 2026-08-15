import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  EDITOR_CONTENT_VIEWPORT,
  EDITOR_DENSITY,
  MACOS_EDITOR_WINDOW_CHROME,
  editorOuterMinimumSize,
} from '../../src/common/editor-layout';
import { MINIMUM_EDITOR_CANVAS_WIDTH, effectiveInspectorWidth } from '../../src/common/workspace-layout';

describe('professional editor density contract', () => {
  it('keeps a bounded canvas floor at the supported minimum content viewport', () => {
    expect(EDITOR_CONTENT_VIEWPORT).toEqual({
      defaultWidth: 1_520,
      defaultHeight: 940,
      minimumWidth: 980,
      minimumHeight: 640,
      compactBreakpointWidth: 1_120,
    });
    const minimumCanvasWidth = EDITOR_CONTENT_VIEWPORT.minimumWidth
      - EDITOR_DENSITY.toolRailWidth
      - EDITOR_DENSITY.compactSidebarWidth;
    const minimumCanvasHeight = EDITOR_CONTENT_VIEWPORT.minimumHeight
      - EDITOR_DENSITY.topbarHeight
      - EDITOR_DENSITY.contextHeight
      - EDITOR_DENSITY.statusHeight;
    expect(minimumCanvasWidth).toBeGreaterThanOrEqual(600);
    expect(minimumCanvasHeight).toBeGreaterThanOrEqual(480);
    expect(minimumCanvasHeight - EDITOR_DENSITY.timelineHeight).toBeGreaterThanOrEqual(340);
  });

  it('adds measured native frame insets to the renderer-content minimum', () => {
    expect(editorOuterMinimumSize(
      { width: 1_536, height: 979 },
      { width: 1_520, height: 940 },
    )).toEqual({ width: 996, height: 679 });
    expect(editorOuterMinimumSize(
      { width: 1_520, height: 940 },
      { width: 1_520, height: 940 },
    )).toEqual({ width: 980, height: 640 });
    expect(editorOuterMinimumSize(
      { width: 1_500, height: 920 },
      { width: 1_520, height: 940 },
    )).toEqual({ width: 980, height: 640 });
  });

  it('binds the BrowserWindow and CSS shell to the shared size and density contract', async () => {
    const [main, styles, electronTypes] = await Promise.all([
      readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
      readFile(new URL('../../node_modules/electron/electron.d.ts', import.meta.url), 'utf8'),
    ]);
    for (const property of ['defaultWidth', 'defaultHeight']) {
      expect(main).toContain(`EDITOR_CONTENT_VIEWPORT.${property}`);
    }
    expect(main).toContain('useContentSize: true');
    expect(MACOS_EDITOR_WINDOW_CHROME).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 11 },
      trafficLightReservedWidth: 84,
    });
    expect(main).toContain('titleBarStyle: MACOS_EDITOR_WINDOW_CHROME.titleBarStyle');
    expect(main).toContain('trafficLightPosition: MACOS_EDITOR_WINDOW_CHROME.trafficLightPosition');
    expect(main).toContain("url.searchParams.set('native-titlebar', 'hidden-inset')");
    expect(main).toContain("editorRendererUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL ?? 'aidraw://app/index.html')");
    expect(main).not.toContain('enableLargerThanScreen: true');
    expect(main).toContain('editorOuterMinimumSize(');
    expect(main).toContain('window.getSize()');
    expect(main).toContain('window.getContentSize()');
    expect(main).toContain('window.setMinimumSize(minimumOuterSize.width, minimumOuterSize.height)');
    expect(main).not.toMatch(/\bminWidth:\s*EDITOR_CONTENT_VIEWPORT/);
    expect(main).not.toMatch(/\bminHeight:\s*EDITOR_CONTENT_VIEWPORT/);
    expect(electronTypes).toContain("titleBarStyle?: ('default' | 'hidden' | 'hiddenInset' | 'customButtonsOnHover')");
    expect(electronTypes).toContain("The `width` and `height` would be used as web page's size");
    expect(styles).toMatch(/html, body, #root \{[^}]*width: 100%;[^}]*height: 100%;[^}]*overflow: hidden;/);
    expect(styles).toMatch(/\.app-shell \{[^}]*width: 100%; height: 100%; display: grid;[^}]*minmax\(0, 1fr\)/);
    const cssTokens: Array<[string, number]> = [
      ['ui-type-body', EDITOR_DENSITY.bodyType],
      ['ui-type-label', EDITOR_DENSITY.labelType],
      ['ui-type-caption', EDITOR_DENSITY.captionType],
      ['ui-icon-secondary', EDITOR_DENSITY.secondaryIcon],
      ['ui-hit-primary', EDITOR_DENSITY.primaryHitTarget],
      ['ui-hit-secondary', EDITOR_DENSITY.secondaryHitTarget],
      ['shell-topbar-height', EDITOR_DENSITY.topbarHeight],
      ['shell-context-height', EDITOR_DENSITY.contextHeight],
      ['shell-status-height', EDITOR_DENSITY.statusHeight],
      ['timeline-height', EDITOR_DENSITY.timelineHeight],
      ['shell-tool-rail-width', EDITOR_DENSITY.toolRailWidth],
      ['shell-sidebar-width', EDITOR_DENSITY.sidebarWidth],
      ['shell-sidebar-compact-width', EDITOR_DENSITY.compactSidebarWidth],
    ];
    for (const [name, value] of cssTokens) expect(styles).toContain(`--${name}: ${value}px;`);
    expect(styles).toContain(`@media (max-width: ${EDITOR_CONTENT_VIEWPORT.compactBreakpointWidth}px)`);
    expect(styles).toContain('var(--shell-sidebar-effective-width)');
    expect(effectiveInspectorWidth(EDITOR_DENSITY.sidebarWidth, EDITOR_CONTENT_VIEWPORT.minimumWidth)).toBe(EDITOR_DENSITY.compactSidebarWidth);
    expect(MINIMUM_EDITOR_CANVAS_WIDTH).toBe(EDITOR_CONTENT_VIEWPORT.minimumWidth - EDITOR_DENSITY.toolRailWidth - EDITOR_DENSITY.compactSidebarWidth);
    expect(styles).toContain('html[data-native-titlebar="hidden-inset"] .topbar { -webkit-app-region: drag; }');
    expect(styles).toContain(`--macos-traffic-light-inset: ${MACOS_EDITOR_WINDOW_CHROME.trafficLightReservedWidth}px;`);
    expect(styles).toContain('html[data-native-titlebar="hidden-inset"] .brand { width: calc(118px + var(--macos-traffic-light-inset)); padding-left: var(--macos-traffic-light-inset); }');
    expect(styles).toContain('html[data-native-titlebar="hidden-inset"] .topbar button,');
    expect(styles).toContain('-webkit-app-region: no-drag;');
  });

  it('keeps the r2 host work area reachable instead of extending a decorated window below it', () => {
    const hostWorkArea = { width: 1_920, height: 960 };
    const r2ObservedContent = { width: 1_520, height: 928 };
    const inferredDefaultFrameHeight = hostWorkArea.height - r2ObservedContent.height;
    const largerThanScreenOuterHeight = EDITOR_CONTENT_VIEWPORT.defaultHeight + inferredDefaultFrameHeight;
    expect(inferredDefaultFrameHeight).toBe(32);
    expect(largerThanScreenOuterHeight - hostWorkArea.height).toBe(12);
    expect(EDITOR_CONTENT_VIEWPORT.defaultWidth).toBeLessThanOrEqual(hostWorkArea.width);
    expect(EDITOR_CONTENT_VIEWPORT.defaultHeight).toBeLessThanOrEqual(hostWorkArea.height);
    expect(EDITOR_CONTENT_VIEWPORT.minimumWidth).toBeLessThanOrEqual(hostWorkArea.width);
    expect(EDITOR_CONTENT_VIEWPORT.minimumHeight).toBeLessThanOrEqual(hostWorkArea.height);
  });

  it('keeps pixel canvas measurement and every CSS timeline height on the shared token', async () => {
    const [pixelCanvas, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(pixelCanvas).toContain("import { EDITOR_DENSITY } from '../../common/editor-layout';");
    expect(pixelCanvas).toContain('entry.contentRect.height - (hasTimeline ? EDITOR_DENSITY.timelineHeight : 0)');
    expect(pixelCanvas).not.toMatch(/entry\.contentRect\.height\s*-\s*\(hasTimeline\s*\?\s*\d+/);
    const timelineHeights = [...styles.matchAll(/\.timeline \{[^}]*height:\s*([^;]+);/g)].map((match) => match[1]);
    expect(timelineHeights).not.toHaveLength(0);
    expect(timelineHeights.every((height) => height === 'var(--timeline-height)')).toBe(true);
  });

  it('enlarges primary actions while overflow retains progressive disclosure', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const shellRule = styles.match(/\.app-shell \{([^}]+)\}/)?.[1];
    expect(shellRule).toBeDefined();
    expect(shellRule).not.toMatch(/(?:transform|zoom)\s*:/);
    expect(styles).toMatch(/\.icon-button \{[^}]*var\(--ui-hit-primary\)/);
    expect(styles).toMatch(/\.tool-button \{[^}]*width: 42px;[^}]*var\(--ui-hit-primary\)/);
    expect(styles).toMatch(/\.color-pair input \{[^}]*width: var\(--ui-hit-secondary\);[^}]*height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.range-field input \{[^}]*height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.panel-tabs \{[^}]*height: 52px/);
    expect(styles).toMatch(/\.object-quick-actions button \{[^}]*var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.statusbar \{[^}]*var\(--shell-status-height\)/);
    expect(styles).toMatch(/\.timeline \{[^}]*var\(--timeline-height\)/);
    expect(styles).toContain('.animation-keyframe-actions button { min-height: var(--ui-hit-secondary); font-size: var(--ui-type-caption); }');
    expect(styles).toMatch(/\.context-bar \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.tool-rail \{[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.document-tab-viewport \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.panel-content \{[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.pixel-floating-controls \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.timeline-tags \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.frame-strip \{[^}]*overflow-x: auto/);
    expect(styles).toContain('.palette-grid, .tile-definition-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }');
  });

  it('brings sprite-animation companion panels onto the shared secondary tier', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(EDITOR_DENSITY.secondaryIcon).toBe(18);
    expect(styles).toContain('.cel-exposure-paging button, .cel-exposure-close { width: var(--ui-hit-secondary); height: var(--ui-hit-secondary);');
    expect(styles).toContain('.cel-exposure-paging svg, .cel-exposure-close svg, .cel-exposure-panel > footer svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary); }');
    expect(styles).toContain('.cel-exposure-row > button, .cel-exposure-row > span, .cel-exposure-head > button, .cel-exposure-head > span { height: var(--ui-hit-secondary); font-size: var(--ui-type-caption); }');
    expect(styles).toContain('.cel-exposure-panel > footer > button { min-height: var(--ui-hit-secondary); font-size: var(--ui-type-caption); }');
    expect(styles).toContain('.cel-exposure-grid { min-height: 0; overflow: auto; overscroll-behavior: contain; }');
    expect(styles).toContain('.onion-settings-panel > header button { width: var(--ui-hit-secondary); height: var(--ui-hit-secondary);');
    expect(styles).toContain('.onion-settings-columns select, .onion-settings-columns input[type="color"] { height: var(--ui-hit-secondary); }');
    expect(styles).toContain('.onion-opacity input { height: var(--ui-hit-secondary); }');
    expect(styles).toContain('.onion-settings-panel > footer button { min-height: var(--ui-hit-secondary); font-size: var(--ui-type-caption); }');
    expect(styles).toMatch(/\.onion-settings-panel \{[^}]*max-height: min\(330px, calc\(100% - var\(--timeline-height\) - 48px\)\)/);
    expect(styles).toMatch(/\.onion-settings-panel \{[^}]*overflow: auto/);
    expect(styles).toContain('.tile-object-actions button, .tile-object-property-editor button { min-height: var(--ui-hit-secondary);');
    expect(styles).toContain('.tile-object-property-editor input, .tile-object-property-editor select { min-width: 0; height: var(--ui-hit-secondary);');
    expect(styles).toContain('.tile-object-tile-control { height: var(--ui-hit-secondary);');
    expect(styles).toContain('font-size: var(--ui-type-label);');
    expect(styles).toContain('font-size: var(--ui-type-caption);');
  });
});
