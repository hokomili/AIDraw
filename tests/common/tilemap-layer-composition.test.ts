import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, createPixelTilemap, nowIso, type TilemapLayer } from '@aidraw/core';
import { composedVisibleTilemapLayers, tilemapLayerScreenTranslation } from '../../src/common/tilemap-layer-composition';

function layer(id: string, type: TilemapLayer['type'], patch: Partial<TilemapLayer> = {}): TilemapLayer {
  const timestamp = nowIso();
  return {
    id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
    type, visible: true, locked: false, opacity: 1, offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1,
    ...(type === 'group' ? { childIds: [] } : type === 'tile' ? { chunks: {} } : { objects: [] }),
    ...patch,
  };
}

describe('tilemap layer composition', () => {
  it('adds nested offsets while multiplying opacity and parallax in painter order', () => {
    const map = createPixelTilemap('Composed layers');
    const tile = layer('tile', 'tile', { parentId: 'inner', opacity: 0.5, offsetX: 7, offsetY: -2, parallaxX: 0.5, parallaxY: 2 });
    const object = layer('object', 'object', { parentId: 'outer', offsetX: -4, offsetY: 6 });
    const inner = layer('inner', 'group', { parentId: 'outer', childIds: [tile.id], opacity: 0.8, offsetX: -3, offsetY: 5, parallaxX: 2, parallaxY: 0.25 });
    const outer = layer('outer', 'group', { childIds: [inner.id, object.id], opacity: 0.5, offsetX: 10, offsetY: -8, parallaxX: 0.5, parallaxY: 4 });
    map.layerIds = [outer.id]; map.layers = { [outer.id]: outer, [inner.id]: inner, [tile.id]: tile, [object.id]: object };

    const composed = composedVisibleTilemapLayers(map);
    expect(composed.map((entry) => entry.layer.id)).toEqual(['tile', 'object']);
    expect(composed[0]).toMatchObject({ opacity: 0.2, offsetX: 14, offsetY: -5, parallaxX: 0.5, parallaxY: 2 });
    expect(composed[1]).toMatchObject({ opacity: 0.5, offsetX: 6, offsetY: -2, parallaxX: 0.5, parallaxY: 4 });
    expect(map.layers.tile).toMatchObject({ offsetX: 7, offsetY: -2, parallaxX: 0.5, parallaxY: 2 });
  });

  it('retains ancestor composition for an exact leaf or group-only render and excludes hidden branches', () => {
    const map = createPixelTilemap('Selected layers');
    const first = layer('first', 'tile', { parentId: 'group', offsetX: 2 });
    const second = layer('second', 'object', { parentId: 'group', offsetY: 3 });
    const group = layer('group', 'group', { childIds: [first.id, second.id], offsetX: 5, offsetY: -4 });
    const hidden = layer('hidden', 'tile', { visible: false });
    map.layerIds = [group.id, hidden.id]; map.layers = { [group.id]: group, [first.id]: first, [second.id]: second, [hidden.id]: hidden };

    expect(composedVisibleTilemapLayers(map, first.id)).toEqual([expect.objectContaining({ layer: first, offsetX: 7, offsetY: -4 })]);
    expect(composedVisibleTilemapLayers(map, group.id).map((entry) => entry.layer.id)).toEqual(['first', 'second']);
    expect(composedVisibleTilemapLayers(map, hidden.id)).toEqual([]);
    expect(composedVisibleTilemapLayers(map, 'missing')).toEqual([]);
  });

  it('keeps camera parallax separate from scaled map-pixel drawing offsets', () => {
    expect(tilemapLayerScreenTranslation({ offsetX: 5, offsetY: -3, parallaxX: 0.5, parallaxY: 2 }, { x: 20, y: -8 }, 2)).toEqual({ x: 0, y: -14 });
    expect(() => tilemapLayerScreenTranslation({ offsetX: 0, offsetY: 0, parallaxX: 1, parallaxY: 1 }, { x: 0, y: 0 }, 0)).toThrow(/positive projection scale/);
  });
});
