import type { PixelTileset, TileDefinition } from '@aidraw/core';

export type TileAnimationFrame = TileDefinition['animation'][number];

export function moveTileAnimationFrame(
  animation: TileAnimationFrame[],
  fromIndex: number,
  toIndex: number,
): TileAnimationFrame[] {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= animation.length) throw new RangeError('Animation source index is outside the frame list.');
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= animation.length) throw new RangeError('Animation destination index is outside the frame list.');
  const next = animation.map((frame) => ({ ...frame }));
  if (fromIndex === toIndex) return next;
  const [frame] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, frame);
  return next;
}

export function tilesetTileSourceRect(tileset: PixelTileset, tileId: number): { x: number; y: number; width: number; height: number } {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= tileset.columns * tileset.rows) throw new RangeError('Animation tile falls outside the tileset slice.');
  const tile = tileset.tiles[tileId];
  return {
    x: tile?.sourceX ?? tileset.margin + tileId % tileset.columns * (tileset.tileWidth + tileset.spacing),
    y: tile?.sourceY ?? tileset.margin + Math.floor(tileId / tileset.columns) * (tileset.tileHeight + tileset.spacing),
    width: tileset.tileWidth,
    height: tileset.tileHeight,
  };
}
