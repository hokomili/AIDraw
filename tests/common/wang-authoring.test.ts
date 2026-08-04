import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelTileset } from '@aidraw/core';
import { assignWangTile, deleteWangColor, deleteWangSet, upsertWangColor, upsertWangSet } from '../../src/common/wang-authoring';

function fixture() {
  const document = createPixelDocument('sprite');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  return createPixelTileset('Terrain', sprite.id, 16, 16, 4, 4);
}

describe('Wang authoring', () => {
  it('authors sets, colors, assignments, and clears deleted color references', () => {
    let tileset = fixture();
    tileset = upsertWangSet(tileset, { id: 'terrain', name: 'Terrain', type: 'mixed', colors: [], tiles: [] });
    tileset = upsertWangColor(tileset, 'terrain', { id: 1, name: 'Grass', color: '#55aa44', tileId: 0, probability: 1 });
    tileset = assignWangTile(tileset, 'terrain', { tileId: 3, wangId: [1, 0, 1, 0, 1, 0, 1, 0] });
    expect(tileset.wangSets[0].tiles[0].wangId).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    tileset = deleteWangColor(tileset, 'terrain', 1);
    expect(tileset.wangSets[0]).toMatchObject({ colors: [], tiles: [] });
    expect(deleteWangSet(tileset, 'terrain').wangSets).toEqual([]);
  });

  it('rejects duplicate colors and missing slot references', () => {
    const tileset = fixture();
    expect(() => upsertWangSet(tileset, { id: 'bad', name: 'Bad', type: 'mixed', colors: [{ id: 1, name: 'A', color: '#ffffff', tileId: 0, probability: 1 }, { id: 1, name: 'B', color: '#000000', tileId: 1, probability: 1 }], tiles: [] })).toThrow(/duplicated/);
    const valid = upsertWangSet(tileset, { id: 'valid', name: 'Valid', type: 'edge', colors: [], tiles: [] });
    expect(() => assignWangTile(valid, 'valid', { tileId: 0, wangId: [9, 0, 0, 0, 0, 0, 0, 0] })).toThrow(/missing color/);
  });
});
