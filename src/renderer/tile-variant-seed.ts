const MIN_TILE_VARIANT_SEED = -2_147_483_648;
const MAX_TILE_VARIANT_SEED = 2_147_483_647;

export function parseTileVariantSeedDraft(value: string): number {
  return Math.max(MIN_TILE_VARIANT_SEED, Math.min(MAX_TILE_VARIANT_SEED, Math.trunc(Number(value) || 0)));
}
