import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, decodeTiledGid, encodeTiledGid, isImageCollectionTileset, nextTilesetFirstGid, readPixel, resolveTilesetForGid, resizePixelSpriteCanvas, tiledTileTransformMatrix, tilesetLocalIdSpan, tilesetTileSourceAssetId, writePixelRuns, writePixels, writeTileRuns, writeTiles, readTile, type TilemapChunk } from '@aidraw/core';

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

  it('resolves only exact sparse image-collection IDs without rebasing gaps', () => {
    const document = createPixelDocument('project', 'Sparse collection'); document.assetIds = []; document.pixelAssets = {};
    const zero = createPixelSprite('Tile zero', 2, 2); const three = createPixelSprite('Tile three', 1, 2);
    const tileset = createPixelTileset('Collection', zero.id, 2, 2, 1, 1); delete tileset.spriteAssetId; tileset.columns = 2; tileset.rows = 0; tileset.firstGid = 17;
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: zero.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: three.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    const atlas = createPixelTileset('Following atlas', zero.id, 2, 2, 1, 1); atlas.firstGid = nextTilesetFirstGid([tileset]);
    const map = createPixelTilemap('Map'); map.tilesetIds = [tileset.id, atlas.id];
    document.pixelAssets = { [zero.id]: zero, [three.id]: three, [tileset.id]: tileset, [atlas.id]: atlas, [map.id]: map }; document.assetIds = [zero.id, three.id, tileset.id, atlas.id, map.id]; document.activeAssetId = map.id;
    expect(isImageCollectionTileset(tileset)).toBe(true); expect(tilesetLocalIdSpan(tileset)).toBe(4);
    expect(tileset.columns).toBe(2); expect(atlas.firstGid).toBe(21);
    expect(resolveTilesetForGid(document, map, 17)).toMatchObject({ tileset, localId: 0 });
    expect(resolveTilesetForGid(document, map, 20)).toMatchObject({ tileset, localId: 3 });
    expect(resolveTilesetForGid(document, map, 18)).toBeUndefined();
    expect(resolveTilesetForGid(document, map, 21)).toMatchObject({ tileset: atlas, localId: 0 });
    expect(tilesetTileSourceAssetId(tileset, 3)).toBe(three.id);
  });

  it('maps all eight Tiled tile transforms in diagonal-first order', () => {
    const cases = [
      [{}, ['A', 'B', 'C', 'D']],
      [{ hFlip: true }, ['B', 'A', 'D', 'C']],
      [{ vFlip: true }, ['C', 'D', 'A', 'B']],
      [{ hFlip: true, vFlip: true }, ['D', 'C', 'B', 'A']],
      [{ diagonal: true }, ['D', 'B', 'C', 'A']],
      [{ diagonal: true, hFlip: true }, ['B', 'D', 'A', 'C']],
      [{ diagonal: true, vFlip: true }, ['C', 'A', 'D', 'B']],
      [{ diagonal: true, hFlip: true, vFlip: true }, ['A', 'C', 'B', 'D']],
    ] as const;
    const sourceCorners = [
      ['A', -2, -2], ['B', 2, -2], ['C', -2, 2], ['D', 2, 2],
    ] as const;
    const destinationOrder = ['LT', 'RT', 'LB', 'RB'];

    for (const [transforms, expected] of cases) {
      const matrix = tiledTileTransformMatrix(transforms);
      const destinations = new Map<string, string>();
      for (const [label, x, y] of sourceCorners) {
        const transformedX = matrix.a * x + matrix.c * y;
        const transformedY = matrix.b * x + matrix.d * y;
        expect(Math.abs(transformedX)).toBeCloseTo(2);
        expect(Math.abs(transformedY)).toBeCloseTo(2);
        destinations.set(`${transformedX < 0 ? 'L' : 'R'}${transformedY < 0 ? 'T' : 'B'}`, label);
      }
      expect(destinationOrder.map((position) => destinations.get(position))).toEqual(expected);
    }
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
