import {
  HUMAN_ACTOR,
  applyTransaction,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  encodeTiledGid,
  nowIso,
  type CanvasTransaction,
  type PixelDocument,
} from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_STAMP_LIBRARY_BYTES,
  MAX_STAMP_LIBRARY_CELLS,
  parseStampLibraryJson,
  prepareStampLibraryImport,
  serializePixelStampLibrary,
  serializeTileStampLibrary,
} from '../../src/common/stamp-library-interchange';

function commit(document: PixelDocument, operations: CanvasTransaction['operations']): PixelDocument {
  const result = applyTransaction(document, { id: 'stamp-library-tx', clientOperationId: 'stamp-library-op', documentId: document.id, actor: HUMAN_ACTOR, label: 'Import stamp library', createdAt: nowIso(), operations }).document;
  if (result.kind !== 'pixel') throw new Error('Expected pixel document');
  return result;
}

function deterministicIds() {
  let sequence = 0;
  return (prefix: string) => `${prefix}-import-${++sequence}`;
}

function tileProject(firstGid = 17) {
  const document = createPixelDocument('project', 'Tile library project'); document.assetIds = []; document.pixelAssets = {};
  const sprite = createPixelSprite('Shared terrain pixels', 32, 16);
  const tileset = createPixelTileset('Shared terrain', sprite.id, 16, 16, 2, 1); tileset.firstGid = firstGid;
  const map = createPixelTilemap('Shared map'); map.tilesetIds = [tileset.id];
  document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
  return { document, sprite, tileset, map };
}

describe('stamp library interchange', () => {
  it('copies a pixel library across documents with exact color remapping and non-destructive append names', () => {
    const source = createPixelDocument('sprite', 'Source stamp library');
    source.palette[2].color = '#123456'; source.palette[3].color = '#abcdef';
    source.stamps = [{ id: 'source-badge', name: 'Badge', width: 3, height: 1, anchorX: 1, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 3 }, { x: 2, y: 0, index: 0 }] }];
    const sourceBefore = structuredClone(source);
    const bundle = parseStampLibraryJson(serializePixelStampLibrary(source));
    expect(bundle).toMatchObject({ format: 'aidraw-stamp-library', version: 1, kind: 'pixel', stamps: [{ id: 'source-badge' }] });

    const target = createPixelDocument('sprite', 'Target stamp library');
    target.palette[5].color = '#abcdef';
    target.stamps = [{ id: 'existing-badge', name: 'Badge', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 1 }] }];
    const originalPaletteLength = target.palette.length;
    const plan = prepareStampLibraryImport(target, bundle, 'append', { makeId: deterministicIds() });
    expect(plan).toMatchObject({ kind: 'pixel', mode: 'append', incomingCount: 1, totalCount: 2, importedIds: ['stamp-import-2'] });
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['pixel.palette.replace', 'pixel.stamps.replace']);
    const imported = commit(target, plan.operations);
    expect(imported.palette).toHaveLength(originalPaletteLength + 1);
    expect(imported.palette.at(-1)).toMatchObject({ id: 'palette-import-1', color: '#123456' });
    expect(imported.stamps[0]).toEqual(target.stamps[0]);
    expect(imported.stamps[1]).toMatchObject({ id: 'stamp-import-2', name: 'Badge (import 2)', cells: [{ index: originalPaletteLength }, { index: 5 }, { index: 0 }] });
    expect(source).toEqual(sourceBefore);
  });

  it('fails closed when an exact pixel color cannot fit and rejects malformed or oversized exchange input', () => {
    const source = createPixelDocument('sprite'); source.palette[2].color = '#123456'; source.stamps = [{ id: 'color', name: 'Color', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }] }];
    const bundle = parseStampLibraryJson(serializePixelStampLibrary(source));
    const full = createPixelDocument('sprite');
    while (full.palette.length < 256) { const index = full.palette.length; full.palette.push({ id: `full-${index}`, name: `Full ${index}`, color: `#${index.toString(16).padStart(6, '0')}` }); }
    expect(() => prepareStampLibraryImport(full, bundle, 'replace', { makeId: deterministicIds() })).toThrow(/palette is full/);
    expect(() => parseStampLibraryJson('{')).toThrow(/malformed/);
    expect(() => parseStampLibraryJson(JSON.stringify({ ...(bundle as object), unexpected: true }))).toThrow(/Unrecognized key/);
    expect(() => parseStampLibraryJson('x'.repeat(MAX_STAMP_LIBRARY_BYTES + 1))).toThrow(/16 MiB/);

    const cells = Array.from({ length: MAX_STAMP_LIBRARY_CELLS + 1 }, (_, index) => ({ x: index % 8_192, y: Math.floor(index / 8_192), index: 1 }));
    const oversizedCells = { format: 'aidraw-stamp-library', version: 1, kind: 'pixel', palette: source.palette, stamps: Array.from({ length: 5 }, (_, index) => ({ id: `many-${index}`, name: `Many ${index}`, width: 8_192, height: 8_192, anchorX: 0, anchorY: 0, cells: cells.slice(index * 65_536, Math.min(cells.length, (index + 1) * 65_536)) })) };
    expect(() => parseStampLibraryJson(JSON.stringify(oversizedCells))).toThrow(/262,144/);
  });

  it('moves exact transformed tile stamps only between maps with the same declared tileset identities', () => {
    const source = tileProject();
    const horizontal = encodeTiledGid(source.tileset.firstGid, { hFlip: true });
    const diagonal = encodeTiledGid(source.tileset.firstGid + 1, { diagonal: true, vFlip: true });
    source.document.tileStamps = [{ id: 'terrain-pair', name: 'Terrain pair', width: 2, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: horizontal }, { x: 1, y: 0, gid: diagonal }] }];
    const bundle = parseStampLibraryJson(serializeTileStampLibrary(source.document, source.map));
    expect(bundle).toMatchObject({ kind: 'tile', tilesets: [{ id: source.tileset.id, firstGid: 17, tileCount: 2 }] });

    const target = structuredClone(source.document); target.id = 'target-tile-document'; target.tileStamps = [{ id: 'existing-terrain', name: 'Terrain pair', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 17 }] }];
    const targetMap = target.pixelAssets[source.map.id]; if (targetMap.type !== 'tilemap') throw new Error('Expected target map');
    const plan = prepareStampLibraryImport(target, bundle, 'append', { map: targetMap, makeId: deterministicIds() });
    const imported = commit(target, plan.operations);
    expect(imported.tileStamps).toHaveLength(2);
    expect(imported.tileStamps[1]).toMatchObject({ id: 'tile-stamp-import-1', name: 'Terrain pair (import 2)', cells: [{ gid: horizontal }, { gid: diagonal }] });

    const mismatched = structuredClone(target); const mismatchedTileset = mismatched.pixelAssets[source.tileset.id]; if (mismatchedTileset.type !== 'tileset') throw new Error('Expected tileset'); mismatchedTileset.revision += 1;
    const mismatchedMap = mismatched.pixelAssets[source.map.id]; if (mismatchedMap.type !== 'tilemap') throw new Error('Expected map');
    expect(() => prepareStampLibraryImport(mismatched, bundle, 'replace', { map: mismatchedMap })).toThrow(/does not match the exported identity/);
  });

  it('refuses unresolved source GIDs and imports replacement libraries without mutating their bundle', () => {
    const source = tileProject(); source.document.tileStamps = [{ id: 'bad-gid', name: 'Bad GID', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: 999 }] }];
    expect(() => serializeTileStampLibrary(source.document, source.map)).toThrow(/cannot resolve/);

    source.document.tileStamps[0].cells[0].gid = source.tileset.firstGid;
    const bundle = parseStampLibraryJson(serializeTileStampLibrary(source.document, source.map)); const before = structuredClone(bundle);
    const target = structuredClone(source.document); target.id = 'replace-target'; target.tileStamps = [{ id: 'old', name: 'Old', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: source.tileset.firstGid }] }];
    const targetMap = target.pixelAssets[source.map.id]; if (targetMap.type !== 'tilemap') throw new Error('Expected target map');
    const plan = prepareStampLibraryImport(target, bundle, 'replace', { map: targetMap });
    expect(plan).toMatchObject({ kind: 'tile', mode: 'replace', incomingCount: 1, totalCount: 1, importedIds: ['bad-gid'] });
    expect(commit(target, plan.operations).tileStamps).toEqual(source.document.tileStamps);
    expect(bundle).toEqual(before);
  });
});
