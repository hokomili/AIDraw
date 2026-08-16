import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PixelCanvasSizeControls,
  PixelCreationSizeReview,
  TilemapStorageChoice,
} from '../../src/renderer/components/PixelProjectSizing';
import {
  MAX_PIXEL_DIMENSION,
  pixelCanvasSizeEditorKey,
  pixelDimension,
  reviewPixelCanvasSize,
} from '../../src/renderer/pixel-project-sizing';

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

describe('pixel project creation and sprite sizing presentation', () => {
  it('retains exact dimension normalization while classifying unchanged, shrink, expand, and mixed drafts', () => {
    const sprite = Object.freeze({ id: 'sprite-a', width: 64, height: 48 });
    expect(reviewPixelCanvasSize(sprite, '64', '48')).toEqual({
      currentWidth: 64,
      currentHeight: 48,
      draftWidth: 64,
      draftHeight: 48,
      widthChange: 'unchanged',
      heightChange: 'unchanged',
      change: 'unchanged',
      normalized: false,
    });
    expect(reviewPixelCanvasSize(sprite, '32', '24')).toMatchObject({ widthChange: 'shrink', heightChange: 'shrink', change: 'shrink' });
    expect(reviewPixelCanvasSize(sprite, '128', '96')).toMatchObject({ widthChange: 'expand', heightChange: 'expand', change: 'expand' });
    expect(reviewPixelCanvasSize(sprite, '32', '96')).toMatchObject({ widthChange: 'shrink', heightChange: 'expand', change: 'mixed' });
    expect(reviewPixelCanvasSize(sprite, 'not-a-number', '999999999999999999999999')).toMatchObject({
      draftWidth: 64,
      draftHeight: MAX_PIXEL_DIMENSION,
      normalized: true,
    });
    expect(pixelDimension('1.6')).toBe(2);
    expect(pixelDimension('')).toBe(1);
    expect(pixelDimension(Number.POSITIVE_INFINITY, 37)).toBe(37);
    expect(sprite).toEqual({ id: 'sprite-a', width: 64, height: 48 });
  });

  it('renders exact current/draft identity, disabled unchanged state, and top-left crop or transparent expansion meaning', () => {
    const props = {
      sprite: { id: 'sprite-a', width: 64, height: 48 },
      onWidthChange: () => undefined,
      onHeightChange: () => undefined,
      onResize: () => undefined,
    };
    const unchanged = renderToStaticMarkup(createElement(PixelCanvasSizeControls, { ...props, width: '64', height: '48' }));
    expect(unchanged).toContain('aria-label="Sprite canvas size decision"');
    expect(unchanged).toContain('aria-label="Current and drafted sprite dimensions"');
    expect(unchanged).toContain('<small>Current canvas</small><strong>64 × 48 px</strong>');
    expect(unchanged).toContain('<small>Draft canvas</small><strong>64 × 48 px</strong><span>Unchanged</span>');
    expect(unchanged).toContain('<button type="button" disabled=""');
    expect(unchanged).toContain('The draft matches the committed canvas, so Resize is unavailable.');

    const shrink = renderToStaticMarkup(createElement(PixelCanvasSizeControls, { ...props, width: '32', height: '24' }));
    expect(shrink).toContain('Width shrinks: pixels beyond the new right edge are cropped.');
    expect(shrink).toContain('Height shrinks: pixels beyond the new bottom edge are cropped.');
    expect(shrink).toContain('Undo restores the previous complete canvas.');
    expect(shrink).not.toContain('<button type="button" disabled=""');

    const expand = renderToStaticMarkup(createElement(PixelCanvasSizeControls, { ...props, width: '128', height: '96' }));
    expect(expand).toContain('Width expands: transparent space is added at the right edge.');
    expect(expand).toContain('Height expands: transparent space is added at the bottom edge.');
    expect(expand).toContain('existing pixels are never resampled or moved');

    const mixedNormalized = renderToStaticMarkup(createElement(PixelCanvasSizeControls, { ...props, width: '-900000000000000000000', height: '48.6' }));
    expect(mixedNormalized).toContain('<strong>1 × 49 px</strong><span>Resize ready</span>');
    expect(mixedNormalized).toContain('Width shrinks: pixels beyond the new right edge are cropped.');
    expect(mixedNormalized).toContain('Height expands: transparent space is added at the bottom edge.');
    expect(mixedNormalized).toContain('Draft inputs resolve to whole pixels between 1 and 8192 before resize.');
  });

  it('routes raw native input drafts and one normalized resize without mutating its observed sprite', () => {
    const sprite = Object.freeze({ id: 'sprite-route', width: 64, height: 48 });
    const events: unknown[] = [];
    const tree = PixelCanvasSizeControls({
      sprite,
      width: '32',
      height: '95.7',
      onWidthChange: (value) => events.push(['width', value]),
      onHeightChange: (value) => events.push(['height', value]),
      onResize: (width, height) => events.push(['resize', width, height]),
    });
    const controls = descendantElements(tree).filter((element) => element.type === 'input' || element.type === 'button') as Array<ReactElement<Record<string, unknown>>>;
    const [width, height] = controls.filter((element) => element.type === 'input');
    const resize = controls.find((element) => element.type === 'button')!;
    expect(width?.props).toMatchObject({ 'aria-label': 'Sprite canvas width', min: 1, max: 8192, value: '32' });
    expect(height?.props).toMatchObject({ 'aria-label': 'Sprite canvas height', min: 1, max: 8192, value: '95.7' });
    expect(resize.props.disabled).toBe(false);
    (width?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '00017' } });
    (height?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '819200000000000000' } });
    (resize.props.onClick as () => void)();
    expect(events).toEqual([['width', '00017'], ['height', '819200000000000000'], ['resize', 32, 96]]);
    expect(sprite).toEqual({ id: 'sprite-route', width: 64, height: 48 });
  });

  it('keys the stateful draft to exact sprite identity and committed dimensions', () => {
    expect(pixelCanvasSizeEditorKey({ id: 'sprite-a', width: 64, height: 48 })).toBe('sprite-a:64:48');
    expect(pixelCanvasSizeEditorKey({ id: 'sprite-a', width: 64, height: 48 })).toBe('sprite-a:64:48');
    expect(pixelCanvasSizeEditorKey({ id: 'sprite-b', width: 64, height: 48 })).not.toBe('sprite-a:64:48');
    expect(pixelCanvasSizeEditorKey({ id: 'sprite-a', width: 32, height: 48 })).not.toBe('sprite-a:64:48');
    expect(pixelCanvasSizeEditorKey({ id: 'sprite-a', width: 64, height: 32 })).not.toBe('sprite-a:64:48');
  });

  it('makes new sprite/project dimensions and both finite tilemap storage states explicit through native controls', () => {
    const sprite = renderToStaticMarkup(createElement(PixelCreationSizeReview, { kind: 'sprite', width: 8_192, height: 1 }));
    const project = renderToStaticMarkup(createElement(PixelCreationSizeReview, { kind: 'project', width: 32, height: 48 }));
    expect(sprite).toContain('<small>Sprite canvas</small><strong>8192 × 1 px</strong>');
    expect(project).toContain('<small>Starting sprite canvas</small><strong>32 × 48 px</strong>');
    for (const markup of [sprite, project]) expect(markup).toContain('no existing artwork is resized');

    const finite = renderToStaticMarkup(createElement(TilemapStorageChoice, {
      infinite: false,
      width: 96,
      height: 48,
      tileWidth: 32,
      tileHeight: 16,
      orientation: 'isometric',
      onChange: () => undefined,
    }));
    expect(finite).toContain('<legend>Map extent and storage</legend>');
    expect(finite).toMatch(/aria-label="Use finite tilemap storage"[^>]*checked=""/);
    expect(finite).toContain('aria-label="Use sparse infinite tilemap storage"');
    expect(finite).toContain('<strong>Finite map</strong><small>96 × 48 addressed cells. Painting stays inside the configured bounds.</small>');
    expect(finite).toContain('<strong>Sparse infinite map</strong><small>Starts at 96 × 48 cells; painted regions beyond it use 32 × 32 chunks.</small>');
    expect(finite).toContain('<strong>Configured map</strong><span>Isometric · 96 × 48 initial cells · 32 × 16 px tiles</span>');
    expect(finite.match(/>Selected<\/span>/g)).toHaveLength(1);

    const infinite = renderToStaticMarkup(createElement(TilemapStorageChoice, {
      infinite: true,
      width: 64,
      height: 64,
      tileWidth: 16,
      tileHeight: 16,
      orientation: 'orthogonal',
      onChange: () => undefined,
    }));
    expect(infinite).toMatch(/aria-label="Use sparse infinite tilemap storage"[^>]*checked=""/);
    expect(infinite).toContain('Orthogonal · 64 × 64 initial cells · 16 × 16 px tiles');
  });

  it('routes finite and sparse choices as exact booleans without mutating reviewed geometry', () => {
    const input = Object.freeze({ width: 96, height: 48, tileWidth: 32, tileHeight: 16, orientation: 'isometric' as const });
    const events: boolean[] = [];
    const tree = TilemapStorageChoice({ ...input, infinite: false, onChange: (value) => events.push(value) });
    const radios = descendantElements(tree).filter((element) => element.type === 'input') as Array<ReactElement<Record<string, unknown>>>;
    expect(radios.map((radio) => radio.props.checked)).toEqual([true, false]);
    expect(radios.map((radio) => radio.props['aria-label'])).toEqual(['Use finite tilemap storage', 'Use sparse infinite tilemap storage']);
    (radios[1]?.props.onChange as () => void)();
    (radios[0]?.props.onChange as () => void)();
    expect(events).toEqual([true, false]);
    expect(input).toEqual({ width: 96, height: 48, tileWidth: 32, tileHeight: 16, orientation: 'isometric' });
  });

  it('binds density floors, real inspector widths, wrapping, focus, and later compact cascades', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const legacyPixelOffset = styles.indexOf('.pixel-size-editor { padding: 0 12px 10px;');
    const legacyStorageOffset = styles.indexOf('.tilemap-options .infinite-toggle');
    const correctedOffset = styles.indexOf('/* Pixel creation and sprite resizing expose their exact dimensions and consequences');
    const compactOffset = styles.indexOf('@media (max-width: 1120px)', correctedOffset);
    const compactReviewOffset = styles.indexOf('.pixel-size-review { grid-template-columns: minmax(0, 1fr); }', compactOffset);
    const narrowDialogOffset = styles.indexOf('@media (max-width: 680px)', correctedOffset);
    const containerOffset = styles.indexOf('@container new-document-sizing (max-width: 420px)', correctedOffset);
    expect(correctedOffset).toBeGreaterThan(legacyPixelOffset);
    expect(correctedOffset).toBeGreaterThan(legacyStorageOffset);
    expect(compactReviewOffset).toBeGreaterThan(compactOffset);
    expect(narrowDialogOffset).toBeGreaterThan(compactReviewOffset);
    expect(containerOffset).toBeGreaterThan(narrowDialogOffset);

    const rootStart = styles.indexOf(':root {');
    const root = styles.slice(rootStart, styles.indexOf('}', rootStart) + 1);
    const px = (name: string) => Number(root.match(new RegExp(`--${name}:\\s*(\\d+)px`))?.[1]);
    const rem = (name: string) => Number(root.match(new RegExp(`--${name}:\\s*([\\d.]+)rem`))?.[1]);
    const regularPanel = px('shell-sidebar-width');
    const compactPanel = px('shell-sidebar-compact-width');
    const editorHorizontalPadding = 24;
    const fieldGap = 6;
    const cross = px('ui-icon-secondary');
    const fieldTrack = (panel: number) => (panel - editorHorizontalPadding - cross - fieldGap * 2) / 2;
    expect({ regularTrack: fieldTrack(regularPanel), compactTrack: fieldTrack(compactPanel) }).toEqual({ regularTrack: 132, compactTrack: 116 });
    expect(fieldTrack(regularPanel)).toBeGreaterThanOrEqual(px('ui-hit-secondary'));
    expect(fieldTrack(compactPanel)).toBeGreaterThanOrEqual(px('ui-hit-secondary'));

    const regularDialog = 760;
    const regularConfiguration = regularDialog - 40 - 260 - 18 - 4;
    const regularStorageTrack = (regularConfiguration - 7) / 2;
    const narrowViewport = 500;
    const narrowDialog = narrowViewport - 48;
    const narrowConfiguration = narrowDialog - 40 - 4;
    expect({ regularConfiguration, regularStorageTrack, narrowConfiguration }).toEqual({ regularConfiguration: 438, regularStorageTrack: 215.5, narrowConfiguration: 408 });
    expect(regularStorageTrack).toBeGreaterThanOrEqual(px('ui-hit-secondary'));
    expect(narrowConfiguration).toBeLessThanOrEqual(420);
    expect(narrowConfiguration).toBeGreaterThanOrEqual(px('ui-hit-secondary'));

    expect(px('ui-hit-secondary')).toBe(32);
    expect(px('ui-icon-secondary')).toBe(18);
    expect(rem('ui-type-label') * 16).toBe(11);
    expect(rem('ui-type-caption') * 16).toBe(10);
    const corrected = styles.slice(correctedOffset);
    expect(corrected).toContain('.pixel-size-fields button svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary);');
    expect(corrected).toContain('.pixel-size-fields input:focus-visible, .pixel-size-fields button:focus-visible');
    expect(corrected).toContain('.tilemap-storage-options > label:focus-within');
    expect(corrected).toContain('.tilemap-storage-options input { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary);');
    expect(corrected).toContain('.tilemap-storage-options, .pixel-creation-size-review { grid-template-columns: minmax(0, 1fr); }');
    expect(corrected).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(corrected).not.toMatch(/white-space:\s*nowrap/);
  });

  it('keeps creation and resize on the exact predecessor submission and canonical operation routes', async () => {
    const [app, sizing] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/components/PixelProjectSizing.tsx', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('width: pixelDimension(width, definition.width)');
    expect(app).toContain('height: pixelDimension(height, definition.height)');
    expect(app).toContain('options.infinite = infinite');
    expect(app).toContain('options.tileWidth = pixelDimension(tileWidth, 16)');
    expect(app).toContain('options.tileHeight = pixelDimension(tileHeight, 16)');
    expect(app).toContain('await newDocument(options)');
    expect(app).toContain('<TilemapStorageChoice');
    expect(app).toContain('onChange={setInfinite}');
    expect(app).toContain('key={pixelCanvasSizeEditorKey(asset)}');
    expect(app).toContain('resizePixelSpriteCanvas(asset, width, height)');
    expect(app).toContain('"Resize sprite canvas"');
    expect(sizing).not.toContain('resizePixelSpriteCanvas');
    expect(sizing).not.toContain('useEditorStore');
  });

  it('binds literal changelog, architecture, tracker, and testing truth to the presentation-only boundary', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('UX-01/PIX-01 pixel creation and canvas-sizing presentation correction');
    expect(architecture).toContain('Pixel project creation and sprite resizing share one renderer-only sizing presentation');
    expect(tracker).toContain('A bounded source/headless UX-01/PIX-01 checkpoint (2026-08-17)');
    expect(tracker).toContain('The current bounded UX-01/PIX-01 source/headless candidate changes only pixel creation and sprite canvas-sizing presentation');
    expect(testing).toContain('Current source/headless pixel creation and sizing presentation checkpoint');
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain('top-left');
      expect(truth).toContain('32 × 32');
    }
    expect(tracker).toContain('| PIX-01 | Pixel Sprite/Tilemap/Project creation and custom sizing | ✅ Verified |');
    expect(testing).toContain('UX-01 remains Working');
    expect(testing).toContain('not packaged/native visual, pointer, keyboard, focus, screen-reader');
  });
});
