import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, MAX_WANG_TERRAIN_COORDINATE, MAX_WANG_TERRAIN_STROKE_POINTS, applyTransaction, createId, createPixelDocument, matchingWangTiles, nowIso, paintWangTerrain, planWangTerrainStroke, readTileAt, selectWangTile, type WangSet } from '@aidraw/core';

const terrain: WangSet = {
  id: 'wang-grass', name: 'Grass', type: 'mixed',
  colors: [{ id: 1, name: 'Grass', color: '#65a85b', tileId: 0, probability: 1 }],
  tiles: [
    { tileId: 0, wangId: [1, 1, 1, 1, 1, 1, 1, 1] },
    { tileId: 1, wangId: [1, 0, 1, 0, 1, 0, 1, 0] },
    { tileId: 2, wangId: [0, 0, 0, 0, 0, 0, 0, 0] },
  ],
};

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

const wangIdFromMask = (mask: number): WangSet['tiles'][number]['wangId'] => (
  Array.from({ length: 8 }, (_, slot) => (mask & (1 << slot)) === 0 ? 0 : 1) as WangSet['tiles'][number]['wangId']
);

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

  it('plans a deduplicated drag against queued repairs and returns one sorted change set', () => {
    const plan = planWangTerrainStroke(transitions, [{ x: 4, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }], 1, () => 0, { random: () => 0 });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.strokePointCount).toBe(2);
    expect(plan.changes).toHaveLength(12);
    expect(plan.targetChangeCount).toBe(2);
    expect(plan.repairChangeCount).toBe(10);
    expect(plan.affectedCellCount).toBe(12);
    expect(plan.changes).toEqual([...plan.changes].sort((left, right) => left.y - right.y || left.x - right.x));
    expect(new Set(plan.changes.map((change) => `${change.x},${change.y}`)).size).toBe(plan.changes.length);
  });

  it('omits every tile that already matches the completed stroke', () => {
    const first = planWangTerrainStroke(transitions, [{ x: 4, y: 5 }, { x: 5, y: 5 }], 1, () => 0, { random: () => 0 });
    if (first.status !== 'ready') throw new Error('Expected ready terrain plan');
    const placed = new Map(first.changes.map((change) => [`${change.x},${change.y}`, change.tileId]));
    const repeated = planWangTerrainStroke(transitions, [{ x: 4, y: 5 }, { x: 5, y: 5 }], 1, (x, y) => placed.get(`${x},${y}`) ?? 0, { random: () => 0 });
    expect(repeated).toMatchObject({ status: 'ready', changes: [], targetChangeCount: 0, repairChangeCount: 0, strokePointCount: 2 });
  });

  it('commits a ready drag as one revision-checked operation with an exact inverse', () => {
    const source = createPixelDocument('tilemap', 'Terrain stroke');
    const map = source.pixelAssets[source.activeAssetId];
    if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const layer = map.layers[map.layerIds[0]];
    if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const plan = planWangTerrainStroke(transitions, [{ x: 4, y: 5 }, { x: 5, y: 5 }], 1, () => 0, { random: () => 0 });
    if (plan.status !== 'ready') throw new Error('Expected ready terrain plan');
    const applied = applyTransaction(source, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: source.id, actor: HUMAN_ACTOR,
      label: 'Paint Wang terrain', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: plan.changes.map(({ x, y, tileId }) => ({ x, y, gid: tileId + 1 })), expectedRevision: layer.revision }],
    });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const appliedMap = applied.document.pixelAssets[map.id];
    if (appliedMap.type !== 'tilemap') throw new Error('Expected tilemap');
    const appliedLayer = appliedMap.layers[layer.id];
    if (appliedLayer.type !== 'tile' || !appliedLayer.chunks) throw new Error('Expected tile layer');
    expect(applied.document.revision).toBe(1);
    expect(applied.document.activity).toHaveLength(1);
    expect(readTileAt(appliedLayer.chunks, 4, 5)).toBe(2);
    expect(readTileAt(appliedLayer.chunks, 6, 5)).toBe(5);

    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredMap = restored.pixelAssets[map.id];
    if (restoredMap.type !== 'tilemap') throw new Error('Expected tilemap');
    const restoredLayer = restoredMap.layers[layer.id];
    if (restoredLayer.type !== 'tile' || !restoredLayer.chunks) throw new Error('Expected tile layer');
    expect(readTileAt(restoredLayer.chunks, 4, 5)).toBe(0);
    expect(readTileAt(restoredLayer.chunks, 6, 5)).toBe(0);
  });

  it('returns no partial changes and exact diagnostics when an in-map transition is missing', () => {
    const initial = new Map<string, number>([['2,2', 0]]);
    const plan = planWangTerrainStroke(
      { ...terrain, tiles: transitions.tiles.slice(0, 2) },
      [{ x: 2, y: 2 }],
      1,
      (x, y) => initial.get(`${x},${y}`) ?? 0,
      { random: () => 0 },
    );
    expect(plan).toMatchObject({ status: 'unmatched', changes: [], strokePointCount: 1, affectedCellCount: 9, provisionalChangeCount: 1 });
    if (plan.status !== 'unmatched') return;
    expect(plan.unmatched.map(({ x, y }) => [x, y])).toEqual([
      [1, 1], [2, 1], [3, 1],
      [1, 2], [3, 2],
      [1, 3], [2, 3], [3, 3],
    ]);
    expect(plan.unmatched[1]?.wangId).toEqual([0, 0, 0, 1, 1, 1, 0, 0]);
    expect(initial).toEqual(new Map([['2,2', 0]]));
  });

  it('lets later stroke cells resolve an earlier gap and ignores nonexistent finite-map neighbors', () => {
    const completeOrEmpty: WangSet = { ...terrain, tiles: transitions.tiles.slice(0, 2) };
    const contains = (x: number, y: number) => y === 0 && x >= 0 && x < 2;
    const plan = planWangTerrainStroke(completeOrEmpty, [{ x: 0, y: 0 }, { x: 1, y: 0 }], 1, () => 0, { contains, random: () => 0 });
    expect(plan).toEqual({
      status: 'ready',
      changes: [{ x: 0, y: 0, tileId: 1 }, { x: 1, y: 0, tileId: 1 }],
      targetChangeCount: 2,
      repairChangeCount: 0,
      strokePointCount: 2,
      affectedCellCount: 2,
    });
  });

  it('retains an unmatched desired boundary until a later diagonal repair satisfies its union', () => {
    const everySignatureExceptLeftOnly: WangSet = {
      ...terrain,
      tiles: Array.from({ length: 256 }, (_, mask) => ({ tileId: mask, wangId: wangIdFromMask(mask) }))
        .filter((tile) => tile.tileId !== 224),
    };
    const contains = (x: number, y: number) => x >= 0 && x < 2 && y >= 0 && y < 2;
    const firstPoint = planWangTerrainStroke(everySignatureExceptLeftOnly, [{ x: 0, y: 0 }], 1, () => 0, { contains, random: () => 0 });
    expect(firstPoint.status).toBe('unmatched');
    if (firstPoint.status !== 'unmatched') return;
    expect(firstPoint.unmatched.find(({ x, y }) => x === 1 && y === 0)?.wangId).toEqual(wangIdFromMask(224));

    const plan = planWangTerrainStroke(
      everySignatureExceptLeftOnly,
      [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      1,
      () => 0,
      { contains, random: () => 0 },
    );
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.changes.find(({ x, y }) => x === 1 && y === 0)).toEqual({ x: 1, y: 0, tileId: 248 });
    expect(plan.changes).not.toContainEqual({ x: 1, y: 0, tileId: 56 });
  });

  it('fails closed on out-of-map, unsafe, or oversized strokes', () => {
    expect(() => planWangTerrainStroke(transitions, [{ x: -1, y: 0 }], 1, () => 0, { contains: (x, y) => x >= 0 && y >= 0 })).toThrow('outside the map');
    expect(() => planWangTerrainStroke(transitions, [{ x: 0.5, y: 0 }], 1, () => 0)).toThrow('safe integers');
    expect(() => planWangTerrainStroke(transitions, [{ x: MAX_WANG_TERRAIN_COORDINATE, y: 0 }], 1, () => 0)).toThrow('16,777,216');
    expect(() => planWangTerrainStroke(transitions, Array.from({ length: MAX_WANG_TERRAIN_STROKE_POINTS + 1 }, () => ({ x: 0, y: 0 })), 1, () => 0)).toThrow('65,536 points');
  });
});
