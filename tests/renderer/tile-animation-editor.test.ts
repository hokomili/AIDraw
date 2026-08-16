import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import {
  TileAnimationEditor,
  TileAnimationFrameManager,
} from '../../src/renderer/components/TileAnimationEditor';

const frames = [
  { tileId: 1_022, durationMs: 60_000 },
  { tileId: 300, durationMs: 27 },
  { tileId: 1_022, durationMs: 60_000 },
];

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

function manager(overrides: Partial<Parameters<typeof TileAnimationFrameManager>[0]> = {}) {
  return createElement(TileAnimationFrameManager, {
    tileId: 300,
    animation: frames,
    tileCount: 3,
    availableTileIds: [0, 300, 1_022],
    preview: createElement('div', null, 'Exact animation preview remains adjacent'),
    onDraggedFrameIndexChange: () => undefined,
    onDropFrameIndexChange: () => undefined,
    onChange: () => undefined,
    ...overrides,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('selected-tile animation editor presentation', () => {
  it('shows exact authored-order frame identities, labeled values, sparse choices, and visible actions', () => {
    const markup = renderToStaticMarkup(manager());
    expect(markup).toContain('aria-label="Add animation frame for tile 300"');
    expect(markup).toContain('Add frame');
    expect(markup).toContain('role="list" aria-label="Animation frames for tile 300"');
    expect(markup).toContain('aria-label="Animation frame 1, tile 1022, 60000 milliseconds"');
    expect(markup).toContain('aria-label="Animation frame 2, tile 300, 27 milliseconds"');
    expect(markup).toContain('<strong>Frame 1</strong><small>Tile ID 1022 · 60000 ms</small>');
    expect(markup).toContain('<span>Tile ID</span>');
    expect(markup).toContain('<span>Duration (ms)</span>');
    expect(markup).toContain('aria-label="Animation frame 1 tile ID" title="Existing collection tile ID"');
    expect(markup).toContain('<option value="0">0</option>');
    expect(markup).toContain('<option value="300">300</option>');
    expect(markup).toContain('<option value="1022" selected="">1022</option>');
    expect(markup).not.toContain('<option value="301">');
    for (const label of ['Drag frame', 'Move up', 'Move down', 'Delete frame']) expect(markup).toContain(label);
    expect(markup).toContain('Exact animation preview remains adjacent');
    expect(markup.indexOf('Frame 1')).toBeLessThan(markup.indexOf('Frame 2'));
    expect(markup.indexOf('Frame 2')).toBeLessThan(markup.indexOf('Frame 3'));
  });

  it('routes add, edit, delete, drag, and separate up/down actions without mutating authored input', () => {
    const before = structuredClone(frames);
    const changes: Array<[typeof frames, string]> = [];
    const dragged: Array<number | undefined> = [];
    const dropped: Array<number | undefined> = [];
    const tree = TileAnimationFrameManager({
      tileId: 300,
      animation: frames,
      tileCount: 3,
      availableTileIds: [0, 300, 1_022],
      preview: createElement('div'),
      onDraggedFrameIndexChange: (index) => dragged.push(index),
      onDropFrameIndexChange: (index) => dropped.push(index),
      onChange: (animation, label) => changes.push([structuredClone(animation), label]),
    });
    const elements = descendantElements(tree);
    const controls = elements.filter((element) => element.type === 'input' || element.type === 'select' || element.type === 'button') as Array<ReactElement<Record<string, unknown>>>;
    expect(controls.every((control) => control.props.tabIndex !== -1)).toBe(true);
    const byLabel = (label: string) => controls.find((control) => control.props['aria-label'] === label)!;

    expect(byLabel('Move animation frame 1 up').props.disabled).toBe(true);
    expect(byLabel('Move animation frame 3 down').props.disabled).toBe(true);
    expect(byLabel('Move animation frame 2 up').props.disabled).not.toBe(true);
    expect(byLabel('Move animation frame 2 down').props.disabled).not.toBe(true);
    expect(byLabel('Drag animation frame 2').props.draggable).toBe(true);

    (byLabel('Add animation frame for tile 300').props.onClick as () => void)();
    (byLabel('Animation frame 2 tile ID').props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '0' } });
    (byLabel('Animation frame 2 duration in milliseconds').props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '99999' } });
    (byLabel('Move animation frame 2 up').props.onClick as () => void)();
    (byLabel('Move animation frame 2 down').props.onClick as () => void)();
    (byLabel('Delete animation frame 2, tile 300').props.onClick as () => void)();

    const transferValues = new Map<string, string>();
    const transfer = {
      effectAllowed: '',
      dropEffect: '',
      getData: (type: string) => transferValues.get(type) ?? '',
      setData: (type: string, value: string) => transferValues.set(type, value),
    };
    (byLabel('Drag animation frame 2').props.onDragStart as (event: { dataTransfer: typeof transfer }) => void)({ dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe('move');
    expect(transferValues.get('text/plain')).toBe('1');
    const cards = elements.filter((element) => element.type === 'article') as Array<ReactElement<Record<string, unknown>>>;
    let prevented = 0;
    (cards[2].props.onDragOver as (event: { preventDefault(): void; dataTransfer: typeof transfer }) => void)({ preventDefault: () => { prevented += 1; }, dataTransfer: transfer });
    transferValues.set('text/plain', '0');
    (cards[2].props.onDrop as (event: { preventDefault(): void; dataTransfer: typeof transfer }) => void)({ preventDefault: () => { prevented += 1; }, dataTransfer: transfer });
    (byLabel('Drag animation frame 2').props.onDragEnd as () => void)();

    expect(changes).toEqual([
      [[...frames, { tileId: 300, durationMs: 100 }], 'Add animated tile frame'],
      [[frames[0], { tileId: 0, durationMs: 27 }, frames[2]], 'Edit animated tile frame'],
      [[frames[0], { tileId: 300, durationMs: 60_000 }, frames[2]], 'Edit animated tile timing'],
      [[frames[1], frames[0], frames[2]], 'Reorder animated tile frames'],
      [[frames[0], frames[2], frames[1]], 'Reorder animated tile frames'],
      [[frames[0], frames[2]], 'Delete animated tile frame'],
      [[frames[1], frames[2], frames[0]], 'Reorder animated tile frames'],
    ]);
    expect(prevented).toBe(2);
    expect(dragged).toEqual([1, undefined, undefined]);
    expect(dropped).toEqual([2, undefined, undefined]);
    expect(frames).toEqual(before);
  });

  it('keeps the exact duration-aware crop preview and makes reduced-motion play state visible', () => {
    const document = createPixelDocument('project', 'Animation presentation');
    const sprite = createPixelSprite('Source sheet', 32, 16);
    const tileset = createPixelTileset('Tiles', sprite.id, 16, 16, 2, 1);
    const tile = {
      id: 0,
      sourceX: 0,
      sourceY: 0,
      probability: 1,
      animation: [{ tileId: 0, durationMs: 60_000 }, { tileId: 1, durationMs: 27 }],
      collisions: [],
      properties: {},
    };
    tileset.tiles[0] = tile;
    document.assetIds = [sprite.id, tileset.id];
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset };

    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const reducedMarkup = renderToStaticMarkup(createElement(TileAnimationEditor, { document, tileset, tile, tileCount: 2, onChange: () => undefined }));
    expect(reducedMarkup).toContain('aria-label="Tile animation preview, frame 1, tile 0"');
    expect(reducedMarkup).toContain('<strong>Frame 1 of 2</strong>');
    expect(reducedMarkup).toContain('Tile 0 · 16 × 16px · 60000 ms');
    expect(reducedMarkup).toContain('aria-label="Play animation preview"');
    expect(reducedMarkup).toContain('Play preview');

    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const playingMarkup = renderToStaticMarkup(createElement(TileAnimationEditor, { document, tileset, tile, tileCount: 2, onChange: () => undefined }));
    expect(playingMarkup).toContain('aria-label="Pause animation preview"');
    expect(playingMarkup).toContain('Pause preview');
  });

  it('uses shared type, icon, and secondary-target floors with a later compact no-loss reflow', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.tile-animation-heading \.tile-animation-add \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-animation-preview > button \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-animation-drag-handle \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-animation-field input, \.tile-animation-field select \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.tile-animation-frame-actions button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toContain('.tile-animation-heading .tile-animation-add svg, .tile-animation-preview > button svg, .tile-animation-drag-handle svg, .tile-animation-frame-actions svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary);');
    expect(styles).toContain('.tile-animation-preview-copy strong, .tile-animation-preview-copy small { display: block; min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }');
    expect(styles).toContain('.tile-animation-frame-card:focus-within { border-color: #267f79;');
    const ordinaryOffset = styles.indexOf('.tile-animation-frame-fields { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    const compactMediaOffset = styles.indexOf('@media (max-width: 1120px) {\n  .wang-signature-fields');
    const compactOffset = styles.indexOf('.tile-animation-frame-fields { grid-template-columns: minmax(0, 1fr); }', compactMediaOffset);
    expect(ordinaryOffset).toBeGreaterThanOrEqual(0);
    expect(compactMediaOffset).toBeGreaterThan(ordinaryOffset);
    expect(compactOffset).toBeGreaterThan(ordinaryOffset);
    expect(styles.slice(compactMediaOffset)).toContain('.tile-animation-frame-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(styles.slice(compactMediaOffset)).toContain('.tile-animation-frame-actions .tile-animation-delete { grid-column: 1 / -1; }');
    expect(styles.slice(compactMediaOffset)).toContain('.tile-animation-preview > button { grid-column: 1 / -1; width: 100%; }');
  });

  it('retains the established preview, reorder, canonical replacement, and documentation boundaries', async () => {
    const [component, app, changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../src/renderer/components/TileAnimationEditor.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(component).toContain('drawSpriteRegionThumbnail');
    expect(component).toContain('resolveTilesetTileSource');
    expect(component).toContain('Math.min(frame.durationMs, 2_147_483_647)');
    expect(component).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches");
    expect(component).toContain('moveTileAnimationFrame(animation, fromIndex, toIndex)');
    expect(app).toContain('<TileAnimationEditor document={document} tileset={tileset} tile={selectedTile}');
    expect(app).toContain('onChange={(animation, label) => updateTile({ animation }, label)}');
    expect(app).toContain('expectedRevision: tileset.revision');
    expect(app).toContain('expectedSpriteDependencies');
    expect(changelog).toContain('selected-tile animation editor');
    expect(architecture).toContain('The selected-tile animation manager is a presentation-only projection');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-03 checkpoint (2026-08-17)');
    expect(testing).toContain('selected-tile animation presentation correction retains exact frame order and duplicates');
    expect(testing).toContain('no animation schema, playback, renderer, export, semantic-agent, or canonical mutation change');
  });
});
