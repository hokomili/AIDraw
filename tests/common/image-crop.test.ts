import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type ImageObject } from '@aidraw/core';
import { cropImageObject, cropImageToAspect, normalizedDisplayCrop, resetImageCrop, setImageSourceCrop } from '../../src/common/image-crop';

function image(rotation = 0): ImageObject { const timestamp = nowIso(); return { id: 'image', revision: 0, name: 'Image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: 'layer', visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20, rotation }, type: 'image', assetId: 'asset', width: 400, height: 200, sourceWidth: 400, sourceHeight: 200, filters: [] }; }

describe('non-destructive image crops', () => {
  it('constrains a display crop to an aspect ratio', () => { expect(normalizedDisplayCrop(image(), { x: 10, y: 10 }, { x: 210, y: 160 }, 1)).toEqual({ x: 10, y: 10, width: 150, height: 150 }); });
  it('preserves displayed pixel scale and shifts a rotated local origin', () => { const cropped = cropImageObject(image(90), { x: 100, y: 50, width: 200, height: 100 }); expect(cropped).toMatchObject({ width: 200, height: 100, crop: { x: 100, y: 50, width: 200, height: 100 } }); expect(cropped.transform.x).toBeCloseTo(-40); expect(cropped.transform.y).toBeCloseTo(120); });
  it('centers aspect presets and resets to the original source frame', () => { const cropped = cropImageToAspect(image(), 1); expect(cropped).toMatchObject({ width: 200, height: 200, crop: { x: 100, y: 0, width: 200, height: 200 } }); const reset = resetImageCrop(cropped); expect(reset.width).toBeCloseTo(400); expect(reset.height).toBeCloseTo(200); expect(reset.transform.x).toBeCloseTo(10); expect(reset.transform.y).toBeCloseTo(20); expect(reset.crop).toBeUndefined(); });
  it('sets fractional source coordinates while preserving pixel scale and transformed origin', () => {
    const source = image(90);
    source.width = 300;
    source.height = 50;
    source.crop = { x: 100, y: 50, width: 200, height: 100 };
    source.transform = { ...source.transform, scaleX: 2, scaleY: 3, skewX: 45 };
    const edited = setImageSourceCrop(source, { x: 110.5, y: 70.25, width: 100.25, height: 50.5 });
    expect(edited.crop).toEqual({ x: 110.5, y: 70.25, width: 100.25, height: 50.5 });
    expect(edited.width).toBeCloseTo(150.375);
    expect(edited.height).toBeCloseTo(25.25);
    expect(edited.transform.x).toBeCloseTo(-20.375);
    expect(edited.transform.y).toBeCloseTo(61.625);
  });

  it('clears a full-source numeric crop and rejects invalid rectangles', () => {
    const cropped = cropImageToAspect(image(), 1);
    const reset = setImageSourceCrop(cropped, { x: 0, y: 0, width: 400, height: 200 });
    expect(reset).toMatchObject({ width: 400, height: 200 });
    expect(reset.crop).toBeUndefined();
    expect(() => setImageSourceCrop(image(), { x: 399, y: 0, width: 2, height: 1 })).toThrow(/fit inside 400 × 200/);
    expect(() => setImageSourceCrop(image(), { x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow(/finite, nonnegative/);
  });
});
