import type { Transform } from '@aidraw/core';
import { AIDRAW_PSD_EDITABLE_TEXT_SUFFIX, aidrawPsdTextGeometry, aidrawPsdTextMatrix, illustrationTransformMatrix } from '@common/psd-text';
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
  });
});
