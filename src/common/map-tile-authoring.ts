import {
  encodeTiledGid,
  isImageCollectionTileset,
  resolveTilesetForGid,
  TILED_GID_MASK,
  tilesetLocalIdSpan,
  type PixelDocument,
  type PixelSpriteDependencyGuard,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import { imageCollectionSourceDependencyGuards } from './image-collection-authoring';
import { resolveTilesetTileSource } from './tile-animation';
import { tileTransformFlagsAllowed, type TileTransformFlags } from './tile-transform-options';

export interface MapTileAuthoringRequest {
  mapId: string;
  tilesetId: string;
  tileId: number;
  transforms: TileTransformFlags;
}

/**
 * One exact visible map-tile choice. Image-collection choices carry the full
 * canonical document revision because their meaning depends on the attached
 * tileset and every independently owned source sprite, not only on the target
 * tile-layer revision.
 */
export interface MapTileAuthoringPlan {
  documentId: string;
  mapId: string;
  mapRevision: number;
  tileset: PixelTileset;
  tilesetId: string;
  tilesetRevision: number;
  tileId: number;
  rawGid: number;
  transforms: TileTransformFlags;
  imageCollection: boolean;
  sourceId?: string;
  expectedDocumentRevision?: number;
  expectedSpriteDependencies?: PixelSpriteDependencyGuard[];
}

export function attachedMapTileAuthoringTilesets(
  document: PixelDocument,
  map: PixelTilemap,
): PixelTileset[] {
  return map.tilesetIds.flatMap((id) => {
    const asset = document.pixelAssets[id];
    return asset?.type === 'tileset' ? [asset] : [];
  });
}

export function imageCollectionAuthoringTileIds(tileset: PixelTileset): number[] {
  if (!isImageCollectionTileset(tileset)) return [];
  return Object.values(tileset.tiles)
    .filter((tile) => Boolean(tile.imageAssetId))
    .map((tile) => tile.id)
    .sort((left, right) => left - right);
}

export interface CurrentMapTileScope {
  documentId: string;
  mapId: string;
  tilesetId: string;
}

export interface CurrentMapTileDraft extends CurrentMapTileScope {
  value: string;
}

export interface CurrentMapTileSelectionUpdate {
  choice: CurrentMapTileScope;
  draft?: CurrentMapTileDraft;
  nextPixelIndex?: number;
}

export function resolveCurrentMapTileDraftValue(
  draft: CurrentMapTileDraft | undefined,
  scope: CurrentMapTileScope,
  fallbackTileId: number,
): string {
  return draft?.documentId === scope.documentId
    && draft.mapId === scope.mapId
    && draft.tilesetId === scope.tilesetId
    ? draft.value
    : String(fallbackTileId);
}

/**
 * Image-collection local IDs are map-tool state and never palette indices.
 * Atlas IDs retain the predecessor palette-coupled selection behavior.
 */
export function selectCurrentMapTileset(
  scope: Omit<CurrentMapTileScope, 'tilesetId'>,
  tileset: PixelTileset,
  currentPaletteTileId: number,
): CurrentMapTileSelectionUpdate {
  const choice = { ...scope, tilesetId: tileset.id };
  if (isImageCollectionTileset(tileset)) {
    const ids = imageCollectionAuthoringTileIds(tileset);
    const tileId = ids.includes(currentPaletteTileId) ? currentPaletteTileId : ids[0];
    return {
      choice,
      ...(tileId === undefined ? {} : { draft: { ...choice, value: String(tileId) } }),
    };
  }
  const span = tilesetLocalIdSpan(tileset);
  return {
    choice,
    ...(currentPaletteTileId < 0 || currentPaletteTileId >= span ? { nextPixelIndex: 1 } : {}),
  };
}

export function selectScopedMapTileId(
  scope: CurrentMapTileScope,
  tileset: PixelTileset,
  value: string,
): Pick<CurrentMapTileSelectionUpdate, 'draft' | 'nextPixelIndex'> {
  const draft = { ...scope, value };
  const parsed = Number(value);
  return {
    draft,
    ...(!isImageCollectionTileset(tileset)
      && value.trim()
      && Number.isSafeInteger(parsed)
      && parsed >= 0
      ? { nextPixelIndex: parsed + 1 }
      : {}),
  };
}

/**
 * Admits the same exact base GID that production rendering will resolve.
 * Range uniqueness catches overlaps in either attachment order; the final
 * production-resolver check also catches a later higher-firstGid sparse/short
 * tileset that shadows the requested tile to unresolved.
 */
export function planMapTileAuthoringSelection(
  document: PixelDocument,
  request: MapTileAuthoringRequest,
): MapTileAuthoringPlan {
  const map = document.pixelAssets[request.mapId];
  if (!map) throw new Error(`Map ${request.mapId} no longer exists.`);
  if (map.type !== 'tilemap') throw new Error(`Asset ${request.mapId} is not a tilemap.`);
  if (!map.tilesetIds.includes(request.tilesetId)) throw new Error(`Tileset ${request.tilesetId} is not attached to map ${map.id}.`);
  const tileset = document.pixelAssets[request.tilesetId];
  if (!tileset) throw new Error(`Tileset ${request.tilesetId} no longer exists.`);
  if (tileset.type !== 'tileset') throw new Error(`Asset ${request.tilesetId} is not a tileset.`);

  const imageCollection = isImageCollectionTileset(tileset);
  const tileCount = tilesetLocalIdSpan(tileset);
  if (!Number.isSafeInteger(request.tileId) || request.tileId < 0 || request.tileId >= tileCount) {
    throw new RangeError(`Tile ID must be a whole number from 0 to ${Math.max(0, tileCount - 1)} for tileset “${tileset.name}”.`);
  }
  if (imageCollection && !tileset.tiles[request.tileId]?.imageAssetId) {
    throw new Error(`Tile ${request.tileId} is a sparse gap in image collection “${tileset.name}”. Choose one exact existing tile ID.`);
  }
  if (imageCollection && (map.orientation !== 'orthogonal' || map.infinite)) {
    throw new Error('Image-collection tile painting and the Current tile stamp require a finite orthogonal map.');
  }
  if (!tileTransformFlagsAllowed(request.transforms, tileset.transformations)) {
    throw new Error(`The selected H/V/diagonal transform is not permitted by tileset “${tileset.name}”.`);
  }

  const baseGid = tileset.firstGid + request.tileId;
  const rawGid = encodeTiledGid(baseGid, request.transforms);
  const coveringTilesetCount = map.tilesetIds.reduce((count, id) => {
    const attached = document.pixelAssets[id];
    if (attached?.type !== 'tileset') return count;
    const span = tilesetLocalIdSpan(attached);
    const lastGid = attached.firstGid + span - 1;
    if (!Number.isSafeInteger(span) || span < 0 || !Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) {
      throw new RangeError(`Attached tileset “${attached.name}” has an unsafe Tiled GID range.`);
    }
    return baseGid >= attached.firstGid && baseGid <= lastGid ? count + 1 : count;
  }, 0);
  if (coveringTilesetCount !== 1) {
    throw new Error(`GID ${baseGid} is covered by ${coveringTilesetCount} attached tileset ranges; exact tile authoring requires exactly one.`);
  }
  const resolved = resolveTilesetForGid(document, map, baseGid);
  if (!resolved || resolved.tileset.id !== tileset.id || resolved.localId !== request.tileId) {
    throw new Error(`Tile ${request.tileId} does not resolve exactly to attached tileset ${tileset.id}; no tile was authored.`);
  }

  let sourceId: string | undefined;
  let expectedSpriteDependencies: PixelSpriteDependencyGuard[] | undefined;
  if (imageCollection) {
    sourceId = resolveTilesetTileSource(document, tileset, request.tileId).sprite.id;
    expectedSpriteDependencies = imageCollectionSourceDependencyGuards(document, tileset);
  }

  return {
    documentId: document.id,
    mapId: map.id,
    mapRevision: map.revision,
    tileset: structuredClone(tileset),
    tilesetId: tileset.id,
    tilesetRevision: tileset.revision,
    tileId: request.tileId,
    rawGid,
    transforms: { ...request.transforms },
    imageCollection,
    ...(sourceId ? { sourceId } : {}),
    ...(imageCollection ? {
      expectedDocumentRevision: document.revision,
      expectedSpriteDependencies,
    } : {}),
  };
}

/** Exact comparison between the visible choice and the action-time snapshot. */
export function mapTileAuthoringPlansMatch(
  observed: MapTileAuthoringPlan,
  current: MapTileAuthoringPlan,
): boolean {
  if (observed.documentId !== current.documentId
    || observed.mapId !== current.mapId
    || observed.mapRevision !== current.mapRevision
    || observed.tilesetId !== current.tilesetId
    || observed.tilesetRevision !== current.tilesetRevision
    || observed.tileId !== current.tileId
    || observed.rawGid !== current.rawGid
    || observed.imageCollection !== current.imageCollection
    || observed.sourceId !== current.sourceId
    || observed.expectedDocumentRevision !== current.expectedDocumentRevision) return false;
  const left = observed.expectedSpriteDependencies ?? [];
  const right = current.expectedSpriteDependencies ?? [];
  return left.length === right.length && left.every((guard, index) => {
    const candidate = right[index];
    return guard.spriteId === candidate?.spriteId
      && guard.expectedRevision === candidate.expectedRevision
      && guard.width === candidate.width
      && guard.height === candidate.height;
  });
}
