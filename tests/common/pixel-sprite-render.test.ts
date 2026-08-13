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

  it('supports exact editor opacity, color, and replay-mask hooks', () => {
    const document = createPixelDocument('project', 'Editor hooks');
    const sprite = createPixelSprite('Hooked source', 2, 1); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 3 }]);
    const canvas = createCanvas(2, 1);
    drawPixelSpriteRegion(canvas.getContext('2d'), sprite, sprite.frameIds[0], document.palette, { x: 0, y: 0, width: 2, height: 1 }, {
      opacityMultiplier: 0.5,
      colorForIndex: () => '#0000ffff',
      skipPixel: (_targetCel, x) => x === 1,
    });
    const pixels = [...canvas.getContext('2d').getImageData(0, 0, 2, 1).data];
    expect(pixels.slice(0, 3)).toEqual([0, 0, 255]);
    expect(pixels[3]).toBeGreaterThanOrEqual(127); expect(pixels[3]).toBeLessThanOrEqual(128);
    expect(pixels.slice(4)).toEqual([0, 0, 0, 0]);
    expect(() => drawPixelSpriteRegion(canvas.getContext('2d'), sprite, sprite.frameIds[0], document.palette, { x: 0, y: 0, width: 1, height: 1 }, { opacityMultiplier: 2 })).toThrow(/between zero and one/);
  });

  it('does not access a nonintersecting stored chunk payload', () => {
    const document = createPixelDocument('project', 'Candidate-only decode');
    const sprite = createPixelSprite('Sparse source', 64, 1); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 32, y: 0, index: 2 }]);
    Object.defineProperty(cel.chunks, '0,0', { configurable: true, enumerable: true, get: () => { throw new Error('A nonintersecting sprite chunk was decoded.'); } });
    const canvas = createCanvas(1, 1);
    drawPixelSpriteRegion(canvas.getContext('2d'), sprite, sprite.frameIds[0], document.palette, { x: 32, y: 0, width: 1, height: 1 }, { invalidChunk: 'skip' });
    expect(canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3]).toBe(255);
  });
});
