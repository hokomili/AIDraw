import { describe, expect, it } from 'vitest';
import { matchingWangTiles, selectWangTile, type WangSet } from '@aidraw/core';

const terrain: WangSet = {
  id: 'wang-grass', name: 'Grass', type: 'mixed',
  colors: [{ id: 1, name: 'Grass', color: '#65a85b', tileId: 0, probability: 1 }],
  tiles: [
    { tileId: 0, wangId: [1, 1, 1, 1, 1, 1, 1, 1] },
    { tileId: 1, wangId: [1, 0, 1, 0, 1, 0, 1, 0] },
    { tileId: 2, wangId: [0, 0, 0, 0, 0, 0, 0, 0] },
  ],
};

describe('Wang terrain selection', () => {
  it('matches edge and corner constraints and selects deterministically', () => {
    const matches = matchingWangTiles(terrain, { top: 1, topRight: 1, right: 1 });
    expect(matches.map((tile) => tile.tileId)).toEqual([0]);
    expect(selectWangTile(terrain, { top: 1, right: 1 }, () => 0)?.tileId).toBe(0);
  });
});
