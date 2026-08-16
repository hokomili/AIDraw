import type { PixelDocument, PixelTileset } from '@aidraw/core';

import {
  MAX_AUTHORED_IMAGE_COLLECTION_SOURCES,
  imageCollectionSourceEligibility,
  imageCollectionSourceRemovalProof,
  imageCollectionSourceReplacementImpact,
  imageCollectionTileIds,
  type ImageCollectionSourceRemovalProof,
  type ImageCollectionSourceReplacementImpact,
} from '../common/image-collection-authoring';

export interface ImageCollectionSourceChoice {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly unavailableReason?: string;
}

interface ImageCollectionSourceObservation {
  readonly id: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
}

export interface ImageCollectionSourceOpening {
  readonly mode: 'create' | 'append' | 'replace' | 'remove';
  readonly documentId: string;
  readonly documentRevision: number;
  readonly assetIds: readonly string[];
  readonly choices: readonly ImageCollectionSourceChoice[];
  readonly sourceObservations: readonly ImageCollectionSourceObservation[];
  readonly defaultName?: string;
  readonly target?: {
    readonly id: string;
    readonly revision: number;
    readonly name: string;
    readonly tileId?: number;
    readonly sourceId?: string;
    readonly sourceName?: string;
  };
  readonly impact?: ImageCollectionSourceReplacementImpact;
  readonly removalProof?: ImageCollectionSourceRemovalProof;
}

export interface ImageCollectionSourceDialogView {
  contextError?: string;
  impactConfirmed: boolean;
  selectedIds: string[];
  selectedInAuthoredOrder: string[];
}

function imageCollectionSourceChoices(document: PixelDocument, tileset?: PixelTileset, replacingTileId?: number): ImageCollectionSourceChoice[] {
  const existing = new Set(tileset ? imageCollectionTileIds(tileset).map((tileId) => tileset.tiles[tileId].imageAssetId) : []);
  const replacingSourceId = replacingTileId === undefined ? undefined : tileset?.tiles[replacingTileId]?.imageAssetId;
  return document.assetIds.flatMap((assetId) => {
    const asset = document.pixelAssets[assetId];
    if (asset?.type !== 'sprite') return [];
    const unavailableReason = asset.id === replacingSourceId
      ? `current source for tile ${replacingTileId}`
      : existing.has(asset.id)
        ? 'already in this collection'
      : imageCollectionSourceEligibility(document, asset.id);
    return [{ id: asset.id, name: asset.name, width: asset.width, height: asset.height, frameCount: asset.frameIds.length, unavailableReason }];
  });
}

/** Captures the exact bounded human intent that one open chooser may submit. */
export function createImageCollectionSourceOpening(
  document: PixelDocument,
  mode: 'create' | 'append' | 'replace' | 'remove',
  options: { defaultName?: string; tileset?: PixelTileset; tileId?: number } = {},
): ImageCollectionSourceOpening {
  if (mode !== 'create' && !options.tileset) throw new Error(`${mode === 'append' ? 'Appending' : mode === 'replace' ? 'Replacement' : 'Removal'} requires one exact image collection.`);
  const targetTile = (mode === 'replace' || mode === 'remove') && options.tileset && options.tileId !== undefined
    ? options.tileset.tiles[options.tileId]
    : undefined;
  if ((mode === 'replace' || mode === 'remove') && (!targetTile?.imageAssetId || options.tileId === undefined)) throw new Error(`${mode === 'replace' ? 'Replacement' : 'Removal'} requires one exact existing image-collection tile.`);
  const impact = mode === 'replace' && options.tileset && options.tileId !== undefined
    ? imageCollectionSourceReplacementImpact(document, options.tileset.id, options.tileId)
    : undefined;
  const removalProof = mode === 'remove' && options.tileset && options.tileId !== undefined
    ? imageCollectionSourceRemovalProof(document, options.tileset.id, options.tileId)
    : undefined;
  const targetSource = targetTile?.imageAssetId ? document.pixelAssets[targetTile.imageAssetId] : undefined;
  const sourceObservations = document.assetIds.flatMap((assetId) => {
    const asset = document.pixelAssets[assetId];
    return asset?.type === 'sprite'
      ? [{ id: asset.id, revision: asset.revision, width: asset.width, height: asset.height, frameCount: asset.frameIds.length }]
      : [];
  });
  return Object.freeze({
    mode,
    documentId: document.id,
    documentRevision: document.revision,
    assetIds: Object.freeze([...document.assetIds]),
    choices: Object.freeze((mode === 'remove' ? [] : imageCollectionSourceChoices(document, options.tileset, options.tileId)).map((choice) => Object.freeze(choice))),
    sourceObservations: Object.freeze(sourceObservations.map((observation) => Object.freeze(observation))),
    ...(options.defaultName ? { defaultName: options.defaultName } : {}),
    ...(options.tileset ? { target: Object.freeze({
      id: options.tileset.id,
      revision: options.tileset.revision,
      name: options.tileset.name,
      ...(options.tileId === undefined ? {} : { tileId: options.tileId, sourceId: targetTile?.imageAssetId, sourceName: targetSource?.name }),
    }) } : {}),
    ...(impact ? { impact: Object.freeze(impact) } : {}),
    ...(removalProof ? { removalProof: Object.freeze(removalProof) } : {}),
  });
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Refuses any parent update that would reinterpret the still-open chooser. */
export function imageCollectionSourceOpeningGuardError(
  opening: ImageCollectionSourceOpening,
  current: PixelDocument,
  currentTilesetId?: string,
): string | undefined {
  const retry = 'Close this chooser and reopen it before trying again.';
  if (current.id !== opening.documentId) return `The active document changed while this chooser was open. ${retry}`;
  if (!sameOrderedIds(opening.assetIds, current.assetIds)) return `The project asset order changed while this chooser was open. ${retry}`;
  if (opening.mode !== 'create') {
    if (!opening.target || currentTilesetId !== opening.target.id) return `The selected image collection changed while this chooser was open. ${retry}`;
    const target = current.pixelAssets[opening.target.id];
    if (target?.type !== 'tileset' || target.revision !== opening.target.revision) return `The image collection changed while this chooser was open. ${retry}`;
    if (opening.mode === 'replace' || opening.mode === 'remove') {
      if (current.revision !== opening.documentRevision) return `The document changed after this ${opening.mode === 'replace' ? 'replacement impact was counted' : 'unused-source proof was computed'}. ${retry}`;
      if (opening.target.tileId === undefined || !opening.target.sourceId || target.tiles[opening.target.tileId]?.imageAssetId !== opening.target.sourceId) {
        return `The selected image-collection tile source changed while this chooser was open. ${retry}`;
      }
    }
  }
  for (const observed of opening.sourceObservations) {
    const source = current.pixelAssets[observed.id];
    if (source?.type !== 'sprite') return `Sprite source ${observed.id} is missing or changed kind. ${retry}`;
    if (
      source.revision !== observed.revision
      || source.width !== observed.width
      || source.height !== observed.height
      || source.frameIds.length !== observed.frameCount
    ) return `Sprite “${source.name}” changed while this chooser was open. ${retry}`;
  }
  return undefined;
}

/**
 * Headless counterpart of the mounted dialog state. The opening and authored
 * order are immutable; parent rerenders only supply a new context to observe.
 */
export class ImageCollectionSourceDialogLifecycle {
  readonly opening: ImageCollectionSourceOpening;
  private readonly selectedIds = new Set<string>();
  private impactConfirmed = false;

  constructor(opening: ImageCollectionSourceOpening) {
    this.opening = opening;
  }

  toggle(sourceId: string): string | undefined {
    const choice = this.opening.choices.find((entry) => entry.id === sourceId);
    if (!choice || choice.unavailableReason) return 'That sprite source is not available in this chooser.';
    if (this.opening.mode !== 'create') {
      this.selectedIds.clear();
      this.selectedIds.add(sourceId);
      if (this.opening.mode === 'replace') this.impactConfirmed = false;
      return undefined;
    }
    if (this.selectedIds.has(sourceId)) {
      this.selectedIds.delete(sourceId);
      return undefined;
    }
    if (this.selectedIds.size >= MAX_AUTHORED_IMAGE_COLLECTION_SOURCES) {
      return `Choose at most ${MAX_AUTHORED_IMAGE_COLLECTION_SOURCES.toLocaleString('en-US')} sprite sources.`;
    }
    this.selectedIds.add(sourceId);
    return undefined;
  }

  confirmReplacement(value: boolean): string | undefined {
    if (this.opening.mode !== 'replace') return 'Only source replacement has a document-wide impact confirmation.';
    this.impactConfirmed = value;
    return undefined;
  }

  confirmRemoval(value: boolean): string | undefined {
    if (this.opening.mode !== 'remove') return 'Only source removal has an unused-tile confirmation.';
    this.impactConfirmed = value;
    return undefined;
  }

  observe(current: PixelDocument, currentTilesetId?: string): ImageCollectionSourceDialogView {
    const selectedInAuthoredOrder = this.opening.choices
      .filter((choice) => this.selectedIds.has(choice.id))
      .map((choice) => choice.id);
    const contextError = imageCollectionSourceOpeningGuardError(this.opening, current, currentTilesetId);
    return {
      ...(contextError ? { contextError } : {}),
      impactConfirmed: this.impactConfirmed,
      selectedIds: [...this.selectedIds],
      selectedInAuthoredOrder,
    };
  }
}
