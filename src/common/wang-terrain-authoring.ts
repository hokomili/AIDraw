import {
  TILED_GID_MASK,
  isImageCollectionTileset,
  resolveTilesetForGid,
  tilesetLocalIdSpan,
  type PixelDocument,
  type PixelSpriteDependencyGuard,
  type PixelTilemap,
  type PixelTileset,
  type WangSet,
} from '@aidraw/core';
import { imageCollectionSourceDependencyGuards } from './image-collection-authoring';

export interface WangTerrainSelectionRequest {
  mapId: string;
  tilesetId: string;
  wangSetId: string;
  colorId: number;
}

export interface WangTerrainSelectionPlan {
  documentId: string;
  mapId: string;
  mapRevision: number;
  tileset: PixelTileset;
  tilesetId: string;
  tilesetRevision: number;
  wangSet: WangSet;
  colorId: number;
  imageCollection: boolean;
  expectedDocumentRevision?: number;
  expectedSpriteDependencies?: PixelSpriteDependencyGuard[];
}

function exactCollectionTile(tileset: PixelTileset, tileId: number, label: string): void {
  if (!Number.isSafeInteger(tileId) || tileId < 0 || !tileset.tiles[tileId]?.imageAssetId) {
    throw new Error(`${label} ${tileId} is a sparse gap or missing source in image collection “${tileset.name}”.`);
  }
}

function exactAtlasTile(tileset: PixelTileset, tileId: number, label: string): void {
  const count = tileset.columns * tileset.rows;
  if (!Number.isSafeInteger(tileId) || tileId < 0 || tileId >= count) {
    throw new Error(`${label} ${tileId} falls outside tileset “${tileset.name}”.`);
  }
}

function validateCollectionAnimationTargets(tileset: PixelTileset): void {
  if (!isImageCollectionTileset(tileset)) return;
  for (const tile of Object.values(tileset.tiles)) {
    for (const frame of tile.animation) {
      exactCollectionTile(tileset, frame.tileId, `Animated tile ${tile.id} frame`);
    }
  }
}

export function wangSetReferencedTileIds(set: WangSet): number[] {
  return [...new Set([
    ...set.colors.map((color) => color.tileId),
    ...set.tiles.map((tile) => tile.tileId),
  ])].sort((left, right) => left - right);
}

/** Validates exact local-ID/source meaning without requiring a map attachment. */
export function validateWangTilesetMeaning(tileset: PixelTileset, set: WangSet): void {
  const exactTile = isImageCollectionTileset(tileset) ? exactCollectionTile : exactAtlasTile;
  for (const color of set.colors) exactTile(tileset, color.tileId, `Wang color ${color.id} representative tile`);
  for (const tile of set.tiles) exactTile(tileset, tile.tileId, 'Wang mapping tile');
}

function assertExactAttachedResolution(
  document: PixelDocument,
  map: PixelTilemap,
  tileset: PixelTileset,
  tileIds: readonly number[],
): void {
  for (const tileId of tileIds) {
    const baseGid = tileset.firstGid + tileId;
    if (!Number.isSafeInteger(baseGid) || baseGid < 1 || baseGid > TILED_GID_MASK) {
      throw new RangeError(`Wang tile ${tileId} exceeds the supported 28-bit Tiled GID range.`);
    }
    let covering = 0;
    for (const attachedId of map.tilesetIds) {
      const attached = document.pixelAssets[attachedId];
      if (attached?.type !== 'tileset') continue;
      const span = tilesetLocalIdSpan(attached);
      const lastGid = attached.firstGid + span - 1;
      if (!Number.isSafeInteger(span) || span < 1 || !Number.isSafeInteger(lastGid) || lastGid > TILED_GID_MASK) {
        throw new RangeError(`Attached tileset “${attached.name}” has an unsafe Tiled GID range.`);
      }
      if (baseGid >= attached.firstGid && baseGid <= lastGid) covering += 1;
    }
    if (covering !== 1) {
      throw new Error(`Wang tile ${tileId} at GID ${baseGid} is covered by ${covering} attached tileset ranges; exact terrain authoring requires one.`);
    }
    const resolved = resolveTilesetForGid(document, map, baseGid);
    if (!resolved || resolved.tileset.id !== tileset.id || resolved.localId !== tileId) {
      throw new Error(`Wang tile ${tileId} does not resolve exactly to attached tileset ${tileset.id} in map “${map.name}”.`);
    }
  }
}

function requireMap(document: PixelDocument, mapId: string, tileset: PixelTileset): PixelTilemap {
  const map = document.pixelAssets[mapId];
  if (!map || map.type !== 'tilemap') throw new Error(`Tilemap ${mapId} does not exist.`);
  if (!map.tilesetIds.includes(tileset.id)) throw new Error(`Tileset ${tileset.id} is not attached to tilemap ${map.id}.`);
  if (isImageCollectionTileset(tileset) && (map.orientation !== 'orthogonal' || map.infinite)) {
    throw new Error('Image-collection Wang terrain requires a finite orthogonal map.');
  }
  return map;
}

/**
 * Freezes one exact visible terrain choice. Collection plans carry the whole
 * document revision because the attached resolver and independently owned
 * sprite sources are canonical dependencies of every produced GID.
 */
export function planWangTerrainSelection(
  document: PixelDocument,
  request: WangTerrainSelectionRequest,
): WangTerrainSelectionPlan {
  const tileset = document.pixelAssets[request.tilesetId];
  if (!tileset || tileset.type !== 'tileset') throw new Error(`Tileset ${request.tilesetId} does not exist.`);
  const map = requireMap(document, request.mapId, tileset);
  const wangSet = tileset.wangSets.find((entry) => entry.id === request.wangSetId);
  if (!wangSet) throw new Error(`Wang set ${request.wangSetId} does not exist in tileset ${tileset.id}.`);
  if (!wangSet.colors.some((color) => color.id === request.colorId)) {
    throw new Error(`Wang color ${request.colorId} does not exist in “${wangSet.name}”.`);
  }
  validateCollectionAnimationTargets(tileset);
  validateWangTilesetMeaning(tileset, wangSet);
  const tileIds = wangSetReferencedTileIds(wangSet);
  assertExactAttachedResolution(document, map, tileset, tileIds);
  const imageCollection = isImageCollectionTileset(tileset);
  const expectedSpriteDependencies = imageCollection
    ? imageCollectionSourceDependencyGuards(document, tileset)
    : undefined;
  return {
    documentId: document.id,
    mapId: map.id,
    mapRevision: map.revision,
    tileset: structuredClone(tileset),
    tilesetId: tileset.id,
    tilesetRevision: tileset.revision,
    wangSet: structuredClone(wangSet),
    colorId: request.colorId,
    imageCollection,
    ...(imageCollection ? {
      expectedDocumentRevision: document.revision,
      expectedSpriteDependencies,
    } : {}),
  };
}

export function wangTerrainSelectionPlansMatch(
  observed: WangTerrainSelectionPlan,
  current: WangTerrainSelectionPlan,
): boolean {
  if (observed.documentId !== current.documentId
    || observed.mapId !== current.mapId
    || observed.mapRevision !== current.mapRevision
    || observed.tilesetId !== current.tilesetId
    || observed.tilesetRevision !== current.tilesetRevision
    || observed.wangSet.id !== current.wangSet.id
    || observed.colorId !== current.colorId
    || observed.imageCollection !== current.imageCollection
    || observed.expectedDocumentRevision !== current.expectedDocumentRevision
    || JSON.stringify(observed.wangSet) !== JSON.stringify(current.wangSet)) return false;
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

export interface ImageCollectionWangMutationPlan {
  expectedDocumentRevision: number;
  expectedSpriteDependencies: PixelSpriteDependencyGuard[];
}

/** Admits one collection Wang metadata replacement against every attachment. */
export function planImageCollectionWangMutation(
  document: PixelDocument,
  current: PixelTileset,
  next: PixelTileset,
): ImageCollectionWangMutationPlan {
  if (!isImageCollectionTileset(current) || !isImageCollectionTileset(next) || current.id !== next.id) {
    throw new Error('Image-collection Wang editing requires the exact current image collection.');
  }
  const currentWithoutWang = { ...structuredClone(current), wangSets: [] };
  const nextWithoutWang = { ...structuredClone(next), wangSets: [] };
  if (JSON.stringify(currentWithoutWang) !== JSON.stringify(nextWithoutWang)) {
    throw new Error('Wang editing cannot change any other image-collection field, source topology, local ID, or first GID.');
  }
  validateCollectionAnimationTargets(next);
  const maps = Object.values(document.pixelAssets).filter((asset): asset is PixelTilemap => asset.type === 'tilemap' && asset.tilesetIds.includes(current.id));
  if (!maps.length) throw new Error('Attach this image collection to a finite orthogonal map before authoring Wang terrain.');
  const tileIds = [...new Set(next.wangSets.flatMap(wangSetReferencedTileIds))].sort((left, right) => left - right);
  for (const set of next.wangSets) validateWangTilesetMeaning(next, set);
  for (const map of maps) {
    if (map.orientation !== 'orthogonal' || map.infinite) throw new Error('Image-collection Wang terrain requires every attached map to remain finite orthogonal.');
    assertExactAttachedResolution(document, map, next, tileIds);
  }
  return {
    expectedDocumentRevision: document.revision,
    expectedSpriteDependencies: imageCollectionSourceDependencyGuards(document, current),
  };
}
