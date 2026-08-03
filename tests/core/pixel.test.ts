import { describe, expect, it } from 'vitest';
import { createPixelDocument, readPixel, resizePixelSpriteCanvas, writePixels, writeTiles, readTile, type TilemapChunk } from '@aidraw/core';

describe('chunked indexed pixels and sparse tiles', () => {
  it('round-trips pixels across positive and negative chunk boundaries', () => {
    const document = createPixelDocument('sprite');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const inverse = writePixels(cel, [{ x: 0, y: 0, index: 4 }, { x: 31, y: 31, index: 7 }, { x: 32, y: 32, index: 9 }, { x: -1, y: -1, index: 3 }]);
    expect(readPixel(cel, 0, 0)).toBe(4);
    expect(readPixel(cel, 32, 32)).toBe(9);
    expect(readPixel(cel, -1, -1)).toBe(3);
    writePixels(cel, inverse);
    expect(readPixel(cel, 32, 32)).toBe(0);
  });

  it('stores 32-bit tile GIDs in sparse chunks', () => {
    const chunks: Record<string, TilemapChunk> = {};
    const inverse = writeTiles(chunks, [{ x: 34, y: 2, gid: 0xf000_0042 }]);
    const chunk = Object.values(chunks)[0];
    expect(readTile(chunk, 34, 2)).toBe(0xf000_0042);
    writeTiles(chunks, inverse);
    expect(readTile(chunk, 34, 2)).toBe(0);
  });

  it('treats a legacy cel with no chunk table as empty and repairs it on write', () => {
    const document = createPixelDocument('sprite');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    delete (cel as Partial<typeof cel>).chunks;
    expect(readPixel(cel, 3, 4)).toBe(0);
    writePixels(cel, [{ x: 3, y: 4, index: 6 }]);
    expect(readPixel(cel, 3, 4)).toBe(6);
  });

  it('resizes a sprite canvas from the top-left and permanently crops outside pixels', () => {
    const document = createPixelDocument('sprite');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 7, y: 9, index: 2 }, { x: 63, y: 63, index: 4 }]);

    const smaller = resizePixelSpriteCanvas(sprite, 32, 48);
    const smallerCel = Object.values(smaller.cels)[0];
    expect([smaller.width, smaller.height]).toEqual([32, 48]);
    expect(readPixel(smallerCel, 7, 9)).toBe(2);
    expect(readPixel(smallerCel, 63, 63)).toBe(0);
    expect(readPixel(cel, 63, 63)).toBe(4);

    const larger = resizePixelSpriteCanvas(smaller, 80, 72);
    expect([larger.width, larger.height]).toEqual([80, 72]);
    expect(readPixel(Object.values(larger.cels)[0], 7, 9)).toBe(2);
    expect(readPixel(Object.values(larger.cels)[0], 63, 63)).toBe(0);
  });
});
