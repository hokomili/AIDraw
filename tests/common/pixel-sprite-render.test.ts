import { createCanvas } from '@napi-rs/canvas';
import { createPixelDocument, createPixelSprite, writePixels } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import { drawPixelSpriteRegion, pixelSpriteRegionPlan } from '../../src/common/pixel-sprite-render';

describe('bounded pixel sprite rendering', () => {
  it('matches full-sprite fractional sampling while allocating only the nominal intersection', () => {
    const document = createPixelDocument('project', 'Fractional crop');
    document.palette[2].color = '#ff0000ff'; document.palette[3].color = '#00ff00ff'; document.palette[4].color = '#0000ffff';
    const sprite = createPixelSprite('Fractional source', 4, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, Array.from({ length: 8 }, (_, offset) => ({ x: offset % 4, y: Math.floor(offset / 4), index: 2 + offset % 3 })));
    const source = { x: 1.5, y: 0, width: 3, height: 2 };
    const plan = pixelSpriteRegionPlan(sprite, source);
    expect(plan).toEqual({ render: { x: 1, y: 0, width: 3, height: 2 }, sample: { x: 0.5, y: 0, width: 3, height: 2 }, empty: false });

    const full = createCanvas(4, 2); drawPixelSpriteRegion(full.getContext('2d'), sprite, sprite.frameIds[0], document.palette, { x: 0, y: 0, width: 4, height: 2 });
    const bounded = createCanvas(plan.render.width, plan.render.height); drawPixelSpriteRegion(bounded.getContext('2d'), sprite, sprite.frameIds[0], document.palette, plan.render);
    const expected = createCanvas(6, 4); expected.getContext('2d').imageSmoothingEnabled = false; expected.getContext('2d').drawImage(full, source.x, source.y, source.width, source.height, 0, 0, 6, 4);
    const actual = createCanvas(6, 4); actual.getContext('2d').imageSmoothingEnabled = false; actual.getContext('2d').drawImage(bounded, plan.sample.x, plan.sample.y, plan.sample.width, plan.sample.height, 0, 0, 6, 4);
    expect(Buffer.from(actual.getContext('2d').getImageData(0, 0, 6, 4).data)).toEqual(Buffer.from(expected.getContext('2d').getImageData(0, 0, 6, 4).data));
  });

  it('keeps stored pixels outside nominal sprite bounds transparent', () => {
    const document = createPixelDocument('project', 'Nominal clipping');
    const sprite = createPixelSprite('Clipped source', 64, 2); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 32, y: 0, index: 2 }, { x: 64, y: 0, index: 2 }]);
    (cel.chunks as Record<string, unknown>)['0,0'] = null;
    const canvas = createCanvas(1, 1);
    drawPixelSpriteRegion(canvas.getContext('2d'), sprite, sprite.frameIds[0], document.palette, { x: 32, y: 0, width: 1, height: 1 });
    expect(canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3]).toBe(255);
    expect(pixelSpriteRegionPlan(sprite, { x: 64, y: 0, width: 1, height: 1 }).empty).toBe(true);
    canvas.getContext('2d').clearRect(0, 0, 1, 1);
    drawPixelSpriteRegion(canvas.getContext('2d'), sprite, sprite.frameIds[0], document.palette, { x: 64, y: 0, width: 1, height: 1 }, { invalidChunk: 'skip' });
    expect([...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
  });
});
