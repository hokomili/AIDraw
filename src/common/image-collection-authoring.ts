import {
  isImageCollectionTileset,
  type PixelDocument,
  type PixelSpriteDependencyGuard,
  type PixelTileset,
  type TileDefinition,
} from '@aidraw/core';

export type ImageCollectionTileMetadataPatch = Partial<Pick<
  TileDefinition,
  'probability' | 'animation' | 'collisions' | 'properties'
>>;

export function imageCollectionTileIds(tileset: PixelTileset): number[] {
  if (!isImageCollectionTileset(tileset)) throw new Error('Sparse tile IDs require an image-collection tileset.');
  return Object.values(tileset.tiles).map((tile) => tile.id).sort((left, right) => left - right);
}

export function imageCollectionSourceDependencyGuards(
  document: PixelDocument,
  tileset: PixelTileset,
): PixelSpriteDependencyGuard[] {
  if (!isImageCollectionTileset(tileset)) throw new Error('Sprite dependency guards require an image collection.');
  const guards = new Map<string, PixelSpriteDependencyGuard>();
  for (const tileId of imageCollectionTileIds(tileset)) {
    const sourceId = tileset.tiles[tileId].imageAssetId;
    const source = sourceId ? document.pixelAssets[sourceId] : undefined;
    if (source?.type !== 'sprite') throw new Error(`Image-collection tile ${tileId} is missing its sprite source.`);
    guards.set(source.id, { spriteId: source.id, expectedRevision: source.revision, width: source.width, height: source.height });
  }
  return [...guards.values()];
}

/** Replaces only editable metadata while preserving the collection's exact sparse source topology. */
export function replaceImageCollectionTileMetadata(
  tileset: PixelTileset,
  tileId: number,
  patch: ImageCollectionTileMetadataPatch,
): PixelTileset {
  if (!isImageCollectionTileset(tileset)) throw new Error('Image-collection metadata editing requires an image collection.');
  const tile = tileset.tiles[tileId];
  if (!tile?.imageAssetId) throw new Error(`Image-collection tile ${tileId} is unavailable.`);
  if (patch.animation?.some((frame) => !tileset.tiles[frame.tileId]?.imageAssetId)) {
    throw new Error('Image-collection animation frames must use existing sparse tile IDs.');
  }
  const next = structuredClone(tileset);
  const target = next.tiles[tileId];
  if (patch.probability !== undefined) target.probability = patch.probability;
  if (patch.animation !== undefined) target.animation = structuredClone(patch.animation);
  if (patch.collisions !== undefined) target.collisions = structuredClone(patch.collisions);
  if (patch.properties !== undefined) target.properties = structuredClone(patch.properties);
  return next;
}

/**
 * Binds an authoring action to the exact rendered collection and all of its
 * per-tile sprite revisions. The canonical asset replacement performs the
 * final revision check; this guard prevents submitting edits from stale source
 * dimensions or collection membership.
 */
export function imageCollectionAuthoringGuardError(
  observed: PixelDocument,
  current: PixelDocument,
  tilesetId: string,
): string | undefined {
  if (observed.id !== current.id) return 'The active document changed. Re-open the image collection before editing it.';
  const observedTileset = observed.pixelAssets[tilesetId];
  const currentTileset = current.pixelAssets[tilesetId];
  if (observedTileset?.type !== 'tileset' || !isImageCollectionTileset(observedTileset)) return 'The observed image collection is unavailable.';
  if (currentTileset?.type !== 'tileset' || !isImageCollectionTileset(currentTileset)) return 'The image collection changed or is unavailable. Re-open it before editing.';
  if (currentTileset.revision !== observedTileset.revision) return 'The image collection changed. Re-open it before editing.';
  const observedIds = imageCollectionTileIds(observedTileset);
  const currentIds = imageCollectionTileIds(currentTileset);
  if (observedIds.length !== currentIds.length || observedIds.some((id, index) => id !== currentIds[index])) return 'The image collection tile IDs changed. Re-open it before editing.';
  for (const tileId of observedIds) {
    const observedTile = observedTileset.tiles[tileId];
    const currentTile = currentTileset.tiles[tileId];
    if (!observedTile.imageAssetId || currentTile?.imageAssetId !== observedTile.imageAssetId) return `Image-collection tile ${tileId} changed source. Re-open it before editing.`;
    const observedSource = observed.pixelAssets[observedTile.imageAssetId];
    const currentSource = current.pixelAssets[observedTile.imageAssetId];
    if (observedSource?.type !== 'sprite' || currentSource?.type !== 'sprite') return `Image-collection tile ${tileId} is missing its sprite source.`;
    if (currentSource.revision !== observedSource.revision || currentSource.width !== observedSource.width || currentSource.height !== observedSource.height) return `Image-collection tile ${tileId} source changed. Re-open it before editing.`;
  }
  return undefined;
}
