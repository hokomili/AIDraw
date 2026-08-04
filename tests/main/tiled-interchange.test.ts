import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTileAt } from '@aidraw/core';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));

import { importDocument } from '../../src/main/import-document';
import { exportDocument } from '../../src/main/export-document';

const fixture = new URL('../fixtures/tiled/isometric-external.tmj', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const xmlFixtureSource = new URL('../fixtures/tiled/orthogonal-external.tmx', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const xmlTilesetSource = new URL('../fixtures/tiled/terrain.tsx.fixture', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

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
    expect(tileset).toMatchObject({ firstGid: 17, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1, transformations: { hFlip: true, vFlip: false, rotate: true } });
    expect(tileset.tiles[0]).toMatchObject({ probability: 0.25, animation: [{ tileId: 1, durationMs: 120 }], properties: { walkable: true, cost: 3 } });
    expect(tileset.tiles[0].collisions[0]).toMatchObject({ type: 'rectangle', x: 1, y: 2, width: 14, height: 12, properties: { name: 'Footprint', class: 'solid', damage: 2 } });
    expect(tileset.wangSets[0]).toMatchObject({ name: 'Track edge', type: 'mixed', colors: [{ name: 'Rail', color: '#c9953d', tileId: 0, probability: 1 }], tiles: [{ tileId: 0, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }] });
  });

  it('exports current Tiled JSON field names and exact property types', async () => {
    const imported = await importDocument(fixture, true); const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const artifact = await exportDocument(document, 'tiled-json'); const output = JSON.parse(artifact.data.toString());
    const tileset = output.tilesets[0]; expect(tileset.wangsets[0].colors).toEqual([expect.objectContaining({ name: 'Rail' })]); expect(tileset.wangsets[0].wangcolors).toBeUndefined();
    expect(tileset.tiles[0].properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'walkable', type: 'bool', value: true }), expect.objectContaining({ name: 'cost', type: 'int', value: 3 })]));
    expect(tileset.tiles[0].objectgroup.objects[0]).toMatchObject({ name: 'Footprint', type: 'solid', properties: [expect.objectContaining({ name: 'damage', type: 'int', value: 2 })] });
    expect(output.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'seed', type: 'int', value: 42 })]));
  });

  it('imports an external TSX through TMX with typed properties and geometry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-tmx-fixture-')); temporaryDirectories.push(directory); const xmlFixture = join(directory, basename(xmlFixtureSource)); await Promise.all([copyFile(xmlFixtureSource, xmlFixture), copyFile(xmlTilesetSource, join(directory, 'terrain.tsx'))]);
    const result = await importDocument(xmlFixture, true); expect(result.warnings).toEqual([]); const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(map).toMatchObject({ orientation: 'orthogonal', width: 2, height: 2, properties: { chapter: 7 } }); const group = map.layers[map.layerIds[0]]; if (group.type !== 'group') throw new Error('Expected group'); expect(group).toMatchObject({ name: 'XML World', opacity: 0.6 });
    const ground = map.layers[group.childIds![0]]; const zones = map.layers[group.childIds![1]]; if (ground.type !== 'tile' || zones.type !== 'object') throw new Error('Expected tile and object layers'); expect(readTileAt(ground.chunks!, 1, 0)).toBe(10); expect(ground).toMatchObject({ parallaxX: 0.5, parallaxY: 0.25 }); expect(zones.objects?.[0]).toMatchObject({ type: 'rectangle', properties: { name: 'Spawn', class: 'start', team: 'blue' } });
    const tileset = document.pixelAssets[map.tilesetIds[0]]; if (tileset.type !== 'tileset') throw new Error('Expected tileset'); expect(tileset).toMatchObject({ firstGid: 9, transformations: { hFlip: true, vFlip: true, rotate: false } }); expect(tileset.tiles[0]).toMatchObject({ probability: 0.4, properties: { friction: 0.75 } }); expect(tileset.tiles[0].collisions[0]).toMatchObject({ type: 'polyline', properties: { name: 'Slope', class: 'ramp', oneWay: true }, points: [{ x: 0, y: 16 }, { x: 8, y: 8 }, { x: 16, y: 0 }] }); expect(tileset.wangSets[0]).toMatchObject({ name: 'XML edge', type: 'edge', colors: [{ name: 'Stone', color: '#8794a8', tileId: 1, probability: 0.5 }] });
  });
});
