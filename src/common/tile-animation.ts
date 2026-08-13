import type { PixelTileset, TileDefinition } from '@aidraw/core';

export type TileAnimationFrame = TileDefinition['animation'][number];

export interface TileAnimationFrameSample {
  tileId: number;
  frameIndex: number;
  remainingMs: number;
}

/**
 * Samples one canonical tileset animation at an exact nonnegative integer
 * millisecond. BigInt keeps looping exact even when the sum of individually
 * safe frame durations is larger than Number.MAX_SAFE_INTEGER.
 */
export function tileAnimationFrameAt(
  animation: TileAnimationFrame[],
  timeMs: number,
): TileAnimationFrameSample | undefined {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new RangeError('Tile animation time must be a nonnegative safe integer millisecond.');
  if (!animation.length) return undefined;
  let cycleDuration = 0n;
  for (const frame of animation) {
    if (!Number.isSafeInteger(frame.tileId) || frame.tileId < 0) throw new RangeError('Animation tile IDs must be nonnegative safe integers.');
    if (!Number.isSafeInteger(frame.durationMs) || frame.durationMs < 1) throw new RangeError('Animation frame durations must be positive safe integer milliseconds.');
    cycleDuration += BigInt(frame.durationMs);
  }
  let cyclePosition = BigInt(timeMs) % cycleDuration;
  for (const [frameIndex, frame] of animation.entries()) {
    const duration = BigInt(frame.durationMs);
    if (cyclePosition < duration) return { tileId: frame.tileId, frameIndex, remainingMs: Number(duration - cyclePosition) };
    cyclePosition -= duration;
  }
  throw new Error('Tile animation sampling reached an impossible cycle position.');
}

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
