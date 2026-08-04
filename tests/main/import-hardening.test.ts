import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));

import { importDocument, MAX_STRUCTURED_IMPORT_BYTES } from '../../src/main/import-document';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-import-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('untrusted import limits', () => {
  it('rejects a structured root file before reading beyond its byte budget', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'oversized.tmj'); await writeFile(filePath, ''); await truncate(filePath, MAX_STRUCTURED_IMPORT_BYTES + 1);
    await expect(importDocument(filePath, true)).rejects.toThrow(/16 MiB safety limit/);
  });

  it('rejects DTD and entity declarations in SVG and Tiled XML', async () => {
    const directory = await temporaryDirectory(); const svg = join(directory, 'unsafe.svg'); const map = join(directory, 'unsafe.tmx');
    await writeFile(svg, '<!DOCTYPE svg [<!ENTITY local SYSTEM "file:///secret">]><svg width="1" height="1"><text>&local;</text></svg>');
    await writeFile(map, '<!DOCTYPE map [<!ENTITY local SYSTEM "file:///secret">]><map width="1" height="1" tilewidth="1" tileheight="1"><layer width="1" height="1"><data encoding="csv">0</data></layer></map>');
    await expect(importDocument(svg)).rejects.toThrow(/cannot contain DTD or entity declarations/);
    await expect(importDocument(map, true)).rejects.toThrow(/cannot contain DTD or entity declarations/);
  });

  it('prevents sprite-sheet metadata from escaping the approved folder', async () => {
    const directory = await temporaryDirectory(); const approved = join(directory, 'approved'); await writeFile(join(directory, 'outside.png'), 'not an image'); await mkdir(approved); const metadataPath = join(approved, 'sheet.json');
    await writeFile(metadataPath, JSON.stringify({ frames: [{ frame: { x: 0, y: 0, w: 1, h: 1 } }], meta: { image: '../outside.png' } }));
    await expect(importDocument(metadataPath, true)).rejects.toThrow(/outside the approved import folder/);
  });

  it('prevents Tiled maps and tilesets from escaping through companion references', async () => {
    const directory = await temporaryDirectory(); const approved = join(directory, 'approved'); await mkdir(approved);
    await writeFile(join(directory, 'outside.tsx'), '<tileset name="Outside" tilewidth="1" tileheight="1" tilecount="1" columns="1"/>'); await writeFile(join(directory, 'outside.png'), 'not an image');
    const mapPath = join(approved, 'map.tmj'); await writeFile(mapPath, JSON.stringify({ type: 'map', width: 1, height: 1, tilewidth: 1, tileheight: 1, tilesets: [{ firstgid: 1, source: '../outside.tsx' }], layers: [{ type: 'tilelayer', width: 1, height: 1, data: [0] }] }));
    const tilesetPath = join(approved, 'tileset.tsj'); await writeFile(tilesetPath, JSON.stringify({ type: 'tileset', name: 'Unsafe', tilewidth: 1, tileheight: 1, tilecount: 1, columns: 1, image: '../outside.png', imagewidth: 1, imageheight: 1 }));
    await expect(importDocument(mapPath, true)).rejects.toThrow(/outside the approved import folder/);
    await expect(importDocument(tilesetPath, true)).rejects.toThrow(/outside the approved import folder/);
  });

  it('rejects oversized finite maps and inconsistent tile arrays', async () => {
    const directory = await temporaryDirectory(); const huge = join(directory, 'huge.tmj'); const short = join(directory, 'short.tmj');
    await writeFile(huge, JSON.stringify({ type: 'map', width: 4097, height: 1024, tilewidth: 16, tileheight: 16, layers: [] }));
    await writeFile(short, JSON.stringify({ type: 'map', width: 2, height: 2, tilewidth: 16, tileheight: 16, layers: [{ type: 'tilelayer', width: 2, height: 2, data: [0] }] }));
    await expect(importDocument(huge, true)).rejects.toThrow(/cell layer limit/);
    await expect(importDocument(short, true)).rejects.toThrow(/contains 1 cells; expected 4/);
  });

  it('bounds compressed Tiled layer expansion to the declared dimensions', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'bomb.tmj'); const compressed = deflateSync(Buffer.alloc(1_024)).toString('base64');
    await writeFile(filePath, JSON.stringify({ type: 'map', width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ type: 'tilelayer', width: 1, height: 1, encoding: 'base64', compression: 'zlib', data: compressed }] }));
    await expect(importDocument(filePath, true)).rejects.toThrow();
  });

  it('rejects an oversized PSD canvas from its header before decoding layers', async () => {
    const directory = await temporaryDirectory(); const filePath = join(directory, 'oversized.psd'); const header = Buffer.alloc(26); header.write('8BPS', 0, 'ascii'); header.writeUInt16BE(1, 4); header.writeUInt32BE(1, 14); header.writeUInt32BE(8_193, 18); await writeFile(filePath, header);
    await expect(importDocument(filePath)).rejects.toThrow(/8192px\/16MP import limit/);
  });
});
