import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUMAN_ACTOR,
  applyTransaction,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  encodeTiledGid,
  nowIso,
  readTileAt,
  writePixels,
  writeTiles,
} from '@aidraw/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStampLibraryJson, prepareStampLibraryImport, serializePortableTileStampKit } from '../../src/common/stamp-library-interchange';
import { exportDocument } from '../../src/main/export-document';
import { readNativeDocument, writeNativeDocument } from '../../src/main/persistence';
import { renderTilemap } from '../../src/main/render-document';

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function sourceProject() {
  const document = createPixelDocument('project', 'Portable persisted source');
  document.assetIds = []; document.pixelAssets = {};
  const sprite = createPixelSprite('Portable blue pixels', 16, 16);
  writePixels(Object.values(sprite.cels)[0]!, [{ x: 2, y: 3, index: 4 }, { x: 3, y: 3, index: 4 }]);
  const tileset = createPixelTileset('Portable persisted atlas', sprite.id, 16, 16, 1, 1); tileset.firstGid = 33;
  const map = createPixelTilemap('Portable source map'); map.width = 1; map.height = 1; map.tilesetIds = [tileset.id];
  document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map };
  document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
  document.tileStamps = [{ id: 'portable-native-stamp', name: 'Portable native stamp', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: encodeTiledGid(33, { hFlip: true, diagonal: true }) }] }];
  return { document, map };
}

function targetProject() {
  const document = createPixelDocument('project', 'Portable persisted target');
  document.assetIds = []; document.pixelAssets = {};
  const map = createPixelTilemap('Portable target map'); map.width = 1; map.height = 1;
  document.pixelAssets = { [map.id]: map }; document.assetIds = [map.id]; document.activeAssetId = map.id;
  return { document, map };
}

describe('portable tile stamp kit persistence and maintained output', () => {
  it('keeps imported dependencies, transformed GIDs, headless pixels, native state, and Tiled references coherent', async () => {
    const source = sourceProject();
    const target = targetProject();
    const bundle = parseStampLibraryJson(serializePortableTileStampKit(source.document, source.map));
    let sequence = 0;
    const plan = prepareStampLibraryImport(target.document, bundle, 'replace', { map: target.map, makeId: (prefix) => `${prefix}-persisted-${++sequence}` });
    const applied = applyTransaction(target.document, {
      id: 'portable-persistence-tx', clientOperationId: 'portable-persistence-op', documentId: target.document.id,
      expectedDocumentRevision: plan.expectedDocumentRevision, actor: HUMAN_ACTOR, label: 'Import portable persisted kit', createdAt: nowIso(), operations: plan.operations,
    }).document;
    if (applied.kind !== 'pixel') throw new Error('Expected pixel document');
    const importedMap = applied.pixelAssets[target.map.id]; if (importedMap.type !== 'tilemap') throw new Error('Expected imported map');
    const importedTileset = applied.pixelAssets[importedMap.tilesetIds[0]!]; if (importedTileset.type !== 'tileset') throw new Error('Expected imported tileset');
    const rawGid = applied.tileStamps[0]!.cells[0]!.gid;
    const layer = importedMap.layers[importedMap.layerIds[0]!]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: rawGid }]);
    expect(readTileAt(layer.chunks, 0, 0)).toBe(rawGid);
    const raster = renderTilemap(applied, importedMap).getContext('2d').getImageData(0, 0, 16, 16).data;
    expect([...raster].some((value, index) => index % 4 === 3 && value === 255)).toBe(true);

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-portable-stamp-kit-'));
    temporaryDirectories.push(directory);
    const nativePath = await writeNativeDocument(join(directory, 'portable.aidraw'), applied, '1.0.0');
    const reopened = await readNativeDocument(nativePath);
    if (reopened.document.kind !== 'pixel') throw new Error('Expected reopened pixel document');
    const reopenedMap = reopened.document.pixelAssets[target.map.id]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected reopened map');
    const reopenedTileset = reopened.document.pixelAssets[reopenedMap.tilesetIds[0]!]; if (reopenedTileset.type !== 'tileset') throw new Error('Expected reopened tileset');
    expect(reopened.document.tileStamps[0]?.cells[0]?.gid).toBe(rawGid);
    expect(reopenedTileset).toMatchObject({ id: importedTileset.id, firstGid: importedTileset.firstGid, spriteAssetId: importedTileset.spriteAssetId });
    expect(Buffer.from(renderTilemap(reopened.document, reopenedMap).getContext('2d').getImageData(0, 0, 16, 16).data)).toEqual(Buffer.from(raster));

    for (const format of ['tiled-json', 'tiled-xml'] as const) {
      const artifact = await exportDocument(reopened.document, format);
      expect(artifact.report).toEqual({ warnings: [], rasterized: [] });
      expect(artifact.companions).toHaveLength(1);
      if (format === 'tiled-json') {
        const json = JSON.parse(artifact.data.toString());
        expect(json.tilesets[0].firstgid).toBe(importedTileset.firstGid);
        expect(json.layers[0].data[0]).toBe(rawGid);
      } else {
        expect(artifact.data.toString()).toContain(`firstgid="${importedTileset.firstGid}"`);
        expect(artifact.data.toString()).toContain(String(rawGid));
      }
    }
  });
});
