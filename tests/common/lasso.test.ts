import { describe, expect, it } from 'vitest';
import { combineSelection, lassoSelectsBounds, pointInPolygon } from '../../src/common/lasso';

const polygon = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 10, y: 10 }, { x: 0, y: 20 }];

describe('freeform lasso selection', () => {
  it('handles concave polygons and boundary-independent point tests', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 10, y: 17 }, polygon)).toBe(false);
  });

  it('supports intersection and complete-containment bounds policies', () => {
    expect(lassoSelectsBounds(polygon, { x: 4, y: 4, width: 4, height: 4 }, false)).toBe(true);
    expect(lassoSelectsBounds(polygon, { x: 18, y: 4, width: 6, height: 6 }, false)).toBe(true);
    expect(lassoSelectsBounds(polygon, { x: 18, y: 4, width: 6, height: 6 }, true)).toBe(false);
  });

  it('combines selections through replace/add/subtract/intersect modes', () => {
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'replace')).toEqual(['b', 'c']);
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c']);
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'subtract')).toEqual(['a']);
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'intersect')).toEqual(['b']);
  });
});
