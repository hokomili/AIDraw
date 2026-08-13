import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, createPixelDocument, writePixels } from '@aidraw/core';
import { createExactAnimationPalettePlanner, exactAnimationFrameChanges, exactNormalCompositeAnimationFrame, exactSingleLayerGifFrame } from '../../src/common/animation-palette';

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

  it('offers exact GIF indexes only for opaque ordinary single-layer frames', () => {
    const document = createPixelDocument('sprite', 'Exact GIF guard'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.width = 2; sprite.height = 1; const cel = Object.values(sprite.cels)[0]; writePixels(cel, [{ x: 0, y: 0, index: 1 }, { x: 1, y: 0, index: 2 }]);
    document.palette[1].color = '#010203'; document.palette[2].color = '#040506'; const exact = exactSingleLayerGifFrame(document.palette, sprite, sprite.frameIds[0]); expect(Array.from(exact!.indexes)).toEqual([1, 2]); expect(exact!.palette.slice(1, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
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
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
    sprite.layers[topId].opacity = 1; sprite.layers[topId].blendMode = 'multiply';
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
    sprite.layers[topId].blendMode = 'normal'; sprite.layers[groupId].blendMode = 'multiply';
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
    sprite.layers[groupId].blendMode = 'normal'; sprite.layers[groupId].opacity = 0.5;
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
    sprite.layers[groupId].opacity = 1; document.palette[2].color = '#0000ff00';
    expect(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])).toBeUndefined();
  });

  it('retains the established stored transparent RGB for an ordinary single layer', () => {
    const document = createPixelDocument('sprite', 'Transparent RGB'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = 1; sprite.height = 1; document.palette[1].color = '#12345600'; writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 1 }]);
    expect(Array.from(exactNormalCompositeAnimationFrame(document.palette, sprite, sprite.frameIds[0])!)).toEqual([18, 52, 86, 0]);
  });
});
