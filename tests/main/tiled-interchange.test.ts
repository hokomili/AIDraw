import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, encodeTiledGid, readPixel, readTileAt, writePixels, writeTiles, type CollisionShape, type PixelSprite } from '@aidraw/core';
import UPNG from 'upng-js';

import { importDocument } from '../../src/main/import-document';
import { exportDocument } from '../../src/main/export-document';
import { readNativeDocument, writeNativeDocument } from '../../src/main/persistence';
import { renderSprite, renderTilemap, renderTilemapRegion } from '../../src/main/render-document';
import { runImportUtilityRequest } from '../../src/main/utility-import';
import { editTileObject } from '../../src/common/tile-object-authoring';
import { appendImageCollectionSource, createImageCollectionTileset, removeUnusedImageCollectionSource, replaceImageCollectionSource } from '../../src/common/image-collection-authoring';

const fixture = new URL('../fixtures/tiled/isometric-external.tmj', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const xmlFixtureSource = new URL('../fixtures/tiled/orthogonal-external.tmx', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const xmlTilesetSource = new URL('../fixtures/tiled/terrain.tsx.fixture', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function exactPng(width: number, height: number, rgba: number[]): Buffer {
  const pixels = Uint8Array.from(rgba);
  if (pixels.length !== width * height * 4) throw new Error('PNG fixture pixels do not match its dimensions.');
  return Buffer.from(UPNG.encode([pixels.buffer as ArrayBuffer], width, height, 0));
}

describe('representative Tiled JSON interchange', () => {
  it('imports an external tileset with typed metadata, collisions, Wang colors, transforms, and nested isometric layers', async () => {
    const result = await importDocument(fixture, true); expect(result.warnings).toEqual([]); const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map).toMatchObject({ orientation: 'isometric', infinite: false, width: 2, height: 2, tileWidth: 16, tileHeight: 16, properties: { weather: 'snow', seed: 42 } });
    const group = map.layers[map.layerIds[0]]; expect(group).toMatchObject({ type: 'group', name: 'World', opacity: 0.8 }); if (group.type !== 'group') throw new Error('Expected group');
    const tileLayer = map.layers[group.childIds![0]]; const objectLayer = map.layers[group.childIds![1]]; if (tileLayer.type !== 'tile' || objectLayer.type !== 'object') throw new Error('Expected nested tile and object layers');
    expect(tileLayer).toMatchObject({ name: 'Rails', parallaxX: 0.75, parallaxY: 0.5 }); expect(readTileAt(tileLayer.chunks!, 0, 0)).toBe(17); expect(readTileAt(tileLayer.chunks!, 1, 0)).toBe(2_147_483_666);
    expect(objectLayer.objects?.[0]).toMatchObject({ type: 'polygon', properties: { name: 'Signal zone', class: 'trigger', enabled: true }, points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 4, y: 9 }] });
    const tileset = document.pixelAssets[map.tilesetIds[0]]; if (tileset.type !== 'tileset') throw new Error('Expected tileset');
    expect(tileset).toMatchObject({ firstGid: 17, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1, tileOffset: { x: -3, y: 5 }, transformations: { hFlip: true, vFlip: false, rotate: true } });
    expect(tileset.tiles[0]).toMatchObject({ probability: 0.25, animation: [{ tileId: 1, durationMs: 120 }, { tileId: 0, durationMs: 80 }, { tileId: 1, durationMs: 200 }], properties: { walkable: true, cost: 3 } });
    expect(tileset.tiles[0].collisions[0]).toMatchObject({ type: 'rectangle', x: 1, y: 2, width: 14, height: 12, properties: { name: 'Footprint', class: 'solid', damage: 2 } });
    expect(tileset.wangSets[0]).toMatchObject({ name: 'Track edge', type: 'mixed', colors: [{ name: 'Rail', color: '#c9953d', tileId: 0, probability: 1 }], tiles: [{ tileId: 0, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }] });
  });

  it('exports current Tiled JSON field names and exact property types', async () => {
    const imported = await importDocument(fixture, true); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const artifact = await exportDocument(document, 'tiled-json'); const output = JSON.parse(artifact.data.toString());
    const tileset = output.tilesets[0]; expect(tileset.tileoffset).toEqual({ x: -3, y: 5 }); expect(tileset.wangsets[0].colors).toEqual([expect.objectContaining({ name: 'Rail' })]); expect(tileset.wangsets[0].wangcolors).toBeUndefined();
    expect(tileset.tiles[0].properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'walkable', type: 'bool', value: true }), expect.objectContaining({ name: 'cost', type: 'int', value: 3 })]));
    expect(tileset.tiles[0].objectgroup.objects[0]).toMatchObject({ name: 'Footprint', type: 'solid', properties: [expect.objectContaining({ name: 'damage', type: 'int', value: 2 })] });
    expect(output.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'seed', type: 'int', value: 42 })]));
  });

  it('round-trips ordered tile animation, probability, typed properties, and collision metadata from the external TMJ/TSJ fixture', async () => {
    const imported = await importDocument(fixture, true); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const artifact = await exportDocument(document, 'tiled-json'); expect(artifact.report).toEqual({ warnings: [], rasterized: [] });
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-json-fixture-roundtrip-')); temporaryDirectories.push(directory);
    const mapPath = join(directory, 'fixture-roundtrip.tmj');
    await Promise.all([writeFile(mapPath, artifact.data), ...(artifact.companions ?? []).map((companion) => writeFile(join(directory, companion.name), companion.data))]);
    const reopened = await importDocument(mapPath, true); expect(reopened.warnings).toEqual([]); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected reopened pixel document');
    const map = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected reopened tilemap');
    const tileset = reopenedDocument.pixelAssets[map.tilesetIds[0]]; if (tileset.type !== 'tileset') throw new Error('Expected reopened tileset');
    expect(tileset.tileOffset).toEqual({ x: -3, y: 5 });
    expect(tileset.tiles[0]).toMatchObject({
      probability: 0.25,
      animation: [{ tileId: 1, durationMs: 120 }, { tileId: 0, durationMs: 80 }, { tileId: 1, durationMs: 200 }],
      properties: { walkable: true, cost: 3 },
      collisions: [expect.objectContaining({ type: 'rectangle', x: 1, y: 2, width: 14, height: 12, properties: { name: 'Footprint', class: 'solid', damage: 2 } })],
    });
    expect(tileset.tiles[1]).toMatchObject({ probability: 0.75, animation: [] });
  });

  it('round-trips sanitization-colliding tileset names through distinct referenced PNG companions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-companion-collisions-')); temporaryDirectories.push(directory);
    const document = createPixelDocument('project', 'Tiled companion collisions'); document.assetIds = []; document.pixelAssets = {};
    const firstSprite = createPixelSprite('First pixels', 1, 1); writePixels(Object.values(firstSprite.cels)[0], [{ x: 0, y: 0, index: 2 }]);
    const secondSprite = createPixelSprite('Second pixels', 1, 1); writePixels(Object.values(secondSprite.cels)[0], [{ x: 0, y: 0, index: 4 }]);
    const first = createPixelTileset('Terrain/Day', firstSprite.id, 1, 1, 1, 1); first.id = 'first-tileset'; first.firstGid = 1;
    const second = createPixelTileset('terrain:day', secondSprite.id, 1, 1, 1, 1); second.id = 'second-tileset'; second.firstGid = 2;
    const map = createPixelTilemap('Collision map'); map.width = 2; map.height = 1; map.tileWidth = 1; map.tileHeight = 1; map.tilesetIds = [first.id, second.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer'); writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 1 }, { x: 1, y: 0, gid: 2 }]);
    document.pixelAssets = { [firstSprite.id]: firstSprite, [secondSprite.id]: secondSprite, [first.id]: first, [second.id]: second, [map.id]: map }; document.assetIds = [firstSprite.id, secondSprite.id, first.id, second.id, map.id]; document.activeAssetId = map.id;
    const sourcePixels = Buffer.from(renderTilemap(document, map).getContext('2d').getImageData(0, 0, 2, 1).data);

    const artifact = await exportDocument(document, 'tiled-json'); const names = artifact.companions?.map((companion) => companion.name) ?? [];
    expect(names).toEqual(['Terrain-Day.png', 'terrain-day (2).png']);
    const mapPath = join(directory, 'collision-map.tmj');
    await Promise.all([writeFile(mapPath, artifact.data, { flag: 'wx' }), ...artifact.companions!.map((companion) => writeFile(join(directory, companion.name), companion.data, { flag: 'wx' }))]);
    expect((await readdir(directory)).sort()).toEqual(['collision-map.tmj', ...names].sort());

    const imported = await runImportUtilityRequest({ id: 'companion-collision-roundtrip', kind: 'import-document', filePath: mapPath, pixelMode: true }); expect(imported.warnings).toEqual([]);
    const reopened = imported.documents[0]; if (reopened.kind !== 'pixel') throw new Error('Expected pixel document');
    const reopenedMap = reopened.pixelAssets[reopened.activeAssetId]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(reopenedMap.tilesetIds.map((id) => reopened.pixelAssets[id].name)).toEqual(['Terrain/Day', 'terrain:day']);
    expect(Buffer.from(renderTilemap(reopened, reopenedMap).getContext('2d').getImageData(0, 0, 2, 1).data)).toEqual(sourcePixels);
  });

  it('emits one stable numeric object namespace across inline tileset and map object groups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-object-ids-')); temporaryDirectories.push(directory);
    const shape = (id: string, name: string, x: number): CollisionShape => ({ id, type: 'rectangle', x, y: 0, width: 1, height: 1, properties: { name } });
    const document = createPixelDocument('project', 'Tiled object IDs'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Object pixels', 1, 1);
    const tileset = createPixelTileset('Object tileset', sprite.id, 1, 1, 1, 1); tileset.firstGid = 1;
    tileset.tiles[0] = { id: 0, sourceX: 0, sourceY: 0, probability: 1, animation: [], properties: {}, collisions: [shape('uuid-12-34', 'Opaque collision', 0), shape('7', 'Exact collision', 1)] };
    const map = createPixelTilemap('Object map'); map.tilesetIds = [tileset.id];
    const objectLayer = map.layers[map.layerIds[0]]; objectLayer.type = 'object'; delete objectLayer.chunks; objectLayer.objects = [shape('1234', 'Exact map object', 2), shape('also-12-34', 'Second opaque object', 3)];
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const objectIds = (bytes: Buffer) => {
      const output = JSON.parse(bytes.toString()) as { tilesets: Array<{ tiles: Array<{ objectgroup?: { objects: Array<{ id: number }> } }> }>; layers: Array<{ objects?: Array<{ id: number }> }> };
      return [...(output.tilesets[0].tiles[0].objectgroup?.objects ?? []), ...(output.layers[0].objects ?? [])].map((object) => object.id);
    };
    const first = await exportDocument(document, 'tiled-json'); expect(objectIds(first.data)).toEqual([1, 7, 1234, 2]);
    const xml = await exportDocument(document, 'tiled-xml'); expect([...xml.data.toString().matchAll(/<object id="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([1, 7, 1234, 2]);
    const mapPath = join(directory, 'object-ids.tmj');
    await Promise.all([writeFile(mapPath, first.data, { flag: 'wx' }), ...first.companions!.map((companion) => writeFile(join(directory, companion.name), companion.data, { flag: 'wx' }))]);
    const imported = await runImportUtilityRequest({ id: 'object-id-roundtrip', kind: 'import-document', filePath: mapPath, pixelMode: true }); expect(imported.warnings).toEqual([]);
    const second = await exportDocument(imported.documents[0], 'tiled-json'); expect(objectIds(second.data)).toEqual([1, 7, 1234, 2]);
    expect(new Set(objectIds(second.data)).size).toBe(4);
  });

  it('imports an external TSX through TMX with typed properties and geometry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tmx-fixture-')); temporaryDirectories.push(directory); const xmlFixture = join(directory, basename(xmlFixtureSource)); await Promise.all([copyFile(xmlFixtureSource, xmlFixture), copyFile(xmlTilesetSource, join(directory, 'terrain.tsx'))]);
    const result = await importDocument(xmlFixture, true); expect(result.warnings).toEqual([]); const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map).toMatchObject({ orientation: 'orthogonal', width: 2, height: 2, properties: { chapter: 7 } }); const group = map.layers[map.layerIds[0]]; if (group.type !== 'group') throw new Error('Expected group'); expect(group).toMatchObject({ name: 'XML World', opacity: 0.6 });
    const ground = map.layers[group.childIds![0]]; const zones = map.layers[group.childIds![1]]; if (ground.type !== 'tile' || zones.type !== 'object') throw new Error('Expected tile and object layers'); expect(readTileAt(ground.chunks!, 1, 0)).toBe(10); expect(ground).toMatchObject({ parallaxX: 0.5, parallaxY: 0.25 }); expect(zones.objects?.[0]).toMatchObject({ type: 'rectangle', properties: { name: 'Spawn', class: 'start', team: 'blue' } });
    const tileset = document.pixelAssets[map.tilesetIds[0]]; if (tileset.type !== 'tileset') throw new Error('Expected tileset'); expect(tileset).toMatchObject({ firstGid: 9, tileOffset: { x: 4, y: -6 }, transformations: { hFlip: true, vFlip: true, rotate: false } }); expect(tileset.tiles[0]).toMatchObject({ probability: 0.4, animation: [{ tileId: 1, durationMs: 90 }, { tileId: 0, durationMs: 60 }], properties: { friction: 0.75 } }); expect(tileset.tiles[0].collisions[0]).toMatchObject({ type: 'polyline', properties: { name: 'Slope', class: 'ramp', oneWay: true }, points: [{ x: 0, y: 16 }, { x: 8, y: 8 }, { x: 16, y: 0 }] }); expect(tileset.wangSets[0]).toMatchObject({ name: 'XML edge', type: 'edge', colors: [{ name: 'Stone', color: '#8794a8', tileId: 1, probability: 0.5 }] });
  });

  it('round-trips ordered tile animation, probability, typed properties, and collision metadata from the external TMX/TSX fixture', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'aidraw-tmx-fixture-source-')); temporaryDirectories.push(sourceDirectory);
    const sourceMap = join(sourceDirectory, basename(xmlFixtureSource));
    await Promise.all([copyFile(xmlFixtureSource, sourceMap), copyFile(xmlTilesetSource, join(sourceDirectory, 'terrain.tsx'))]);
    const imported = await importDocument(sourceMap, true); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const artifact = await exportDocument(document, 'tiled-xml'); expect(artifact.report).toEqual({ warnings: [], rasterized: [] }); expect(artifact.data.toString()).toContain('<tileoffset x="4" y="-6"/>');
    const outputDirectory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-xml-fixture-roundtrip-')); temporaryDirectories.push(outputDirectory);
    const mapPath = join(outputDirectory, 'fixture-roundtrip.tmx');
    await Promise.all([writeFile(mapPath, artifact.data), ...(artifact.companions ?? []).map((companion) => writeFile(join(outputDirectory, companion.name), companion.data))]);
    const reopened = await importDocument(mapPath, true); expect(reopened.warnings).toEqual([]); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected reopened pixel document');
    const map = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected reopened tilemap');
    const tileset = reopenedDocument.pixelAssets[map.tilesetIds[0]]; if (tileset.type !== 'tileset') throw new Error('Expected reopened tileset');
    expect(tileset.tileOffset).toEqual({ x: 4, y: -6 });
    expect(tileset.tiles[0]).toMatchObject({
      probability: 0.4,
      animation: [{ tileId: 1, durationMs: 90 }, { tileId: 0, durationMs: 60 }],
      properties: { friction: 0.75 },
      collisions: [expect.objectContaining({ type: 'polyline', properties: { name: 'Slope', class: 'ramp', oneWay: true }, points: [{ x: 0, y: 16 }, { x: 8, y: 8 }, { x: 16, y: 0 }] })],
    });
  });

  it('emits optional tile offsets through embedded TMJ/TMX and standalone TSJ/TSX while omitting zero', async () => {
    const document = createPixelDocument('project', 'Tile offset interchange'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Offset pixels', 2, 2);
    const tileset = createPixelTileset('Offset tiles', sprite.id, 2, 2, 1, 1); tileset.firstGid = 1; tileset.tileOffset = { x: -7, y: 11 };
    const map = createPixelTilemap('Offset map'); map.width = 1; map.height = 1; map.tileWidth = 2; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer'); writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 1 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id];

    document.activeAssetId = map.id;
    const tmj = await exportDocument(document, 'tiled-json'); const tmx = await exportDocument(document, 'tiled-xml');
    expect(tmj.extension).toBe('tmj'); expect(JSON.parse(tmj.data.toString()).tilesets[0].tileoffset).toEqual({ x: -7, y: 11 });
    expect(tmx.extension).toBe('tmx'); expect(tmx.data.toString()).toContain('<tileoffset x="-7" y="11"/>');

    document.activeAssetId = tileset.id;
    const tsj = await exportDocument(document, 'tiled-json'); const tsx = await exportDocument(document, 'tiled-xml');
    expect(tsj.extension).toBe('tsj'); expect(JSON.parse(tsj.data.toString()).tileoffset).toEqual({ x: -7, y: 11 });
    expect(tsx.extension).toBe('tsx'); expect(tsx.data.toString()).toContain('<tileoffset x="-7" y="11"/>');

    tileset.tileOffset = { x: 0, y: 0 };
    const zeroJson = await exportDocument(document, 'tiled-json'); const zeroXml = await exportDocument(document, 'tiled-xml');
    expect(JSON.parse(zeroJson.data.toString()).tileoffset).toBeUndefined();
    expect(zeroXml.data.toString()).not.toContain('<tileoffset');
  });

  it.each([
    { tilesetFormat: 'tiled-json' as const, tilesetName: 'objects.tsj', mapName: 'objects.tmj' },
    { tilesetFormat: 'tiled-xml' as const, tilesetName: 'objects.tsx', mapName: 'objects.tmx' },
  ])('round-trips external $tilesetName object alignment and transformed tile objects', async ({ tilesetFormat, tilesetName, mapName }) => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-tile-objects-')); temporaryDirectories.push(directory);
    const source = createPixelDocument('project', 'Tile object source'); const sprite = source.pixelAssets[source.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.width = 2; sprite.height = 3; writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 2 }, { x: 1, y: 2, index: 4 }]);
    const tileset = createPixelTileset('Object artwork', sprite.id, 2, 3, 1, 1); tileset.firstGid = 17; tileset.objectAlignment = 'topright'; tileset.tileOffset = { x: 2, y: -1 }; source.pixelAssets[tileset.id] = tileset; source.assetIds.push(tileset.id); source.activeAssetId = tileset.id;
    const tilesetArtifact = await exportDocument(source, tilesetFormat);
    await Promise.all([writeFile(join(directory, tilesetName), tilesetArtifact.data), ...(tilesetArtifact.companions ?? []).map((companion) => writeFile(join(directory, companion.name), companion.data))]);

    const gid = encodeTiledGid(17, { hFlip: true, diagonal: true });
    const mapPath = join(directory, mapName);
    if (mapName.endsWith('.tmj')) await writeFile(mapPath, JSON.stringify({ type: 'map', orientation: 'orthogonal', infinite: false, width: 4, height: 4, tilewidth: 2, tileheight: 3, tilesets: [{ firstgid: 17, source: tilesetName }], layers: [{ id: 1, type: 'objectgroup', name: 'Actors', objects: [{ id: 8, name: 'Gate', class: 'portal', gid, x: 7, y: 11, width: 6, height: 8, rotation: 30, properties: [{ name: 'target', type: 'string', value: 'north' }] }] }] }));
    else await writeFile(mapPath, `<?xml version="1.0"?><map orientation="orthogonal" infinite="0" width="4" height="4" tilewidth="2" tileheight="3"><tileset firstgid="17" source="${tilesetName}"/><objectgroup id="1" name="Actors"><object id="8" name="Gate" type="portal" gid="${gid}" x="7" y="11" width="6" height="8" rotation="30"><properties><property name="target" value="north"/></properties></object></objectgroup></map>`);

    const imported = await importDocument(mapPath, true); expect(imported.warnings).toEqual([]); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap'); const importedTileset = document.pixelAssets[map.tilesetIds[0]]; if (importedTileset.type !== 'tileset') throw new Error('Expected tileset'); const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'object') throw new Error('Expected object layer');
    expect(importedTileset).toMatchObject({ firstGid: 17, objectAlignment: 'topright', tileOffset: { x: 2, y: -1 } });
    expect(layer.objects?.[0]).toEqual({ id: '8', type: 'tile', gid, x: 7, y: 11, width: 6, height: 8, rotation: 30, name: 'Gate', className: 'portal', properties: { target: 'north' } });
    const importedObject = layer.objects?.[0]; if (!importedObject || importedObject.type !== 'tile') throw new Error('Expected tile object');
    layer.objects![0] = editTileObject(importedObject, { ...importedObject, x: 9, y: 13, width: 7, height: 9, rotation: 45, name: 'Edited gate', className: 'portal-exit', properties: { target: 'south', cost: 2, open: true } });
    importedTileset.objectAlignment = 'bottom';

    const output = await exportDocument(document, mapName.endsWith('.tmj') ? 'tiled-json' : 'tiled-xml');
    if (mapName.endsWith('.tmj')) {
      const value = JSON.parse(output.data.toString()); expect(value.tilesets[0].objectalignment).toBe('bottom'); expect(value.layers[0].objects[0]).toMatchObject({ gid, x: 9, y: 13, width: 7, height: 9, rotation: 45, name: 'Edited gate', type: 'portal-exit', properties: expect.arrayContaining([expect.objectContaining({ name: 'target', value: 'south' }), expect.objectContaining({ name: 'cost', value: 2 }), expect.objectContaining({ name: 'open', value: true })]) });
    } else {
      expect(output.data.toString()).toContain('objectalignment="bottom"'); expect(output.data.toString()).toContain(`name="Edited gate" type="portal-exit" gid="${gid}" x="9" y="13" width="7" height="9" rotation="45"`); expect(output.data.toString()).toContain('<property name="cost" type="int" value="2"/>'); expect(output.data.toString()).toContain('<property name="open" type="bool" value="true"/>');
    }
  });

  it('omits unspecified object alignment from predecessor-compatible TSJ and TSX output and rejects unknown values', async () => {
    const document = createPixelDocument('project', 'Object alignment omission'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const tileset = createPixelTileset('Default alignment', sprite.id, 1, 1, 1, 1); document.pixelAssets[tileset.id] = tileset; document.assetIds.push(tileset.id); document.activeAssetId = tileset.id;
    expect(JSON.parse((await exportDocument(document, 'tiled-json')).data.toString()).objectalignment).toBeUndefined();
    expect((await exportDocument(document, 'tiled-xml')).data.toString()).not.toContain('objectalignment=');
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-object-alignment-')); temporaryDirectories.push(directory); const sourcePath = join(directory, 'invalid.tsj'); await writeFile(sourcePath, JSON.stringify({ type: 'tileset', name: 'Invalid', tilewidth: 1, tileheight: 1, tilecount: 1, columns: 1, objectalignment: 'baseline' }));
    await expect(importDocument(sourcePath, true)).rejects.toThrow('Unsupported Tiled tile-object alignment: baseline');
  });

  it('does not flatten tile objects nested in tileset collision groups into vector collision geometry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-collision-tile-object-')); temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'collision-tile-object.tsj');
    await writeFile(sourcePath, JSON.stringify({
      type: 'tileset', name: 'Collision boundary', tilewidth: 1, tileheight: 1, tilecount: 1, columns: 1,
      tiles: [{ id: 0, objectgroup: { objects: [{ id: 1, gid: 1, x: 0, y: 1, width: 1, height: 1 }] } }],
    }));
    await expect(importDocument(sourcePath, true)).rejects.toThrow('Tiled tile objects inside tileset collision groups are not supported.');
  });

  it('rejects an external tileset drawing offset outside the canonical signed-integer bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-offset-bound-')); temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'oversized-offset.tsj');
    await writeFile(sourcePath, JSON.stringify({
      type: 'tileset', version: '1.10', tiledversion: '1.11.2', name: 'Oversized offset',
      tilewidth: 1, tileheight: 1, tilecount: 1, columns: 1,
      tileoffset: { x: 16_777_217, y: 0 },
    }));
    await expect(importDocument(sourcePath, true)).rejects.toThrow('Tileset drawing offset x must be an integer from -16777216 to 16777216.');
  });

  it('round-trips signed tile, object, and nested group offsets through TMJ and TMX while omitting zero defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-layer-offsets-')); temporaryDirectories.push(directory);
    const jsonPath = join(directory, 'offsets.tmj');
    await writeFile(jsonPath, JSON.stringify({
      type: 'map', version: '1.10', tiledversion: '1.11.2', orientation: 'orthogonal', infinite: false,
      width: 2, height: 2, tilewidth: 4, tileheight: 4,
      layers: [{ id: 1, name: 'World', type: 'group', offsetx: 7, offsety: -5, layers: [
        { id: 2, name: 'Ground', type: 'tilelayer', width: 2, height: 2, offsetx: -2, offsety: 3, data: [0, 0, 0, 0] },
        { id: 3, name: 'Objects', type: 'objectgroup', offsetx: 4, offsety: 1, objects: [{ id: 1, name: 'Marker', type: '', x: 0, y: 0, width: 1, height: 1 }] },
      ] }], tilesets: [],
    }));
    const imported = await importDocument(jsonPath, true); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    const group = map.layers[map.layerIds[0]]; if (group.type !== 'group') throw new Error('Expected group'); const ground = map.layers[group.childIds![0]]; const objects = map.layers[group.childIds![1]];
    expect(group).toMatchObject({ offsetX: 7, offsetY: -5 }); expect(ground).toMatchObject({ type: 'tile', offsetX: -2, offsetY: 3 }); expect(objects).toMatchObject({ type: 'object', offsetX: 4, offsetY: 1 });

    const json = await exportDocument(document, 'tiled-json'); const jsonLayers = JSON.parse(json.data.toString()).layers;
    expect(jsonLayers[0]).toMatchObject({ offsetx: 7, offsety: -5, layers: [expect.objectContaining({ offsetx: -2, offsety: 3 }), expect.objectContaining({ offsetx: 4, offsety: 1 })] });
    const xml = await exportDocument(document, 'tiled-xml'); const xmlText = xml.data.toString();
    expect(xmlText).toContain('name="World" visible="1" opacity="1" offsetx="7" offsety="-5"');
    expect(xmlText).toContain('name="Ground" visible="1" opacity="1" offsetx="-2" offsety="3"');
    expect(xmlText).toContain('name="Objects" visible="1" opacity="1" offsetx="4" offsety="1"');

    const reopenedJsonPath = join(directory, 'reopened.tmj'); const reopenedXmlPath = join(directory, 'reopened.tmx'); await Promise.all([writeFile(reopenedJsonPath, json.data), writeFile(reopenedXmlPath, xml.data)]);
    for (const reopenedPath of [reopenedJsonPath, reopenedXmlPath]) {
      const reopened = await importDocument(reopenedPath, true); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected pixel document'); const reopenedMap = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected tilemap'); const reopenedGroup = reopenedMap.layers[reopenedMap.layerIds[0]]; if (reopenedGroup.type !== 'group') throw new Error('Expected group');
      expect(reopenedGroup).toMatchObject({ offsetX: 7, offsetY: -5 }); expect(reopenedMap.layers[reopenedGroup.childIds![0]]).toMatchObject({ offsetX: -2, offsetY: 3 }); expect(reopenedMap.layers[reopenedGroup.childIds![1]]).toMatchObject({ offsetX: 4, offsetY: 1 });
    }

    const zeroDocument = createPixelDocument('tilemap', 'Zero layer offsets'); const zeroJson = await exportDocument(zeroDocument, 'tiled-json'); const zeroXml = await exportDocument(zeroDocument, 'tiled-xml');
    expect(JSON.parse(zeroJson.data.toString()).layers[0]).not.toHaveProperty('offsetx'); expect(JSON.parse(zeroJson.data.toString()).layers[0]).not.toHaveProperty('offsety');
    expect(zeroXml.data.toString()).not.toMatch(/\soffset[xy]=/);
  });

  it('fails closed on fractional or out-of-policy Tiled layer offsets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-invalid-tiled-layer-offsets-')); temporaryDirectories.push(directory);
    const jsonPath = join(directory, 'fractional.tmj'); await writeFile(jsonPath, JSON.stringify({ type: 'map', orientation: 'orthogonal', infinite: false, width: 1, height: 1, tilewidth: 1, tileheight: 1, tilesets: [], layers: [{ type: 'tilelayer', width: 1, height: 1, offsetx: 0.5, data: [0] }] }));
    await expect(importDocument(jsonPath, true)).rejects.toThrow('Tiled layer 1 offset x must be an integer from -16777216 to 16777216.');
    const xmlPath = join(directory, 'oversized.tmx'); await writeFile(xmlPath, '<?xml version="1.0"?><map orientation="orthogonal" infinite="0" width="1" height="1" tilewidth="1" tileheight="1"><objectgroup id="1" name="Objects" offsety="16777217"/></map>');
    await expect(importDocument(xmlPath, true)).rejects.toThrow('Tiled layer 1 offset y must be an integer from -16777216 to 16777216.');
  });

  it('preserves signed orthogonal infinite chunks across external TMJ import and current TMJ export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-infinite-tmj-')); temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'signed-sparse.tmj');
    const cells = [
      { x: -33, y: -1, gid: 1 }, { x: -32, y: -1, gid: 1 }, { x: -31, y: -1, gid: 1 },
      { x: -1, y: -1, gid: 1 }, { x: 0, y: -1, gid: 1 }, { x: 1, y: -1, gid: 1 },
      { x: -1, y: 0, gid: 1 }, { x: 0, y: 0, gid: 1 }, { x: 1, y: 0, gid: 1 },
      { x: 31, y: 0, gid: 1 }, { x: 32, y: 0, gid: 1 }, { x: 33, y: 0, gid: 1 },
      { x: 31, y: 31, gid: 1 }, { x: 32, y: 32, gid: 1 },
    ];
    const origins = [[-64, -32], [-32, -32], [0, -32], [-32, 0], [0, 0], [32, 0], [32, 32]] as const;
    const chunks = origins.map(([x, y]) => {
      const data = Array<number>(32 * 32).fill(0);
      for (const cell of cells) if (cell.x >= x && cell.x < x + 32 && cell.y >= y && cell.y < y + 32) data[(cell.y - y) * 32 + cell.x - x] = cell.gid;
      return { x, y, width: 32, height: 32, data };
    });
    await writeFile(sourcePath, JSON.stringify({
      type: 'map', version: '1.10', tiledversion: '1.11.2', orientation: 'orthogonal', renderorder: 'right-down', infinite: true,
      width: 32, height: 32, tilewidth: 16, tileheight: 16,
      properties: [{ name: 'qa06-scenario', type: 'string', value: 'orthogonal-sparse-chunks' }],
      tilesets: [{ firstgid: 1, name: 'Signed terrain', type: 'tileset', tilewidth: 16, tileheight: 16, tilecount: 1, columns: 1 }],
      layers: [{ id: 1, name: 'Ground', type: 'tilelayer', visible: true, opacity: 1, chunks }],
    }, null, 2));

    const imported = await importDocument(sourcePath, true);
    expect(imported.warnings).toEqual([]);
    const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map).toMatchObject({ orientation: 'orthogonal', infinite: true, width: 32, height: 32, tileWidth: 16, tileHeight: 16, properties: { 'qa06-scenario': 'orthogonal-sparse-chunks' } });
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    expect(Object.values(layer.chunks).map((chunk) => [chunk.x, chunk.y]).sort()).toEqual([...origins].map(([x, y]) => [x, y]).sort());
    for (const cell of cells) expect(readTileAt(layer.chunks, cell.x, cell.y)).toBe(cell.gid);

    const artifact = await exportDocument(document, 'tiled-json');
    expect(artifact.report).toEqual({ warnings: [], rasterized: [] });
    expect(artifact.companions).toEqual([expect.objectContaining({ name: 'Signed terrain.png', extension: 'png', mimeType: 'image/png' })]);
    const output = JSON.parse(artifact.data.toString()) as {
      type: string; orientation: string; infinite: boolean; width: number; height: number; tilewidth: number; tileheight: number;
      properties: Array<{ name: string; type: string; value: unknown }>;
      tilesets: Array<{ firstgid: number; name: string; image: string }>;
      layers: Array<{ name: string; type: string; chunks: Array<{ x: number; y: number; width: number; height: number; data: number[] }> }>;
    };
    expect(output).toMatchObject({
      type: 'map', orientation: 'orthogonal', infinite: true, width: 32, height: 32, tilewidth: 16, tileheight: 16,
      properties: [{ name: 'qa06-scenario', type: 'string', value: 'orthogonal-sparse-chunks' }],
      tilesets: [{ firstgid: 1, name: 'Signed terrain', image: 'Signed terrain.png' }],
      layers: [{ name: 'Ground', type: 'tilelayer' }],
    });
    expect(output.layers[0].chunks.map((chunk) => [chunk.x, chunk.y]).sort()).toEqual([...origins].map(([x, y]) => [x, y]).sort());
    const exportedCells = output.layers[0].chunks.flatMap((chunk) => chunk.data.flatMap((gid, index) => gid ? [{ x: chunk.x + index % chunk.width, y: chunk.y + Math.floor(index / chunk.width), gid }] : []));
    const cellOrder = (left: { x: number; y: number; gid: number }, right: { x: number; y: number; gid: number }) => left.y - right.y || left.x - right.x || left.gid - right.gid;
    expect(exportedCells.sort(cellOrder)).toEqual([...cells].sort(cellOrder));
  });

  it('round-trips the supported orthogonal TMJ and PNG companion surface through a second document and distinct re-export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-roundtrip-')); temporaryDirectories.push(directory);
    const firstDirectory = join(directory, 'first-export'); const secondDirectory = join(directory, 'second-export');
    const document = createPixelDocument('project', 'Supported Tiled round trip'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Roundtrip Terrain', 32, 16); const sourceCel = Object.values(sprite.cels)[0];
    writePixels(sourceCel, [
      { x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 4 }, { x: 15, y: 7, index: 7 },
      { x: 16, y: 0, index: 9 }, { x: 17, y: 0, index: 15 }, { x: 31, y: 15, index: 3 },
    ]);
    const tileset = createPixelTileset('Roundtrip Terrain', sprite.id, 16, 16, 2, 1); tileset.firstGid = 1; tileset.transformations = { hFlip: true, vFlip: false, rotate: true };
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, probability: 0.25, animation: [], collisions: [], properties: { walkable: true, cost: 3 } },
      1: { id: 1, sourceX: 16, sourceY: 0, probability: 0.75, animation: [{ tileId: 0, durationMs: 120 }], collisions: [], properties: { walkable: false, cost: 8 } },
    };
    const map = createPixelTilemap('Signed map'); map.infinite = true; map.width = 32; map.height = 32; map.tilesetIds = [tileset.id];
    map.properties = { 'qa06-scenario': 'orthogonal-companion-roundtrip', seed: 4242, collisionSafe: true };
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const cells = [
      { x: -33, y: -1, gid: 1 }, { x: -32, y: -1, gid: 2 }, { x: -31, y: -1, gid: 1 },
      { x: -1, y: -1, gid: 2 }, { x: 0, y: -1, gid: 1 }, { x: 1, y: -1, gid: 2 },
      { x: -1, y: 0, gid: 1 }, { x: 0, y: 0, gid: 2 }, { x: 1, y: 0, gid: 1 },
      { x: 31, y: 0, gid: 2 }, { x: 32, y: 0, gid: 1 }, { x: 33, y: 0, gid: 2 },
      { x: 31, y: 31, gid: 1 }, { x: 32, y: 32, gid: 2 },
    ];
    writeTiles(layer.chunks, cells);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;

    const persist = async (targetDirectory: string, mapName: string, artifact: Awaited<ReturnType<typeof exportDocument>>) => {
      await mkdir(targetDirectory); expect(artifact.companions).toHaveLength(1); const companion = artifact.companions![0];
      const mapPath = join(targetDirectory, mapName); const companionPath = join(targetDirectory, companion.name);
      await Promise.all([writeFile(mapPath, artifact.data, { flag: 'wx' }), writeFile(companionPath, companion.data, { flag: 'wx' })]);
      expect((await readdir(targetDirectory)).sort()).toEqual([mapName, companion.name].sort());
      return { mapPath, companionPath, companion };
    };
    const firstArtifact = await exportDocument(document, 'tiled-json'); const first = await persist(firstDirectory, 'first-pass.tmj', firstArtifact);
    const imported = await runImportUtilityRequest({ id: 'supported-roundtrip-import', kind: 'import-document', filePath: first.mapPath, pixelMode: true }); expect(imported.warnings).toEqual([]); const importedDocument = imported.documents[0]; if (importedDocument.kind !== 'pixel') throw new Error('Expected imported pixel document');
    const importedMap = importedDocument.pixelAssets[importedDocument.activeAssetId]; if (importedMap.type !== 'tilemap') throw new Error('Expected imported tilemap');
    expect(importedMap).toMatchObject({ orientation: 'orthogonal', infinite: true, width: 32, height: 32, tileWidth: 16, tileHeight: 16, properties: map.properties });
    const importedLayer = importedMap.layers[importedMap.layerIds[0]]; if (importedLayer.type !== 'tile' || !importedLayer.chunks) throw new Error('Expected imported tile layer');
    const cellOrder = (left: { x: number; y: number; gid: number }, right: { x: number; y: number; gid: number }) => left.y - right.y || left.x - right.x || left.gid - right.gid;
    const importedCells = Object.values(importedLayer.chunks).flatMap((chunk) => Array.from({ length: chunk.width * chunk.height }, (_, index) => ({ x: chunk.x + index % chunk.width, y: chunk.y + Math.floor(index / chunk.width), gid: readTileAt(importedLayer.chunks!, chunk.x + index % chunk.width, chunk.y + Math.floor(index / chunk.width)) })).filter((cell) => cell.gid));
    expect(importedCells.sort(cellOrder)).toEqual([...cells].sort(cellOrder));
    const importedTileset = importedDocument.pixelAssets[importedMap.tilesetIds[0]]; if (importedTileset.type !== 'tileset') throw new Error('Expected imported tileset');
    expect(importedTileset).toMatchObject({ name: tileset.name, firstGid: 1, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1, transformations: tileset.transformations });
    expect(importedTileset.tiles).toMatchObject({ 0: { probability: 0.25, properties: { walkable: true, cost: 3 } }, 1: { probability: 0.75, animation: [{ tileId: 0, durationMs: 120 }], properties: { walkable: false, cost: 8 } } });
    if (!importedTileset.spriteAssetId) throw new Error('Expected imported atlas tileset');
    const importedSprite = importedDocument.pixelAssets[importedTileset.spriteAssetId]; if (importedSprite.type !== 'sprite') throw new Error('Expected imported tileset pixels');
    const pixelPlane = (asset: PixelSprite) => { const cel = Object.values(asset.cels)[0]; return Array.from({ length: asset.width * asset.height }, (_, index) => readPixel(cel, index % asset.width, Math.floor(index / asset.width))); };
    expect(importedSprite).toMatchObject({ width: sprite.width, height: sprite.height }); expect(pixelPlane(importedSprite)).toEqual(pixelPlane(sprite));

    const secondArtifact = await exportDocument(importedDocument, 'tiled-json'); const second = await persist(secondDirectory, 'second-pass.tmj', secondArtifact);
    expect(second.mapPath).not.toBe(first.mapPath); expect(second.companionPath).not.toBe(first.companionPath); expect((await readdir(directory)).sort()).toEqual(['first-export', 'second-export']);
    const semantics = (bytes: Buffer) => {
      const value = JSON.parse(bytes.toString()) as {
        type: string; orientation: string; infinite: boolean; width: number; height: number; tilewidth: number; tileheight: number;
        properties: Array<Record<string, unknown>>;
        tilesets: Array<{ firstgid: number; name: string; tilewidth: number; tileheight: number; margin: number; spacing: number; tilecount: number; columns: number; image: string; imagewidth: number; imageheight: number; transformations: Record<string, unknown>; tiles: Array<Record<string, unknown>> }>;
        layers: Array<{ name: string; type: string; visible: boolean; opacity: number; parallaxx: number; parallaxy: number; chunks: Array<{ x: number; y: number; width: number; height: number; data: number[] }> }>;
      };
      return { type: value.type, orientation: value.orientation, infinite: value.infinite, width: value.width, height: value.height, tilewidth: value.tilewidth, tileheight: value.tileheight, properties: value.properties, tilesets: value.tilesets, layers: value.layers.map((entry) => ({ ...entry, chunks: [...entry.chunks].sort((left, right) => left.y - right.y || left.x - right.x) })) };
    };
    expect(semantics(await readFile(second.mapPath))).toEqual(semantics(await readFile(first.mapPath)));
    const pngPixels = (bytes: Buffer) => { const decoded = UPNG.decode(Uint8Array.from(bytes).buffer); return { width: decoded.width, height: decoded.height, rgba: Buffer.from(UPNG.toRGBA8(decoded)[0]) }; };
    const firstPng = pngPixels(await readFile(first.companionPath)); const secondPng = pngPixels(await readFile(second.companionPath));
    expect(firstPng).toMatchObject({ width: 32, height: 16 }); expect(secondPng.width).toBe(firstPng.width); expect(secondPng.height).toBe(firstPng.height); expect(secondPng.rgba.equals(firstPng.rgba)).toBe(true);
  });

  it('round-trips all eight square-tile transform flags with pixel-identical production rendering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-transforms-')); temporaryDirectories.push(directory);
    const document = createPixelDocument('project', 'Tiled transform round trip'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Labeled tile', 2, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 4 }, { x: 0, y: 1, index: 8 }, { x: 1, y: 1, index: 11 }]);
    const tileset = createPixelTileset('Labeled tile', sprite.id, 2, 2, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Transform matrix'); map.width = 8; map.height = 1; map.tileWidth = 2; map.tileHeight = 2; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const transforms = [
      {}, { hFlip: true }, { vFlip: true }, { hFlip: true, vFlip: true },
      { diagonal: true }, { diagonal: true, hFlip: true }, { diagonal: true, vFlip: true }, { diagonal: true, hFlip: true, vFlip: true },
    ];
    const expectedGids = transforms.map((flags) => encodeTiledGid(1, flags));
    writeTiles(layer.chunks, expectedGids.map((gid, x) => ({ x, y: 0, gid })));
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const originalRender = Buffer.from(renderTilemap(document, map).getContext('2d').getImageData(0, 0, 16, 2).data);

    const artifact = await exportDocument(document, 'tiled-json'); expect(artifact.report).toEqual({ warnings: [], rasterized: [] }); expect(artifact.companions).toHaveLength(1);
    const mapPath = join(directory, 'transform-matrix.tmj'); const companion = artifact.companions![0];
    await Promise.all([writeFile(mapPath, artifact.data, { flag: 'wx' }), writeFile(join(directory, companion.name), companion.data, { flag: 'wx' })]);
    const imported = await runImportUtilityRequest({ id: 'transform-roundtrip-import', kind: 'import-document', filePath: mapPath, pixelMode: true }); expect(imported.warnings).toEqual([]);
    const importedDocument = imported.documents[0]; if (importedDocument.kind !== 'pixel') throw new Error('Expected imported pixel document');
    const importedMap = importedDocument.pixelAssets[importedDocument.activeAssetId]; if (importedMap.type !== 'tilemap') throw new Error('Expected imported tilemap');
    const importedLayer = importedMap.layers[importedMap.layerIds[0]]; if (importedLayer.type !== 'tile' || !importedLayer.chunks) throw new Error('Expected imported tile layer');
    expect(Array.from({ length: 8 }, (_, x) => readTileAt(importedLayer.chunks!, x, 0))).toEqual(expectedGids);
    expect(Buffer.from(renderTilemap(importedDocument, importedMap).getContext('2d').getImageData(0, 0, 16, 2).data)).toEqual(originalRender);
  });

  it('imports, persists, renders, and JSON/XML re-exports one sparse orthogonal image collection without atlas synthesis', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-image-collection-')); temporaryDirectories.push(directory);
    const colors = {
      plum: [108, 59, 120, 255], coral: [255, 107, 122, 255], teal: [49, 166, 160, 255], gold: [229, 184, 75, 255],
    };
    await Promise.all([
      writeFile(join(directory, 'tile-zero.png'), exactPng(2, 2, [...colors.plum, ...colors.coral, ...colors.teal, ...colors.gold])),
      writeFile(join(directory, 'tile-three.png'), exactPng(1, 2, [...colors.gold, ...colors.coral])),
      writeFile(join(directory, 'collection.tsj'), JSON.stringify({
        type: 'tileset', name: 'Sparse collection', tilewidth: 2, tileheight: 2, tilecount: 2, columns: 2,
        transformations: { hflip: true, vflip: true, rotate: true, preferuntransformed: false },
        wangsets: [{ name: 'Sparse Wang', type: 'mixed', colors: [{ name: 'Stone', color: '#777777', tile: 3, probability: 1 }], wangtiles: [{ tileid: 0, wangid: [0, 0, 0, 0, 0, 0, 0, 0] }, { tileid: 3, wangid: [1, 1, 1, 1, 1, 1, 1, 1] }] }],
        tiles: [
          { id: 0, image: 'tile-zero.png', imagewidth: 2, imageheight: 2, probability: 0.25, animation: [{ tileid: 0, duration: 80 }, { tileid: 3, duration: 120 }], properties: [{ name: 'walkable', type: 'bool', value: true }], objectgroup: { objects: [{ id: 7, name: 'Solid', type: 'collision', x: 0, y: 1, width: 2, height: 1, properties: [{ name: 'damage', type: 'int', value: 2 }] }] } },
          { id: 3, image: 'tile-three.png', imagewidth: 1, imageheight: 2, probability: 0.75, properties: [{ name: 'terrain', type: 'string', value: 'stone' }] },
        ],
      }, null, 2)),
      writeFile(join(directory, 'map.tmj'), JSON.stringify({ type: 'map', orientation: 'orthogonal', infinite: false, width: 2, height: 1, tilewidth: 2, tileheight: 2, tilesets: [{ firstgid: 5, source: 'collection.tsj' }], layers: [{ id: 1, name: 'Sparse cells', type: 'tilelayer', width: 2, height: 1, data: [5, encodeTiledGid(8, { hFlip: true, diagonal: true })] }] }, null, 2)),
    ]);

    const imported = await importDocument(join(directory, 'map.tmj'), true); expect(imported.warnings).toEqual([]);
    const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel image-collection document');
    const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected image-collection tilemap');
    const tileset = document.pixelAssets[map.tilesetIds[0]]; if (tileset.type !== 'tileset') throw new Error('Expected image-collection tileset');
    expect(tileset).toMatchObject({ firstGid: 5, columns: 2, rows: 0, transformations: { hFlip: true, vFlip: true, rotate: true } });
    expect(tileset.spriteAssetId).toBeUndefined();
    expect(Object.keys(tileset.tiles)).toEqual(['0', '3']);
    expect(tileset.tiles[0]).toMatchObject({ probability: 0.25, animation: [{ tileId: 0, durationMs: 80 }, { tileId: 3, durationMs: 120 }], properties: { walkable: true }, collisions: [expect.objectContaining({ type: 'rectangle', properties: { name: 'Solid', class: 'collision', damage: 2 } })] });
    expect(tileset.tiles[3]).toMatchObject({ probability: 0.75, properties: { terrain: 'stone' } });
    expect(tileset.wangSets).toMatchObject([{ name: 'Sparse Wang', type: 'mixed', colors: [{ id: 1, name: 'Stone', tileId: 3 }], tiles: [{ tileId: 0 }, { tileId: 3 }] }]);
    expect(new Set([tileset.tiles[0].imageAssetId, tileset.tiles[3].imageAssetId]).size).toBe(2);
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected image-collection tile layer');
    expect([readTileAt(layer.chunks, 0, 0), readTileAt(layer.chunks, 1, 0)]).toEqual([5, encodeTiledGid(8, { hFlip: true, diagonal: true })]);
    const originalRaster = Buffer.from(renderTilemap(document, map).getContext('2d').getImageData(0, 0, 4, 2).data);
    expect([...originalRaster].filter((_, index) => Math.floor(index / 4) % 4 < 2 && index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);
    const rightRegion = renderTilemapRegion(document, map, { x: 3, y: 0, width: 1, height: 2 });
    expect(Buffer.from(rightRegion.getContext('2d').getImageData(0, 0, 1, 2).data)).toEqual(Buffer.from(originalRaster.filter((_, index) => Math.floor(index / 4) % 4 === 3)));
    for (const unsupported of [{ orientation: 'isometric' as const }, { infinite: true }]) {
      const rejectedDocument = structuredClone(document); const rejectedMap = rejectedDocument.pixelAssets[rejectedDocument.activeAssetId];
      if (rejectedMap.type !== 'tilemap') throw new Error('Expected rejected image-collection tilemap'); Object.assign(rejectedMap, unsupported);
      expect(() => renderTilemap(rejectedDocument, rejectedMap)).toThrow(/must remain finite orthogonal/);
    }

    const nativePath = await writeNativeDocument(join(directory, 'collection-native'), document, '1.0.0');
    const native = await readNativeDocument(nativePath); if (native.document.kind !== 'pixel') throw new Error('Expected persisted image-collection document');
    const nativeMap = native.document.pixelAssets[native.document.activeAssetId]; if (nativeMap.type !== 'tilemap') throw new Error('Expected persisted tilemap');
    const nativeTileset = native.document.pixelAssets[nativeMap.tilesetIds[0]]; if (nativeTileset.type !== 'tileset') throw new Error('Expected persisted tileset');
    expect({ columns: nativeTileset.columns, rows: nativeTileset.rows, spriteAssetId: nativeTileset.spriteAssetId, ids: Object.keys(nativeTileset.tiles) }).toEqual({ columns: 2, rows: 0, spriteAssetId: undefined, ids: ['0', '3'] });
    expect(nativeTileset.wangSets).toEqual(tileset.wangSets);
    expect(Buffer.from(renderTilemap(native.document, nativeMap).getContext('2d').getImageData(0, 0, 4, 2).data)).toEqual(originalRaster);

    for (const format of ['tiled-json', 'tiled-xml'] as const) {
      const artifact = await exportDocument(native.document, format); expect(artifact.report).toEqual({ warnings: [], rasterized: [] }); expect(artifact.companions?.map((entry) => entry.name)).toEqual(['Sparse collection tile 0.png', 'Sparse collection tile 3.png']);
      const text = artifact.data.toString();
      if (format === 'tiled-json') {
        const output = JSON.parse(text); const exported = output.tilesets[0];
        expect(exported).toMatchObject({ firstgid: 5, tilecount: 2, columns: 2 }); expect(exported.image).toBeUndefined();
        expect(exported.tiles.map((tile: any) => ({ id: tile.id, image: tile.image }))).toEqual([{ id: 0, image: 'Sparse collection tile 0.png' }, { id: 3, image: 'Sparse collection tile 3.png' }]);
        expect(exported.tiles[0]).toMatchObject({ probability: 0.25, animation: [{ tileid: 0, duration: 80 }, { tileid: 3, duration: 120 }], properties: [expect.objectContaining({ name: 'walkable', type: 'bool', value: true })] });
        expect(exported.wangsets).toEqual([{ name: 'Sparse Wang', type: 'mixed', colors: [{ name: 'Stone', color: '#777777', tile: 3, probability: 1 }], wangtiles: [{ tileid: 0, wangid: [0, 0, 0, 0, 0, 0, 0, 0] }, { tileid: 3, wangid: [1, 1, 1, 1, 1, 1, 1, 1] }] }]);
      } else {
        expect(text).toContain('tilecount="2" columns="2"'); expect(text).not.toMatch(/<tileset[^>]*>[^<]*<image /);
        expect(text).toContain('<image source="Sparse collection tile 0.png" width="2" height="2"/>');
        expect(text).toContain('<image source="Sparse collection tile 3.png" width="1" height="2"/>');
        expect(text).toContain('<wangcolor name="Stone" color="#777777" tile="3" probability="1"/>');
        expect(text).toContain('<wangtile tileid="3" wangid="1,1,1,1,1,1,1,1"/>');
        const tileZero = text.match(/<tile id="0"[^>]*>([\s\S]*?)<\/tile>/)?.[1]; expect(tileZero).toBeDefined();
        const childOrder = ['<properties>', '<image ', '<objectgroup>', '<animation>'].map((child) => tileZero!.indexOf(child));
        expect(childOrder.every((index) => index >= 0)).toBe(true); expect(childOrder).toEqual([...childOrder].sort((left, right) => left - right));
      }
      const outputDirectory = join(directory, format); await mkdir(outputDirectory);
      const outputPath = join(outputDirectory, format === 'tiled-json' ? 'map.tmj' : 'map.tmx');
      await Promise.all([writeFile(outputPath, artifact.data), ...artifact.companions!.map((entry) => writeFile(join(outputDirectory, entry.name), entry.data))]);
      const reopened = await importDocument(outputPath, true); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected reopened image collection');
      const reopenedMap = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected reopened image-collection map');
      const reopenedTileset = reopenedDocument.pixelAssets[reopenedMap.tilesetIds[0]]; if (reopenedTileset.type !== 'tileset') throw new Error('Expected reopened image-collection tileset');
      expect(reopenedTileset.columns).toBe(2);
      expect(Object.keys(reopenedTileset.tiles)).toEqual(['0', '3']);
      expect(reopenedTileset.wangSets).toMatchObject([{ name: 'Sparse Wang', colors: [{ tileId: 3 }], tiles: [{ tileId: 0 }, { tileId: 3 }] }]);
      expect(Buffer.from(renderTilemap(reopenedDocument, reopenedMap).getContext('2d').getImageData(0, 0, 4, 2).data)).toEqual(originalRaster);
    }

    const standalone = structuredClone(native.document); standalone.activeAssetId = nativeTileset.id;
    const standaloneTsx = await exportDocument(standalone, 'tiled-xml'); expect(standaloneTsx.extension).toBe('tsx');
    const standaloneTileZero = standaloneTsx.data.toString().match(/<tile id="0"[^>]*>([\s\S]*?)<\/tile>/)?.[1]; expect(standaloneTileZero).toBeDefined();
    const standaloneOrder = ['<properties>', '<image ', '<objectgroup>', '<animation>'].map((child) => standaloneTileZero!.indexOf(child));
    expect(standaloneOrder.every((index) => index >= 0)).toBe(true); expect(standaloneOrder).toEqual([...standaloneOrder].sort((left, right) => left - right));
  });

  it('persists and JSON/XML exports a human-created collection plus appended exact source without atlas synthesis', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-authored-image-collection-')); temporaryDirectories.push(directory);
    const document = createPixelDocument('project', 'Authored collection project');
    const first = createPixelSprite('Red wide', 2, 1); writePixels(Object.values(first.cels)[0], [{ x: 0, y: 0, index: 4 }, { x: 1, y: 0, index: 8 }]);
    const second = createPixelSprite('Gold tall', 1, 2); writePixels(Object.values(second.cels)[0], [{ x: 0, y: 0, index: 12 }, { x: 0, y: 1, index: 4 }]);
    document.assetIds = [first.id, second.id]; document.pixelAssets = { [first.id]: first, [second.id]: second }; document.activeAssetId = first.id;
    const collection = createImageCollectionTileset(document, 'Authored sparse', [first.id], { id: 'authored-collection' });
    document.assetIds.push(collection.id); document.pixelAssets[collection.id] = collection;
    const appended = appendImageCollectionSource(document, collection.id, second.id);
    document.pixelAssets[collection.id] = appended.tileset; document.activeAssetId = collection.id;

    const nativePath = await writeNativeDocument(join(directory, 'authored-native'), document, '1.0.0');
    const reopened = await readNativeDocument(nativePath); if (reopened.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const reopenedDocument = reopened.document;
    const persisted = reopenedDocument.pixelAssets[collection.id]; if (persisted.type !== 'tileset') throw new Error('Expected collection');
    expect(Object.values(persisted.tiles).map(({ id, imageAssetId }) => ({ id, imageAssetId }))).toEqual([{ id: 0, imageAssetId: first.id }, { id: 1, imageAssetId: second.id }]);
    expect(persisted).toMatchObject({ firstGid: 1, tileWidth: 2, tileHeight: 2, columns: 0, rows: 0 });

    for (const format of ['tiled-json', 'tiled-xml'] as const) {
      const artifact = await exportDocument(reopenedDocument, format);
      expect(artifact.report).toEqual({ warnings: [], rasterized: [] });
      expect(artifact.companions?.map((entry) => entry.name)).toEqual(['Authored sparse tile 0.png', 'Authored sparse tile 1.png']);
      const decoded = artifact.companions!.map((entry) => UPNG.decode(entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) as ArrayBuffer));
      expect(decoded.map(({ width, height }) => [width, height])).toEqual([[2, 1], [1, 2]]);
      const decodedPixels = decoded.map((entry) => Buffer.from(UPNG.toRGBA8(entry)[0]));
      const expectedPixels = [first.id, second.id].map((id) => {
        const source = reopenedDocument.pixelAssets[id]; if (source.type !== 'sprite') throw new Error('Expected source sprite');
        return Buffer.from(renderSprite(reopenedDocument, source).getContext('2d').getImageData(0, 0, source.width, source.height).data);
      });
      expect(decodedPixels).toEqual(expectedPixels);
      if (format === 'tiled-json') {
        const output = JSON.parse(artifact.data.toString());
        expect(output).toMatchObject({ name: 'Authored sparse', tilecount: 2, columns: 0, tilewidth: 2, tileheight: 2 });
        expect(output.image).toBeUndefined();
        expect(output.tiles.map((tile: { id: number; image: string }) => ({ id: tile.id, image: tile.image }))).toEqual([{ id: 0, image: 'Authored sparse tile 0.png' }, { id: 1, image: 'Authored sparse tile 1.png' }]);
      } else {
        const output = artifact.data.toString();
        expect(output).toContain('<tileset version="1.10" tiledversion="1.11.2" name="Authored sparse" tilewidth="2" tileheight="2" margin="0" spacing="0" tilecount="2" columns="0">');
        expect(output).not.toMatch(/<tileset[^>]*>\s*<image/u);
        expect(output).toContain('<tile id="0" probability="1">'); expect(output).toContain('<tile id="1" probability="1">');
      }
    }
  });

  it('persists and JSON/XML reopens a stable sparse ID/GID with deliberately replaced companion pixels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-replaced-image-collection-')); temporaryDirectories.push(directory);
    const document = createPixelDocument('project', 'Replaced collection source project');
    const retained = createPixelSprite('Retained envelope', 3, 2); writePixels(Object.values(retained.cels)[0], [{ x: 0, y: 0, index: 4 }]);
    const original = createPixelSprite('Original source', 2, 1); writePixels(Object.values(original.cels)[0], [{ x: 0, y: 0, index: 8 }, { x: 1, y: 0, index: 8 }]);
    const replacement = createPixelSprite('Replacement source', 1, 1); writePixels(Object.values(replacement.cels)[0], [{ x: 0, y: 0, index: 12 }]);
    document.assetIds = [retained.id, original.id, replacement.id];
    document.pixelAssets = { [retained.id]: retained, [original.id]: original, [replacement.id]: replacement };
    document.activeAssetId = retained.id;
    const collection = createImageCollectionTileset(document, 'Stable collection', [retained.id, original.id], { id: 'stable-collection' });
    const map = createPixelTilemap('Stable GID map'); map.width = 1; map.height = 1; map.tileWidth = 2; map.tileHeight = 1; map.tilesetIds = [collection.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const stableRawGid = encodeTiledGid(collection.firstGid + 1, { hFlip: true });
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: stableRawGid }]);
    document.assetIds.push(collection.id, map.id); document.pixelAssets[collection.id] = collection; document.pixelAssets[map.id] = map; document.activeAssetId = map.id;
    const beforePixels = Buffer.from(renderTilemap(document, map).getContext('2d').getImageData(0, 0, 2, 1).data);

    const plan = replaceImageCollectionSource(document, collection.id, 1, replacement.id);
    expect(plan.tileset).toMatchObject({ firstGid: collection.firstGid, tileWidth: 3, tileHeight: 2, tiles: { 1: { id: 1, imageAssetId: replacement.id } } });
    expect(plan.tileset.tiles[1]).toEqual({ ...collection.tiles[1], imageAssetId: replacement.id });
    document.pixelAssets[collection.id] = plan.tileset;
    expect(readTileAt(layer.chunks, 0, 0)).toBe(stableRawGid);
    const afterPixels = Buffer.from(renderTilemap(document, map).getContext('2d').getImageData(0, 0, 2, 1).data);
    expect(afterPixels).not.toEqual(beforePixels);

    const nativePath = await writeNativeDocument(join(directory, 'stable-native'), document, '1.0.0');
    const native = await readNativeDocument(nativePath); if (native.document.kind !== 'pixel') throw new Error('Expected pixel document');
    for (const format of ['tiled-json', 'tiled-xml'] as const) {
      const artifact = await exportDocument(native.document, format);
      expect(artifact.companions?.map(({ name }) => name)).toEqual(['Stable collection tile 0.png', 'Stable collection tile 1.png']);
      const replacementCompanion = artifact.companions![1];
      const decoded = UPNG.decode(replacementCompanion.data.buffer.slice(replacementCompanion.data.byteOffset, replacementCompanion.data.byteOffset + replacementCompanion.data.byteLength) as ArrayBuffer);
      expect([decoded.width, decoded.height, Buffer.from(UPNG.toRGBA8(decoded)[0])]).toEqual([1, 1, afterPixels.subarray(0, 4)]);
      const outputDirectory = join(directory, `replaced-${format}`); await mkdir(outputDirectory);
      const outputPath = join(outputDirectory, format === 'tiled-json' ? 'map.tmj' : 'map.tmx');
      await Promise.all([writeFile(outputPath, artifact.data), ...artifact.companions!.map((entry) => writeFile(join(outputDirectory, entry.name), entry.data))]);
      const reopened = await importDocument(outputPath, true); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected pixel document');
      const reopenedMap = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const reopenedLayer = reopenedMap.layers[reopenedMap.layerIds[0]]; if (reopenedLayer.type !== 'tile' || !reopenedLayer.chunks) throw new Error('Expected tile layer');
      expect(readTileAt(reopenedLayer.chunks, 0, 0)).toBe(stableRawGid);
      const reopenedCollection = reopenedDocument.pixelAssets[reopenedMap.tilesetIds[0]]; if (reopenedCollection.type !== 'tileset') throw new Error('Expected tileset');
      expect(Object.keys(reopenedCollection.tiles)).toEqual(['0', '1']);
      expect(Buffer.from(renderTilemap(reopenedDocument, reopenedMap).getContext('2d').getImageData(0, 0, 2, 1).data)).toEqual(afterPixels);
    }
  });

  it('persists and JSON/XML reopens proven-unused removal without compacting retained sparse IDs or deleting the source sprite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-removed-image-collection-')); temporaryDirectories.push(directory);
    const document = createPixelDocument('project', 'Removed collection source project');
    const source0 = createPixelSprite('Source zero', 2, 2); writePixels(Object.values(source0.cels)[0], [{ x: 0, y: 0, index: 4 }]);
    const source3 = createPixelSprite('Removable largest source', 10, 9); writePixels(Object.values(source3.cels)[0], [{ x: 0, y: 0, index: 8 }]);
    const source7 = createPixelSprite('Source seven', 3, 1); writePixels(Object.values(source7.cels)[0], [{ x: 0, y: 0, index: 12 }, { x: 1, y: 0, index: 12 }, { x: 2, y: 0, index: 12 }]);
    document.assetIds = [source0.id, source3.id, source7.id]; document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [source7.id]: source7 }; document.activeAssetId = source0.id;
    const collection = createImageCollectionTileset(document, 'Removal collection', [source0.id, source3.id, source7.id], { id: 'removal-collection' });
    collection.tiles = {
      0: { ...collection.tiles[0], id: 0 },
      3: { ...collection.tiles[1], id: 3, probability: 0.4, properties: { removable: true } },
      7: { ...collection.tiles[2], id: 7, probability: 0.7, properties: { retained: true } },
    };
    const map = createPixelTilemap('Retained sparse GID map'); map.width = 1; map.height = 1; map.tileWidth = 3; map.tileHeight = 1; map.tilesetIds = [collection.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    const retainedRawGid = encodeTiledGid(collection.firstGid + 7, { diagonal: true });
    writeTiles(layer.chunks, [{ x: 0, y: 0, gid: retainedRawGid }]);
    document.assetIds.push(collection.id, map.id); document.pixelAssets[collection.id] = collection; document.pixelAssets[map.id] = map; document.activeAssetId = map.id;
    const beforeMap = JSON.stringify(map); const beforeSources = JSON.stringify([source0, source3, source7]);
    const plan = removeUnusedImageCollectionSource(document, collection.id, 3);
    expect(Object.keys(plan.tileset.tiles)).toEqual(['0', '7']);
    expect(plan.tileset).toMatchObject({ firstGid: collection.firstGid, tileWidth: 3, tileHeight: 2, tiles: { 7: collection.tiles[7] } });
    document.pixelAssets[collection.id] = plan.tileset;
    expect(JSON.stringify(map)).toBe(beforeMap); expect(JSON.stringify([source0, source3, source7])).toBe(beforeSources);
    expect(readTileAt(layer.chunks, 0, 0)).toBe(retainedRawGid);

    const nativePath = await writeNativeDocument(join(directory, 'removed-native'), document, '1.0.0');
    const native = await readNativeDocument(nativePath); if (native.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(native.document.pixelAssets[source3.id]).toEqual(source3);
    for (const format of ['tiled-json', 'tiled-xml'] as const) {
      const artifact = await exportDocument(native.document, format);
      expect(artifact.companions?.map(({ name }) => name)).toEqual(['Removal collection tile 0.png', 'Removal collection tile 7.png']);
      const outputDirectory = join(directory, `removed-${format}`); await mkdir(outputDirectory);
      const outputPath = join(outputDirectory, format === 'tiled-json' ? 'map.tmj' : 'map.tmx');
      await Promise.all([writeFile(outputPath, artifact.data), ...artifact.companions!.map((entry) => writeFile(join(outputDirectory, entry.name), entry.data))]);
      const reopened = await importDocument(outputPath, true); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected reopened image collection');
      const reopenedMap = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const reopenedLayer = reopenedMap.layers[reopenedMap.layerIds[0]]; if (reopenedLayer.type !== 'tile' || !reopenedLayer.chunks) throw new Error('Expected tile layer');
      expect(readTileAt(reopenedLayer.chunks, 0, 0)).toBe(retainedRawGid);
      const reopenedCollection = reopenedDocument.pixelAssets[reopenedMap.tilesetIds[0]]; if (reopenedCollection.type !== 'tileset') throw new Error('Expected tileset');
      expect(Object.keys(reopenedCollection.tiles)).toEqual(['0', '7']);
      expect(reopenedCollection.tiles[7]).toMatchObject({ id: 7, probability: 0.7, properties: { retained: true } });
    }
  });

  it('rejects explicitly malformed JSON/XML image declarations while retaining metadata-only atlases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-image-declarations-')); temporaryDirectories.push(directory);
    const metadataOnly = { type: 'tileset', name: 'Metadata only', tilewidth: 1, tileheight: 1, tilecount: 1, columns: 1, tiles: [{ id: 0, properties: [{ name: 'kind', type: 'string', value: 'marker' }] }] };
    await writeFile(join(directory, 'metadata-only.tsj'), JSON.stringify(metadataOnly));
    const admitted = await importDocument(join(directory, 'metadata-only.tsj'), true);
    const admittedDocument = admitted.documents[0]; if (admittedDocument.kind !== 'pixel') throw new Error('Expected metadata-only pixel document');
    const admittedTileset = admittedDocument.pixelAssets[admittedDocument.activeAssetId]; if (admittedTileset.type !== 'tileset') throw new Error('Expected metadata-only tileset');
    expect(admittedTileset.spriteAssetId).toBeDefined();
    expect(admittedTileset.tiles[0].properties).toEqual({ kind: 'marker' });

    await writeFile(join(directory, 'bad-top-level.tsj'), JSON.stringify({ ...metadataOnly, image: 42 }));
    await expect(importDocument(join(directory, 'bad-top-level.tsj'), true)).rejects.toThrow('Tiled tileset image source must be a nonempty string path.');
    await writeFile(join(directory, 'bad-per-tile.tsj'), JSON.stringify({ ...metadataOnly, tiles: [{ id: 0, image: '   ' }] }));
    await expect(importDocument(join(directory, 'bad-per-tile.tsj'), true)).rejects.toThrow('Tiled tile 0 image source must be a nonempty string path.');

    await writeFile(join(directory, 'bad-top-level.tsx'), '<tileset version="1.10" tiledversion="1.12.2" name="Bad top" tilewidth="1" tileheight="1" tilecount="1" columns="1"><image/></tileset>');
    await expect(importDocument(join(directory, 'bad-top-level.tsx'), true)).rejects.toThrow('Tiled tileset image source must be a nonempty string path.');
    await writeFile(join(directory, 'bad-per-tile.tsx'), '<tileset version="1.10" tiledversion="1.12.2" name="Bad tile" tilewidth="1" tileheight="1" tilecount="1" columns="1"><tile id="0"><image/></tile></tileset>');
    await expect(importDocument(join(directory, 'bad-per-tile.tsx'), true)).rejects.toThrow('Tiled tile 0 image source must be a nonempty string path.');
  });

  it('fails closed for incompatible sources, ambiguous IDs/ranges, sparse gaps, and isometric maps while admitting exact tile objects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tiled-image-collection-refusal-')); temporaryDirectories.push(directory);
    await writeFile(join(directory, 'tile.png'), exactPng(1, 1, [255, 107, 122, 255]));
    const tileset = { type: 'tileset', name: 'Collection', tilewidth: 1, tileheight: 1, tilecount: 1, columns: 0, tiles: [{ id: 2, image: 'tile.png', imagewidth: 1, imageheight: 1 }] };
    await writeFile(join(directory, 'collection.tsj'), JSON.stringify(tileset));
    const map = (overrides: Record<string, unknown> = {}) => ({ type: 'map', orientation: 'orthogonal', infinite: false, width: 1, height: 1, tilewidth: 1, tileheight: 1, tilesets: [{ firstgid: 7, source: 'collection.tsj' }], layers: [{ id: 1, name: 'Cells', type: 'tilelayer', width: 1, height: 1, data: [9] }], ...overrides });
    await writeFile(join(directory, 'gap.tmj'), JSON.stringify(map({ layers: [{ id: 1, name: 'Gap', type: 'tilelayer', width: 1, height: 1, data: [7] }] })));
    await expect(importDocument(join(directory, 'gap.tmj'), true)).rejects.toThrow('missing sparse image-collection GID 7');
    await writeFile(join(directory, 'isometric.tmj'), JSON.stringify(map({ orientation: 'isometric' })));
    await expect(importDocument(join(directory, 'isometric.tmj'), true)).rejects.toThrow('only finite orthogonal');
    const transformedObjectGid = encodeTiledGid(9, { hFlip: true, diagonal: true });
    await writeFile(join(directory, 'object.tmj'), JSON.stringify(map({ layers: [{ id: 1, name: 'Objects', type: 'objectgroup', objects: [
      { id: 'default-size', gid: transformedObjectGid, x: 3, y: 5, name: 'Exact sparse tile', class: 'actor', properties: [{ name: 'solid', type: 'bool', value: true }] },
      { id: 'explicit-size', gid: 9, x: 7, y: 9, width: 2, height: 3 },
    ] }] })));
    const objectImport = await importDocument(join(directory, 'object.tmj'), true); const objectDocument = objectImport.documents[0]; if (objectDocument.kind !== 'pixel') throw new Error('Expected collection object document');
    const objectMap = objectDocument.pixelAssets[objectDocument.activeAssetId]; if (objectMap.type !== 'tilemap') throw new Error('Expected collection object map');
    const importedObjectLayer = objectMap.layers[objectMap.layerIds[0]]; if (importedObjectLayer.type !== 'object') throw new Error('Expected object layer');
    expect(importedObjectLayer.objects).toEqual([
      { id: 'default-size', type: 'tile', gid: transformedObjectGid, x: 3, y: 5, width: 1, height: 1, rotation: 0, name: 'Exact sparse tile', className: 'actor', properties: { solid: true } },
      { id: 'explicit-size', type: 'tile', gid: 9, x: 7, y: 9, width: 2, height: 3, rotation: 0, name: '', className: '', properties: {} },
    ]);
    const nativeObjectPath = await writeNativeDocument(join(directory, 'collection-objects-native'), objectDocument, '1.0.0');
    const nativeObject = await readNativeDocument(nativeObjectPath); if (nativeObject.document.kind !== 'pixel') throw new Error('Expected native collection object document');
    const nativeMap = nativeObject.document.pixelAssets[nativeObject.document.activeAssetId]; if (nativeMap.type !== 'tilemap') throw new Error('Expected native collection object map');
    const nativeObjectLayer = nativeMap.layers[nativeMap.layerIds[0]]; if (nativeObjectLayer.type !== 'object') throw new Error('Expected native object layer');
    expect(nativeObjectLayer.objects).toEqual(importedObjectLayer.objects);
    for (const format of ['tiled-json', 'tiled-xml'] as const) {
      const artifact = await exportDocument(objectDocument, format); expect(artifact.companions?.some((entry) => entry.name.endsWith('.png'))).toBe(true);
      const outputDirectory = join(directory, `object-${format}`); await mkdir(outputDirectory); const outputPath = join(outputDirectory, format === 'tiled-json' ? 'object.tmj' : 'object.tmx');
      await Promise.all([writeFile(outputPath, artifact.data), ...(artifact.companions ?? []).map((entry) => writeFile(join(outputDirectory, entry.name), entry.data))]);
      const reopened = await importDocument(outputPath, true); const reopenedDocument = reopened.documents[0]; if (reopenedDocument.kind !== 'pixel') throw new Error('Expected reopened object document');
      const reopenedMap = reopenedDocument.pixelAssets[reopenedDocument.activeAssetId]; if (reopenedMap.type !== 'tilemap') throw new Error('Expected reopened object map');
      const reopenedLayer = reopenedMap.layers[reopenedMap.layerIds[0]]; if (reopenedLayer.type !== 'object') throw new Error('Expected reopened object layer');
      expect(reopenedLayer.objects?.map((object) => object.type === 'tile' ? { gid: object.gid, width: object.width, height: object.height, name: object.name, className: object.className, properties: object.properties } : undefined)).toEqual([
        { gid: transformedObjectGid, width: 1, height: 1, name: 'Exact sparse tile', className: 'actor', properties: { solid: true } },
        { gid: 9, width: 2, height: 3, name: '', className: '', properties: {} },
      ]);
    }
    await writeFile(join(directory, 'missing.tsj'), JSON.stringify({ ...tileset, tiles: [{ id: 2, image: 'missing.png' }] }));
    await writeFile(join(directory, 'missing.tmj'), JSON.stringify({ ...map(), tilesets: [{ firstgid: 7, source: 'missing.tsj' }] }));
    await expect(importDocument(join(directory, 'missing.tmj'), true)).rejects.toThrow('missing.png');
    await writeFile(join(directory, 'not-static.png'), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]));
    await writeFile(join(directory, 'incompatible.tsj'), JSON.stringify({ ...tileset, tiles: [{ id: 2, image: 'not-static.png' }] }));
    await writeFile(join(directory, 'incompatible.tmj'), JSON.stringify({ ...map(), tilesets: [{ firstgid: 7, source: 'incompatible.tsj' }] }));
    await expect(importDocument(join(directory, 'incompatible.tmj'), true)).rejects.toThrow('must be a static PNG');
    for (const [name, tile, message] of [
      ['bad-width', { ...tileset.tiles[0], imagewidth: 'not-a-number' }, 'image width must be an integer from 1'],
      ['bad-height', { ...tileset.tiles[0], imageheight: 0 }, 'image height must be an integer from 1'],
      ['mismatch-width', { ...tileset.tiles[0], imagewidth: 2 }, 'declared dimensions disagree'],
    ] as const) {
      await writeFile(join(directory, `${name}.tsj`), JSON.stringify({ ...tileset, tiles: [tile] }));
      await writeFile(join(directory, `${name}.tmj`), JSON.stringify({ ...map(), tilesets: [{ firstgid: 7, source: `${name}.tsj` }] }));
      await expect(importDocument(join(directory, `${name}.tmj`), true)).rejects.toThrow(message);
    }
    await writeFile(join(directory, 'missing-animation-target.tsj'), JSON.stringify({ ...tileset, tiles: [{ ...tileset.tiles[0], animation: [{ tileid: 1, duration: 100 }] }] }));
    await expect(importDocument(join(directory, 'missing-animation-target.tsj'), true)).rejects.toThrow('animation references missing tile 1');
    await writeFile(join(directory, 'missing-wang-target.tsj'), JSON.stringify({ ...tileset, wangsets: [{ name: 'Invalid sparse Wang', type: 'mixed', colors: [{ name: 'Exact representative', color: '#777777', tile: 2, probability: 1 }], wangtiles: [{ tileid: 1, wangid: [1, 1, 1, 1, 1, 1, 1, 1] }] }] }));
    await expect(importDocument(join(directory, 'missing-wang-target.tsj'), true)).rejects.toThrow('Wang mapping references missing tile 1');
    await writeFile(join(directory, 'duplicate.tsj'), JSON.stringify({ ...tileset, tilecount: 2, tiles: [tileset.tiles[0], tileset.tiles[0]] }));
    await writeFile(join(directory, 'duplicate.tmj'), JSON.stringify({ ...map(), tilesets: [{ firstgid: 7, source: 'duplicate.tsj' }] }));
    await expect(importDocument(join(directory, 'duplicate.tmj'), true)).rejects.toThrow('tile ID 2 is duplicated');
    await writeFile(join(directory, 'overlap.tmj'), JSON.stringify({ ...map(), tilesets: [{ firstgid: 7, source: 'collection.tsj' }, { firstgid: 8, source: 'collection.tsj' }] }));
    await expect(importDocument(join(directory, 'overlap.tmj'), true)).rejects.toThrow('overlapping GID ranges');
  });
});
