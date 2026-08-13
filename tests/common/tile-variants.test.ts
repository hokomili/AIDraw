import { describe, expect, it } from 'vitest';
import { createPixelTileset } from '@aidraw/core';
import { TILE_VARIANT_GROUP_PROPERTY, chooseTileVariant, nextTileVariantSeed, tileVariantCandidates } from '../../src/common/tile-variants';

function tileset() {
  const value = createPixelTileset('Terrain', 'sprite', 16, 16, 3, 1);
  for (let id = 0; id < 3; id += 1) value.tiles[id] = { id, sourceX: id * 16, sourceY: 0, probability: id === 0 ? 1 : id === 1 ? 3 : 20, animation: [], collisions: [], properties: { [TILE_VARIANT_GROUP_PROPERTY]: id < 2 ? 'grass' : 'stone' } };
  return value;
}

describe('deterministic tile variants', () => {
  it('limits candidates to one named group and honors zero weight', () => {
    const value = tileset();
    expect(tileVariantCandidates(value, 0).map((tile) => tile.id)).toEqual([0, 1]);
    value.tiles[1].probability = 0;
    expect(tileVariantCandidates(value, 0).map((tile) => tile.id)).toEqual([0]);
  });

  it('is stable for a seed and coordinate while producing weighted variation across a region', () => {
    const value = tileset();
    const first = chooseTileVariant(value, 0, 19, -4, 912);
    expect(chooseTileVariant(value, 0, 19, -4, 912)).toBe(first);
    const samples = Array.from({ length: 256 }, (_, index) => chooseTileVariant(value, 0, index % 32, Math.floor(index / 32), 912));
    expect(new Set(samples)).toEqual(new Set([0, 1]));
    expect(samples.filter((id) => id === 1).length).toBeGreaterThan(samples.filter((id) => id === 0).length);
  });

  it('advances a persisted signed seed deterministically for a new stroke', () => {
    expect(nextTileVariantSeed(0)).toBe(1_013_904_223);
    expect(nextTileVariantSeed(912)).toBe(nextTileVariantSeed(912));
    const sequence = Array.from({ length: 16 }, (_, index) => index).reduce<number[]>((values) => [...values, nextTileVariantSeed(values.at(-1)!)], [912]);
    expect(new Set(sequence).size).toBe(sequence.length);
    expect(sequence.every((value) => Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647)).toBe(true);
  });
});
