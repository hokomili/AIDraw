import {
  HUMAN_ACTOR,
  TILED_GID_MASK,
  createId,
  isImageCollectionTileset,
  nextTilesetFirstGid,
  nowIso,
  tilesetLocalIdSpan,
  type PixelDocument,
  type PixelSprite,
  type PixelSpriteDependencyGuard,
  type PixelTileset,
  type TileDefinition,
} from '@aidraw/core';

export const MAX_AUTHORED_IMAGE_COLLECTION_SOURCES = 1_023;
export const MAX_AUTHORED_IMAGE_COLLECTION_PIXELS = 64 * 1024 * 1024;

export interface ImageCollectionCreationOptions {
  id?: string;
  createdAt?: string;
  createdBy?: string;
}

export interface ImageCollectionAppendPlan {
  tileset: PixelTileset;
  tileId: number;
  expectedSpriteDependencies: PixelSpriteDependencyGuard[];
}

export type ImageCollectionTileMetadataPatch = Partial<Pick<
  TileDefinition,
  'probability' | 'animation' | 'collisions' | 'properties'
>>;

export function imageCollectionTileIds(tileset: PixelTileset): number[] {
  if (!isImageCollectionTileset(tileset)) throw new Error('Sparse tile IDs require an image-collection tileset.');
  return Object.values(tileset.tiles).map((tile) => tile.id).sort((left, right) => left - right);
}

function requirePixelDocument(document: PixelDocument): PixelDocument {
  if (document.kind !== 'pixel') throw new Error('Image-collection authoring requires a pixel document.');
  return document;
}

function requireEligibleSource(document: PixelDocument, sourceId: string): PixelSprite {
  const source = document.pixelAssets[sourceId];
  if (!source) throw new Error(`Sprite source ${sourceId} does not exist in this document.`);
  if (source.type !== 'sprite') throw new Error(`Asset “${source.name}” is not a sprite source.`);
  if (source.frameIds.length !== 1) throw new Error(`Sprite “${source.name}” has ${source.frameIds.length} frames. Image-collection sources must be exact one-frame sprites.`);
  return source;
}

function imageCollectionSourcePixels(document: PixelDocument, sourceIds: readonly string[]): number {
  let total = 0;
  for (const sourceId of sourceIds) {
    const source = requireEligibleSource(document, sourceId);
    total += source.width * source.height;
    if (!Number.isSafeInteger(total) || total > MAX_AUTHORED_IMAGE_COLLECTION_PIXELS) {
      throw new RangeError('Image-collection sources exceed the 64-megapixel expanded artwork budget.');
    }
  }
  return total;
}

function requireUniqueSourceIds(sourceIds: readonly string[]): void {
  if (sourceIds.length < 1) throw new Error('Choose at least one exact sprite source.');
  if (sourceIds.length > MAX_AUTHORED_IMAGE_COLLECTION_SOURCES) {
    throw new RangeError(`Image collections support at most ${MAX_AUTHORED_IMAGE_COLLECTION_SOURCES.toLocaleString('en-US')} authorable sprite sources.`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Image-collection source identities must be unique.');
}

export function imageCollectionSourceEligibility(document: PixelDocument, sourceId: string): string | undefined {
  try {
    requirePixelDocument(document);
    requireEligibleSource(document, sourceId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'This asset is not an eligible image-collection source.';
  }
}

/** Binds a chooser selection to the exact sprite state the human observed. */
export function imageCollectionSourceObservationGuardError(
  observed: PixelDocument,
  current: PixelDocument,
  sourceIds: readonly string[],
): string | undefined {
  if (observed.id !== current.id) return 'The active document changed. Re-open the image-collection source chooser.';
  for (const sourceId of sourceIds) {
    const observedSource = observed.pixelAssets[sourceId];
    const currentSource = current.pixelAssets[sourceId];
    if (observedSource?.type !== 'sprite' || currentSource?.type !== 'sprite') return `Sprite source ${sourceId} is missing or changed kind. Re-open the chooser.`;
    if (
      currentSource.revision !== observedSource.revision
      || currentSource.width !== observedSource.width
      || currentSource.height !== observedSource.height
    ) return `Sprite “${observedSource.name}” changed. Re-open the chooser before using it.`;
  }
  return undefined;
}

function sourceTile(id: number, imageAssetId: string): TileDefinition {
  return { id, sourceX: 0, sourceY: 0, imageAssetId, probability: 1, animation: [], collisions: [], properties: {} };
}

/**
 * Builds one collection without copying sprite pixels. The caller owns the
 * source order; human callers pass canonical asset order, while semantic
 * callers pass their explicit bounded order.
 */
export function createImageCollectionTileset(
  document: PixelDocument,
  name: string,
  sourceIds: readonly string[],
  options: ImageCollectionCreationOptions = {},
): PixelTileset {
  requirePixelDocument(document);
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 200) throw new Error('Image-collection names must contain 1–200 characters.');
  requireUniqueSourceIds(sourceIds);
  imageCollectionSourcePixels(document, sourceIds);
  const sources = sourceIds.map((id) => requireEligibleSource(document, id));
  const tilesets = document.assetIds
    .map((id) => document.pixelAssets[id])
    .filter((asset): asset is PixelTileset => asset?.type === 'tileset');
  const firstGid = nextTilesetFirstGid(tilesets);
  if (firstGid + sourceIds.length - 1 > TILED_GID_MASK) throw new RangeError('No safe Tiled GID range remains for this image collection.');
  const createdAt = options.createdAt ?? nowIso();
  return {
    id: options.id ?? createId('tileset'),
    revision: 0,
    name: normalizedName,
    type: 'tileset',
    createdAt,
    updatedAt: createdAt,
    createdBy: options.createdBy ?? HUMAN_ACTOR.id,
    firstGid,
    tileWidth: Math.max(...sources.map((source) => source.width)),
    tileHeight: Math.max(...sources.map((source) => source.height)),
    margin: 0,
    spacing: 0,
    tileOffset: { x: 0, y: 0 },
    objectAlignment: 'unspecified',
    columns: 0,
    rows: 0,
    tiles: Object.fromEntries(sourceIds.map((sourceId, id) => [id, sourceTile(id, sourceId)])),
    wangSets: [],
    transformations: { hFlip: true, vFlip: true, rotate: true },
  };
}

function assertAppendRangeAvailable(document: PixelDocument, tileset: PixelTileset, tileId: number): void {
  const firstGid = tileset.firstGid;
  const lastGid = firstGid + tileId;
  if (!Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) throw new RangeError('Appending this source would exceed the 28-bit Tiled GID range.');
  for (const assetId of document.assetIds) {
    const other = document.pixelAssets[assetId];
    if (other?.type !== 'tileset' || other.id === tileset.id) continue;
    const span = tilesetLocalIdSpan(other);
    const otherLastGid = other.firstGid + span - 1;
    if (span > 0 && firstGid <= otherLastGid && other.firstGid <= lastGid) {
      throw new Error(`Appending local tile ${tileId} would leave image collection “${tileset.name}” overlapping tileset “${other.name}” in the Tiled GID space.`);
    }
  }
}

/** Appends one exact source above the collection's authored sparse span. */
export function appendImageCollectionSource(
  document: PixelDocument,
  tilesetId: string,
  sourceId: string,
): ImageCollectionAppendPlan {
  requirePixelDocument(document);
  const current = document.pixelAssets[tilesetId];
  if (!current || current.type !== 'tileset' || !isImageCollectionTileset(current)) throw new Error(`Image collection ${tilesetId} does not exist.`);
  const source = requireEligibleSource(document, sourceId);
  const existingIds = imageCollectionTileIds(current);
  if (existingIds.some((tileId) => current.tiles[tileId].imageAssetId === source.id)) throw new Error(`Sprite “${source.name}” already belongs to this image collection.`);
  if (existingIds.length >= MAX_AUTHORED_IMAGE_COLLECTION_SOURCES) {
    throw new RangeError(`Image collections support at most ${MAX_AUTHORED_IMAGE_COLLECTION_SOURCES.toLocaleString('en-US')} authorable sprite sources.`);
  }
  const sourceIds = [...existingIds.map((tileId) => current.tiles[tileId].imageAssetId!), source.id];
  imageCollectionSourcePixels(document, sourceIds);
  const tileId = tilesetLocalIdSpan(current);
  if (tileId >= 1_048_576) throw new RangeError('The image collection has no remaining local tile ID.');
  assertAppendRangeAvailable(document, current, tileId);
  const tileset = structuredClone(current);
  tileset.tiles[tileId] = sourceTile(tileId, source.id);
  tileset.tileWidth = Math.max(tileset.tileWidth, source.width);
  tileset.tileHeight = Math.max(tileset.tileHeight, source.height);
  return { tileset, tileId, expectedSpriteDependencies: imageCollectionSourceDependencyGuards(document, tileset) };
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
