import { describe, expect, it } from 'vitest';
import { createPixelDocument, decodeTiledGid, encodeTiledGid, readPixel, resizePixelSpriteCanvas, writePixelRuns, writePixels, writeTileRuns, writeTiles, readTile, type TilemapChunk } from '@aidraw/core';

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
    expect(cel.chunks).toEqual({});
  });

  it('stores 32-bit tile GIDs in sparse chunks', () => {
    const chunks: Record<string, TilemapChunk> = {};
    const inverse = writeTiles(chunks, [{ x: 34, y: 2, gid: 0xf000_0042 }]);
    const chunk = Object.values(chunks)[0];
    expect(readTile(chunk, 34, 2)).toBe(0xf000_0042);
    writeTiles(chunks, inverse);
    expect(chunks).toEqual({});
  });

  it('round-trips Tiled flip and diagonal flags as unsigned GIDs', () => {
    const encoded = encodeTiledGid(0x0abc_def0, { hFlip: true, vFlip: true, diagonal: true });
    expect(encoded).toBe(0xeabc_def0);
    expect(decodeTiledGid(encoded)).toEqual({ gid: 0x0abc_def0, hFlip: true, vFlip: true, diagonal: true });
    expect(() => encodeTiledGid(0x1000_0000)).toThrow(/28-bit/);
  });

  it('writes compact pixel and tile runs across chunk boundaries with compact exact inverses', () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 30, y: 4, index: 2 }, { x: 33, y: 4, index: 2 }]);
    const inverse = writePixelRuns(cel, [{ x: 30, y: 4, length: 8, index: 7 }]);
    expect(Array.from({ length: 8 }, (_, offset) => readPixel(cel, 30 + offset, 4))).toEqual(new Array(8).fill(7));
    expect(inverse.length).toBeLessThan(8);
    writePixelRuns(cel, inverse);
    expect(Array.from({ length: 8 }, (_, offset) => readPixel(cel, 30 + offset, 4))).toEqual([2, 0, 0, 2, 0, 0, 0, 0]);

    const chunks: Record<string, TilemapChunk> = {};
    const tileInverse = writeTileRuns(chunks, [{ x: 31, y: -2, length: 4, gid: 0xe000_0003 }]);
    expect([31, 32, 33, 34].map((x) => readTile(chunks[`${Math.floor(x / 32)},-1`], x, -2))).toEqual(new Array(4).fill(0xe000_0003));
    writeTileRuns(chunks, tileInverse);
    expect(chunks).toEqual({});
  });

  it('undoes repeated writes to the same cell in reverse write order', () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    const inverse = writePixels(cel, [{ x: 1, y: 1, index: 3 }, { x: 1, y: 1, index: 8 }]);
    expect(readPixel(cel, 1, 1)).toBe(8);
    writePixels(cel, inverse);
    expect(readPixel(cel, 1, 1)).toBe(0);
    expect(cel.chunks).toEqual({});
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
