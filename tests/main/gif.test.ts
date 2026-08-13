import { describe, expect, it } from 'vitest';
import { GIFEncoder } from 'gifenc';
import { decodeGifFrames, inspectGif } from '../../src/main/gif';

function minimalGif(width = 1, height = 1): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 2, 2, 0x44, 0x01, 0, 0x3b]);
}

function replaceImageData(bytes: Buffer, payload: readonly number[]): Buffer {
  return Buffer.concat([bytes.subarray(0, 30), Buffer.from([payload.length, ...payload, 0, 0x3b])]);
}

function withoutGlobalColorTable(bytes: Buffer): Buffer {
  return Buffer.concat([bytes.subarray(0, 10), Buffer.from([0, bytes[11], bytes[12]]), bytes.subarray(19)]);
}

function withTransparencyIndex(bytes: Buffer, index: number): Buffer {
  return Buffer.concat([bytes.subarray(0, 19), Buffer.from([0x21, 0xf9, 4, 1, 0, 0, index, 0]), bytes.subarray(19)]);
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

  it('decodes a complete pixel stream through its active color table', () => {
    const frames = decodeGifFrames(minimalGif());
    expect(frames).toHaveLength(1);
    expect(frames[0].dims).toEqual({ width: 1, height: 1, top: 0, left: 0 });
    expect(frames[0].patch).toEqual(Uint8ClampedArray.from([0, 0, 0, 255]));
    expect(decodeGifFrames(replaceImageData(minimalGif(2, 1), [0x04, 0x53]))[0].patch).toEqual(Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]));
  });

  it('decodes code-size growth without changing pixels', () => {
    const width = 256; const height = 256;
    const palette = Array.from({ length: 16 }, (_, index) => [index * 11, index * 7, index * 3]);
    const indexes = new Uint8Array(width * height); const expected = new Uint8ClampedArray(width * height * 4); let state = 0x9e3779b9;
    for (let index = 0; index < indexes.length; index += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      const colorIndex = state & 15; indexes[index] = colorIndex; expected.set([...palette[colorIndex], 255], index * 4);
    }
    const encoder = GIFEncoder(); encoder.writeFrame(indexes, width, height, { palette }); encoder.finish();
    expect(decodeGifFrames(Buffer.from(encoder.bytes()))[0].patch).toEqual(expected);
  });

  it('rejects LZW streams without exact pixels and an end-of-information code', () => {
    expect(() => decodeGifFrames(replaceImageData(minimalGif(), [0x2c]))).toThrow('decoded 0 pixels instead of 1');
    expect(() => decodeGifFrames(replaceImageData(minimalGif(), [0x04]))).toThrow('ended before its end-of-information code');
    expect(() => decodeGifFrames(replaceImageData(minimalGif(), [0x04, 0x0a]))).toThrow('expands beyond its declared rectangle');
    expect(() => decodeGifFrames(replaceImageData(minimalGif(), [0xc4, 0x01]))).toThrow('invalid LZW dictionary code');
  });

  it('rejects missing or out-of-range active palette entries', () => {
    expect(() => decodeGifFrames(withoutGlobalColorTable(minimalGif()))).toThrow('has no active color table');
    expect(() => decodeGifFrames(replaceImageData(minimalGif(), [0x54, 0x01]))).toThrow('references color index 2 outside its active color table');
    expect(() => decodeGifFrames(withTransparencyIndex(minimalGif(), 2))).toThrow('transparency index falls outside its active color table');
  });
});
