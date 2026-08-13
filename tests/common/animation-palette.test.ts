import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, createPixelDocument, writePixels } from '@aidraw/core';
import { createExactAnimationPalettePlanner, exactAnimationFrameChanges, exactNormalCompositeAnimationFrame, exactNormalCompositeGifFrame, exactSharedIndexedPaletteChanges, exactSingleLayerGifFrame, planExactSharedIndexedPalette } from '../../src/common/animation-palette';

describe('exact animation frame palettes', () => {
  it('keeps reference indexes and assigns frame-local RGBA colors deterministically', () => {
    const first = Uint8ClampedArray.from([
      255, 107, 122, 255,
      64, 128, 192, 128,
      0, 0, 0, 0,
    ]);
    const second = Uint8ClampedArray.from([
      7, 8, 9, 255,
      10, 11, 12, 192,
      0, 0, 0, 0,
    ]);
    const planner = createExactAnimationPalettePlanner(DEFAULT_PALETTE, 0.5);
    expect(planner.addFrame(first)).toBe(true);
    expect(planner.addFrame(second)).toBe(true);
    const plan = planner.finish()!;
    expect(plan.palette[4].color).toBe('#ff6b7a');
    expect(plan.palette[1].color).toBe('#4080c080');
    expect(plan.frames[1].paletteOverride?.[1].color).toBe('#070809');
    expect(plan.frames[1].paletteOverride?.[2].color).toBe('#0a0b0cc0');
    expect(exactAnimationFrameChanges(first, 3, 1, plan.frames[0], plan.alphaThreshold)).toEqual([
      { x: 0, y: 0, index: 4 },
      { x: 1, y: 0, index: 1 },
    ]);
    expect(exactAnimationFrameChanges(second, 3, 1, plan.frames[1], plan.alphaThreshold)).toEqual([
      { x: 0, y: 0, index: 1 },
      { x: 1, y: 0, index: 2 },
    ]);
  });

  it('declines a frame with more than 255 visible colors without returning a partial plan', () => {
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let index = 0; index < 256; index += 1) rgba.set([index, index ^ 0x55, index ^ 0xaa, 255], index * 4);
    const planner = createExactAnimationPalettePlanner(DEFAULT_PALETTE, 0.5);
    expect(planner.addFrame(rgba)).toBe(false);
    expect(planner.finish()).toBeUndefined();
  });

  it('plans one deterministic exact palette across several structural RGBA sources', () => {
    const first = Uint8ClampedArray.from([255, 107, 122, 255, 18, 52, 86, 128]);
    const second = Uint8ClampedArray.from([171, 205, 239, 255, 18, 52, 86, 128]);
    const plan = planExactSharedIndexedPalette([first, second], DEFAULT_PALETTE, 0.5)!;
    expect(plan.palette[4].color).toBe('#ff6b7a'); expect(plan.palette[1].color).toBe('#12345680'); expect(plan.palette[2].color).toBe('#abcdef');
    expect(exactSharedIndexedPaletteChanges(first, 2, 1, plan)).toEqual([{ x: 0, y: 0, index: 4 }, { x: 1, y: 0, index: 1 }]);
    expect(exactSharedIndexedPaletteChanges(second, 2, 1, plan)).toEqual([{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 1 }]);
  });

  it('declines a shared union above 255 visible colors without returning a partial plan', () => {
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let index = 0; index < 256; index += 1) rgba.set([index, index ^ 0x55, index ^ 0xaa, 255], index * 4);
    expect(planExactSharedIndexedPalette([rgba.subarray(0, 128 * 4), rgba.subarray(128 * 4)], DEFAULT_PALETTE, 0.5)).toBeUndefined();
    const exact = planExactSharedIndexedPalette([rgba.subarray(0, 127 * 4), rgba.subarray(128 * 4)], DEFAULT_PALETTE, 0.5);
    expect(exact).toBeDefined(); expect(exact?.assignments).toHaveLength(255);
  });

  it('offers exact GIF indexes only for opaque ordinary single-layer frames', () => {
    const document = createPixelDocument('sprite', 'Exact GIF guard'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.width = 2; sprite.height = 1; const cel = Object.values(sprite.cels)[0]; writePixels(cel, [{ x: 0, y: 0, index: 1 }, { x: 1, y: 0, index: 2 }]);
    document.palette[1].color = '#010203'; document.palette[2].color = '#040506'; const exact = exactSingleLayerGifFrame(document.palette, sprite, sprite.frameIds[0]); expect(Array.from(exact!.indexes)).toEqual([1, 2]); expect(exact!.palette.slice(1, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(exactNormalCompositeGifFrame(document.palette, sprite, sprite.frameIds[0])).toEqual(exact);
    document.palette[1].color = '#01020380'; expect(exactSingleLayerGifFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined(); document.palette[1].color = '#010203'; sprite.layers[sprite.layerIds[0]].opacity = 0.5; expect(exactSingleLayerGifFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
  });

  it('composites nested full-opacity normal pixel layers into exact unpremultiplied RGBA', () => {
    const document = createPixelDocument('sprite', 'Exact normal composite'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 2; sprite.height = 1; document.palette[1].color = '#ff000080'; document.palette[2].color = '#0000ff80';
    const bottomId = sprite.layerIds[0]; const bottom = sprite.layers[bottomId]; const bottomCel = Object.values(sprite.cels)[0];
    const topId = 'exact-top-layer'; const topCelId = 'exact-top-cel'; const groupId = 'exact-normal-group';
    sprite.layers[topId] = { ...structuredClone(bottom), id: topId, name: 'Top', parentId: groupId };
    sprite.layers[bottomId] = { ...bottom, parentId: groupId };
    sprite.layers[groupId] = { ...structuredClone(bottom), id: groupId, name: 'Group', type: 'group', childIds: [bottomId, topId] };
    sprite.layerIds = [groupId];
    sprite.cels[topCelId] = { ...structuredClone(bottomCel), id: topCelId, name: 'Top cel', layerId: topId, chunks: {} };
    writePixels(bottomCel, [{ x: 0, y: 0, index: 1 }, { x: 1, y: 0, index: 1 }]);
    writePixels(sprite.cels[topCelId], [{ x: 0, y: 0, index: 2 }]);

    expect(Array.from(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])!)).toEqual([
      85, 0, 170, 192,
      255, 0, 0, 128,
    ]);
    sprite.layers[topId].opacity = 0.5;
    expect(Array.from(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])!)).toEqual([
      153, 0, 102, 160,
      255, 0, 0, 128,
    ]);
    sprite.layers[topId].opacity = 1; sprite.layers[topId].blendMode = 'multiply';
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
    sprite.layers[topId].blendMode = 'normal'; sprite.layers[groupId].blendMode = 'multiply';
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
    sprite.layers[groupId].blendMode = 'normal'; sprite.layers[groupId].opacity = 0.5;
    expect(Array.from(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])!)).toEqual([
      109, 0, 146, 112,
      255, 0, 0, 64,
    ]);
    sprite.layers[groupId].opacity = 1; document.palette[2].color = '#0000ff00';
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
  });

  it('retains exact source RGB while applying the renderer opacity byte contract', () => {
    const document = createPixelDocument('sprite', 'Fractional normal opacity'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 1; sprite.height = 1; document.palette[1].color = '#4080c080'; sprite.layers[sprite.layerIds[0]].opacity = 0.5;
    writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 1 }]);
    expect(Array.from(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])!)).toEqual([64, 128, 192, 64]);
    expect(exactNormalCompositeGifFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
  });

  it('retains the established stored transparent RGB for an ordinary single layer', () => {
    const document = createPixelDocument('sprite', 'Transparent RGB'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 1; sprite.height = 1; document.palette[1].color = '#12345600'; writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 1 }]);
    expect(Array.from(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])!)).toEqual([18, 52, 86, 0]);
  });

  it('assigns exact first-use GIF slots to a binary-alpha normal composite', () => {
    const document = createPixelDocument('sprite', 'Exact composite GIF'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 3; sprite.height = 1; document.palette[1].color = '#ff0000'; document.palette[2].color = '#0000ff80';
    const bottomId = sprite.layerIds[0]; const bottom = sprite.layers[bottomId]; const bottomCel = Object.values(sprite.cels)[0]; const topId = 'gif-top-layer'; const topCelId = 'gif-top-cel';
    sprite.layers[topId] = { ...structuredClone(bottom), id: topId, name: 'Top' }; sprite.layerIds.push(topId);
    sprite.cels[topCelId] = { ...structuredClone(bottomCel), id: topCelId, name: 'Top cel', layerId: topId, chunks: {} };
    writePixels(bottomCel, [{ x: 0, y: 0, index: 1 }, { x: 1, y: 0, index: 1 }]); writePixels(sprite.cels[topCelId], [{ x: 0, y: 0, index: 2 }]);

    const exact = exactNormalCompositeGifFrame(document.palette, sprite, sprite.frameIds[0])!;
    expect(Array.from(exact.indexes)).toEqual([1, 2, 0]);
    expect(exact.palette).toEqual([[0, 0, 0], [127, 0, 128], [255, 0, 0]]);
    sprite.layers[topId].opacity = 0.5; expect(exactNormalCompositeGifFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined(); sprite.layers[topId].opacity = 1;
    writePixels(sprite.cels[topCelId], [{ x: 2, y: 0, index: 2 }]);
    expect(exactNormalCompositeGifFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
  });

  it('declines a normal composite that needs 256 visible GIF colors', () => {
    const document = createPixelDocument('sprite', 'GIF color overflow'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 256; sprite.height = 1;
    while (document.palette.length < 256) document.palette.push({ id: `gif-overflow-${document.palette.length}`, name: `Overflow ${document.palette.length}`, color: '#000000' });
    document.palette[1].color = '#000000'; document.palette[2].color = '#ffffff';
    for (let index = 3; index < 256; index += 1) {
      const color = index - 2; const red = color % 16 * 16; const green = Math.floor(color / 16) * 16;
      document.palette[index].color = `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}0080`;
    }
    const bottomId = sprite.layerIds[0]; const bottom = sprite.layers[bottomId]; const bottomCel = Object.values(sprite.cels)[0]; const topId = 'gif-overflow-top'; const topCelId = 'gif-overflow-top-cel';
    sprite.layers[topId] = { ...structuredClone(bottom), id: topId, name: 'Top' }; sprite.layerIds.push(topId);
    sprite.cels[topCelId] = { ...structuredClone(bottomCel), id: topCelId, name: 'Top cel', layerId: topId, chunks: {} };
    writePixels(bottomCel, Array.from({ length: 256 }, (_, x) => ({ x, y: 0, index: x < 254 ? 1 : 2 })));
    writePixels(sprite.cels[topCelId], [...Array.from({ length: 253 }, (_, x) => ({ x, y: 0, index: x + 3 })), { x: 255, y: 0, index: 3 }]);

    expect(exactNormalCompositeGifFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
  });
});
