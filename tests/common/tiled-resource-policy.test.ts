import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  createPixelTilemap,
  nowIso,
  type CollisionShape,
  type TilemapChunk,
  type TilemapLayer,
} from '@aidraw/core';
import {
  MAX_TILED_DEPTH,
  MAX_TILED_LAYER_CELLS,
  MAX_TILED_LAYERS,
  MAX_TILED_OBJECTS,
  MAX_TILED_TOTAL_CELLS,
  assertTiledExportResourceBudget,
} from '../../src/common/tiled-resource-policy';

type TileLayer = TilemapLayer & { type: 'tile'; chunks: NonNullable<TilemapLayer['chunks']> };
type ObjectLayer = TilemapLayer & { type: 'object'; objects: CollisionShape[] };
type GroupLayer = TilemapLayer & { type: 'group'; childIds: string[] };

function tileLayer(map: ReturnType<typeof createPixelTilemap>): TileLayer {
  const layer = map.layers[map.layerIds[0]];
  if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
  return layer as TileLayer;
}

function objectLayer(id: string, objects: CollisionShape[] = []): ObjectLayer {
  const timestamp = nowIso();
  return {
    id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    type: 'object', visible: true, locked: false, opacity: 1, objects, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
  };
}

function groupLayer(id: string, childIds: string[]): GroupLayer {
  const timestamp = nowIso();
  return {
    id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    type: 'group', visible: true, locked: false, opacity: 1, childIds, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
  };
}

describe('Tiled export resource policy', () => {
  it('admits exact finite per-layer and aggregate cell boundaries', () => {
    const map = createPixelTilemap('Finite Tiled boundary');
    map.width = 2_048; map.height = 2_048;
    const first = tileLayer(map);
    expect(assertTiledExportResourceBudget(map)).toEqual({ layers: 1, maximumDepth: 0, tileCells: MAX_TILED_LAYER_CELLS, objects: 0 });

    for (let index = 1; index < 4; index += 1) {
      const id = `finite-layer-${index}`;
      map.layers[id] = { ...structuredClone(first), id, name: id, chunks: {} };
      map.layerIds.push(id);
    }
    expect(assertTiledExportResourceBudget(map).tileCells).toBe(MAX_TILED_TOTAL_CELLS);

    const fifthId = 'finite-layer-4';
    map.layers[fifthId] = { ...structuredClone(first), id: fifthId, name: fifthId, chunks: {} };
    map.layerIds.push(fifthId);
    expect(() => assertTiledExportResourceBudget(map)).toThrow('16,777,216-cell aggregate safety limit');

    map.layerIds = [first.id]; map.width = 2_049;
    expect(() => assertTiledExportResourceBudget(map)).toThrow('4,194,304-cell safety limit');
  });

  it('counts sparse infinite chunk payload geometry without deriving visual bounds', () => {
    const map = createPixelTilemap('Infinite Tiled boundary'); map.infinite = true;
    const layer = tileLayer(map); layer.chunks = {};
    for (let index = 0; index < MAX_TILED_LAYER_CELLS / (32 * 32); index += 1) {
      const chunk: TilemapChunk = { x: index * 32, y: 0, width: 32, height: 32, data: '' };
      layer.chunks[`${index},0`] = chunk;
    }
    expect(assertTiledExportResourceBudget(map)).toEqual({ layers: 1, maximumDepth: 0, tileCells: MAX_TILED_LAYER_CELLS, objects: 0 });
    layer.chunks['4096,0'] = { x: 4_096 * 32, y: 0, width: 32, height: 32, data: '' };
    expect(() => assertTiledExportResourceBudget(map)).toThrow('4,194,304-cell safety limit');
  });

  it('matches the established layer, nesting, cycle, and object ceilings', () => {
    const broad = createPixelTilemap('Broad Tiled boundary'); broad.layers = {}; broad.layerIds = [];
    for (let index = 0; index < MAX_TILED_LAYERS; index += 1) {
      const id = `object-layer-${index}`; broad.layers[id] = objectLayer(id); broad.layerIds.push(id);
    }
    expect(assertTiledExportResourceBudget(broad).layers).toBe(MAX_TILED_LAYERS);
    const excessiveId = `object-layer-${MAX_TILED_LAYERS}`; broad.layers[excessiveId] = objectLayer(excessiveId); broad.layerIds.push(excessiveId);
    expect(() => assertTiledExportResourceBudget(broad)).toThrow('4,096-layer safety limit');

    const deep = createPixelTilemap('Deep Tiled boundary'); const leaf = tileLayer(deep); deep.layers = { [leaf.id]: leaf };
    let childId = leaf.id;
    for (let depth = MAX_TILED_DEPTH - 1; depth >= 0; depth -= 1) {
      const id = `group-${depth}`; deep.layers[id] = groupLayer(id, [childId]); childId = id;
    }
    deep.layerIds = [childId];
    expect(assertTiledExportResourceBudget(deep).maximumDepth).toBe(MAX_TILED_DEPTH);
    const outerId = 'group-outer'; deep.layers[outerId] = groupLayer(outerId, [childId]); deep.layerIds = [outerId];
    expect(() => assertTiledExportResourceBudget(deep)).toThrow('64-level safety limit');
    deep.layers[outerId] = groupLayer(outerId, [outerId]);
    expect(() => assertTiledExportResourceBudget(deep)).toThrow('contains a cycle');

    const shape: CollisionShape = { id: 'shape', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, properties: {} };
    const objects = createPixelTilemap('Object Tiled boundary'); const objectId = 'objects'; objects.layers = { [objectId]: objectLayer(objectId, Array(MAX_TILED_OBJECTS).fill(shape)) }; objects.layerIds = [objectId];
    expect(assertTiledExportResourceBudget(objects).objects).toBe(MAX_TILED_OBJECTS);
    objects.layers[objectId] = objectLayer(objectId, Array(MAX_TILED_OBJECTS + 1).fill(shape));
    expect(() => assertTiledExportResourceBudget(objects)).toThrow('100,000-object safety limit');
  });
});
