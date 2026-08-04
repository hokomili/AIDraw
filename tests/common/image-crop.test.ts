import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type ImageObject } from '@aidraw/core';
import { cropImageObject, cropImageToAspect, normalizedDisplayCrop, resetImageCrop } from '../../src/common/image-crop';

function image(rotation = 0): ImageObject { const timestamp = nowIso(); return { id: 'image', revision: 0, name: 'Image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: 'layer', visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20, rotation }, type: 'image', assetId: 'asset', width: 400, height: 200, sourceWidth: 400, sourceHeight: 200, filters: [] }; }

describe('non-destructive image crops', () => {
  it('constrains a display crop to an aspect ratio', () => { expect(normalizedDisplayCrop(image(), { x: 10, y: 10 }, { x: 210, y: 160 }, 1)).toEqual({ x: 10, y: 10, width: 150, height: 150 }); });
  it('preserves displayed pixel scale and shifts a rotated local origin', () => { const cropped = cropImageObject(image(90), { x: 100, y: 50, width: 200, height: 100 }); expect(cropped).toMatchObject({ width: 200, height: 100, crop: { x: 100, y: 50, width: 200, height: 100 } }); expect(cropped.transform.x).toBeCloseTo(-40); expect(cropped.transform.y).toBeCloseTo(120); });
  it('centers aspect presets and resets to the original source frame', () => { const cropped = cropImageToAspect(image(), 1); expect(cropped).toMatchObject({ width: 200, height: 200, crop: { x: 100, y: 0, width: 200, height: 200 } }); const reset = resetImageCrop(cropped); expect(reset.width).toBeCloseTo(400); expect(reset.height).toBeCloseTo(200); expect(reset.transform.x).toBeCloseTo(10); expect(reset.transform.y).toBeCloseTo(20); expect(reset.crop).toBeUndefined(); });
});
