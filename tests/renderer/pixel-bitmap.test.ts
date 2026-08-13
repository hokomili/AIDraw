import { createCanvas } from '@napi-rs/canvas';
import { createPixelDocument, createPixelSprite, createPixelTileset, writePixels } from '@aidraw/core';
import { describe, expect, it } from 'vitest';

import { tilesetTileSourceRect } from '../../src/common/tile-animation';
import { drawSpriteRegion, drawSpriteThumbnail } from '../../src/renderer/canvas/pixel-bitmap';

describe('renderer pixel bitmap regions', () => {
  it('draws only the requested tileset frame through the shared layered sprite compositor', () => {
    const document = createPixelDocument('project', 'Preview palette');
    document.palette[2].color = '#ff0000ff';
    document.palette[3].color = '#00ff00ff';
    const sprite = createPixelSprite('Two preview tiles', 4, 2);
    const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [
      { x: 0, y: 0, index: 2 }, { x: 1, y: 1, index: 2 },
      { x: 2, y: 0, index: 3 }, { x: 3, y: 1, index: 3 },
    ]);
    const tileset = createPixelTileset('Preview tiles', sprite.id, 2, 2, 2, 1);
    const canvas = createCanvas(2, 2);
    const context = canvas.getContext('2d');
    drawSpriteRegion(context as unknown as CanvasRenderingContext2D, sprite, sprite.frameIds[0], document.palette, tilesetTileSourceRect(tileset, 1));
    expect(Array.from(context.getImageData(0, 0, 2, 2).data)).toEqual([
      0, 255, 0, 255, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 255, 0, 255,
    ]);
  });

  it('samples a bounded whole-sheet thumbnail without allocating the source-sized bitmap', () => {
    const document = createPixelDocument('project', 'Thumbnail palette');
    document.palette[2].color = '#ff0000ff';
    document.palette[3].color = '#00ff00ff';
    const sprite = createPixelSprite('Wide source', 4, 2);
    const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 0, y: 0, index: 2 }, { x: 2, y: 0, index: 3 }]);
    const canvas = createCanvas(2, 1);
    const context = canvas.getContext('2d');

    drawSpriteThumbnail(context as unknown as CanvasRenderingContext2D, sprite, sprite.frameIds[0], document.palette, 2, 1);

    expect(Array.from(context.getImageData(0, 0, 2, 1).data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });
});
