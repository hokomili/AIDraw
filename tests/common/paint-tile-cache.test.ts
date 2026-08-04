import { describe, expect, it } from 'vitest';
import { createIllustrationDocument, type DocumentAsset } from '@aidraw/core';
import { paintTileCachePlan, parsePaintTileKey } from '../../src/common/paint-tile-cache';

describe('paint tile cache planning', () => {
  it('accepts only complete, bounded PNG tile references', () => {
    const document = createIllustrationDocument('Cache plan');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'paint');
    if (!layer || layer.type !== 'paint') throw new Error('Paint layer missing');
    const asset: DocumentAsset = { id: 'tile', name: 'Tile', mimeType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64), source: 'rendered', data: 'AA==' };
    layer.tileAssetIds = { '0,0': asset.id };
    layer.tileCache = { version: 1, strokeCount: 0, strokesSha256: 'b'.repeat(64) };
    expect(paintTileCachePlan(layer, { [asset.id]: asset })).toMatchObject({ strokeCount: 0, entries: [{ tileX: 0, tileY: 0, assetId: asset.id }] });
    expect(paintTileCachePlan(layer, {})).toBeUndefined();
    layer.tileAssetIds = { '../0': asset.id };
    expect(paintTileCachePlan(layer, { [asset.id]: asset })).toBeUndefined();
    expect(parsePaintTileKey('-2,3')).toEqual({ tileX: -2, tileY: 3 });
  });
});
