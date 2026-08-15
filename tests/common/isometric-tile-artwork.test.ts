import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset } from '@aidraw/core';

import {
  isometricMapTileArtworkEnvelope,
  isometricTileArtworkEnvelope,
  isometricTileArtworkIntersects,
  isometricTileArtworkPlacement,
} from '../../src/common/isometric-tile-artwork';

describe('isometric native tile artwork geometry', () => {
  it('anchors native artwork to the projected cell left edge and bottom baseline', () => {
    expect(isometricTileArtworkPlacement(
      { x: 10, y: 20, width: 4, height: 2 },
      4,
      2,
      { width: 6, height: 8 },
      {},
      { x: 2, y: -1 },
    )).toEqual({
      centerX: 15,
      centerY: 17,
      width: 6,
      height: 8,
      transform: { a: 1, b: 0, c: 0, d: 1 },
      bounds: { left: 12, top: 13, right: 18, bottom: 21 },
    });
  });

  it('compensates every diagonal-first non-square transform around the same left/bottom anchor', () => {
    const cell = { x: 10, y: 20, width: 4, height: 2 };
    const ordinaryBounds = { left: 12, top: 13, right: 18, bottom: 21 };
    const diagonalBounds = { left: 12, top: 15, right: 20, bottom: 21 };
    const cases = [
      [{}, { a: 1, b: 0, c: 0, d: 1 }, ordinaryBounds],
      [{ hFlip: true }, { a: -1, b: 0, c: 0, d: 1 }, ordinaryBounds],
      [{ vFlip: true }, { a: 1, b: 0, c: 0, d: -1 }, ordinaryBounds],
      [{ hFlip: true, vFlip: true }, { a: -1, b: 0, c: 0, d: -1 }, ordinaryBounds],
      [{ diagonal: true }, { a: 0, b: -1, c: -1, d: 0 }, diagonalBounds],
      [{ diagonal: true, hFlip: true }, { a: 0, b: -1, c: 1, d: 0 }, diagonalBounds],
      [{ diagonal: true, vFlip: true }, { a: 0, b: 1, c: -1, d: 0 }, diagonalBounds],
      [{ diagonal: true, hFlip: true, vFlip: true }, { a: 0, b: 1, c: 1, d: 0 }, diagonalBounds],
    ] as const;

    for (const [transforms, transform, bounds] of cases) {
      const placement = isometricTileArtworkPlacement(cell, 4, 2, { width: 6, height: 8 }, transforms, { x: 2, y: -1 });
      expect(placement.transform).toEqual(transform);
      expect(placement.bounds).toEqual(bounds);
      expect(placement.centerX).toBe((bounds.left + bounds.right) / 2);
      expect(placement.centerY).toBe((bounds.top + bounds.bottom) / 2);
    }
  });

  it('keeps equal-size zero-offset placement byte-compatible for ordinary and H/V cases', () => {
    const cell = { x: 0.25, y: -1.75, width: 7.3, height: 4.1 };
    const placement = isometricTileArtworkPlacement(cell, 16, 8, { width: 16, height: 8 }, { hFlip: true, vFlip: true });
    expect(placement).toEqual({
      centerX: cell.x + cell.width / 2,
      centerY: cell.y + cell.height / 2,
      width: cell.width,
      height: cell.height,
      transform: { a: -1, b: 0, c: 0, d: -1 },
      bounds: { left: cell.x, top: cell.y, right: cell.x + cell.width, bottom: cell.y + cell.height },
    });
  });

  it('unions nominal fallback, native dimensions, offsets, and diagonal swaps', () => {
    expect(isometricTileArtworkEnvelope(4, 2, [
      { width: 6, height: 8, offset: { x: 2, y: -1 } },
    ])).toEqual({ left: 0, top: -7, right: 10, bottom: 2 });
    expect(isometricTileArtworkEnvelope(4, 2, [])).toEqual({ left: 0, top: 0, right: 4, bottom: 2 });
  });

  it('admits only attached renderable sprite-backed tilesets into the map envelope', () => {
    const document = createPixelDocument('project', 'Isometric envelope'); document.assetIds = []; document.pixelAssets = {};
    const source = createPixelSprite('Renderable source', 6, 8);
    const renderable = createPixelTileset('Renderable tiles', source.id, 6, 8, 1, 1); renderable.tileOffset = { x: 2, y: -1 };
    const missing = createPixelTileset('Missing source', 'missing-source', 100, 100, 1, 1); missing.tileOffset = { x: -1_000, y: 1_000 };
    const map = createPixelTilemap('Isometric map'); map.orientation = 'isometric'; map.tileWidth = 4; map.tileHeight = 2; map.tilesetIds = [renderable.id, missing.id];
    document.pixelAssets = { [source.id]: source, [renderable.id]: renderable, [missing.id]: missing, [map.id]: map };

    expect(isometricMapTileArtworkEnvelope(document, map)).toEqual({ left: 0, top: -7, right: 10, bottom: 2 });
    map.tilesetIds = [missing.id];
    expect(isometricMapTileArtworkEnvelope(document, map)).toEqual({ left: 0, top: 0, right: 4, bottom: 2 });
  });

  it('uses strict raster intersection and rejects unsafe geometry', () => {
    const bounds = { left: 12, top: 13, right: 18, bottom: 21 };
    expect(isometricTileArtworkIntersects(bounds, { x: 17, y: 20, width: 1, height: 1 })).toBe(true);
    expect(isometricTileArtworkIntersects(bounds, { x: 18, y: 20, width: 1, height: 1 })).toBe(false);
    expect(() => isometricTileArtworkPlacement({ x: 0, y: 0, width: 4, height: 2 }, 4, 2, { width: 0, height: 2 })).toThrow(/artwork width/);
    expect(() => isometricTileArtworkPlacement({ x: 0, y: 0, width: 4, height: 2 }, 4, 2, { width: 4, height: 2 }, {}, { x: Number.NaN, y: 0 })).toThrow(/offset/);
  });
});
