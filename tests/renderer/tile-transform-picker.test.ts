import { readFile } from 'node:fs/promises';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPixelDocument, createPixelTileset, type PixelSprite } from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import {
  TILE_TRANSFORM_CHOICES,
  tileTransformChoiceId,
  type TileTransformChoice,
  type TileTransformFlags,
} from '../../src/common/tile-transform-options';
import {
  TileTransformChoiceControl,
  TileTransformPicker,
} from '../../src/renderer/components/TileTransformPicker';

function fixture(tileWidth = 8, tileHeight = 8) {
  const document = createPixelDocument('sprite', 'Transform preview');
  const sprite = document.pixelAssets[document.activeAssetId] as PixelSprite;
  const tileset = createPixelTileset('Square labels', sprite.id, tileWidth, tileHeight, 2, 2);
  return { document, sprite, tileset };
}

describe('tile transform picker', () => {
  it('renders all eight exact choices with explicit current, available, and unavailable meaning', () => {
    const { document, sprite, tileset } = fixture();
    tileset.transformations = { hFlip: false, vFlip: false, rotate: true };
    const markup = renderToStaticMarkup(createElement(TileTransformPicker, {
      document,
      sprite,
      tileset,
      tileId: 0,
      value: { hFlip: true, vFlip: false, diagonal: true },
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('aria-label="Tile transform preview"');
    expect(markup).toContain('aria-label="Current tile transform review"');
    expect(markup).toContain('aria-label="Eight tile transform choices"');
    expect(markup).toContain('Tiled transform order');
    expect(markup).toContain('Diagonal is applied first, then horizontal and vertical.');
    expect(markup).toContain('Current transform');
    expect(markup).toContain('D+H · Diagonal + horizontal');
    expect(markup).toContain('aria-label="Close tile transform preview"');
    expect(markup).toContain('<span>Close</span>');
    expect(markup.match(/aria-label="Use [^"]* tile transform\./g)).toHaveLength(8);
    expect([...markup.matchAll(/tile-transform-choice-copy"><strong>([^<]+)<\/strong>/g)].map((match) => match[1])).toEqual(
      TILE_TRANSFORM_CHOICES.map((choice) => choice.label),
    );
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(7);
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(markup.match(/tile-transform-choice-state is-disabled" aria-hidden="true"><span>Unavailable<\/span>/g)).toHaveLength(4);
    expect(markup.match(/tile-transform-choice-state is-selected/g)).toHaveLength(1);
    expect(markup.match(/lucide-check/g)).toHaveLength(1);
    expect(markup).toContain('Diagonal + horizontal + vertical');
    expect(markup).toContain('Each nearest-neighbor sample aspect-fits the complete transformed footprint inside 32 × 32px.');
    expect(markup).toContain('Existing GIDs, source pixels, and canonical documents remain unchanged.');
  });

  it('keeps exact rectangular source dimensions and long source meaning recoverable', () => {
    const { document, sprite, tileset } = fixture(16, 8);
    sprite.name = 'A deliberately long exact atlas source name that must remain fully recoverable';
    const markup = renderToStaticMarkup(createElement(TileTransformPicker, {
      document,
      sprite,
      tileset,
      tileId: 0,
      value: { hFlip: false, vFlip: false, diagonal: false },
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('A deliberately long exact atlas source name that must remain fully recoverable');
    expect(markup).toContain('Tile ID 0 · 16 × 8px');
    expect(markup.match(/aria-label="Use [^"]* tile transform\./g)).toHaveLength(8);
    expect(markup).toContain('aria-label="Use original tile transform. Available under this tileset’s capabilities. Currently selected."');
    expect(markup).toContain('aria-label="Use diagonal + vertical tile transform. Available under this tileset’s capabilities."');
    expect(markup).toContain('A diagonal rectangular preview therefore swaps the visible footprint axes.');
    expect(markup).not.toContain('intentionally limited to square tiles');
  });

  it('presents one exact sparse image-collection source at its own dimensions', () => {
    const { document, sprite, tileset } = fixture(16, 8);
    tileset.spriteAssetId = undefined;
    tileset.columns = 0;
    tileset.rows = 0;
    tileset.wangSets = [];
    tileset.tiles = { 7: { id: 7, sourceX: 0, sourceY: 0, imageAssetId: sprite.id, probability: 1, animation: [], collisions: [], properties: {} } };
    const markup = renderToStaticMarkup(createElement(TileTransformPicker, {
      document,
      sprite,
      tileset,
      tileId: 7,
      value: { hFlip: false, vFlip: false, diagonal: true },
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain(`Tile ID 7 · ${sprite.width} × ${sprite.height}px`);
    expect(markup.match(/aria-label="Use [^"]* tile transform\./g)).toHaveLength(8);
    expect(markup).toContain('aria-label="Use diagonal tile transform. Available under this tileset’s capabilities. Currently selected."');
  });

  it('retains a stale exact selected identity while making its unavailable state explicit', () => {
    const { document, sprite, tileset } = fixture();
    tileset.transformations = { hFlip: false, vFlip: false, rotate: false };
    const markup = renderToStaticMarkup(createElement(TileTransformPicker, {
      document,
      sprite,
      tileset,
      tileId: 0,
      value: { hFlip: false, vFlip: false, diagonal: true },
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('D · Diagonal');
    expect(markup).toContain('Unavailable under this tileset’s capabilities');
    expect(markup).toContain('class="is-active is-disabled" disabled="" aria-pressed="true"');
    expect(markup).toContain('<span>Selected · unavailable</span>');
  });

  it('routes every authored-order choice through a fresh immutable flag value', () => {
    const ids: string[] = [];
    const received: TileTransformFlags[] = [];
    for (const original of TILE_TRANSFORM_CHOICES) {
      const choice: TileTransformChoice = {
        ...original,
        flags: { ...original.flags },
      };
      Object.freeze(choice.flags);
      Object.freeze(choice);
      const control = TileTransformChoiceControl({
        choice,
        active: false,
        disabled: false,
        onSelect: (flags) => {
          ids.push(tileTransformChoiceId(flags));
          received.push(flags);
        },
      }) as ReactElement<{ onClick: () => void }>;
      control.props.onClick();
      expect(received.at(-1)).toEqual(choice.flags);
      expect(received.at(-1)).not.toBe(choice.flags);
      expect(choice.flags).toEqual(original.flags);
    }
    expect(ids).toEqual(['identity', 'h', 'v', 'hv', 'd', 'dh', 'dv', 'dhv']);
  });

  it('derives responsive four-by-two and two-by-four capacity without clipping meaning', async () => {
    const styles = await readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');
    const pickerOffset = styles.indexOf('.tile-transform-picker {');
    const gridOffset = styles.indexOf('.tile-transform-grid {', pickerOffset);
    const containerOffset = styles.indexOf('@container tile-transform-picker (max-width: 360px)', gridOffset);
    const endOffset = styles.indexOf('.tileset-canvas-label', containerOffset);
    const ruleBody = (selector: string, offset: number) => {
      const start = styles.indexOf(`${selector} {`, offset);
      const end = styles.indexOf('}', start);
      if (start < 0 || end < 0) throw new Error(`Missing ${selector} CSS rule.`);
      return styles.slice(start, end + 1);
    };
    const root = styles.slice(styles.indexOf(':root {'), styles.indexOf('}', styles.indexOf(':root {')) + 1);
    const variablePx = (name: string) => Number(root.match(new RegExp(`--${name}:\\s*(\\d+)px`))?.[1]);
    const variableRem = (name: string) => Number(root.match(new RegExp(`--${name}:\\s*([\\d.]+)rem`))?.[1]);
    const picker = ruleBody('.tile-transform-picker', pickerOffset);
    const baseGrid = ruleBody('.tile-transform-grid', gridOffset);
    const narrowGrid = ruleBody('.tile-transform-grid', containerOffset);
    const choice = ruleBody('.tile-transform-grid > button', gridOffset);
    const close = ruleBody('.tile-transform-close', pickerOffset);
    const pickerSlice = styles.slice(pickerOffset, endOffset);
    const outerRegular = Number(picker.match(/width:\s*min\((\d+)px/)?.[1]);
    const outerNarrow = variablePx('shell-sidebar-compact-width');
    const padding = Number(picker.match(/padding:\s*(\d+)px/)?.[1]);
    const border = Number(picker.match(/border:\s*(\d+)px/)?.[1]);
    const gap = Number(baseGrid.match(/gap:\s*(\d+)px/)?.[1]);
    const regularColumns = Number(baseGrid.match(/repeat\((\d+),/)?.[1]);
    const narrowColumns = Number(narrowGrid.match(/repeat\((\d+),/)?.[1]);
    const minimumMeaningWidth = Number(baseGrid.match(/minmax\((\d+)px/)?.[1]);
    const choiceHeight = Number(choice.match(/min-height:\s*(\d+)px/)?.[1]);
    if (!pickerOffset || !gridOffset || !containerOffset || !endOffset || !outerRegular || !outerNarrow || !padding || !border || !gap || !regularColumns || !narrowColumns || !minimumMeaningWidth || !choiceHeight) throw new Error('Missing tile-transform geometry inputs.');
    const contentWidth = (outer: number) => outer - padding * 2 - border * 2;
    const trackWidth = (outer: number, columns: number) => (contentWidth(outer) - gap * (columns - 1)) / columns;
    const rows = (columns: number) => Math.ceil(TILE_TRANSFORM_CHOICES.length / columns);
    const gridHeight = (columns: number) => rows(columns) * choiceHeight + (rows(columns) - 1) * gap;
    const regularTrack = trackWidth(outerRegular, regularColumns);
    const narrowTrack = trackWidth(outerNarrow, narrowColumns);
    const rejectedEightColumnTrack = trackWidth(outerRegular, 8);
    const rejectedFourColumnNarrowTrack = trackWidth(outerNarrow, 4);
    expect({ regularColumns, regularRows: rows(regularColumns), regularTrack, regularHeight: gridHeight(regularColumns) }).toEqual({
      regularColumns: 4,
      regularRows: 2,
      regularTrack: 97.5,
      regularHeight: 214,
    });
    expect({ narrowColumns, narrowRows: rows(narrowColumns), narrowTrack, narrowHeight: gridHeight(narrowColumns) }).toEqual({
      narrowColumns: 2,
      narrowRows: 4,
      narrowTrack: 129,
      narrowHeight: 434,
    });
    expect(regularTrack).toBeGreaterThanOrEqual(minimumMeaningWidth);
    expect(narrowTrack).toBeGreaterThanOrEqual(minimumMeaningWidth);
    expect(rejectedEightColumnTrack).toBeLessThan(minimumMeaningWidth);
    expect(rejectedFourColumnNarrowTrack).toBeLessThan(minimumMeaningWidth);
    expect(variablePx('ui-hit-secondary')).toBe(32);
    expect(variablePx('ui-icon-secondary')).toBe(18);
    expect(variableRem('ui-type-label') * 16).toBe(11);
    expect(variableRem('ui-type-caption') * 16).toBe(10);
    expect(picker).toContain('max-height: calc(100% - 62px)');
    expect(picker).toContain('overflow-y: auto');
    expect(close).toContain('min-width: var(--ui-hit-secondary)');
    expect(close).toContain('min-height: var(--ui-hit-secondary)');
    expect(pickerSlice).toContain('.tile-transform-close svg { width: var(--ui-icon-secondary); height: var(--ui-icon-secondary); }');
    expect(pickerSlice).toContain('.tile-transform-preview { width: 34px; height: 34px;');
    expect(pickerSlice).toContain('.tile-transform-grid canvas { width: 32px; height: 32px; image-rendering: pixelated; }');
    expect(pickerSlice).toContain('.tile-transform-grid > button:focus-visible');
    expect(pickerSlice).toContain('.tile-transform-choice-state.is-selected');
    expect(pickerSlice).toContain('.tile-transform-grid > button.is-disabled { opacity: 1;');
    expect(pickerSlice).toContain('overflow-wrap: anywhere');
    expect(pickerSlice).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(pickerSlice).not.toMatch(/white-space:\s*nowrap/);
    expect(containerOffset).toBeGreaterThan(gridOffset);
  });

  it('uses constrained flags for stamps/paint while tile-object admission refuses stale disallowed flags', async () => {
    const [canvasSource, pickerSource] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/components/TileTransformPicker.tsx', import.meta.url), 'utf8'),
    ]);
    expect(canvasSource).toContain('const constrainedTileTransforms = constrainTileTransformFlags(tileTransforms');
    expect(canvasSource).toContain("const activeTileTransforms = tool === 'tile-object' ? { ...tileTransforms } : constrainedTileTransforms");
    expect(canvasSource).toContain('transforms: activeTileTransforms');
    expect(canvasSource).toContain('gid: gesturePlan.rawGid');
    expect(canvasSource).toContain('pendingMapTilePlan!.rawGid');
    expect(canvasSource).toContain('pendingMapTilePlan!.transforms');
    expect(canvasSource).toContain('<TileTransformPicker');
    expect(canvasSource).toContain('value={activeTileTransforms}');
    expect(canvasSource).toContain("Toggle Tiled's diagonal-first flag when the resulting transform is permitted");
    expect(canvasSource).toContain('tileTransformFlagsAllowed(tileTransformCandidates.hFlip');
    expect(canvasSource).toContain('tileTransformFlagsAllowed(tileTransformCandidates.vFlip');
    expect(canvasSource).toContain('tileTransformFlagsAllowed(tileTransformCandidates.diagonal');
    expect(canvasSource).not.toMatch(/encodeTiledGid\([^\n]+, tileTransforms\)/);
    expect(pickerSource).toContain('TILE_TRANSFORM_PREVIEW_SIDE = 32');
    expect(pickerSource).toContain('tilesetHasLocalId(tileset, tileId)');
    expect(pickerSource).toContain('tilesetTileSourceRect(tileset, tileId, sprite)');
    expect(pickerSource).toContain('tileTransformPreviewGeometry(sourceRect.width, sourceRect.height, choice.flags');
    expect(pickerSource).toContain('source.width = geometry.sampleWidth');
    expect(pickerSource).toContain('geometry.transform.a');
    expect(pickerSource).toContain('geometry.drawWidth');
    expect(pickerSource).toContain('context.imageSmoothingEnabled = false');
    expect(pickerSource).toContain('source.width = 1');
    expect(pickerSource).toContain('onClick={() => onSelect({ ...choice.flags })}');
    expect(pickerSource).toContain('onSelect={onChange}');
    expect(pickerSource).toContain('onClick={onClose}');
  });

  it('keeps literal project truth bounded to the earned presentation checkpoint', async () => {
    const [changelog, architecture, tracker, testing] = await Promise.all([
      readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/FEATURE_TRACKER.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/TESTING.md', import.meta.url), 'utf8'),
    ]);
    expect(changelog).toContain('complete eight-choice tile-transform picker legible');
    expect(architecture).toContain('hook-free tile-transform choice control');
    expect(tracker).toContain('bounded source/headless UX-01/MAP-12 checkpoint');
    expect(testing).toContain('Current source/headless tile-transform-picker presentation checkpoint');
    for (const source of [changelog, architecture, tracker, testing]) {
      expect(source).toContain('32×32');
      expect(source).toContain('packaged/native');
    }
  });
});
