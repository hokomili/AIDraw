import { describe, expect, it } from 'vitest';
import { inspectGif } from '../../src/main/gif';

function minimalGif(width = 1, height = 1): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]);
}

describe('bounded GIF inspection', () => {
  it('counts validated frame rectangles before LZW decoding', () => {
    expect(inspectGif(minimalGif())).toEqual({ width: 1, height: 1, frameCount: 1, patchPixels: 1 });
  });

  it('rejects huge logical screens, out-of-bounds frames, and truncated sub-blocks', () => {
    expect(() => inspectGif(minimalGif(9_000, 1))).toThrow('8192px/16MP');
    const outside = minimalGif(); outside[23] = 1; expect(() => inspectGif(outside)).toThrow('exceeds the logical screen');
    const truncated = minimalGif().subarray(0, -2); expect(() => inspectGif(truncated)).toThrow(/truncated|trailer/);
  });
});
