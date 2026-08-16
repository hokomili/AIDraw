import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import { TileAnimationEditor } from '../../src/renderer/components/TileAnimationEditor';

function fixture() {
  const document = createPixelDocument('project', 'Collection inspector');
  const tall = createPixelSprite('Tall tile', 7, 13);
  const wide = createPixelSprite('Wide tile', 19, 5);
  const tileset = createPixelTileset('Sparse collection', tall.id, 7, 13, 1, 1);
  tileset.spriteAssetId = undefined; tileset.columns = 2; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
  tileset.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: tall.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: wide.id, probability: 0.5, animation: [], collisions: [], properties: {} },
  };
  document.assetIds = [tall.id, wide.id, tileset.id]; document.pixelAssets = { [tall.id]: tall, [wide.id]: wide, [tileset.id]: tileset };
  return { document, tileset };
}

afterEach(() => vi.unstubAllGlobals());

describe('image-collection authoring surface', () => {
  it('renders the selected sparse tile at its own dimensions and never offers gap IDs', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { document, tileset } = fixture();
    const staticMarkup = renderToStaticMarkup(createElement(TileAnimationEditor, {
      document, tileset, tile: tileset.tiles[3], tileCount: 2, availableTileIds: [0, 3], onChange: () => undefined,
    }));
    expect(staticMarkup).toContain('Tile 3 · 19 × 5px');
    const animated = { ...tileset.tiles[3], animation: [{ tileId: 3, durationMs: 120 }] };
    const animationMarkup = renderToStaticMarkup(createElement(TileAnimationEditor, {
      document, tileset, tile: animated, tileCount: 2, availableTileIds: [0, 3], onChange: () => undefined,
    }));
    expect(animationMarkup).toContain('title="Existing collection tile ID"');
    expect(animationMarkup).toContain('<option value="0">0</option>');
    expect(animationMarkup).toContain('<option value="3" selected="">3</option>');
    expect(animationMarkup).not.toMatch(/<option value="[12]"/u);
  });

  it('wires sparse selection, metadata-only replacement, exact sources, and the guarded canonical transaction', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('const collectionTileIds = imageCollection ? imageCollectionTileIds(tileset) : undefined;');
    expect(app).toContain('displayedTileIds.map((id)');
    expect(app).toContain('replaceImageCollectionTileMetadata(tileset, effectiveSelectedTileId, patch)');
    expect(app).toContain('imageCollectionAuthoringGuardError(document, active, tileset.id)');
    expect(app).toContain('imageCollectionSourceDependencyGuards(document, tileset)');
    expect(app).toContain('...(expectedSpriteDependencies ? { expectedSpriteDependencies } : {})');
    expect(app).toContain('imageCollection ? document.id : undefined');
    expect(app).toContain('availableTileIds={collectionTileIds}');
    expect(app).toContain('sprite={selectedSource?.sprite');
    expect(app).toContain('width={selectedSource?.rect.width ?? tileset.tileWidth}');
    expect(app).toContain('{!imageCollection && <>');
    expect(app).toContain('Apply drawing offset');
    expect(app).toContain('Per-tile sources and sparse IDs remain fixed.');
  });
});
