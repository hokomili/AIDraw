import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';
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

  it('authors exact sparse image-collection representatives without densifying gaps', () => {
    const source0 = createPixelSprite('Zero', 8, 8);
    const source3 = createPixelSprite('Three', 12, 7);
    let tileset = createPixelTileset('Sparse terrain', source0.id, 12, 8, 1, 1);
    delete tileset.spriteAssetId; tileset.columns = 2; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0;
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    tileset = upsertWangSet(tileset, {
      id: 'sparse', name: 'Sparse', type: 'mixed',
      colors: [{ id: 1, name: 'Ground', color: '#55aa44', tileId: 3, probability: 1 }],
      tiles: [{ tileId: 0, wangId: [0, 0, 0, 0, 0, 0, 0, 0] }],
    });
    tileset = assignWangTile(tileset, 'sparse', { tileId: 3, wangId: [1, 1, 1, 1, 1, 1, 1, 1] });
    expect(tileset.wangSets[0]).toMatchObject({ colors: [{ tileId: 3 }], tiles: [{ tileId: 0 }, { tileId: 3 }] });
    expect(Object.keys(tileset.tiles)).toEqual(['0', '3']);
    expect(() => assignWangTile(tileset, 'sparse', { tileId: 2, wangId: [1, 1, 1, 1, 1, 1, 1, 1] })).toThrow('sparse gap');
    expect(() => upsertWangColor(tileset, 'sparse', { id: 2, name: 'Gap', color: '#333333', tileId: 2, probability: 1 })).toThrow('sparse gap');
  });
});
