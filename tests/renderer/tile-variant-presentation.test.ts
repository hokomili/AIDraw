import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { createPixelDocument, createPixelTileset, type TileDefinition } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import { EDITOR_CONTENT_VIEWPORT, EDITOR_DENSITY } from '../../src/common/editor-layout';
import {
  TileVariantPreview,
  TileVariantSwatch,
} from '../../src/renderer/components/TileVariantPreview';
import {
  TileVariantSeedControl,
} from '../../src/renderer/components/TileVariantSeedControl';
import { parseTileVariantSeedDraft } from '../../src/renderer/tile-variant-seed';

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(descendantElements)];
}

function tile(id: number, probability: number, group = 'weighted ground'): TileDefinition {
  return {
    id,
    sourceX: id * 16,
    sourceY: 0,
    probability,
    animation: [],
    collisions: [],
    properties: { 'aidraw:variantGroup': group },
  };
}

function fixture(candidates: TileDefinition[]) {
  const document = createPixelDocument('sprite', 'Variant presentation');
  const tileset = createPixelTileset('Atlas variants', document.activeAssetId, 16, 16, Math.max(1, candidates.length), 1);
  tileset.tiles = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));
  return { document, tileset };
}

interface VariantGridGeometry {
  editorMargin: number;
  editorBorder: number;
  editorPadding: number;
  previewBorder: number;
  previewPadding: number;
  stripEndPadding: number;
  columns: number;
  columnGap: number;
  cardBorder: number;
  cardPadding: number;
  cardGap: number;
  thumbnailFrame: number;
  cardHeight: number;
  rowGap: number;
  scrollportHeight: number;
}

function variantGridCapacity(inspectorWidth: number, geometry: VariantGridGeometry) {
  const stripWidth = inspectorWidth
    - geometry.editorMargin * 2
    - geometry.editorBorder * 2
    - geometry.editorPadding * 2
    - geometry.previewBorder * 2
    - geometry.previewPadding * 2
    - geometry.stripEndPadding;
  const trackWidth = (stripWidth - geometry.columnGap * (geometry.columns - 1)) / geometry.columns;
  const cardContentWidth = trackWidth - geometry.cardBorder * 2 - geometry.cardPadding * 2;
  const copyWidth = cardContentWidth - geometry.thumbnailFrame - geometry.cardGap;
  const completeRows = Math.floor((geometry.scrollportHeight + geometry.rowGap) / (geometry.cardHeight + geometry.rowGap));
  return { stripWidth, trackWidth, copyWidth, completeRows, capacity: completeRows * geometry.columns };
}

describe('weighted tile-variant presentation', () => {
  it('keeps absent, empty, and one-candidate groups out of the bounded preview', () => {
    const lone = tile(7, 1);
    const { document, tileset } = fixture([lone]);
    const props = { document, tileset, selectedTileId: 7, candidates: [lone], onSelect: () => undefined };
    expect(TileVariantPreview({ ...props, group: undefined })).toBeNull();
    expect(TileVariantPreview({ ...props, group: '', candidates: [] })).toBeNull();
    expect(TileVariantPreview({ ...props, group: 'weighted ground' })).toBeNull();
  });

  it('renders exact ordered IDs, authored weights, and visible plus native selection meaning', () => {
    const group = 'Very long authored ground transition group that must remain fully recoverable';
    const candidates = [
      tile(2, 0.125, group),
      tile(10, 3, group),
      tile(47, 1000.75, group),
      tile(1_048_575, Number.MAX_VALUE, group),
    ];
    const before = structuredClone(candidates);
    Object.freeze(candidates);
    const { document, tileset } = fixture(candidates);
    const markup = renderToStaticMarkup(createElement(TileVariantPreview, {
      document,
      tileset,
      selectedTileId: 10,
      group,
      candidates,
      onSelect: () => undefined,
    }));
    expect(markup).toContain(`role="group" aria-label="Weighted tile variants for group ${group}"`);
    expect(markup).toContain(`<dt>Variant group</dt><dd>“${group}”</dd>`);
    expect(markup).toContain('<dt>Candidate count</dt><dd>4 weighted tiles</dd>');
    expect(markup).toContain('aria-label="Variant tile ID 2, authored weight 0.125, not selected" aria-pressed="false"');
    expect(markup).toContain('aria-label="Variant tile ID 10, authored weight 3, selected" aria-pressed="true"');
    expect(markup).toContain('aria-label="Variant tile ID 47, authored weight 1000.75, not selected" aria-pressed="false"');
    expect(markup).toContain('aria-label="Variant tile ID 1048575, authored weight 1.7976931348623157e+308, not selected" aria-pressed="false"');
    expect(markup).toContain('<strong>Tile ID 10</strong><small>Weight 3</small>');
    expect(markup).toContain('<strong>Tile ID 1048575</strong><small>Weight 1.7976931348623157e+308</small>');
    expect(markup).toContain('lucide-check');
    expect(markup.match(/lucide-check/gu)).toHaveLength(1);
    expect(markup).not.toContain('>Not selected<');
    expect(markup.indexOf('Tile ID 2')).toBeLessThan(markup.indexOf('Tile ID 10'));
    expect(markup.indexOf('Tile ID 10')).toBeLessThan(markup.indexOf('Tile ID 47'));
    expect(markup.indexOf('Tile ID 47')).toBeLessThan(markup.indexOf('Tile ID 1048575'));
    expect(candidates).toEqual(before);
  });

  it('routes one exact native swatch activation without mutating its tile', () => {
    const candidate = Object.freeze(tile(1_022, 0.375));
    const before = structuredClone(candidate);
    const { document, tileset } = fixture([candidate]);
    const selected: number[] = [];
    const swatch = TileVariantSwatch({
      document,
      tileset,
      tile: candidate,
      selected: false,
      onSelect: () => selected.push(candidate.id),
    }) as ReactElement<Record<string, unknown>>;
    expect(swatch.type).toBe('button');
    expect(swatch.props.type).toBe('button');
    expect(swatch.props['aria-label']).toBe('Variant tile ID 1022, authored weight 0.375, not selected');
    expect(swatch.props['aria-pressed']).toBe(false);
    expect(swatch.props.tabIndex).not.toBe(-1);
    (swatch.props.onClick as () => void)();
    expect(selected).toEqual([1_022]);
    expect(candidate).toEqual(before);
  });

  it('retains the first twelve candidates and reports the exact overflow', () => {
    const candidates = Array.from({ length: 14 }, (_, id) => tile(id, id + 0.5));
    const { document, tileset } = fixture(candidates);
    const markup = renderToStaticMarkup(createElement(TileVariantPreview, {
      document,
      tileset,
      selectedTileId: 7,
      group: 'weighted ground',
      candidates,
      onSelect: () => undefined,
    }));
    expect(markup.match(/aria-label="Variant tile ID /gu)).toHaveLength(12);
    expect(markup).toContain('Variant tile ID 0, authored weight 0.5');
    expect(markup).toContain('Variant tile ID 11, authored weight 11.5');
    expect(markup).not.toContain('Variant tile ID 12, authored weight 12.5');
    expect(markup).toContain('Showing the first 12 of 14 variants.');
  });

  it('keeps signed seed blur and New stroke on distinct native routes', () => {
    expect(parseTileVariantSeedDraft('2147483648')).toBe(2_147_483_647);
    expect(parseTileVariantSeedDraft('-2147483649')).toBe(-2_147_483_648);
    expect(parseTileVariantSeedDraft('-27.9')).toBe(-27);
    expect(parseTileVariantSeedDraft('')).toBe(0);

    const group = 'Long signed-seed terrain group with complete visible meaning';
    const seeds: number[] = [];
    const actions: string[] = [];
    const tree = TileVariantSeedControl({
      group,
      candidateCount: 12,
      seed: -2_147_483_648,
      onSeedBlur: (seed) => seeds.push(seed),
      onNewStroke: () => actions.push('new-stroke'),
    });
    const controls = descendantElements(tree).filter((element) => element.type === 'input' || element.type === 'button') as Array<ReactElement<Record<string, unknown>>>;
    expect(controls).toHaveLength(2);
    expect(controls.every((control) => control.props.tabIndex !== -1)).toBe(true);
    const input = controls.find((control) => control.type === 'input')!;
    const button = controls.find((control) => control.type === 'button')!;
    expect(input.props['aria-label']).toBe(`Signed tile variant seed for group ${group}`);
    expect(input.props.defaultValue).toBe(-2_147_483_648);
    expect(button.props['aria-label']).toBe(`Start a new weighted tile variant stroke for group ${group}`);
    const blur = input.props.onBlur as (event: { target: { value: string } }) => void;
    blur({ target: { value: '2147483648' } });
    blur({ target: { value: '-2147483649' } });
    blur({ target: { value: '-27.9' } });
    blur({ target: { value: '' } });
    (button.props.onClick as () => void)();
    expect(seeds).toEqual([2_147_483_647, -2_147_483_648, -27, 0]);
    expect(actions).toEqual(['new-stroke']);

    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('<strong>Variant group</strong>');
    expect(markup).toContain(`“${group}”`);
    expect(markup).toContain('<small>12 weighted tiles</small>');
    expect(markup).toContain('<span>Signed seed</span>');
    expect(markup).toContain('<strong>New stroke</strong><small>Advance seed only</small>');
  });

  it('retains atlas-only admission, deterministic kernels, unchanged-seed no-op, and exact parent routes', async () => {
    const [canvas, app, variants, mcp] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/common/tile-variants.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/mcp-host.ts', import.meta.url), 'utf8'),
    ]);
    expect(canvas).toContain("!isImageCollectionTileset(terrainTileset) ? tileVariantGroup");
    expect(canvas).toContain("!isImageCollectionTileset(terrainTileset) ? tileVariantCandidates");
    expect(canvas).toContain('<TileVariantSeedControl key={`${tilemap.id}:${variantSeed}`}');
    expect(canvas).toContain("onSeedBlur={(seed) => changeVariantSeed(seed, 'Change tile variant seed')}");
    expect(canvas).toContain("onNewStroke={() => changeVariantSeed(nextTileVariantSeed(variantSeed), 'Start new tile-variant stroke seed')}");
    expect(canvas).toContain('if (!tilemap || seed === variantSeed) return;');
    expect(canvas).toContain("kind: 'pixel.asset.replace', asset: map, expectedRevision: tilemap.revision");
    expect(variants).toContain(".filter((tile) => tileVariantGroup(tile) === group && tile.probability > 0)");
    expect(variants).toContain('.sort((left, right) => left.id - right.id)');
    expect(variants).toContain('hash32(seed, x, y, selectedTileId)');
    expect(canvas).toContain('chooseTileVariant(');
    expect(mcp).toContain('chooseTileVariant(');
    expect(app).toContain('<TileVariantPreview document={document} tileset={tileset} selectedTileId={effectiveSelectedTileId}');
    expect(app).toContain('onSelect={(tileId) => { setSelectedTileId(tileId); setSelectedCollisionIds([]); }}');
  });

  it('uses shared density floors, full wrapping, local scrolling, and a later compact cascade', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const legacyPreview = styles.indexOf('.tile-variant-preview { margin: 7px 0; padding: 6px;');
    const legacySeed = styles.indexOf('.variant-seed-control { height: 28px;');
    const corrected = styles.indexOf('/* Weighted variants expose exact authored meaning without changing their bounded crop or seed kernels. */');
    const compactMedia = styles.indexOf('@media (max-width: 1120px)', corrected);
    const compactStrip = styles.indexOf('.tile-variant-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }', compactMedia);
    const compactSeed = styles.indexOf('.variant-seed-control { width: 420px;', compactMedia);
    expect(legacyPreview).toBeGreaterThanOrEqual(0);
    expect(legacySeed).toBeGreaterThanOrEqual(0);
    expect(corrected).toBeGreaterThan(legacyPreview);
    expect(corrected).toBeGreaterThan(legacySeed);
    expect(compactMedia).toBeGreaterThan(corrected);
    expect(compactStrip).toBeGreaterThan(compactMedia);
    expect(compactSeed).toBeGreaterThan(compactMedia);

    expect(styles).toMatch(/\.tile-variant-summary dt \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-variant-summary dd \{[^}]*font-size: var\(--ui-type-label\)[^}]*overflow-wrap: anywhere/);
    expect(styles).toMatch(/\.tile-variant-strip \{[^}]*max-height: 300px[^}]*padding-right: 2px[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[^}]*gap: 4px[^}]*overflow-y: auto/);
    expect(styles).toMatch(/\.tile-variant-strip button \{[^}]*min-height: 44px[^}]*padding: 4px[^}]*grid-template-columns: 34px minmax\(0, 1fr\)[^}]*gap: 4px/);
    expect(styles).toContain('.tile-variant-strip button:focus-visible');
    expect(styles).toContain('.tile-variant-strip button[aria-pressed="true"]');
    expect(styles).toMatch(/\.tile-variant-thumbnail canvas \{[^}]*max-width: 32px[^}]*max-height: 32px/);
    expect(styles).toMatch(/\.tile-variant-copy strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.tile-variant-copy small \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(styles).toMatch(/\.tile-variant-strip button > \.tile-variant-selection-state \{[^}]*position: absolute[^}]*width: 22px[^}]*height: 22px/);
    expect(styles).toMatch(/\.tile-variant-selection-state svg \{[^}]*width: var\(--ui-icon-secondary\)[^}]*height: var\(--ui-icon-secondary\)/);
    expect(styles).toMatch(/\.variant-seed-control \{[^}]*width: 460px[^}]*min-height: calc\(var\(--ui-hit-secondary\) \+ 12px\)[^}]*height: auto[^}]*flex: 0 0 auto/);
    expect(styles).toMatch(/\.variant-seed-control input \{[^}]*height: var\(--ui-hit-secondary\)[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.variant-seed-control button \{[^}]*min-height: var\(--ui-hit-secondary\)[^}]*height: auto/);
    expect(styles).toMatch(/\.variant-seed-control button > svg \{[^}]*width: var\(--ui-icon-secondary\)[^}]*height: var\(--ui-icon-secondary\)/);
    expect(styles).toContain('.variant-seed-control button:focus-visible, .variant-seed-control input:focus-visible');
    expect(styles).toMatch(/\.pixel-floating-controls \{[^}]*max-width: calc\(100% - 28px\)[^}]*overflow-x: auto/);
    expect(EDITOR_DENSITY.secondaryHitTarget).toBe(32);
    expect(EDITOR_DENSITY.secondaryIcon).toBe(18);
    expect(460).toBeLessThan(EDITOR_CONTENT_VIEWPORT.minimumWidth - 28);
    expect(420).toBeLessThan(EDITOR_CONTENT_VIEWPORT.minimumWidth - 28);

    const acceptedGeometry: VariantGridGeometry = {
      editorMargin: 12,
      editorBorder: 1,
      editorPadding: 8,
      previewBorder: 1,
      previewPadding: 8,
      stripEndPadding: 2,
      columns: 2,
      columnGap: 4,
      cardBorder: 1,
      cardPadding: 4,
      cardGap: 4,
      thumbnailFrame: 34,
      cardHeight: 44,
      rowGap: 4,
      scrollportHeight: 300,
    };
    const regular = variantGridCapacity(EDITOR_DENSITY.sidebarWidth, acceptedGeometry);
    const compact = variantGridCapacity(EDITOR_DENSITY.compactSidebarWidth, acceptedGeometry);
    expect(regular).toEqual({ stripWidth: 256, trackWidth: 126, copyWidth: 78, completeRows: 6, capacity: 12 });
    expect(compact).toEqual({ stripWidth: 224, trackWidth: 110, copyWidth: 62, completeRows: 6, capacity: 12 });
    expect(acceptedGeometry.cardHeight - acceptedGeometry.cardBorder * 2 - acceptedGeometry.cardPadding * 2).toBe(acceptedGeometry.thumbnailFrame);

    const rejectedRegular = variantGridCapacity(EDITOR_DENSITY.sidebarWidth, {
      ...acceptedGeometry,
      columns: 2,
      columnGap: 6,
      cardHeight: 76,
      rowGap: 6,
    });
    const rejectedCompact = variantGridCapacity(EDITOR_DENSITY.compactSidebarWidth, {
      ...acceptedGeometry,
      columns: 1,
      columnGap: 6,
      cardHeight: 76,
      rowGap: 6,
    });
    expect({ rows: rejectedRegular.completeRows, capacity: rejectedRegular.capacity }).toEqual({ rows: 3, capacity: 6 });
    expect({ rows: rejectedCompact.completeRows, capacity: rejectedCompact.capacity }).toEqual({ rows: 3, capacity: 3 });

    const correctedBlock = styles.slice(corrected, compactMedia);
    expect(correctedBlock).not.toContain('text-overflow: ellipsis');
    expect(correctedBlock).not.toContain('white-space: nowrap');
  });

  it('binds literal changelog, architecture, tracker, and testing truth to this presentation-only checkpoint', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('weighted tile-variant presentation');
    expect(architecture).toContain('renderer-only weighted-variant presentation');
    expect(tracker).toContain('A bounded source/headless UX-01/MAP-10 checkpoint (2026-08-17)');
    expect(testing).toContain('Current source/headless weighted-variant presentation checkpoint');
    for (const truth of [changelog, architecture, tracker, testing]) {
      expect(truth).toContain('aria-pressed');
      expect(truth).toContain('12');
      expect(truth).toContain('32 px');
      expect(truth).toContain('New stroke');
      expect(truth).toContain('AIDraw');
    }
    expect(tracker).toContain('UX-01 and MAP-10 remain Working');
    expect(testing).toContain('Packaged/native visual, pointer, keyboard, focus, screen-reader');
  });
});
