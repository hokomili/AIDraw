import paper from 'paper';
import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  type PathObject,
  type ShapeObject,
} from '@aidraw/core';
import { createBooleanPath, createEditableBooleanPath, UnsupportedBooleanResultError, type BooleanMode } from '../../src/common/path-boolean';

const timestamp = '2026-08-12T00:00:00.000Z';

function base(id: string) {
  return {
    id,
    revision: 0,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    layerId: 'vector-layer',
    visible: true,
    locked: false,
    opacity: 0.75,
    blendMode: 'multiply' as const,
    transform: structuredClone(IDENTITY_TRANSFORM),
  };
}

function rectangle(id: string, x: number, y: number, width = 40, height = 40): ShapeObject {
  return {
    ...base(id),
    transform: { ...IDENTITY_TRANSFORM, x, y },
    type: 'shape',
    shape: 'rectangle',
    width,
    height,
    fill: { kind: 'solid', color: '#8268dd' },
    stroke: { paint: { kind: 'solid', color: '#111111' }, width: 3, opacity: 0.5, lineCap: 'square', lineJoin: 'bevel', dash: [4, 2] },
  };
}

function measurePath(object: PathObject, points: Array<[number, number]> = []) {
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(1, 1));
  try {
    const item = scope.PathItem.create(object.pathData);
    item.fillRule = object.fillRule;
    return {
      area: Math.abs(item.area),
      bounds: { x: item.bounds.x, y: item.bounds.y, width: item.bounds.width, height: item.bounds.height },
      contains: points.map(([x, y]) => item.contains(new scope.Point(x, y))),
    };
  } finally {
    scope.project.remove();
  }
}

describe('canonical illustration path booleans', () => {
  it('distinguishes editable boolean admission from a compound kernel result', () => {
    const a = rectangle('a', 10, 10); const b = rectangle('b', 30, 10);
    const before = structuredClone([a, b]);
    expect(createEditableBooleanPath(a, b, 'union').type).toBe('path');
    expect(() => createEditableBooleanPath(a, b, 'exclude')).toThrow(UnsupportedBooleanResultError);
    expect(() => createEditableBooleanPath(a, b, 'exclude')).toThrow(/Both operands are unchanged/);
    expect([a, b]).toEqual(before);
  });

  it('keeps all four transformed rectangle modes geometrically exact and inputs immutable', () => {
    const first = rectangle('first', 10, 10);
    const second = rectangle('second', 30, 10);
    const before = structuredClone([first, second]);
    const expected: Record<BooleanMode, { area?: number; bounds: { x: number; y: number; width: number; height: number }; contains: boolean[] }> = {
      union: { area: 2_400, bounds: { x: 10, y: 10, width: 60, height: 40 }, contains: [true, true, true] },
      subtract: { area: 800, bounds: { x: 10, y: 10, width: 20, height: 40 }, contains: [true, false, false] },
      intersect: { area: 800, bounds: { x: 30, y: 10, width: 20, height: 40 }, contains: [false, true, false] },
      exclude: { bounds: { x: 10, y: 10, width: 60, height: 40 }, contains: [true, false, true] },
    };

    for (const mode of Object.keys(expected) as BooleanMode[]) {
      const result = createBooleanPath(first, second, mode);
      const measured = measurePath(result, [[20, 20], [40, 20], [60, 20]]);
      if (expected[mode].area !== undefined) expect(measured.area).toBeCloseTo(expected[mode].area, 8);
      expect(measured.bounds).toEqual(expected[mode].bounds);
      expect(measured.contains).toEqual(expected[mode].contains);
      expect(result).toMatchObject({ layerId: first.layerId, opacity: first.opacity, blendMode: first.blendMode, transform: IDENTITY_TRANSFORM, closed: true });
      expect(result.fill).toEqual(first.fill);
      expect(result.fill).not.toBe(first.fill);
      expect(result.stroke).toEqual(first.stroke);
      expect(result.stroke).not.toBe(first.stroke);
      expect(result.stroke.dash).not.toBe(first.stroke.dash);
    }
    expect([first, second]).toEqual(before);
  });

  it('honors an even-odd compound hole and retains the result rule', () => {
    const donut: PathObject = {
      ...base('donut'),
      type: 'path',
      pathData: 'M0 0H100V100H0Z M25 25H75V75H25Z',
      closed: true,
      fillRule: 'evenodd',
      fill: { kind: 'solid', color: '#ff6b7a' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    const island = rectangle('island', 40, 40, 20, 20);
    const before = structuredClone([donut, island]);

    const result = createBooleanPath(donut, island, 'union');

    expect(result.fillRule).toBe('evenodd');
    expect(measurePath(result, [[10, 10], [30, 50], [50, 50]])).toEqual({
      area: 7_900,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      contains: [true, false, true],
    });
    expect([donut, island]).toEqual(before);
  });

  it('rejects an empty result before callers can submit destructive operations', () => {
    const first = rectangle('first', 0, 0, 10, 10);
    const second = rectangle('second', 20, 20, 10, 10);
    const before = structuredClone([first, second]);

    expect(() => createBooleanPath(first, second, 'intersect')).toThrow('Boolean operation produced no filled geometry.');
    expect([first, second]).toEqual(before);
  });
});
