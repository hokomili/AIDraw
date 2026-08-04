import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { quantizeImageToPalette, quantizeRgbaToPalette } from '@main/quantize-image';

const palette = [
  { id: 'transparent', name: 'Transparent', color: '#00000000' },
  { id: 'black', name: 'Black', color: '#000000' },
  { id: 'white', name: 'White', color: '#ffffff' },
];

describe('provider-neutral indexed image quantization', () => {
  it('uses OKLab matching and explicitly covers transparent target cells', () => {
    const rgba = new Uint8ClampedArray([5, 5, 5, 255, 250, 250, 250, 255, 255, 0, 0, 0]);
    expect(quantizeRgbaToPalette(rgba, 3, 1, palette, { alphaThreshold: 0.5, dithering: 'none', includeTransparent: true })).toEqual([
      { x: 0, y: 0, index: 1 }, { x: 1, y: 0, index: 2 }, { x: 2, y: 0, index: 0 },
    ]);
  });

  it('decodes an embedded raster and resizes it to the exact requested target', async () => {
    const source = createCanvas(1, 1); const context = source.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1);
    const changes = await quantizeImageToPalette(source.toBuffer('image/png'), 3, 2, palette, { alphaThreshold: 0.5, dithering: 'none', includeTransparent: true });
    expect(changes).toHaveLength(6);
    expect(changes.every((change) => change.index === 2)).toBe(true);
  });
});
