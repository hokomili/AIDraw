import type { PixelDocument, PixelTileset } from '@aidraw/core';

import {
  MAX_AUTHORED_IMAGE_COLLECTION_SOURCES,
  imageCollectionSourceEligibility,
  imageCollectionTileIds,
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
  readonly mode: 'create' | 'append';
  readonly documentId: string;
  readonly assetIds: readonly string[];
  readonly choices: readonly ImageCollectionSourceChoice[];
  readonly sourceObservations: readonly ImageCollectionSourceObservation[];
  readonly defaultName?: string;
  readonly target?: { readonly id: string; readonly revision: number; readonly name: string };
}

export interface ImageCollectionSourceDialogView {
  contextError?: string;
  selectedIds: string[];
  selectedInAuthoredOrder: string[];
}

function imageCollectionSourceChoices(document: PixelDocument, tileset?: PixelTileset): ImageCollectionSourceChoice[] {
  const existing = new Set(tileset ? imageCollectionTileIds(tileset).map((tileId) => tileset.tiles[tileId].imageAssetId) : []);
  return document.assetIds.flatMap((assetId) => {
    const asset = document.pixelAssets[assetId];
    if (asset?.type !== 'sprite') return [];
    const unavailableReason = existing.has(asset.id)
      ? 'already in this collection'
      : imageCollectionSourceEligibility(document, asset.id);
    return [{ id: asset.id, name: asset.name, width: asset.width, height: asset.height, frameCount: asset.frameIds.length, unavailableReason }];
  });
}

/** Captures the exact bounded human intent that one open chooser may submit. */
export function createImageCollectionSourceOpening(
  document: PixelDocument,
  mode: 'create' | 'append',
  options: { defaultName?: string; tileset?: PixelTileset } = {},
): ImageCollectionSourceOpening {
  if (mode === 'append' && !options.tileset) throw new Error('Appending requires one exact image collection.');
  const sourceObservations = document.assetIds.flatMap((assetId) => {
    const asset = document.pixelAssets[assetId];
    return asset?.type === 'sprite'
      ? [{ id: asset.id, revision: asset.revision, width: asset.width, height: asset.height, frameCount: asset.frameIds.length }]
      : [];
  });
  return Object.freeze({
    mode,
    documentId: document.id,
    assetIds: Object.freeze([...document.assetIds]),
    choices: Object.freeze(imageCollectionSourceChoices(document, options.tileset).map((choice) => Object.freeze(choice))),
    sourceObservations: Object.freeze(sourceObservations.map((observation) => Object.freeze(observation))),
    ...(options.defaultName ? { defaultName: options.defaultName } : {}),
    ...(options.tileset ? { target: Object.freeze({ id: options.tileset.id, revision: options.tileset.revision, name: options.tileset.name }) } : {}),
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
  if (opening.mode === 'append') {
    if (!opening.target || currentTilesetId !== opening.target.id) return `The selected image collection changed while this chooser was open. ${retry}`;
    const target = current.pixelAssets[opening.target.id];
    if (target?.type !== 'tileset' || target.revision !== opening.target.revision) return `The image collection changed while this chooser was open. ${retry}`;
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

  constructor(opening: ImageCollectionSourceOpening) {
    this.opening = opening;
  }

  toggle(sourceId: string): string | undefined {
    const choice = this.opening.choices.find((entry) => entry.id === sourceId);
    if (!choice || choice.unavailableReason) return 'That sprite source is not available in this chooser.';
    if (this.opening.mode === 'append') {
      this.selectedIds.clear();
      this.selectedIds.add(sourceId);
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

  observe(current: PixelDocument, currentTilesetId?: string): ImageCollectionSourceDialogView {
    const selectedInAuthoredOrder = this.opening.choices
      .filter((choice) => this.selectedIds.has(choice.id))
      .map((choice) => choice.id);
    const contextError = imageCollectionSourceOpeningGuardError(this.opening, current, currentTilesetId);
    return {
      ...(contextError ? { contextError } : {}),
      selectedIds: [...this.selectedIds],
      selectedInAuthoredOrder,
    };
  }
}
