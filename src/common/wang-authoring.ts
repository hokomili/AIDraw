import { isImageCollectionTileset, type PixelTileset, type WangColor, type WangSet, type WangTile } from '@aidraw/core';

function validateTileId(tileset: PixelTileset, tileId: number, label: string): void {
  if (!Number.isInteger(tileId) || tileId < 0) throw new Error(`${label} must be a non-negative integer.`);
  if (isImageCollectionTileset(tileset)) {
    if (!tileset.tiles[tileId]?.imageAssetId) throw new Error(`${label} ${tileId} is a sparse gap or missing source in the image collection.`);
    return;
  }
  if (tileId >= tileset.columns * tileset.rows) throw new Error(`${label} ${tileId} falls outside the tileset slice.`);
}

function validateColor(color: WangColor): void {
  if (!Number.isInteger(color.id) || color.id <= 0 || color.id > 255) throw new Error('Wang color IDs must be integers from 1 to 255.');
  if (!color.name.trim() || color.name.length > 100) throw new Error('Wang color names must contain 1–100 characters.');
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color.color)) throw new Error('Wang colors must use hexadecimal RGB or RGBA.');
  if (!Number.isInteger(color.tileId) || color.tileId < 0) throw new Error('A Wang color representative tile must be a non-negative integer.');
  if (!Number.isFinite(color.probability) || color.probability < 0) throw new Error('Wang color probability must be a non-negative finite number.');
}

function validateTile(tileset: PixelTileset, tile: WangTile, colorIds: Set<number>): void {
  validateTileId(tileset, tile.tileId, 'Wang tile');
  if (!Array.isArray(tile.wangId) || tile.wangId.length !== 8) throw new Error('Wang tile assignments require exactly eight clockwise edge/corner slots.');
  for (const colorId of tile.wangId) if (!Number.isInteger(colorId) || colorId < 0 || (colorId > 0 && !colorIds.has(colorId))) throw new Error(`Wang tile ${tile.tileId} references missing color ${colorId}.`);
}

export function validateWangSet(tileset: PixelTileset, set: WangSet): void {
  if (!set.id.trim() || set.id.length > 200) throw new Error('Wang set IDs must contain 1–200 characters.');
  if (!set.name.trim() || set.name.length > 100) throw new Error('Wang set names must contain 1–100 characters.');
  if (!['edge', 'corner', 'mixed'].includes(set.type)) throw new Error('Wang set type must be edge, corner, or mixed.');
  const tileLimit = isImageCollectionTileset(tileset) ? Object.keys(tileset.tiles).length : tileset.columns * tileset.rows;
  if (set.colors.length > 255 || set.tiles.length > tileLimit) throw new Error('Wang set exceeds the tileset authoring limits.');
  const colorIds = new Set<number>();
  for (const color of set.colors) { validateColor(color); if (colorIds.has(color.id)) throw new Error(`Wang color ${color.id} is duplicated.`); colorIds.add(color.id); validateTileId(tileset, color.tileId, `Wang color ${color.id} representative tile`); }
  const tileIds = new Set<number>();
  for (const tile of set.tiles) { validateTile(tileset, tile, colorIds); if (tileIds.has(tile.tileId)) throw new Error(`Wang tile ${tile.tileId} is assigned more than once.`); tileIds.add(tile.tileId); }
}

export function upsertWangSet(tileset: PixelTileset, set: WangSet): PixelTileset {
  validateWangSet(tileset, set);
  const next = structuredClone(tileset);
  const index = next.wangSets.findIndex((entry) => entry.id === set.id);
  if (index < 0) next.wangSets.push(structuredClone(set));
  else next.wangSets[index] = structuredClone(set);
  return next;
}

export function deleteWangSet(tileset: PixelTileset, setId: string): PixelTileset {
  if (!tileset.wangSets.some((set) => set.id === setId)) throw new Error(`Wang set ${setId} does not exist.`);
  const next = structuredClone(tileset);
  next.wangSets = next.wangSets.filter((set) => set.id !== setId);
  return next;
}

export function upsertWangColor(tileset: PixelTileset, setId: string, color: WangColor): PixelTileset {
  const source = tileset.wangSets.find((set) => set.id === setId);
  if (!source) throw new Error(`Wang set ${setId} does not exist.`);
  validateColor(color);
  validateTileId(tileset, color.tileId, 'The Wang color representative tile');
  const set = structuredClone(source);
  const index = set.colors.findIndex((entry) => entry.id === color.id);
  if (index < 0) set.colors.push(structuredClone(color)); else set.colors[index] = structuredClone(color);
  return upsertWangSet(tileset, set);
}

export function deleteWangColor(tileset: PixelTileset, setId: string, colorId: number): PixelTileset {
  const source = tileset.wangSets.find((set) => set.id === setId);
  if (!source) throw new Error(`Wang set ${setId} does not exist.`);
  if (!source.colors.some((color) => color.id === colorId)) throw new Error(`Wang color ${colorId} does not exist.`);
  const set = structuredClone(source);
  set.colors = set.colors.filter((color) => color.id !== colorId);
  set.tiles = set.tiles
    .map((tile) => ({ ...tile, wangId: tile.wangId.map((value) => value === colorId ? 0 : value) as WangTile['wangId'] }))
    .filter((tile) => tile.wangId.some((value) => value > 0));
  return upsertWangSet(tileset, set);
}

export function assignWangTile(tileset: PixelTileset, setId: string, tile: WangTile): PixelTileset {
  const source = tileset.wangSets.find((set) => set.id === setId);
  if (!source) throw new Error(`Wang set ${setId} does not exist.`);
  validateTile(tileset, tile, new Set(source.colors.map((color) => color.id)));
  const set = structuredClone(source);
  const index = set.tiles.findIndex((entry) => entry.tileId === tile.tileId);
  if (tile.wangId.every((value) => value === 0)) {
    if (index >= 0) set.tiles.splice(index, 1);
  } else if (index < 0) set.tiles.push(structuredClone(tile));
  else set.tiles[index] = structuredClone(tile);
  return upsertWangSet(tileset, set);
}
