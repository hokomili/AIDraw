import { createCanvas, loadImage } from '@napi-rs/canvas';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, nowIso, writePixels, writeTiles, type ShapeObject } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import { captureObservation, MAX_OBSERVATION_SIDE } from '../../src/main/capture-observation';
import { exportDocument } from '../../src/main/export-document';
import { materializePaintTiles } from '../../src/main/persistence';
import { renderTilemap } from '../../src/main/render-document';
import { assertObservationUtilityResponse } from '../../src/main/utility-contract';

describe('bounded tilemap observation', () => {
  it('observes a tiny far-edge region without allocating the oversized nominal map raster', async () => {
    const document = createPixelDocument('project', 'Huge nominal observation'); document.assetIds = []; document.pixelAssets = {};
    document.palette[2].color = '#ff3366ff';
    const sprite = createPixelSprite('Observed tile', 16, 16); writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 2 }]);
    const tileset = createPixelTileset('Observed tileset', sprite.id, 16, 16, 1, 1); tileset.firstGid = 1;
    const map = createPixelTilemap('Million-column map'); map.width = 1_000_000; map.height = 1; map.tileWidth = 16; map.tileHeight = 16; map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    writeTiles(layer.chunks, [{ x: map.width - 1, y: 0, gid: 1 }]);
    layer.chunks['0,0'] = {
      x: 0, y: 0, width: 32, height: 32,
      get data(): string { throw new Error('A nonintersecting chunk was decoded.'); },
    };
    document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map }; document.assetIds = [sprite.id, tileset.id, map.id]; document.activeAssetId = map.id;
    const region = { x: (map.width - 1) * map.tileWidth, y: 0, width: 16, height: 16 };

    const observed = await captureObservation(document, { assetId: map.id, region, scale: 1, background: 'transparent' });
    expect(observed).toMatchObject({ available: true, width: 16, height: 16, region, assetId: map.id });
    const image = await loadImage(Buffer.from(String(observed.data), 'base64')); const canvas = createCanvas(16, 16); canvas.getContext('2d').drawImage(image, 0, 0);
    expect([...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([255, 51, 102, 255]);

    const fullRequest = { assetId: map.id, scale: 1, background: 'transparent' as const };
    const rejected = await captureObservation(document, fullRequest);
    expect(rejected).toMatchObject({ error: 'observation_dimensions_too_large', limit: { side: MAX_OBSERVATION_SIDE } });
    expect(() => assertObservationUtilityResponse(
      { id: 'oversized-observation', kind: 'capture-observation', document, request: fullRequest, maxPixels: 4_194_304 },
      { kind: 'capture-observation', result: rejected },
    )).not.toThrow();
    expect(() => renderTilemap(document, map)).toThrow(/Tilemap raster dimensions exceed the 65,535-pixel side limit/);
    for (const format of ['png', 'jpeg', 'webp', 'svg', 'pdf'] as const) {
      await expect(exportDocument(document, format)).rejects.toThrow(/Scaled export dimensions exceed the 65,535-pixel format limit/);
    }

    map.width = 8_193; map.height = 8_192; map.tileWidth = 1; map.tileHeight = 1;
    await expect(captureObservation(document, fullRequest)).resolves.toMatchObject({ error: 'observation_too_large', limit: { pixels: 4_194_304 } });
    expect(() => renderTilemap(document, map)).toThrow(/Tilemap raster exceeds the 64-megapixel safety limit/);
    await expect(exportDocument(document, 'png')).rejects.toThrow(/Scaled export exceeds the 64-megapixel safety limit/);
  });
});

describe('bounded illustration observation', () => {
  it('observes a tiny far-edge region without allocating the full maximum artboard', async () => {
    const document = createIllustrationDocument('Maximum regional illustration');
    document.artboard = { ...document.artboard, width: 8_192, height: 8_192, background: null };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso(); const object: ShapeObject = {
      id: 'far-edge-star', revision: 0, name: 'Far edge star', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 8_176, y: 8_176 },
      type: 'shape', shape: 'star', width: 16, height: 16, sides: 5, innerRadius: 0.45, fill: { kind: 'solid', color: '#ff3366' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[object.id] = object; layer.objectIds.push(object.id);
    const region = { x: 8_184, y: 8_184, width: 1, height: 1 };

    const observed = await captureObservation(document, { region, scale: 1, background: 'transparent' });
    expect(observed).toMatchObject({ available: true, width: 1, height: 1, region });
    const image = await loadImage(Buffer.from(String(observed.data), 'base64')); const canvas = createCanvas(1, 1); canvas.getContext('2d').drawImage(image, 0, 0);
    expect([...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([255, 51, 102, 255]);

    await expect(captureObservation(document, { scale: 1, background: 'transparent' })).resolves.toMatchObject({ error: 'observation_too_large', limit: { pixels: 4_194_304 } });
  });

  it('observes a tiny far-edge region from a complete materialized paint cache', async () => {
    const document = createIllustrationDocument('Maximum materialized-paint observation');
    document.artboard = { ...document.artboard, width: 8_192, height: 8_192, background: null };
    const paint = Object.values(document.layers).find((entry) => entry.type === 'paint');
    if (!paint || paint.type !== 'paint') throw new Error('Expected paint layer');
    paint.strokes.push({
      id: 'far-edge-paint', actorId: HUMAN_ACTOR.id, points: [{ x: 8_184, y: 8_184, pressure: 1 }],
      color: '#ff3366', size: 16, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round',
    });
    expect(materializePaintTiles(document)).toEqual({ layers: 1, renderedTiles: 1, reusedTiles: 0 });
    const region = { x: 8_184, y: 8_184, width: 1, height: 1 };

    const observed = await captureObservation(document, { region, scale: 1, background: 'transparent' });
    expect(observed).toMatchObject({ available: true, width: 1, height: 1, region });
    const image = await loadImage(Buffer.from(String(observed.data), 'base64')); const canvas = createCanvas(1, 1); canvas.getContext('2d').drawImage(image, 0, 0);
    expect([...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([255, 51, 102, 255]);

    await expect(captureObservation(document, { scale: 1, background: 'transparent' })).resolves.toMatchObject({ error: 'observation_too_large', limit: { pixels: 4_194_304 } });
  });
});
