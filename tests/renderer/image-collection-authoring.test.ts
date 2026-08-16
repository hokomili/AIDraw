import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import { TileAnimationEditor } from '../../src/renderer/components/TileAnimationEditor';
import { ImageCollectionSourceDialog } from '../../src/renderer/components/ImageCollectionSourceDialog';
import {
  ImageCollectionSourceDialogLifecycle,
  createImageCollectionSourceOpening,
} from '../../src/renderer/image-collection-source-opening';

function fixture() {
  const document = createPixelDocument('project', 'Collection inspector');
  const tall = createPixelSprite('Tall tile', 7, 13);
  const wide = createPixelSprite('Wide tile', 19, 5);
  const tileset = createPixelTileset('Sparse collection', tall.id, 7, 13, 1, 1);
  tileset.spriteAssetId = undefined; tileset.columns = 2; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
  tileset.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: tall.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: wide.id, probability: 0.5, animation: [], collisions: [], properties: {} },
  };
  document.assetIds = [tall.id, wide.id, tileset.id]; document.pixelAssets = { [tall.id]: tall, [wide.id]: wide, [tileset.id]: tileset };
  return { document, tileset };
}

afterEach(() => vi.unstubAllGlobals());

describe('image-collection authoring surface', () => {
  it('exposes exact sparse Wang metadata controls through the guarded collection mutation planner', async () => {
    const source = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('planImageCollectionWangMutation(active, tileset, next)');
    expect(source).toContain('expectedSpriteDependencies: plan.expectedSpriteDependencies');
    expect(source).toContain('active.id, plan.expectedDocumentRevision');
    expect(source).toContain('tileId: effectiveSelectedTileId');
    expect(source).toContain('<WangSignatureEditor');
    expect(source).toContain('tileId={effectiveSelectedTileId}');
    expect(source).toContain('wangId={activeTileWangId}');
    expect(source).not.toContain('{!imageCollection && <>\n      <div className="section-heading">\n        <span>Wang terrain</span>');
  });

  it('presents exact authored-order source choices with bounded named controls and honest exclusions', () => {
    const document = createPixelDocument('project', 'Chooser');
    const wide = createPixelSprite('Wide source', 19, 5);
    const animated = createPixelSprite('Animated source', 8, 8);
    animated.frameIds.push('second-frame');
    const tall = createPixelSprite('Tall source', 7, 13);
    document.assetIds = [wide.id, animated.id, tall.id];
    document.pixelAssets = { [wide.id]: wide, [animated.id]: animated, [tall.id]: tall };
    const opening = createImageCollectionSourceOpening(document, 'create');
    const markup = renderToStaticMarkup(createElement(ImageCollectionSourceDialog, {
      opening,
      currentDocument: document,
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(markup.indexOf('Wide source')).toBeLessThan(markup.indexOf('Animated source'));
    expect(markup.indexOf('Animated source')).toBeLessThan(markup.indexOf('Tall source'));
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('Animated source</strong><small>8 × 8px · 2 frames · Sprite “Animated source” has 2 frames. Image-collection sources must be exact one-frame sprites.');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Create with 0 sources');
    expect(markup).toContain('No atlas or sprite copy is created.');

    const { document: appendDocument, tileset } = fixture();
    const newSource = createPixelSprite('New source', 11, 9);
    appendDocument.assetIds.splice(2, 0, newSource.id);
    appendDocument.pixelAssets[newSource.id] = newSource;
    const appendOpening = createImageCollectionSourceOpening(appendDocument, 'append', { tileset });
    const append = renderToStaticMarkup(createElement(ImageCollectionSourceDialog, {
      opening: appendOpening,
      currentDocument: appendDocument,
      currentTilesetId: tileset.id,
      onSubmit: async () => true, onClose: () => undefined,
    }));
    expect(append).toContain('Append to Sparse collection');
    expect(append).toContain('type="radio"');
    expect(append).toContain('above the collection’s opening sparse local-ID span');
  });

  it('keeps opening order and selection stable across parent updates and refuses every relevant drift', () => {
    const { document, tileset } = fixture();
    const newSource = createPixelSprite('New source', 11, 9);
    document.assetIds.splice(2, 0, newSource.id);
    document.pixelAssets[newSource.id] = newSource;
    const opening = createImageCollectionSourceOpening(document, 'create');
    expect(Object.isFrozen(opening)).toBe(true);
    expect(Object.isFrozen(opening.assetIds)).toBe(true);
    expect(Object.isFrozen(opening.choices)).toBe(true);
    const lifecycle = new ImageCollectionSourceDialogLifecycle(opening);
    expect(lifecycle.toggle(newSource.id)).toBeUndefined();

    const stableRerender = structuredClone(document);
    stableRerender.revision += 1;
    expect(lifecycle.observe(stableRerender)).toEqual({
      impactConfirmed: false,
      selectedIds: [newSource.id],
      selectedInAuthoredOrder: [newSource.id],
    });

    const sourceDrift = structuredClone(document);
    const changedSource = sourceDrift.pixelAssets[newSource.id];
    if (changedSource?.type !== 'sprite') throw new Error('Expected sprite fixture.');
    changedSource.revision += 1;
    changedSource.width += 1;
    expect(lifecycle.observe(sourceDrift).contextError).toMatch(/Sprite .* changed.*reopen/iu);
    expect(lifecycle.observe(sourceDrift).selectedInAuthoredOrder).toEqual([newSource.id]);

    const reordered = structuredClone(document);
    [reordered.assetIds[0], reordered.assetIds[1]] = [reordered.assetIds[1], reordered.assetIds[0]];
    expect(lifecycle.observe(reordered).contextError).toMatch(/asset order changed.*reopen/iu);

    const switchedDocument = structuredClone(document);
    switchedDocument.id = 'another-document';
    expect(lifecycle.observe(switchedDocument).contextError).toMatch(/active document changed.*reopen/iu);

    const appendOpening = createImageCollectionSourceOpening(document, 'append', { tileset });
    const appendLifecycle = new ImageCollectionSourceDialogLifecycle(appendOpening);
    expect(appendLifecycle.toggle(newSource.id)).toBeUndefined();
    expect(appendLifecycle.observe(structuredClone(document), tileset.id)).toMatchObject({ impactConfirmed: false, selectedInAuthoredOrder: [newSource.id] });
    expect(appendLifecycle.observe(document, 'another-tileset').contextError).toMatch(/selected image collection changed.*reopen/iu);

    const targetDrift = structuredClone(document);
    const changedTarget = targetDrift.pixelAssets[tileset.id];
    if (changedTarget?.type !== 'tileset') throw new Error('Expected tileset fixture.');
    changedTarget.revision += 1;
    expect(appendLifecycle.observe(targetDrift, tileset.id).contextError).toMatch(/image collection changed.*reopen/iu);

    const refusedMarkup = renderToStaticMarkup(createElement(ImageCollectionSourceDialog, {
      opening,
      currentDocument: reordered,
      onSubmit: async () => true,
      onClose: () => undefined,
    }));
    expect(refusedMarkup).toContain('role="alert"');
    expect(refusedMarkup).toContain('project asset order changed while this chooser was open');
    expect(refusedMarkup).toContain('disabled=""');
  });

  it('freezes exact replacement intent, requires impact confirmation, and refuses context or source drift', () => {
    const { document, tileset } = fixture();
    const replacement = createPixelSprite('Unused replacement', 11, 9);
    const alternative = createPixelSprite('Alternative replacement', 6, 4);
    document.assetIds.splice(2, 0, replacement.id, alternative.id);
    document.pixelAssets[replacement.id] = replacement; document.pixelAssets[alternative.id] = alternative;
    const opening = createImageCollectionSourceOpening(document, 'replace', { tileset, tileId: 3 });
    expect(Object.isFrozen(opening.target)).toBe(true);
    expect(Object.isFrozen(opening.impact)).toBe(true);
    expect(opening).toMatchObject({
      mode: 'replace', documentId: document.id, documentRevision: document.revision,
      target: { id: tileset.id, revision: tileset.revision, tileId: 3, sourceId: tileset.tiles[3].imageAssetId },
      impact: { baseGid: tileset.firstGid + 3, attachedMapCount: 0, directMapCellCount: 0, animationReferenceCount: 0, scannedCellCount: 0 },
    });
    expect(opening.choices.find(({ id }) => id === tileset.tiles[3].imageAssetId)?.unavailableReason).toBe('current source for tile 3');
    expect(opening.choices.find(({ id }) => id === tileset.tiles[0].imageAssetId)?.unavailableReason).toBe('already in this collection');
    const lifecycle = new ImageCollectionSourceDialogLifecycle(opening);
    expect(lifecycle.toggle(replacement.id)).toBeUndefined();
    expect(lifecycle.observe(structuredClone(document), tileset.id)).toMatchObject({ impactConfirmed: false, selectedInAuthoredOrder: [replacement.id] });
    expect(lifecycle.confirmReplacement(true)).toBeUndefined();
    expect(lifecycle.observe(structuredClone(document), tileset.id)).toMatchObject({ impactConfirmed: true, selectedInAuthoredOrder: [replacement.id] });
    expect(lifecycle.toggle(alternative.id)).toBeUndefined();
    expect(lifecycle.observe(structuredClone(document), tileset.id)).toMatchObject({ impactConfirmed: false, selectedInAuthoredOrder: [alternative.id] });

    const documentDrift = structuredClone(document); documentDrift.revision += 1;
    expect(lifecycle.observe(documentDrift, tileset.id).contextError).toMatch(/document changed after this replacement impact was counted.*reopen/iu);
    expect(lifecycle.observe(document, 'another-collection').contextError).toMatch(/selected image collection changed.*reopen/iu);
    const sourceDrift = structuredClone(document);
    const target = sourceDrift.pixelAssets[tileset.id]; if (target.type !== 'tileset') throw new Error('Expected tileset');
    target.tiles[3].imageAssetId = replacement.id;
    expect(lifecycle.observe(sourceDrift, tileset.id).contextError).toMatch(/tile source changed.*reopen/iu);

    const markup = renderToStaticMarkup(createElement(ImageCollectionSourceDialog, {
      opening, currentDocument: document, currentTilesetId: tileset.id,
      onSubmit: async () => true, onClose: () => undefined,
    }));
    expect(markup).toContain('Replace tile 3 source');
    expect(markup).toContain('Document-wide replacement impact');
    expect(markup).toContain('Stable tile 3 · base GID 4');
    expect(markup).toContain('I understand this replaces tile 3 artwork everywhere it is referenced.');
    expect(markup).toContain('Replace source everywhere');
    expect(markup).toContain('current source for tile 3');
  });

  it('freezes exact unused-source removal intent and presents a named no-cascade confirmation', () => {
    const { document, tileset } = fixture();
    const opening = createImageCollectionSourceOpening(document, 'remove', { tileset, tileId: 3 });
    expect(Object.isFrozen(opening.target)).toBe(true);
    expect(Object.isFrozen(opening.removalProof)).toBe(true);
    expect(opening).toMatchObject({
      mode: 'remove', documentId: document.id, documentRevision: document.revision,
      target: { id: tileset.id, revision: tileset.revision, tileId: 3, sourceId: tileset.tiles[3].imageAssetId, sourceName: 'Wide tile' },
      removalProof: { baseGid: tileset.firstGid + 3, sourceId: tileset.tiles[3].imageAssetId, sourceName: 'Wide tile', retainedTileCount: 1, scannedReferenceCount: 0 },
    });
    expect(opening.choices).toEqual([]);
    const lifecycle = new ImageCollectionSourceDialogLifecycle(opening);
    expect(lifecycle.observe(structuredClone(document), tileset.id)).toMatchObject({ impactConfirmed: false, selectedInAuthoredOrder: [] });
    expect(lifecycle.confirmRemoval(true)).toBeUndefined();
    expect(lifecycle.observe(structuredClone(document), tileset.id)).toMatchObject({ impactConfirmed: true, selectedInAuthoredOrder: [] });

    const documentDrift = structuredClone(document); documentDrift.revision += 1;
    expect(lifecycle.observe(documentDrift, tileset.id).contextError).toMatch(/document changed after this unused-source proof.*reopen/iu);
    expect(lifecycle.observe(document, 'another-collection').contextError).toMatch(/selected image collection changed.*reopen/iu);
    const sourceDrift = structuredClone(document); const changedSource = sourceDrift.pixelAssets[tileset.tiles[3].imageAssetId!]; if (changedSource.type !== 'sprite') throw new Error('Expected sprite');
    changedSource.revision += 1;
    expect(lifecycle.observe(sourceDrift, tileset.id).contextError).toMatch(/Sprite .* changed.*reopen/iu);

    const markup = renderToStaticMarkup(createElement(ImageCollectionSourceDialog, {
      opening, currentDocument: document, currentTilesetId: tileset.id,
      onSubmit: async () => true, onClose: () => undefined,
    }));
    expect(markup).toContain('Remove unused tile 3');
    expect(markup).toContain('Unused source removal confirmation');
    expect(markup).toContain(`Tile 3 · Wide tile · source ${tileset.tiles[3].imageAssetId}`);
    expect(markup).toContain('Its local ID becomes a sparse gap');
    expect(markup).toContain('without cascading, rewriting references, or deleting its source sprite');
  });

  it('renders the selected sparse tile at its own dimensions and never offers gap IDs', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { document, tileset } = fixture();
    const staticMarkup = renderToStaticMarkup(createElement(TileAnimationEditor, {
      document, tileset, tile: tileset.tiles[3], tileCount: 2, availableTileIds: [0, 3], onChange: () => undefined,
    }));
    expect(staticMarkup).toContain('Tile 3 · 19 × 5px');
    const animated = { ...tileset.tiles[3], animation: [{ tileId: 3, durationMs: 120 }] };
    const animationMarkup = renderToStaticMarkup(createElement(TileAnimationEditor, {
      document, tileset, tile: animated, tileCount: 2, availableTileIds: [0, 3], onChange: () => undefined,
    }));
    expect(animationMarkup).toContain('title="Existing collection tile ID"');
    expect(animationMarkup).toContain('<option value="0">0</option>');
    expect(animationMarkup).toContain('<option value="3" selected="">3</option>');
    expect(animationMarkup).not.toMatch(/<option value="[12]"/u);
  });

  it('wires sparse selection, metadata-only replacement, exact sources, and the guarded canonical transaction', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('const collectionTileIds = imageCollection ? imageCollectionTileIds(tileset) : undefined;');
    expect(app).toContain('tileIds={displayedTileIds}');
    expect(app).toContain('selectedTileId={effectiveSelectedTileId}');
    expect(app).toContain('sourceKind={imageCollection ? "image-collection" : "atlas"}');
    expect(app).toContain('replaceImageCollectionTileMetadata(tileset, effectiveSelectedTileId, patch)');
    expect(app).toContain('imageCollectionAuthoringGuardError(document, active, tileset.id)');
    expect(app).toContain('imageCollectionSourceDependencyGuards(document, tileset)');
    expect(app).toContain('...(expectedSpriteDependencies ? { expectedSpriteDependencies } : {})');
    expect(app).toContain('imageCollection ? document.id : undefined');
    expect(app).toContain('createImageCollectionTileset(active, name ?? "Image collection", authoredSourceIds)');
    expect(app).toContain('imageCollectionSourceOpeningGuardError(opening, document)');
    expect(app).toContain('imageCollectionSourceOpeningGuardError(opening, active)');
    expect(app).toContain('const authoredSourceIds = opening.assetIds.filter');
    expect(app).toContain('sourceId !== authoredSourceIds[index]');
    expect(app).toContain('Append image-collection source');
    expect(app).toContain('const plan = appendImageCollectionSource(active, targetId, selectedSourceId)');
    expect(app).toContain('expectedRevision: openingTarget.revision');
    expect(app).toContain('expectedSpriteDependencies: plan.expectedSpriteDependencies');
    expect(app).toContain('], active.id, active.revision)');
    expect(app).toContain('createImageCollectionSourceOpening(document, "replace", { tileset, tileId: effectiveSelectedTileId })');
    expect(app).toContain('const plan = replaceImageCollectionSource(active, openingTarget.id, openingTarget.tileId, selectedSourceId)');
    expect(app).toContain('expectedSpriteDependencies: plan.expectedSpriteDependencies');
    expect(app).toContain('], active.id, opening.documentRevision)');
    expect(app).toContain('The replacement source or document-wide impact changed.');
    expect(app).toContain('createImageCollectionSourceOpening(document, "remove", { tileset, tileId: effectiveSelectedTileId })');
    expect(app).toContain('const plan = removeUnusedImageCollectionSource(active, openingTarget.id, openingTarget.tileId)');
    expect(app).toContain('The selected source or unused-reference proof changed.');
    expect(app).toContain('Remove unused image-collection source');
    expect(app).toContain('Remove unused tile {effectiveSelectedTileId}');
    expect(app).toContain('return <TilesetPanel key={`${document.id}:${asset.id}`}');
    expect(app).toContain('<AssetsPanel key={document.id} document={document} />');
    expect(app).toContain('availableTileIds={collectionTileIds}');
    expect(app).toContain('sprite={selectedSource?.sprite');
    expect(app).toContain('width={selectedSource?.rect.width ?? tileset.tileWidth}');
    expect(app).toContain('{!imageCollection && <>');
    expect(app).toContain('Apply drawing offset');
    expect(app).toContain('proven-unused exact-ID removal');
  });
});
