import { describe, expect, it } from 'vitest';
import { matchingWangTiles, paintWangTerrain, selectWangTile, type WangSet } from '@aidraw/core';

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

  it('treats zero as an exact empty-terrain constraint', () => {
    expect(matchingWangTiles(terrain, { top: 0 }).map((tile) => tile.tileId)).toEqual([2]);
  });

  it('repairs all eight neighboring Wang boundaries while painting and erasing', () => {
    const transitions: WangSet = {
      ...terrain,
      tiles: [
        { tileId: 0, wangId: [0, 0, 0, 0, 0, 0, 0, 0] },
        { tileId: 1, wangId: [1, 1, 1, 1, 1, 1, 1, 1] },
        { tileId: 2, wangId: [0, 0, 0, 1, 1, 1, 0, 0] },
        { tileId: 3, wangId: [0, 0, 0, 0, 0, 1, 0, 0] },
        { tileId: 4, wangId: [0, 0, 0, 0, 0, 1, 1, 1] },
        { tileId: 5, wangId: [0, 0, 0, 0, 0, 0, 0, 1] },
        { tileId: 6, wangId: [1, 1, 0, 0, 0, 0, 0, 1] },
        { tileId: 7, wangId: [0, 1, 0, 0, 0, 0, 0, 0] },
        { tileId: 8, wangId: [0, 1, 1, 1, 0, 0, 0, 0] },
        { tileId: 9, wangId: [0, 0, 0, 1, 0, 0, 0, 0] },
      ],
    };
    const painted = paintWangTerrain(transitions, 4, 5, 1, () => 0, false, () => 0);
    expect(painted.unmatched).toEqual([]);
    expect(painted.changes).toHaveLength(9);
    expect(painted.changes).toEqual(expect.arrayContaining([{ x: 4, y: 5, tileId: 1 }, { x: 4, y: 4, tileId: 2 }, { x: 5, y: 5, tileId: 4 }]));
    const placed = new Map(painted.changes.map((change) => [change.x + ',' + change.y, change.tileId]));
    const erased = paintWangTerrain(transitions, 4, 5, 1, (x, y) => placed.get(x + ',' + y), true, () => 0);
    expect(erased.unmatched).toEqual([]);
    expect(erased.changes).toHaveLength(9);
    expect(erased.changes.every((change) => change.tileId === 0)).toBe(true);
  });
});
