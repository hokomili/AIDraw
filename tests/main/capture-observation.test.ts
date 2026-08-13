import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, writePixels, writeTiles } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import { captureObservation, MAX_OBSERVATION_SIDE } from '../../src/main/capture-observation';
import { exportDocument } from '../../src/main/export-document';
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
