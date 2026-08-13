import { describe, expect, it } from 'vitest';
import {
  orthogonalCellRect,
  orthogonalCoordinateDeltaFromScreen,
  orthogonalCoordinateFromScreen,
  orthogonalObjectMatrix,
  orthogonalProjectionExtent,
} from '../../src/common/orthogonal-projection';

describe('orthogonal projection geometry', () => {
  it('preserves authored rectangular-cell extent and exact edge cells', () => {
    expect(orthogonalProjectionExtent(3, 5, 48, 24)).toEqual({ width: 144, height: 120 });
    expect(orthogonalCellRect(0, 0, 48, 24)).toEqual({ x: 0, y: 0, width: 48, height: 24 });
    expect(orthogonalCellRect(2, 4, 48, 24)).toEqual({ x: 96, y: 96, width: 48, height: 24 });
  });

  it('inverts continuous coordinates without a square-cell assumption', () => {
    expect(orthogonalCoordinateFromScreen(108, 45, 48, 24)).toEqual({ x: 2.25, y: 1.875 });
    expect(orthogonalCoordinateDeltaFromScreen(-24, 36, 48, 24)).toEqual({ x: -0.5, y: 1.5 });
  });

  it('maps canonical object pixels into an authored-aspect editor cell', () => {
    expect(orthogonalObjectMatrix(48, 24, 96, 48)).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    expect(orthogonalObjectMatrix(48, 24, 72, 60)).toEqual({ a: 1.5, b: 0, c: 0, d: 2.5, e: 0, f: 0 });
  });

  it('rejects invalid geometry rather than producing drifting coordinates', () => {
    expect(() => orthogonalProjectionExtent(-1, 2, 48, 24)).toThrow('finite nonnegative');
    expect(() => orthogonalCellRect(0, 0, 0, 24)).toThrow('positive finite');
    expect(() => orthogonalCoordinateFromScreen(0, 0, 48, Number.NaN)).toThrow('positive finite');
    expect(() => orthogonalObjectMatrix(48, 0, 96, 48)).toThrow('positive finite');
  });
});
