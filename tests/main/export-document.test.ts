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
  type TextObject,
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
      opacity: 1, blendMode: 'normal', blur: 3, fill: { kind: 'linear-gradient', x1: 0, y1: 0, x2: 40, y2: 0, stops: [{ offset: 0, color: '#ff6b7a', opacity: 0.35 }, { offset: 1, color: '#ffe6a8' }] }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'shape', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object: shape }] };
    const svg = illustrationToSvg(applyTransaction(document, transaction).document as typeof document);
    expect(svg).toContain('<rect'); expect(svg).toContain('<linearGradient'); expect(svg).toContain('#ff6b7a'); expect(svg).toContain('stop-opacity="0.35"'); expect(svg).toContain('<feGaussianBlur stdDeviation="3"');
  });

  it('embeds paint layers as transparent SVG raster fallbacks with an explicit report', async () => {
    const document = createIllustrationDocument('Paint SVG'); document.artboard = { ...document.artboard, width: 16, height: 16, background: null };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'paint'); if (!layer || layer.type !== 'paint') throw new Error('Expected paint layer');
    layer.strokes.push(
      { id: 'paint', actorId: HUMAN_ACTOR.id, points: [{ x: 2, y: 8, pressure: 0.5 }, { x: 14, y: 8, pressure: 0.5 }], color: '#ff0000', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' },
      { id: 'erase', actorId: HUMAN_ACTOR.id, points: [{ x: 8, y: 4, pressure: 0.5 }, { x: 8, y: 12, pressure: 0.5 }], color: '#000000', size: 3, opacity: 1, hardness: 1, flow: 1, mode: 'erase', preset: 'eraser' },
    );
    const artifact = await exportDocument(document, 'svg'); const svg = artifact.data.toString();
    expect(svg).toContain('href="data:image/png;base64,'); expect(svg).not.toContain('<polyline');
    expect(artifact.report.rasterized).toEqual([layer.name]); expect(artifact.report.warnings).toContainEqual(expect.stringMatching(/Paint layers are embedded/));
  });

  it('keeps supported illustration geometry and text native in hybrid PDF exports', async () => {
    const document = createIllustrationDocument('Hybrid PDF'); document.artboard = { ...document.artboard, width: 160, height: 100, background: '#ffffff' };
    const vectorLayer = Object.values(document.layers).find((entry) => entry.type === 'vector'); const paintLayer = Object.values(document.layers).find((entry) => entry.type === 'paint');
    if (!vectorLayer || vectorLayer.type !== 'vector' || !paintLayer || paintLayer.type !== 'paint') throw new Error('Expected illustration layers');
    const timestamp = nowIso();
    const shape: ShapeObject = { id: 'pdf-shape', revision: 0, name: 'Native rectangle', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vectorLayer.id, type: 'shape', shape: 'rectangle', width: 50, height: 24, transform: { ...IDENTITY_TRANSFORM, x: 8, y: 8 }, visible: true, locked: false, opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#f2b84b' }, stroke: { paint: { kind: 'solid', color: '#432f12' }, width: 2, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    const text: TextObject = { id: 'pdf-text', revision: 0, name: 'Searchable label', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vectorLayer.id, type: 'text', text: 'AIDraw PDF', width: 120, height: 30, transform: { ...IDENTITY_TRANSFORM, x: 8, y: 42 }, visible: true, locked: false, opacity: 1, blendMode: 'normal', align: 'left', lineHeight: 1.2, ranges: [{ start: 0, end: 10, fontFamily: 'Helvetica', fontSize: 18, fontWeight: 700, fontStyle: 'normal', color: '#27213c', letterSpacing: 0 }] };
    document.objects[shape.id] = shape; document.objects[text.id] = text; vectorLayer.objectIds.push(shape.id, text.id);
    paintLayer.strokes.push({ id: 'pdf-paint', actorId: HUMAN_ACTOR.id, points: [{ x: 90, y: 20, pressure: 0.5 }, { x: 145, y: 20, pressure: 0.5 }], color: '#38a89d', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const artifact = await exportDocument(document, 'pdf');
    expect(artifact.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(artifact.report.rasterized).toContain(paintLayer.name); expect(artifact.report.rasterized).not.toContain(vectorLayer.name); expect(artifact.report.rasterized).not.toContain(shape.name); expect(artifact.report.rasterized).not.toContain(text.name);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const loading = pdfjs.getDocument({ data: Uint8Array.from(artifact.data) });
    try { const page = await loading.promise.then((source) => source.getPage(1)); const content = await page.getTextContent(); expect(content.items.some((item) => 'str' in item && item.str.includes('AIDraw PDF'))).toBe(true); }
    finally { await loading.destroy(); }
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

  it('renders canonical illustration keyframes into GIF and APNG frames', async () => {
    const document = createIllustrationDocument('Animated illustration'); document.artboard = { ...document.artboard, width: 16, height: 8, background: null }; document.animation = { ...document.animation, durationMs: 500, framesPerSecond: 4, playback: 'loop' };
    const layer = document.layerIds.map((id) => document.layers[id]).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape: ShapeObject = { id: 'moving', revision: 0, name: 'Moving', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, type: 'shape', shape: 'rectangle', width: 3, height: 3, transform: { ...IDENTITY_TRANSFORM }, visible: true, locked: false, opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#ff6b7a' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    document.objects[shape.id] = shape; if (layer.type !== 'vector') throw new Error('Expected vector layer'); layer.objectIds.push(shape.id);
    document.animation.keyframeIds = ['start', 'end']; document.animation.keyframes = {
      start: { id: 'start', revision: 0, name: 'Start', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, objectId: shape.id, timeMs: 0, transform: { ...IDENTITY_TRANSFORM }, opacity: 1, visible: true, easing: 'linear' },
      end: { id: 'end', revision: 0, name: 'End', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, objectId: shape.id, timeMs: 500, transform: { ...IDENTITY_TRANSFORM, x: 10 }, opacity: 1, visible: true, easing: 'linear' },
    };
    const gif = await exportDocument(document, 'gif'); const apng = await exportDocument(document, 'apng');
    expect(decompressFrames(parseGIF(Uint8Array.from(gif.data).buffer), true)).toHaveLength(2);
    expect(UPNG.toRGBA8(UPNG.decode(Uint8Array.from(apng.data).buffer))).toHaveLength(2);
    expect(gif.report.rasterized).toEqual(['illustration animation frames']); expect(gif.report.warnings[0]).toContain('4 fps');
    document.animation.keyframeIds = []; document.animation.keyframes = {};
    await expect(exportDocument(document, 'gif')).rejects.toThrow(/at least one keyframe/);
  });

  it('exports a named animation tag in its authored direction and records the exact sheet sequence', async () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const timestamp = nowIso();
    for (let index = 2; index <= 3; index += 1) { const frameId = `frame-${index}`; const celId = `cel-${index}`; sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 100 + index }; sprite.cels[celId] = { id: celId, revision: 0, name: `Cel ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: sprite.layerIds[0], frameId, chunks: {} }; }
    sprite.tags = [{ id: 'bounce', name: 'Bounce', fromFrameId: sprite.frameIds[0], toFrameId: sprite.frameIds[2], direction: 'ping-pong', color: '#ff6b7a' }];
    const gif = await exportDocument(document, 'gif', { animationTagId: 'bounce' }); expect(decompressFrames(parseGIF(Uint8Array.from(gif.data).buffer), true)).toHaveLength(4); expect(gif.report.warnings).toContain('Exported animation tag “Bounce” using ping-pong playback.');
    const sheet = await exportDocument(document, 'sprite-sheet', { animationTagId: 'bounce' }); const metadata = JSON.parse(sheet.companion!.data.toString()); expect(metadata.meta.frameOrder).toEqual([sprite.frameIds[0], sprite.frameIds[1], sprite.frameIds[2], sprite.frameIds[1]]); expect(Object.keys(metadata.frames)).toHaveLength(4);
    await expect(exportDocument(document, 'gif', { animationTagId: 'missing' })).rejects.toThrow(/does not exist/);
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
