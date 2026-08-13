import type { Transform } from '@aidraw/core';
import { AIDRAW_PSD_EDITABLE_TEXT_SUFFIX, aidrawPsdLockFields, aidrawPsdTextGeometry, aidrawPsdTextMatrix, aidrawPsdTextObjectName, illustrationTransformMatrix, psdLayerHasPartialLock, psdLayerIsLockedAll } from '@common/psd-text';
import { describe, expect, it } from 'vitest';

function expectMatrixClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(6);
  for (let index = 0; index < 6; index += 1) expect(actual[index]).toBeCloseTo(expected[index], 10);
}

describe('AIDraw PSD editable-text companion geometry', () => {
  it('round-trips the complete visual affine matrix and text box', () => {
    const source: Transform = { x: 12.25, y: -8.5, scaleX: 1.3, scaleY: 0.75, rotation: 17, skewX: 8, skewY: -3 };
    const matrix = aidrawPsdTextMatrix(source, 22);
    const geometry = aidrawPsdTextGeometry(`Title${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, matrix, [0, 0, 140, 32], 22);

    expect(geometry).toMatchObject({ width: 140, height: 32 });
    expectMatrixClose(illustrationTransformMatrix(geometry!.transform), illustrationTransformMatrix(source));
  });

  it('keeps older translation-only AIDraw companions readable', () => {
    const geometry = aidrawPsdTextGeometry(`Legacy${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, [1, 0, 0, 1, 7, 31], [0, 0, 80, 20], 14);
    expect(geometry).toEqual({ width: 80, height: 20, transform: { x: 7, y: 17, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 } });
  });

  it('does not reinterpret unmarked, malformed, or out-of-contract PSD text', () => {
    expect(aidrawPsdTextGeometry('External text', [1, 0, 0, 1, 0, 12], [0, 0, 40, 20], 12)).toBeUndefined();
    expect(aidrawPsdTextGeometry(`String${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, ['1', 0, 0, 1, 0, 12], [0, 0, 40, 20], 12)).toBeUndefined();
    expect(aidrawPsdTextGeometry(`Bad${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, [1, 0, 0, 1, 0, 12], [1, 0, 40, 20], 12)).toBeUndefined();
    expect(aidrawPsdTextGeometry(`Huge${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, [1, 0, 0, 1, 0, 12], [0, 0, 1_000_001, 20], 12)).toBeUndefined();
    expect(aidrawPsdTextGeometry(AIDRAW_PSD_EDITABLE_TEXT_SUFFIX, [1, 0, 0, 1, 0, 12], [0, 0, 40, 20], 12)).toBeUndefined();
    expect(aidrawPsdTextGeometry(`${'x'.repeat(201)}${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, [1, 0, 0, 1, 0, 12], [0, 0, 40, 20], 12)).toBeUndefined();
  });

  it('recovers only a canonical object name from the private suffix', () => {
    expect(aidrawPsdTextObjectName(`Golden title${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`)).toBe('Golden title');
    expect(aidrawPsdTextObjectName('Golden title')).toBeUndefined();
    expect(aidrawPsdTextObjectName(AIDRAW_PSD_EDITABLE_TEXT_SUFFIX)).toBeUndefined();
  });
});

describe('PSD full-lock mapping', () => {
  it('writes and recognizes the pinned lock-all representation', () => {
    expect(aidrawPsdLockFields(false)).toEqual({});
    expect(aidrawPsdLockFields(true)).toEqual({ transparencyProtected: true, protected: { transparency: false } });
    expect(psdLayerIsLockedAll(aidrawPsdLockFields(true))).toBe(true);
  });

  it('does not widen individual Photoshop locks into AIDraw lock-all', () => {
    expect(psdLayerIsLockedAll({ transparencyProtected: true, protected: { transparency: true } })).toBe(false);
    expect(psdLayerIsLockedAll({ protected: { composite: true, position: true } })).toBe(false);
    expect(psdLayerIsLockedAll({})).toBe(false);
    expect(psdLayerHasPartialLock({ transparencyProtected: true, protected: { transparency: true } })).toBe(true);
    expect(psdLayerHasPartialLock({ protected: { composite: true, position: true } })).toBe(true);
    expect(psdLayerHasPartialLock(aidrawPsdLockFields(true))).toBe(false);
    expect(psdLayerHasPartialLock({})).toBe(false);
  });
});
