import { isImageCollectionTileset, type PixelDocument, type PixelTileset } from '@aidraw/core';

import {
  imageCollectionSourceDependencyGuards,
  imageCollectionTileIds,
} from '../common/image-collection-authoring';
import {
  firstUnusedImageCollectionTileId,
  planImageCollectionTileIdMove,
  type ImageCollectionTileMoveImpact,
} from '../common/image-collection-tile-move';

interface ImageCollectionTileMoveSourceObservation {
  readonly id: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageCollectionTileMoveOpening {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly assetIds: readonly string[];
  readonly tileIds: readonly number[];
  readonly sourceObservations: readonly ImageCollectionTileMoveSourceObservation[];
  readonly target: {
    readonly id: string;
    readonly revision: number;
    readonly name: string;
    readonly sourceTileId: number;
    readonly sourceId: string;
    readonly sourceName: string;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly maximumLocalId: number;
    readonly defaultDestinationTileId: number;
  };
}

export interface ImageCollectionTileMoveReview {
  readonly destinationTileId: number;
  readonly impact: ImageCollectionTileMoveImpact;
}

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function freezeImpact(impact: ImageCollectionTileMoveImpact): ImageCollectionTileMoveImpact {
  for (const map of impact.maps) {
    Object.freeze(map.layerIds);
    Object.freeze(map);
  }
  for (const entry of impact.animations) Object.freeze(entry);
  for (const entry of impact.wangSets) Object.freeze(entry);
  for (const entry of impact.stamps) Object.freeze(entry);
  Object.freeze(impact.maps);
  Object.freeze(impact.animations);
  Object.freeze(impact.wangSets);
  Object.freeze(impact.stamps);
  return Object.freeze(impact);
}

/** Captures the exact document, collection, selected tile, and source state observed when the move dialog opens. */
export function createImageCollectionTileMoveOpening(
  document: PixelDocument,
  tileset: PixelTileset,
  sourceTileId: number,
): ImageCollectionTileMoveOpening {
  const current = document.pixelAssets[tileset.id];
  if (current?.type !== 'tileset' || !isImageCollectionTileset(current) || !isImageCollectionTileset(tileset)) {
    throw new Error('Tile-ID movement requires the exact current image collection.');
  }
  if (current.revision !== tileset.revision) throw new Error('The image collection changed before the move dialog opened. Re-open it and try again.');
  const tileIds = imageCollectionTileIds(current);
  const maximumLocalId = tileIds.at(-1);
  const sourceId = current.tiles[sourceTileId]?.imageAssetId;
  const source = sourceId ? document.pixelAssets[sourceId] : undefined;
  if (maximumLocalId === undefined || !sourceId || source?.type !== 'sprite') throw new Error(`Image-collection tile ${sourceTileId} or its source is unavailable.`);
  const defaultDestinationTileId = firstUnusedImageCollectionTileId(current, sourceTileId);
  const sourceObservations = imageCollectionSourceDependencyGuards(document, current);
  return Object.freeze({
    documentId: document.id,
    documentRevision: document.revision,
    assetIds: Object.freeze([...document.assetIds]),
    tileIds: Object.freeze(tileIds),
    sourceObservations: Object.freeze(sourceObservations.map((entry) => Object.freeze({
      id: entry.spriteId,
      revision: entry.expectedRevision,
      width: entry.width,
      height: entry.height,
    }))),
    target: Object.freeze({
      id: current.id,
      revision: current.revision,
      name: current.name,
      sourceTileId,
      sourceId,
      sourceName: source.name,
      sourceWidth: source.width,
      sourceHeight: source.height,
      maximumLocalId,
      defaultDestinationTileId,
    }),
  });
}

export function imageCollectionTileMoveOpeningGuardError(
  opening: ImageCollectionTileMoveOpening,
  current: PixelDocument,
  currentTilesetId?: string,
): string | undefined {
  const retry = 'Close this move review and reopen it before trying again.';
  if (current.id !== opening.documentId) return `The active document changed while this move review was open. ${retry}`;
  if (current.revision !== opening.documentRevision) return `The document changed after this tile move was opened. ${retry}`;
  if (!sameValues(opening.assetIds, current.assetIds)) return `The project asset order changed while this move review was open. ${retry}`;
  if (currentTilesetId !== opening.target.id) return `The selected image collection changed while this move review was open. ${retry}`;
  const tileset = current.pixelAssets[opening.target.id];
  if (tileset?.type !== 'tileset' || !isImageCollectionTileset(tileset) || tileset.revision !== opening.target.revision) {
    return `The image collection changed while this move review was open. ${retry}`;
  }
  if (!sameValues(opening.tileIds, imageCollectionTileIds(tileset))) return `The image collection’s sparse tile IDs changed while this move review was open. ${retry}`;
  if (tileset.tiles[opening.target.sourceTileId]?.imageAssetId !== opening.target.sourceId) {
    return `The selected tile source changed while this move review was open. ${retry}`;
  }
  for (const observed of opening.sourceObservations) {
    const source = current.pixelAssets[observed.id];
    if (source?.type !== 'sprite') return `Sprite source ${observed.id} is missing or changed kind. ${retry}`;
    if (source.revision !== observed.revision || source.width !== observed.width || source.height !== observed.height) {
      return `Sprite “${source.name}” changed while this move review was open. ${retry}`;
    }
  }
  return undefined;
}

export function reviewImageCollectionTileMove(
  opening: ImageCollectionTileMoveOpening,
  current: PixelDocument,
  destinationTileId: number,
): ImageCollectionTileMoveReview {
  const guardError = imageCollectionTileMoveOpeningGuardError(opening, current, opening.target.id);
  if (guardError) throw new Error(guardError);
  const plan = planImageCollectionTileIdMove(current, opening.target.id, opening.target.sourceTileId, destinationTileId);
  if (plan.impact.sourceId !== opening.target.sourceId || plan.impact.sourceName !== opening.target.sourceName) {
    throw new Error('The selected tile source changed before the move impact was reviewed. Close this review and reopen it.');
  }
  return Object.freeze({ destinationTileId, impact: freezeImpact(plan.impact) });
}

export function imageCollectionTileMoveReviewsMatch(
  left: ImageCollectionTileMoveReview,
  right: ImageCollectionTileMoveReview,
): boolean {
  return left.destinationTileId === right.destinationTileId && JSON.stringify(left.impact) === JSON.stringify(right.impact);
}
