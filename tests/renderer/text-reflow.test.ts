import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  EDITOR_CONTENT_VIEWPORT,
  EDITOR_DENSITY,
  EDITOR_TEXT_REFLOW,
  EDITOR_TEXT_REFLOW_FIT,
  editorTextReflowFitAtRoot,
  editorTypeTiersAtRoot,
} from '../../src/common/editor-layout';

describe('primary pixel workspace 200%-text contract', () => {
  it('keeps the normal density tiers exact and doubles only their text geometry at the supported root', () => {
    expect(EDITOR_TEXT_REFLOW).toEqual({
      baseRootFontSize: 16,
      enlargedRootFontSize: 32,
      scale: 2,
      typeRem: {
        body: 0.75,
        label: 0.6875,
        caption: 0.625,
      },
    });
    expect(editorTypeTiersAtRoot(EDITOR_TEXT_REFLOW.baseRootFontSize)).toEqual({
      body: EDITOR_DENSITY.bodyType,
      label: EDITOR_DENSITY.labelType,
      caption: EDITOR_DENSITY.captionType,
    });
    expect(editorTypeTiersAtRoot(EDITOR_TEXT_REFLOW.enlargedRootFontSize)).toEqual({
      body: 24,
      label: 22,
      caption: 20,
    });
    expect(() => editorTypeTiersAtRoot(0)).toThrow(/positive finite/);
    expect(() => editorTypeTiersAtRoot(Number.NaN)).toThrow(/positive finite/);
    expect(EDITOR_CONTENT_VIEWPORT.minimumWidth).toBe(980);
    expect(EDITOR_CONTENT_VIEWPORT.minimumHeight).toBe(640);
    expect(EDITOR_DENSITY.timelineHeight).toBe(138);
  });

  it('reserves non-overlay scrollbar and frame-metadata space without changing ordinary-root dimensions', () => {
    expect(EDITOR_TEXT_REFLOW_FIT).toEqual({
      inspectorTabs: { minimumHeight: 52, offsetPixels: 31, rootMultiplier: 1.25 },
      timelineFrame: {
        minimumWidth: 62,
        offsetPixels: -18,
        rootMultiplier: 5,
        horizontalPadding: 6,
        expandedLayoutMinimumUsableWidth: 100,
      },
    });
    expect(editorTextReflowFitAtRoot(EDITOR_TEXT_REFLOW.baseRootFontSize)).toEqual({
      inspectorTabsHeight: 52,
      timelineFrameWidth: 62,
      timelineFrameUsableWidth: 56,
      timelineFrameExpandedLayout: false,
      timelineFrameNumberWidth: 28,
      timelineFrameMetadataWidth: 28,
    });
    const enlarged = editorTextReflowFitAtRoot(EDITOR_TEXT_REFLOW.enlargedRootFontSize);
    expect(enlarged).toEqual({
      inspectorTabsHeight: 71,
      timelineFrameWidth: 142,
      timelineFrameUsableWidth: 136,
      timelineFrameExpandedLayout: true,
      timelineFrameNumberWidth: 136,
      timelineFrameMetadataWidth: 136,
    });

    const enlargedCaption = editorTypeTiersAtRoot(EDITOR_TEXT_REFLOW.enlargedRootFontSize).caption;
    const tabContentHeight = 19 + 4 + enlargedCaption * 1.2;
    expect(enlarged.inspectorTabsHeight - 16).toBeGreaterThanOrEqual(tabContentHeight);
    const maximumDurationMetadataWidth = '60000ms'.length * enlargedCaption * 0.75;
    expect(maximumDurationMetadataWidth).toBe(105);
    expect(enlarged.timelineFrameMetadataWidth).toBeGreaterThanOrEqual(maximumDurationMetadataWidth);
    expect(enlarged.timelineFrameNumberWidth).toBe(enlarged.timelineFrameUsableWidth);
    expect(editorTextReflowFitAtRoot(24)).toMatchObject({
      timelineFrameWidth: 102,
      timelineFrameUsableWidth: 96,
      timelineFrameExpandedLayout: false,
      timelineFrameNumberWidth: 48,
      timelineFrameMetadataWidth: 48,
    });
    expect(editorTextReflowFitAtRoot(25)).toMatchObject({
      timelineFrameWidth: 107,
      timelineFrameUsableWidth: 101,
      timelineFrameExpandedLayout: true,
      timelineFrameNumberWidth: 101,
      timelineFrameMetadataWidth: 101,
    });
    expect(() => editorTextReflowFitAtRoot(Number.POSITIVE_INFINITY)).toThrow(/positive finite/);
  });

  it('uses root-relative type without scaling the canvas or fixed shell geometry', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(styles).toContain('--ui-type-body: 0.75rem;');
    expect(styles).toContain('--ui-type-label: 0.6875rem;');
    expect(styles).toContain('--ui-type-caption: 0.625rem;');
    expect(styles).toContain('--shell-context-height: 48px;');
    expect(styles).toContain('--shell-status-height: 38px;');
    expect(styles).toContain('--timeline-height: 138px;');
    const shellRule = styles.match(/\.app-shell \{([^}]+)\}/)?.[1];
    expect(shellRule).toBeDefined();
    expect(shellRule).not.toMatch(/(?:transform|zoom|font-size)\s*:/);
    expect(styles).toContain('.document-tab-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: .8125rem;');
    expect(styles).toContain('.brand { display: flex; align-items: center; gap: 9px; width: max(132px, 5.5rem);');
    expect(styles).toContain('.skip-to-canvas { position: fixed;');
    expect(styles).toContain('min-height: max(34px, 2.125rem);');
    expect(styles).toContain('font-size: var(--ui-type-caption);');
  });

  it('keeps every named primary sprite surface deliberately reachable on a local axis', async () => {
    const [styles, app, pixelCanvas] = await Promise.all([
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
    ]);
    expect(styles).toMatch(/\.document-tab-viewport \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.context-bar \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.tool-rail \{[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.panel-tabs \{[^}]*minmax\(3\.25rem, 1fr\)[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.panel-content \{[^}]*overflow: auto/);
    expect(styles).toContain('.panel-content > * { min-width: max(100%, 16rem); }');
    expect(styles).toContain('.layer-copy strong, .palette-editor-row strong, .palette-cycle-main strong { font-size: var(--ui-type-label); }');
    expect(styles).toContain('.layer-copy small, .layer-opacity, .palette-remap-row > span, .palette-editor-row small, .conversion-editor > small, .palette-cycle-editor > small, .palette-cycle-main small { font-size: var(--ui-type-caption); }');
    expect(styles).toMatch(/\.pixel-floating-controls \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.timeline \{[^}]*max\(82px, 3\.5rem\)[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.timeline-tags \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.frame-strip \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/\.statusbar \{[^}]*overflow-x: auto/);
    expect(styles).toContain('.statusbar > * { flex: 0 0 auto; }');
    expect(styles).toContain('.document-tab-viewport, .context-bar, .tool-rail, .panel-tabs, .panel-content, .pixel-floating-controls, .timeline, .timeline-tags, .frame-strip, .statusbar { scroll-padding: 4px; }');
    expect(styles).toMatch(/button:focus-visible[^}]*outline:/);
    expect(styles).toContain('.drawing-canvas:focus-visible, .panel-content:focus-visible { outline: 2px solid #8268dd; outline-offset: -2px; }');

    expect(app).toContain('<section className="context-bar" aria-label="Active tool settings">');
    expect(app).toContain('aria-label={`${document.kind} tools`}');
    expect(app).toContain('<footer className="statusbar" aria-label="Document status and canvas zoom">');
    expect(app).toContain('className="skip-to-canvas"');
    expect(app).toContain('aria-label={`${inspectorCollapsed ? "Open" : "Collapse"} inspector sidebar`}');
    expect(pixelCanvas).toContain('<section className="timeline" aria-label="Sprite animation timeline">');
    expect(pixelCanvas).toContain('aria-label="Previous frame"');
    expect(pixelCanvas).toContain("aria-label={playing ? 'Pause animation' : 'Play animation'}");
    expect(pixelCanvas).toContain('aria-pressed={pingPong}');
    expect(pixelCanvas).toContain('aria-expanded={exposureGridOpen}');
    expect(pixelCanvas).toContain('aria-label={`Frame ${index + 1}, ${sprite.frames[id]?.durationMs ?? 100} milliseconds`}');
  });

  it('fits enlarged inspector tabs and timeline metadata without changing the canvas boundary', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(styles).toContain('* { box-sizing: border-box; }');
    expect(styles).toMatch(/\.frame-strip > button \{[^}]*padding: 3px;/);
    expect(styles).toContain('.panel-tabs { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(3.25rem, 1fr); height: max(52px, calc(31px + 1.25rem));');
    expect(styles).toMatch(/\.panel-tabs button \{[^}]*font-size: var\(--ui-type-caption\); line-height: 1\.2;/);
    expect(styles).toContain('.timeline-label { width: max(80px, 3.5rem); display: grid; align-content: center; gap: 2px; }');
    expect(styles).toContain('.timeline-label strong { font-size: var(--ui-type-label); line-height: 1; }');
    expect(styles).toContain('.timeline-label small, .frame-strip em { font-size: var(--ui-type-caption); line-height: 1; }');
    expect(styles).toContain('.frame-strip > button { width: max(62px, calc(5rem - 18px)); height: max(70px, calc(50px + 1.2em)); grid-template-rows: 44px max(18px, 1.2em); overflow: hidden; font-size: var(--ui-type-caption); }');
    expect(styles).toContain('.frame-strip > button:not(.add-frame) { container: timeline-frame-card / inline-size; }');
    expect(styles).toContain('@container timeline-frame-card (min-width: 100px) {');
    expect(styles).toContain('.frame-strip > button:not(.add-frame) small { grid-column: 1 / 3; grid-row: 1; align-self: start; justify-self: stretch; z-index: 1; overflow: visible; text-overflow: clip; text-align: left; }');
    expect(styles).toContain('.frame-strip > button:not(.add-frame) em { grid-column: 1 / 3; grid-row: 2; justify-self: stretch; overflow: visible; text-overflow: clip; }');
    expect(styles).toContain('.frame-strip small, .frame-strip em { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
    const timelineHeights = [...styles.matchAll(/\.timeline \{[^}]*height:\s*([^;]+);/g)].map((match) => match[1]);
    expect(timelineHeights).not.toHaveLength(0);
    expect(timelineHeights.every((height) => height === 'var(--timeline-height)')).toBe(true);
  });
});
