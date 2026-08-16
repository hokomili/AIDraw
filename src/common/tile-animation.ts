import {
  isImageCollectionTileset,
  tilesetTileSourceAssetId,
  type PixelDocument,
  type PixelSprite,
  type PixelTileset,
  type TileDefinition,
} from '@aidraw/core';

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

export function tilesetTileSourceRect(tileset: PixelTileset, tileId: number, collectionSource?: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  if (isImageCollectionTileset(tileset)) {
    if (!Number.isInteger(tileId) || tileId < 0 || !tileset.tiles[tileId]?.imageAssetId) throw new RangeError('Animation tile is missing from the image collection.');
    if (!collectionSource || !Number.isInteger(collectionSource.width) || !Number.isInteger(collectionSource.height) || collectionSource.width < 1 || collectionSource.height < 1) throw new RangeError('Image-collection tile is missing valid source dimensions.');
    return { x: 0, y: 0, width: collectionSource.width, height: collectionSource.height };
  }
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= tileset.columns * tileset.rows) throw new RangeError('Animation tile falls outside the tileset slice.');
  const tile = tileset.tiles[tileId];
  return {
    x: tile?.sourceX ?? tileset.margin + tileId % tileset.columns * (tileset.tileWidth + tileset.spacing),
    y: tile?.sourceY ?? tileset.margin + Math.floor(tileId / tileset.columns) * (tileset.tileHeight + tileset.spacing),
    width: tileset.tileWidth,
    height: tileset.tileHeight,
  };
}

export function resolveTilesetTileSource(
  document: PixelDocument,
  tileset: PixelTileset,
  tileId: number,
): { sprite: PixelSprite; rect: { x: number; y: number; width: number; height: number } } {
  const sourceId = tilesetTileSourceAssetId(tileset, tileId);
  const sprite = sourceId ? document.pixelAssets[sourceId] : undefined;
  if (sprite?.type !== 'sprite') throw new Error(`Tile ${tileId} is missing its sprite source.`);
  return { sprite, rect: tilesetTileSourceRect(tileset, tileId, sprite) };
}

/**
 * Resolves the exact source used by one tileset tile at an animation time.
 * Image collections intentionally resolve the sampled frame's own sprite and
 * dimensions; atlas tiles continue to share their predecessor source sprite.
 */
export function resolveRenderedTilesetTileSource(
  document: PixelDocument,
  tileset: PixelTileset,
  tileId: number,
  timeMs: number,
): {
  localId: number;
  sprite: PixelSprite;
  rect: { x: number; y: number; width: number; height: number };
} {
  const localId = tileAnimationFrameAt(tileset.tiles[tileId]?.animation ?? [], timeMs)?.tileId ?? tileId;
  return { localId, ...resolveTilesetTileSource(document, tileset, localId) };
}
