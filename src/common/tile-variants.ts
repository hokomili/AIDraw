import type { PixelTileset, TileDefinition } from '@aidraw/core';

export const TILE_VARIANT_GROUP_PROPERTY = 'aidraw:variantGroup';
export const TILE_VARIANT_SEED_PROPERTY = 'aidraw:variantSeed';

function hash32(seed: number, x: number, y: number, tileId: number): number {
  let value = (seed | 0) ^ Math.imul(x | 0, 0x45d9f3b) ^ Math.imul(y | 0, 0x119de1f3) ^ Math.imul(tileId | 0, 0x27d4eb2d);
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15; value = Math.imul(value, 0x846ca68b); value ^= value >>> 16;
  return value >>> 0;
}

export function tileVariantGroup(tile: TileDefinition | undefined): string | undefined {
  const value = tile?.properties[TILE_VARIANT_GROUP_PROPERTY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function tileVariantCandidates(tileset: PixelTileset, selectedTileId: number): TileDefinition[] {
  const selected = tileset.tiles[selectedTileId];
  const group = tileVariantGroup(selected);
  if (!group) return selected ? [selected] : [];
  return Object.values(tileset.tiles)
    .filter((tile) => tileVariantGroup(tile) === group && tile.probability > 0)
    .sort((left, right) => left.id - right.id);
}

/** Stable coordinate-hash selection makes repainting and agent replay reproducible. */
export function chooseTileVariant(tileset: PixelTileset, selectedTileId: number, x: number, y: number, seed: number): number {
  const candidates = tileVariantCandidates(tileset, selectedTileId);
  if (candidates.length === 0) return selectedTileId;
  const total = candidates.reduce((sum, tile) => sum + tile.probability, 0);
  if (!(total > 0)) return selectedTileId;
  let target = hash32(seed, x, y, selectedTileId) / 0x1_0000_0000 * total;
  for (const tile of candidates) {
    target -= tile.probability;
    if (target < 0) return tile.id;
  }
  return candidates.at(-1)!.id;
}
