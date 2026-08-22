import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import {
  ImageCollectionTileMoveDialog,
  ImageCollectionTileMoveImpactReview,
} from '../../src/renderer/components/ImageCollectionTileMoveDialog';
import {
  createImageCollectionTileMoveOpening,
  imageCollectionTileMoveOpeningGuardError,
  imageCollectionTileMoveReviewsMatch,
  reviewImageCollectionTileMove,
} from '../../src/renderer/image-collection-tile-move-opening';

function fixture() {
  const document = createPixelDocument('project', 'Move review project');
  const zero = createPixelSprite('Stone zero', 8, 12);
  const three = createPixelSprite('Very long grass source three', 19, 5);
  const seven = createPixelSprite('Arch seven', 6, 14);
  const tileset = createPixelTileset('Sparse environment collection', zero.id, 19, 14, 1, 1);
  tileset.spriteAssetId = undefined;
  tileset.firstGid = 41;
  tileset.columns = 2;
  tileset.rows = 0;
  tileset.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: zero.id, probability: 1, animation: [{ tileId: 3, durationMs: 80 }], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: three.id, probability: 0.5, animation: [{ tileId: 3, durationMs: 120 }], collisions: [], properties: { exact: true } },
    7: { id: 7, sourceX: 0, sourceY: 0, imageAssetId: seven.id, probability: 1, animation: [], collisions: [], properties: {} },
  };
  tileset.wangSets = [{ id: 'wang', name: 'Long terrain set', type: 'mixed', colors: [{ id: 1, name: 'Grass', color: '#55aa66', tileId: 3, probability: 1 }], tiles: [{ tileId: 3, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }] }];
  document.assetIds = [zero.id, three.id, seven.id, tileset.id];
  document.pixelAssets = { [zero.id]: zero, [three.id]: three, [seven.id]: seven, [tileset.id]: tileset };
  document.activeAssetId = tileset.id;
  return { document, tileset, zero, three, seven };
}

describe('image-collection tile move review surface', () => {
  it('deep-freezes exact opening identity and a stable reviewed old-to-new impact', () => {
    const { document, tileset, three } = fixture();
    const opening = createImageCollectionTileMoveOpening(document, tileset, 3);
    expect(opening).toMatchObject({
      documentId: document.id,
      documentRevision: document.revision,
      tileIds: [0, 3, 7],
      target: {
        id: tileset.id, revision: tileset.revision, sourceTileId: 3,
        sourceId: three.id, sourceName: three.name, sourceWidth: 19, sourceHeight: 5,
        maximumLocalId: 7, defaultDestinationTileId: 1,
      },
    });
    expect(Object.isFrozen(opening)).toBe(true);
    expect(Object.isFrozen(opening.assetIds)).toBe(true);
    expect(Object.isFrozen(opening.tileIds)).toBe(true);
    expect(Object.isFrozen(opening.sourceObservations)).toBe(true);
    expect(Object.isFrozen(opening.target)).toBe(true);
    expect(imageCollectionTileMoveOpeningGuardError(opening, structuredClone(document), tileset.id)).toBeUndefined();

    const review = reviewImageCollectionTileMove(opening, document, 2);
    expect(review).toMatchObject({
      destinationTileId: 2,
      impact: {
        tilesetId: tileset.id, sourceTileId: 3, destinationTileId: 2,
        sourceId: three.id, oldBaseGid: 44, newBaseGid: 43, maximumLocalId: 7,
        animationFrameCount: 2, wangColorCount: 1, wangTileCount: 1,
        rewrittenReferenceCount: 4, operationCount: 1,
      },
    });
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(review.impact)).toBe(true);
    expect(Object.isFrozen(review.impact.animations)).toBe(true);
    expect(Object.isFrozen(review.impact.wangSets)).toBe(true);
    expect(imageCollectionTileMoveReviewsMatch(review, reviewImageCollectionTileMove(opening, structuredClone(document), 2))).toBe(true);
  });

  it('refuses document, order, collection, selected-source, and source-dimension drift while a stable rerender stays usable', () => {
    const { document, tileset, three } = fixture();
    const opening = createImageCollectionTileMoveOpening(document, tileset, 3);
    expect(imageCollectionTileMoveOpeningGuardError(opening, structuredClone(document), tileset.id)).toBeUndefined();
    expect(reviewImageCollectionTileMove(opening, structuredClone(document), 2).destinationTileId).toBe(2);

    const documentSwitch = structuredClone(document); documentSwitch.id = 'other-document';
    expect(imageCollectionTileMoveOpeningGuardError(opening, documentSwitch, tileset.id)).toMatch(/active document changed.*reopen/iu);
    const revisionDrift = structuredClone(document); revisionDrift.revision += 1;
    expect(imageCollectionTileMoveOpeningGuardError(opening, revisionDrift, tileset.id)).toMatch(/document changed.*reopen/iu);
    const reorder = structuredClone(document); reorder.assetIds.reverse();
    expect(imageCollectionTileMoveOpeningGuardError(opening, reorder, tileset.id)).toMatch(/asset order changed.*reopen/iu);
    expect(imageCollectionTileMoveOpeningGuardError(opening, document, 'other-collection')).toMatch(/selected image collection changed.*reopen/iu);
    const collectionDrift = structuredClone(document); collectionDrift.pixelAssets[tileset.id].revision += 1;
    expect(imageCollectionTileMoveOpeningGuardError(opening, collectionDrift, tileset.id)).toMatch(/image collection changed.*reopen/iu);
    const selectedSourceDrift = structuredClone(document); const changedTileset = selectedSourceDrift.pixelAssets[tileset.id]; if (changedTileset.type !== 'tileset') throw new Error('Expected tileset.');
    changedTileset.tiles[3].imageAssetId = changedTileset.tiles[0].imageAssetId;
    expect(imageCollectionTileMoveOpeningGuardError(opening, selectedSourceDrift, tileset.id)).toMatch(/selected tile source changed.*reopen/iu);
    const sourceDrift = structuredClone(document); const changedSource = sourceDrift.pixelAssets[three.id]; if (changedSource.type !== 'sprite') throw new Error('Expected sprite.');
    changedSource.width += 1;
    expect(imageCollectionTileMoveOpeningGuardError(opening, sourceDrift, tileset.id)).toMatch(/Sprite .* changed.*reopen/iu);
  });

  it('renders explicit native review controls and every frozen impact identity without color-only authority', () => {
    const { document, tileset } = fixture();
    const opening = createImageCollectionTileMoveOpening(document, tileset, 3);
    const dialog = renderToStaticMarkup(createElement(ImageCollectionTileMoveDialog, {
      opening,
      currentDocument: document,
      currentTilesetId: tileset.id,
      onReview: (candidate, destinationTileId) => reviewImageCollectionTileMove(candidate, document, destinationTileId),
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(dialog).toContain('Move image-collection tile 3');
    expect(dialog).toContain('Very long grass source three');
    expect(dialog).toContain('Source ');
    expect(dialog).toContain('19 × 5px');
    expect(dialog).toContain('Unused destination local ID');
    expect(dialog).toContain('type="number"');
    expect(dialog).toContain('value="1"');
    expect(dialog).toContain('Review exact old→new impact');
    expect(dialog).toContain('Review before Apply');
    expect(dialog).toContain('Cancel');

    const review = reviewImageCollectionTileMove(opening, document, 2);
    const summary = renderToStaticMarkup(createElement(ImageCollectionTileMoveImpactReview, {
      review, confirmed: false, disabled: false, onConfirm: () => undefined,
    }));
    expect(summary).toContain('aria-label="Exact tile ID move impact"');
    expect(summary).toContain('Tile 3 → 2 · GID 44 → 43');
    expect(summary).toContain('4 direct references');
    expect(summary).toContain('0 attached maps checked; 0 contain direct references');
    expect(summary).toContain('2 animation frame targets');
    expect(summary).toContain('1 Wang representative');
    expect(summary).toContain('1 Wang signature record');
    expect(summary).toContain('type="checkbox"');
    expect(summary).toContain('I reviewed tile 3 → 2');
    expect(summary).toContain('H/V/diagonal flags');
  });

  it('wires review, exact frozen comparison, canonical operations, document admission, and post-success selection', async () => {
    const source = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('createImageCollectionTileMoveOpening(document, tileset, effectiveSelectedTileId)');
    expect(source).toContain('reviewImageCollectionTileMove(opening, active, destinationTileId)');
    expect(source).toContain('imageCollectionTileMoveOpeningGuardError(opening, document, tileset.id)');
    expect(source).toContain('imageCollectionTileMoveOpeningGuardError(opening, active, tileset.id)');
    expect(source).toContain('imageCollectionTileMoveReviewsMatch(review, currentReview)');
    expect(source).toContain('planImageCollectionTileIdMove(active, opening.target.id, opening.target.sourceTileId, review.destinationTileId)');
    expect(source).toContain('"Move image-collection tile ID"');
    expect(source).toContain('plan.operations');
    expect(source).toContain('opening.documentRevision');
    expect(source).toContain('setSelectedTileId(review.destinationTileId)');
    expect(source).toContain('Move tile {effectiveSelectedTileId} into gap');
  });
});
