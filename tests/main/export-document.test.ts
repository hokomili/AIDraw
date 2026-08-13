import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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
  type PixelLayer,
  type ShapeObject,
  type TextObject,
} from '@aidraw/core';
import { MAX_PSD_LAYER_NESTING_DEPTH, MAX_PSD_LAYER_RECORDS, assertPsdLayerStructureBudget } from '@common/psd-limits';
import { assertAnimationExpandedPixelBudget, assertPsdLayerRasterBudget, boundedInterchangeExportReport, exportDocument, illustrationToSvg, plannedExportCompanionPaths } from '@main/export-document';
import { renderIllustrationLayerSource } from '@main/render-document';
import { MAX_UTILITY_REPORT_SERIALIZED_BYTES, MAX_UTILITY_TEXT_BYTES, assertUtilityJsonBudget } from '@main/utility-resource-policy';
import { decompressFrames, parseGIF } from 'gifuct-js';
import UPNG from 'upng-js';

describe('interchange exporters', () => {
  it('trims additive fidelity reasons to the aggregate utility envelope without displacing a valid legacy report', () => {
    const reason = { code: 'raster-fallback' as const, subjectType: 'object' as const, subjectId: 'object-1', subjectName: 'x'.repeat(200), detail: 'x'.repeat(1_024) };
    const report = boundedInterchangeExportReport([], [], Array.from({ length: 4_096 }, () => ({ ...reason })));
    expect(report.fidelity?.length).toBeGreaterThan(0);
    expect(report.fidelity?.length).toBeLessThan(4_096);
    expect(report.warnings).toContainEqual(expect.stringMatching(/truncated at 4,096 entries/));
    expect(() => assertUtilityJsonBudget(report, { label: 'test report', maxBytes: MAX_UTILITY_REPORT_SERIALIZED_BYTES, maxNodes: 4_096 * 8 + 4, maxDepth: 3 })).not.toThrow();

    const legacyWarnings = Array(16).fill('x'.repeat(MAX_UTILITY_TEXT_BYTES - 10));
    const legacy = boundedInterchangeExportReport(legacyWarnings, [], [reason]);
    expect(legacy).toEqual({ warnings: legacyWarnings, rasterized: [] });
    expect(() => assertUtilityJsonBudget(legacy, { label: 'legacy report', maxBytes: MAX_UTILITY_REPORT_SERIALIZED_BYTES, maxNodes: 4_096 * 8 + 4, maxDepth: 3 })).not.toThrow();
  });

  it('rejects expanded PSD layer rasters before allocating their full canvases', async () => {
    expect(() => assertPsdLayerRasterBudget(8_192, 8_192, 1)).not.toThrow();
    expect(() => assertPsdLayerRasterBudget(4_096, 4_096, 4)).not.toThrow();
    expect(() => assertPsdLayerRasterBudget(8_192, 8_192, 2)).toThrow(/64-megapixel expanded safety budget/);
    expect(() => assertPsdLayerRasterBudget(4_096, 4_096, 5)).toThrow(/64-megapixel expanded safety budget/);
    expect(() => assertPsdLayerRasterBudget(0, 4_096, 1)).toThrow(/positive safe integers/);
    expect(() => assertPsdLayerRasterBudget(4_096, 4_096, -1)).toThrow(/nonnegative safe integer/);

    const pixel = createPixelDocument('sprite', 'PSD raster budget'); const sprite = pixel.pixelAssets[pixel.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.width = 8_192; sprite.height = 8_192;
    const firstLayer = sprite.layers[sprite.layerIds[0]]; const firstCel = Object.values(sprite.cels)[0]; const secondLayerId = createId('layer'); const secondCelId = createId('cel');
    sprite.layers[secondLayerId] = { ...structuredClone(firstLayer), id: secondLayerId, name: 'Second layer' }; sprite.layerIds.push(secondLayerId);
    sprite.cels[secondCelId] = { ...structuredClone(firstCel), id: secondCelId, name: 'Second cel', layerId: secondLayerId, chunks: {} };
    await expect(exportDocument(pixel, 'psd')).rejects.toThrow(/64-megapixel expanded safety budget/);

    const illustration = createIllustrationDocument('PSD raster budget'); illustration.artboard = { ...illustration.artboard, width: 8_192, height: 8_192 };
    await expect(exportDocument(illustration, 'psd')).rejects.toThrow(/64-megapixel expanded safety budget/);
  });

  it('rejects oversized PSD output trees before writer recursion or layer rendering', async () => {
    expect(() => assertPsdLayerStructureBudget(MAX_PSD_LAYER_RECORDS, MAX_PSD_LAYER_NESTING_DEPTH)).not.toThrow();
    expect(() => assertPsdLayerStructureBudget(MAX_PSD_LAYER_RECORDS + 1, MAX_PSD_LAYER_NESTING_DEPTH)).toThrow(/2,048-layer safety limit/);
    expect(() => assertPsdLayerStructureBudget(MAX_PSD_LAYER_RECORDS, MAX_PSD_LAYER_NESTING_DEPTH + 1)).toThrow(/64-level safety limit/);

    const broad = createPixelDocument('sprite', 'PSD broad structure'); const broadSprite = broad.pixelAssets[broad.activeAssetId];
    if (broadSprite.type !== 'sprite') throw new Error('Expected sprite'); broadSprite.layers = {}; broadSprite.layerIds = []; broadSprite.cels = {};
    const timestamp = nowIso();
    for (let index = 0; index <= MAX_PSD_LAYER_RECORDS; index += 1) {
      const id = createId('layer'); const layer: PixelLayer = { id, revision: 0, name: `Empty group ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type: 'group', visible: true, locked: false, opacity: 1, blendMode: 'normal', childIds: [] };
      broadSprite.layers[id] = layer; broadSprite.layerIds.push(id);
    }
    await expect(exportDocument(broad, 'psd')).rejects.toThrow(/2,048-layer safety limit/);

    const deep = createPixelDocument('sprite', 'PSD deep structure'); const deepSprite = deep.pixelAssets[deep.activeAssetId];
    if (deepSprite.type !== 'sprite') throw new Error('Expected sprite'); deepSprite.layers = {}; deepSprite.layerIds = []; deepSprite.cels = {};
    const deepIds = Array.from({ length: MAX_PSD_LAYER_NESTING_DEPTH + 2 }, () => createId('layer'));
    deepIds.forEach((id, index) => {
      const layer: PixelLayer = { id, revision: 0, name: `Depth ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type: 'group', visible: true, locked: false, opacity: 1, blendMode: 'normal', childIds: deepIds[index + 1] ? [deepIds[index + 1]] : [], ...(index > 0 ? { parentId: deepIds[index - 1] } : {}) };
      deepSprite.layers[id] = layer;
    });
    deepSprite.layerIds = [deepIds[0]];
    await expect(exportDocument(deep, 'psd')).rejects.toThrow(/64-level safety limit/);

    const companions = createIllustrationDocument('PSD companion structure'); const vector = companions.layerIds.map((id) => companions.layers[id]).find((layer) => layer.type === 'vector');
    if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const textCount = MAX_PSD_LAYER_RECORDS - companions.layerIds.length;
    for (let index = 0; index < textCount; index += 1) {
      const id = createId('text'); const text: TextObject = { id, revision: 0, name: `Text ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, type: 'text', text: 'x', width: 1, height: 1, transform: IDENTITY_TRANSFORM, visible: true, locked: false, opacity: 1, blendMode: 'normal', align: 'left', lineHeight: 1, ranges: [{ start: 0, end: 1, fontFamily: 'ArialMT', fontSize: 1, fontWeight: 400, fontStyle: 'normal', color: '#000000', letterSpacing: 0 }] };
      companions.objects[id] = text; vector.objectIds.push(id);
    }
    await expect(exportDocument(companions, 'psd')).rejects.toThrow(/2,048-layer safety limit/);
  });

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

  it('bakes authored paint filters and vector masks into the SVG fallback without baking root composite metadata', async () => {
    const document = createIllustrationDocument('Paint SVG fidelity'); document.artboard = { ...document.artboard, width: 16, height: 16, background: null };
    const paintLayer = Object.values(document.layers).find((entry) => entry.type === 'paint');
    const maskLayer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!paintLayer || paintLayer.type !== 'paint' || !maskLayer || maskLayer.type !== 'vector') throw new Error('Expected paint and vector layers');
    paintLayer.opacity = 0.5; paintLayer.blendMode = 'multiply'; paintLayer.filters = [{ type: 'brightness', value: -1 }]; paintLayer.maskLayerId = maskLayer.id;
    paintLayer.strokes.push({ id: 'masked-paint', actorId: HUMAN_ACTOR.id, points: [{ x: 2, y: 8, pressure: 0.5 }, { x: 14, y: 8, pressure: 0.5 }], color: '#ff0000', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    maskLayer.visible = false;
    const timestamp = nowIso(); const mask: ShapeObject = {
      id: 'paint-mask', revision: 0, name: 'Left half mask', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: maskLayer.id, type: 'shape', shape: 'rectangle', width: 8, height: 16, transform: IDENTITY_TRANSFORM, visible: true, locked: false,
      opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#ffffff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[mask.id] = mask; maskLayer.objectIds.push(mask.id);
    const before = structuredClone(document);
    const expected = await renderIllustrationLayerSource(document, paintLayer.id);
    const expectedPixels = Buffer.from(expected.getContext('2d').getImageData(0, 0, 16, 16).data); expected.width = 1; expected.height = 1;

    const artifact = await exportDocument(document, 'svg'); const svg = artifact.data.toString();
    const embedded = /href="data:image\/png;base64,([^"]+)"/.exec(svg)?.[1];
    if (!embedded) throw new Error('Expected embedded paint fallback');
    const image = await loadImage(Buffer.from(embedded, 'base64')); const actual = createCanvas(16, 16); actual.getContext('2d').drawImage(image, 0, 0);
    const actualPixels = Buffer.from(actual.getContext('2d').getImageData(0, 0, 16, 16).data); actual.width = 1; actual.height = 1;
    expect(actualPixels).toEqual(expectedPixels);
    expect([...actualPixels.subarray((8 * 16 + 4) * 4, (8 * 16 + 4) * 4 + 4)]).toEqual([0, 0, 0, 255]);
    expect([...actualPixels.subarray((8 * 16 + 12) * 4, (8 * 16 + 12) * 4 + 4)]).toEqual([0, 0, 0, 0]);
    expect(svg).toContain(`<g id="${paintLayer.id}" opacity="0.5" style="mix-blend-mode:multiply">`);
    expect(artifact.report).toEqual({
      warnings: ['Paint layers are embedded as transparent PNG fallbacks so erasing and natural-media brushes remain visually faithful.'],
      rasterized: [paintLayer.name],
      fidelity: [{
        code: 'raster-fallback',
        subjectType: 'layer',
        subjectId: paintLayer.id,
        subjectName: paintLayer.name,
        detail: 'SVG export embeds this paint layer as a transparent PNG; authored paint, adjustment filters, and a vector layer mask are baked into the fallback where present.',
      }],
    });
    expect(document).toEqual(before);

    paintLayer.visible = false;
    const hidden = await exportDocument(document, 'svg');
    expect(hidden.data.toString()).not.toContain('data:image/png;base64');
    expect(hidden.report).toEqual({ warnings: [], rasterized: [] });

    paintLayer.visible = true; document.layerIds = document.layerIds.filter((layerId) => layerId !== paintLayer.id);
    const unreachable = await exportDocument(document, 'svg');
    expect(unreachable.data.toString()).not.toContain('data:image/png;base64');
    expect(unreachable.report).toEqual({ warnings: [], rasterized: [] });

    document.layerIds.push(paintLayer.id); paintLayer.strokes = []; paintLayer.tileAssetIds = { '0,0': 'orphan-cache-record' };
    const empty = await exportDocument(document, 'svg');
    expect(empty.data.toString()).not.toContain('data:image/png;base64');
    expect(empty.report).toEqual({ warnings: [], rasterized: [] });
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

  it('rejects retained APNG frame surfaces above the expanded-pixel budget before rendering', async () => {
    expect(() => assertAnimationExpandedPixelBudget(8_192, 8_192, 1)).not.toThrow();
    expect(() => assertAnimationExpandedPixelBudget(4_096, 4_096, 4)).not.toThrow();
    expect(() => assertAnimationExpandedPixelBudget(8_192, 8_192, 2)).toThrow(/64-megapixel expanded-frame safety budget/);
    expect(() => assertAnimationExpandedPixelBudget(4_096, 4_096, 5)).toThrow(/64-megapixel expanded-frame safety budget/);
    expect(() => assertAnimationExpandedPixelBudget(0, 4_096, 1)).toThrow(/dimensions must be positive safe integers/);
    expect(() => assertAnimationExpandedPixelBudget(4_096, 4_096, 0)).toThrow(/frame count must be a positive safe integer/);

    const document = createPixelDocument('sprite', 'APNG retained-frame budget'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.width = 1_024; sprite.height = 1_024;
    const frameId = createId('frame'); sprite.frameIds.push(frameId); sprite.frames[frameId] = { ...structuredClone(sprite.frames[sprite.frameIds[0]]), id: frameId, name: 'Frame 2' };
    await expect(exportDocument(document, 'apng', { scale: 8 })).rejects.toThrow(/64-megapixel expanded-frame safety budget/);
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
    writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 2 }]);
    for (let index = 2; index <= 3; index += 1) { const frameId = `frame-${index}`; const celId = `cel-${index}`; sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 100 + index }; sprite.cels[celId] = { id: celId, revision: 0, name: `Cel ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: sprite.layerIds[0], frameId, chunks: {} }; writePixels(sprite.cels[celId], [{ x: index - 1, y: 0, index: index + 2 }]); }
    sprite.tags = [{ id: 'bounce', name: 'Bounce', fromFrameId: sprite.frameIds[0], toFrameId: sprite.frameIds[2], direction: 'ping-pong', color: '#ff6b7a' }];
    const gif = await exportDocument(document, 'gif', { animationTagId: 'bounce' }); expect(decompressFrames(parseGIF(Uint8Array.from(gif.data).buffer), true)).toHaveLength(4); expect(gif.report.warnings).toContain('Exported animation tag “Bounce” using ping-pong playback.');
    const apng = UPNG.decode(Uint8Array.from((await exportDocument(document, 'apng', { animationTagId: 'bounce' })).data).buffer); const apngFrames = UPNG.toRGBA8(apng).map((frame) => Buffer.from(frame)); expect(apng.frames.map((frame) => frame.delay)).toEqual([sprite.frames[sprite.frameIds[0]].durationMs, 102, 103, 102]); expect(apngFrames).toHaveLength(4); expect(apngFrames[0].equals(apngFrames[1])).toBe(false); expect(apngFrames[1].equals(apngFrames[2])).toBe(false); expect(apngFrames[3].equals(apngFrames[1])).toBe(true);
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
    tileset.wangSets = [{ id: 'qa06-meadow', name: 'QA-06 Meadow', type: 'mixed', colors: [{ id: 1, name: 'Meadow', color: '#55aa44', tileId: 0, probability: 0.75 }], tiles: [{ tileId: 0, wangId: [0, 0, 0, 0, 0, 0, 0, 0] }, { tileId: 1, wangId: [1, 1, 1, 1, 1, 1, 1, 1] }] }];
    const map = createPixelTilemap('Map'); map.width = 4; map.height = 4; map.tilesetIds = [tileset.id]; map.properties['qa06-scenario'] = 'finite-wang'; const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer'); writeTiles(layer.chunks, [{ x: 2, y: 1, gid: (17 | 0x8000_0000) >>> 0 }]);
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const json = await exportDocument(document, 'tiled-json'); const xml = await exportDocument(document, 'tiled-xml'); const parsed = JSON.parse(json.data.toString());
    expect(parsed).toMatchObject({ type: 'map', infinite: false, width: 4, height: 4, properties: [{ name: 'qa06-scenario', value: 'finite-wang', type: 'string' }] });
    expect(parsed.tilesets[0]).toMatchObject({ firstgid: 17, wangsets: [{ name: 'QA-06 Meadow', type: 'mixed', colors: [{ name: 'Meadow', color: '#55aa44', tile: 0, probability: 0.75 }], wangtiles: [{ tileid: 0, wangid: [0, 0, 0, 0, 0, 0, 0, 0] }, { tileid: 1, wangid: [1, 1, 1, 1, 1, 1, 1, 1] }] }] });
    expect(parsed.layers[0].data[6]).toBe((17 | 0x8000_0000) >>> 0); expect(json.companions?.[0].data.subarray(1, 4).toString()).toBe('PNG'); expect(xml.extension).toBe('tmx'); expect(xml.data.toString()).toContain('firstgid="17"'); expect(xml.data.toString()).toContain('wangset name="QA-06 Meadow"'); expect(xml.data.toString()).toContain(String((17 | 0x8000_0000) >>> 0));
  });
});
