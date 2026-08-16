import {
  HUMAN_ACTOR,
  applyTransaction,
  createId,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  nowIso,
  readPixel,
} from '@aidraw/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrentMapTileControl } from '../../src/renderer/components/CurrentMapTileControl';
import {
  resolveCurrentMapTileDraftValue,
  selectScopedMapTileId,
  selectCurrentMapTileset,
} from '../../src/common/map-tile-authoring';

function fixture() {
  const document = createPixelDocument('project', 'Current tile control');
  const atlasSource = document.pixelAssets[document.activeAssetId]; if (atlasSource.type !== 'sprite') throw new Error('Expected sprite');
  const atlas = createPixelTileset('Terrain atlas', atlasSource.id, 8, 8, 2, 1); atlas.firstGid = 1;
  const small = createPixelSprite('Small grass', 7, 13); const wide = createPixelSprite('Wide gate', 19, 5);
  const collection = createPixelTileset('Sparse props', small.id, 19, 13, 1, 1);
  collection.spriteAssetId = undefined; collection.firstGid = 17; collection.columns = 2; collection.rows = 0; collection.wangSets = [];
  collection.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: small.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: wide.id, probability: 1, animation: [], collisions: [], properties: {} },
  };
  const map = createPixelTilemap('Village'); map.tilesetIds = [atlas.id, collection.id];
  document.pixelAssets[atlas.id] = atlas; document.pixelAssets[small.id] = small; document.pixelAssets[wide.id] = wide; document.pixelAssets[collection.id] = collection; document.pixelAssets[map.id] = map;
  document.assetIds.push(atlas.id, small.id, wide.id, collection.id, map.id);
  return { document, map, atlas, collection };
}

describe('Current map tile control', () => {
  it('names the shared paint/stamp choice and exposes only authored sparse collection IDs', () => {
    const source = fixture();
    const markup = renderToStaticMarkup(createElement(CurrentMapTileControl, {
      document: source.document,
      map: source.map,
      tilesets: [source.atlas, source.collection],
      tilesetId: source.collection.id,
      tileIdDraft: '3',
      onTilesetChange: () => undefined,
      onTileIdDraftChange: () => undefined,
    }));
    expect(markup).toContain('role="group" aria-label="Current map tile"');
    expect(markup).toContain('aria-label="Current tile tileset"');
    expect(markup).toContain('aria-label="Current tile local tile ID"');
    expect(markup).toContain('Sparse props · image collection');
    expect(markup).toContain('0 · Small grass · 7×13');
    expect(markup).toContain('3 · Wide gate · 19×5');
    expect(markup).not.toMatch(/value="1"|value="2"/u);
    expect(markup).toContain('Village: Collection tile 3: Wide gate, 19 × 5 px. Sparse gaps are unavailable.');
    expect(markup).toContain('aria-describedby="current-map-tile-summary"');
  });

  it('retains the predecessor numeric atlas range and summary', () => {
    const source = fixture();
    const markup = renderToStaticMarkup(createElement(CurrentMapTileControl, {
      document: source.document,
      map: source.map,
      tilesets: [source.atlas, source.collection],
      tilesetId: source.atlas.id,
      tileIdDraft: '1',
      onTilesetChange: () => undefined,
      onTileIdDraftChange: () => undefined,
    }));
    expect(markup).toContain('type="number"');
    expect(markup).toContain('min="0"');
    expect(markup).toContain('max="1"');
    expect(markup).toContain('Village: Atlas tile 1: 8 × 8 px source crop.');
  });

  it('retains a high sparse map choice without changing palette intent across asset and document switches', () => {
    const source = fixture();
    const spriteId = source.document.activeAssetId;
    const high = createPixelSprite('Sparse tower 300', 11, 17);
    source.document.pixelAssets[high.id] = high;
    source.document.assetIds.push(high.id);
    source.collection.tiles[300] = {
      id: 300,
      sourceX: 0,
      sourceY: 0,
      imageAssetId: high.id,
      probability: 1,
      animation: [],
      collisions: [],
      properties: {},
    };
    const paletteIndex = 2;
    expect(source.document.palette[paletteIndex]).toBeDefined();

    const collectionChoice = selectCurrentMapTileset({ documentId: source.document.id, mapId: source.map.id }, source.collection, paletteIndex - 1);
    const highChoice = selectScopedMapTileId(collectionChoice.choice, source.collection, '300');
    const highTileObjectChoice = selectScopedMapTileId({ documentId: source.document.id, mapId: source.map.id, tilesetId: source.collection.id }, source.collection, '300');
    let livePixelIndex = paletteIndex;
    if (collectionChoice.nextPixelIndex !== undefined) livePixelIndex = collectionChoice.nextPixelIndex;
    if (highChoice.nextPixelIndex !== undefined) livePixelIndex = highChoice.nextPixelIndex;
    if (highTileObjectChoice.nextPixelIndex !== undefined) livePixelIndex = highTileObjectChoice.nextPixelIndex;
    expect(livePixelIndex).toBe(paletteIndex);
    expect(highChoice.draft).toMatchObject({ documentId: source.document.id, mapId: source.map.id, tilesetId: source.collection.id, value: '300' });
    expect(highTileObjectChoice.draft).toEqual(highChoice.draft);

    source.document.activeAssetId = spriteId;
    const sprite = source.document.pixelAssets[spriteId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const painted = applyTransaction(source.document, {
      id: createId('tx'),
      clientOperationId: createId('op'),
      documentId: source.document.id,
      actor: HUMAN_ACTOR,
      label: 'Paint after high sparse map choice',
      createdAt: nowIso(),
      operations: [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 0, y: 0, index: livePixelIndex }], expectedRevision: cel.revision }],
    });
    if (painted.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const paintedSprite = painted.document.pixelAssets[sprite.id]; if (paintedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(readPixel(Object.values(paintedSprite.cels)[0], 0, 0)).toBe(paletteIndex);

    const other = createPixelDocument('project', 'Other project');
    expect(other.palette[livePixelIndex]).toBeDefined();
    expect(resolveCurrentMapTileDraftValue(highChoice.draft, {
      documentId: other.id,
      mapId: source.map.id,
      tilesetId: source.collection.id,
    }, 0)).toBe('0');

    source.document.activeAssetId = source.map.id;
    expect(resolveCurrentMapTileDraftValue(highChoice.draft, collectionChoice.choice, 0)).toBe('300');
    expect(resolveCurrentMapTileDraftValue(highTileObjectChoice.draft, collectionChoice.choice, 0)).toBe('300');

    const atlasCurrentTileChoice = selectScopedMapTileId({ documentId: source.document.id, mapId: source.map.id, tilesetId: source.atlas.id }, source.atlas, '1');
    const atlasTileObjectChoice = selectScopedMapTileId({ documentId: source.document.id, mapId: source.map.id, tilesetId: source.atlas.id }, source.atlas, '1');
    expect(atlasCurrentTileChoice.nextPixelIndex).toBe(2);
    expect(atlasTileObjectChoice.nextPixelIndex).toBe(2);
  });
});
