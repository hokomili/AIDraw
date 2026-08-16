import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPixelDocument, createPixelTileset, type PixelSprite } from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import { TileTransformPicker } from '../../src/renderer/components/TileTransformPicker';

function fixture(tileWidth = 8, tileHeight = 8) {
  const document = createPixelDocument('sprite', 'Transform preview');
  const sprite = document.pixelAssets[document.activeAssetId] as PixelSprite;
  const tileset = createPixelTileset('Square labels', sprite.id, tileWidth, tileHeight, 2, 2);
  return { document, sprite, tileset };
}

describe('tile transform picker', () => {
  it('renders all eight exact choices with permissions and bounded-copy text', () => {
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
    expect(markup).toContain('Diagonal first, then H/V');
    expect(markup.match(/aria-label="Use [^"]* tile transform"/g)).toHaveLength(8);
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="Use diagonal + horizontal tile transform"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Preview aspect-fits the complete transformed footprint inside 32 × 32px and never materializes the complete source sprite.');
  });

  it('presents every permitted rectangular state without changing labels or accessibility', () => {
    const { document, sprite, tileset } = fixture(16, 8);
    const markup = renderToStaticMarkup(createElement(TileTransformPicker, {
      document,
      sprite,
      tileset,
      tileId: 0,
      value: { hFlip: false, vFlip: false, diagonal: false },
      onChange: () => undefined,
      onClose: () => undefined,
    }));
    expect(markup).toContain('Tile 0 · 16 × 8px');
    expect(markup.match(/aria-label="Use [^"]* tile transform"/g)).toHaveLength(8);
    expect(markup).toContain('aria-label="Use original tile transform"');
    expect(markup).toContain('aria-label="Use diagonal + vertical tile transform"');
    expect(markup).not.toContain('intentionally limited to square tiles');
  });

  it('presents one exact sparse image-collection source at its own dimensions', () => {
    const { document, sprite, tileset } = fixture(16, 8);
    tileset.spriteAssetId = undefined; tileset.columns = 0; tileset.rows = 0; tileset.wangSets = [];
    tileset.tiles = { 7: { id: 7, sourceX: 0, sourceY: 0, imageAssetId: sprite.id, probability: 1, animation: [], collisions: [], properties: {} } };
    const markup = renderToStaticMarkup(createElement(TileTransformPicker, {
      document, sprite, tileset, tileId: 7, value: { hFlip: false, vFlip: false, diagonal: true }, onChange: () => undefined, onClose: () => undefined,
    }));
    expect(markup).toContain(`Tile 7 · ${sprite.width} × ${sprite.height}px`);
    expect(markup.match(/aria-label="Use [^"]* tile transform"/g)).toHaveLength(8);
    expect(markup).toContain('aria-label="Use diagonal tile transform"');
  });

  it('uses constrained flags for stamps/paint while tile-object admission refuses stale disallowed flags', async () => {
    const [canvasSource, pickerSource] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/components/TileTransformPicker.tsx', import.meta.url), 'utf8'),
    ]);
    expect(canvasSource).toContain('const constrainedTileTransforms = constrainTileTransformFlags(tileTransforms');
    expect(canvasSource).toContain("const activeTileTransforms = tool === 'tile-object' ? { ...tileTransforms } : constrainedTileTransforms");
    expect(canvasSource).toContain('encodeTiledGid((terrainTileset?.type');
    expect(canvasSource).toContain('selectedTileId), activeTileTransforms)');
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
  });
});
