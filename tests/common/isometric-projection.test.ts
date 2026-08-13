import { describe, expect, it } from 'vitest';
import {
  isometricCellRect,
  isometricCoordinateDeltaFromScreen,
  isometricCoordinateFromScreen,
  isometricObjectMatrix,
  isometricProjectionExtent,
} from '../../src/common/isometric-projection';

describe('isometric projection geometry', () => {
  it('bounds every edge cell of an asymmetric non-square grid without a half-cell offset', () => {
    expect(isometricProjectionExtent(3, 5, 48, 24)).toEqual({ width: 192, height: 96 });
    expect(isometricCellRect(0, 0, 5, 48, 24)).toEqual({ x: 96, y: 0, width: 48, height: 24 });
    expect(isometricCellRect(0, 4, 5, 48, 24)).toEqual({ x: 0, y: 48, width: 48, height: 24 });
    expect(isometricCellRect(2, 0, 5, 48, 24)).toEqual({ x: 144, y: 24, width: 48, height: 24 });
    expect(isometricCellRect(2, 4, 5, 48, 24)).toEqual({ x: 48, y: 72, width: 48, height: 24 });
  });

  it('inverts both a cell top vertex and its interior center', () => {
    const rect = isometricCellRect(2, 4, 5, 48, 24);
    expect(isometricCoordinateFromScreen(rect.x + rect.width / 2, rect.y, 5, 48, 24)).toEqual({ x: 2, y: 4 });
    expect(isometricCoordinateFromScreen(rect.x + rect.width / 2, rect.y + rect.height / 2, 5, 48, 24)).toEqual({ x: 2.5, y: 4.5 });
  });

  it('uses the same inverse for parallax screen deltas', () => {
    expect(isometricCoordinateDeltaFromScreen(24, 12, 48, 24)).toEqual({ x: 1, y: 0 });
    expect(isometricCoordinateDeltaFromScreen(-24, 12, 48, 24)).toEqual({ x: 0, y: 1 });
  });

  it('projects map-object pixel coordinates to the same cell vertices', () => {
    const matrix = isometricObjectMatrix(5, 48, 24, 48, 24);
    const objectPoint = { x: 2 * 48, y: 4 * 24 };
    expect({
      x: matrix.a * objectPoint.x + matrix.c * objectPoint.y + matrix.e,
      y: matrix.b * objectPoint.x + matrix.d * objectPoint.y + matrix.f,
    }).toEqual({ x: 72, y: 72 });
  });

  it('rejects unusable projection geometry', () => {
    expect(() => isometricProjectionExtent(1, 1, 0, 16)).toThrow(/cell width/);
    expect(() => isometricProjectionExtent(-1, 1, 16, 8)).toThrow(/dimensions/);
  });
});
