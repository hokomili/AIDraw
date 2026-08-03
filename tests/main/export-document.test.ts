import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  applyTransaction,
  createId,
  createIllustrationDocument,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  nowIso,
  writePixels,
  writeTiles,
  type CanvasTransaction,
  type ShapeObject,
} from '@aidraw/core';
import { exportDocument, illustrationToSvg, plannedExportCompanionPaths } from '@main/export-document';
import { decompressFrames, parseGIF } from 'gifuct-js';
import UPNG from 'upng-js';

describe('interchange exporters', () => {
  it('preserves editable illustration shapes in SVG', () => {
    const document = createIllustrationDocument('Vector export');
    const layer = document.layerIds.map((id) => document.layers[id]).find((entry) => entry.type === 'vector')!;
    const timestamp = nowIso();
    const shape: ShapeObject = {
      id: createId('shape'), revision: 0, name: 'Rectangle', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, type: 'shape', shape: 'rectangle', width: 40, height: 30, transform: IDENTITY_TRANSFORM, visible: true, locked: false,
      opacity: 1, blendMode: 'normal', blur: 3, fill: { kind: 'linear-gradient', x1: 0, y1: 0, x2: 40, y2: 0, stops: [{ offset: 0, color: '#ff6b7a' }, { offset: 1, color: '#ffe6a8' }] }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'shape', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object: shape }] };
    const svg = illustrationToSvg(applyTransaction(document, transaction).document as typeof document);
    expect(svg).toContain('<rect'); expect(svg).toContain('<linearGradient'); expect(svg).toContain('#ff6b7a'); expect(svg).toContain('<feGaussianBlur stdDeviation="3"');
  });

  it('exports an indexed sprite sheet with slicing metadata', async () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    writePixels(Object.values(sprite.cels)[0], [{ x: 1, y: 1, index: 4 }]);
    const artifact = await exportDocument(document, 'sprite-sheet');
    expect(artifact.data.subarray(1, 4).toString()).toBe('PNG');
    expect(Object.keys(JSON.parse(artifact.companion!.data.toString()).frames)).toHaveLength(1);
    expect(plannedExportCompanionPaths(document, 'sprite-sheet', 'output/hero.png')).toEqual(['output/hero.json']);
  });

  it('exports every cel as GIF and APNG animation frames', async () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const firstCel = Object.values(sprite.cels)[0]; writePixels(firstCel, [{ x: 0, y: 0, index: 2 }]);
    const timestamp = nowIso(); const frameId = createId('frame'); const celId = createId('cel'); sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: 'Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 140 }; sprite.cels[celId] = { id: celId, revision: 0, name: 'Frame 2 pixels', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: sprite.layerIds[0], frameId, chunks: {} }; writePixels(sprite.cels[celId], [{ x: 1, y: 0, index: 4 }]);
    const gif = await exportDocument(document, 'gif'); const apng = await exportDocument(document, 'apng');
    expect(decompressFrames(parseGIF(Uint8Array.from(gif.data).buffer), true)).toHaveLength(2); expect(UPNG.toRGBA8(UPNG.decode(Uint8Array.from(apng.data).buffer))).toHaveLength(2);
  });

  it('exports pixel artwork at an integer nearest-neighbor presentation scale', async () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    writePixels(Object.values(sprite.cels)[0], [{ x: 1, y: 1, index: 4 }]);
    const gif = await exportDocument(document, 'gif', { scale: 8 });
    const parsedGif = parseGIF(Uint8Array.from(gif.data).buffer);
    expect(parsedGif.lsd.width).toBe(sprite.width * 8); expect(parsedGif.lsd.height).toBe(sprite.height * 8);
    const png = await exportDocument(document, 'png', { scale: 4 }); const decodedPng = UPNG.decode(Uint8Array.from(png.data).buffer);
    expect(decodedPng.width).toBe(sprite.width * 4); expect(decodedPng.height).toBe(sprite.height * 4);
    const sheet = await exportDocument(document, 'sprite-sheet', { scale: 12 }); const metadata = JSON.parse(sheet.companion!.data.toString());
    expect(metadata.meta.scale).toBe(12); expect(metadata.frames[sprite.frameIds[0]].frame.w).toBe(sprite.width * 12);
    expect(gif.report.warnings).toContain('Exported at 8× using nearest-neighbor pixel scaling.');
  });

  it('rejects unsafe or unsupported export scales', async () => {
    const pixel = createPixelDocument('sprite'); const illustration = createIllustrationDocument('Vector');
    await expect(exportDocument(pixel, 'gif', { scale: 0 })).rejects.toThrow('integer from 1 to 64');
    await expect(exportDocument(pixel, 'psd', { scale: 2 })).rejects.toThrow('does not support presentation scaling');
    await expect(exportDocument(illustration, 'png', { scale: 2 })).rejects.toThrow('available for pixel documents');
  });

  it('exports Tiled JSON/XML with first-GID ranges, chunks, and source artwork', async () => {
    const document = createPixelDocument('project', 'Terrain'); document.assetIds = []; document.pixelAssets = {};
    const sprite = createPixelSprite('Terrain pixels', 16, 16); writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 3 }]);
    const tileset = createPixelTileset('Terrain', sprite.id, 16, 16, 1, 1); tileset.firstGid = 17;
    const map = createPixelTilemap('Map'); map.width = 4; map.height = 4; map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer'); writeTiles(layer.chunks, [{ x: 2, y: 1, gid: (17 | 0x8000_0000) >>> 0 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const json = await exportDocument(document, 'tiled-json'); const xml = await exportDocument(document, 'tiled-xml'); const parsed = JSON.parse(json.data.toString());
    expect(parsed.tilesets[0].firstgid).toBe(17); expect(parsed.layers[0].data[6]).toBe((17 | 0x8000_0000) >>> 0); expect(json.companions?.[0].data.subarray(1, 4).toString()).toBe('PNG'); expect(xml.extension).toBe('tmx'); expect(xml.data.toString()).toContain('firstgid="17"'); expect(xml.data.toString()).toContain(String((17 | 0x8000_0000) >>> 0));
  });
});
