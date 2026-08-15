import { describe, expect, it } from 'vitest';
import type { CollisionShape } from '@aidraw/core';
import { deleteMapObjectPoint, insertMapObjectPoint, mapObjectAtPoint, mapObjectBounds, moveMapObjectPoint, moveMapObjectSelection, nearestMapObjectSegment, transformMapObject } from '../../src/common/map-objects';

describe('tilemap object geometry', () => {
  it('computes polygon bounds in map-pixel coordinates', () => { expect(mapObjectBounds({ id: 'p', type: 'polygon', x: 10, y: 20, points: [{ x: -2, y: 4 }, { x: 8, y: 1 }, { x: 3, y: 12 }], properties: {} })).toEqual({ x: 8, y: 21, width: 10, height: 11 }); });
  it('uses ellipse geometry rather than only its box for hits', () => { const ellipse = { id: 'e', type: 'ellipse' as const, x: 0, y: 0, width: 20, height: 10, properties: {} }; expect(mapObjectAtPoint(ellipse, { x: 10, y: 5 })).toBe(true); expect(mapObjectAtPoint(ellipse, { x: 1, y: 1 })).toBe(false); });
  it('uses polygon edges and interiors instead of accepting the entire bounding box', () => { const polygon = { id: 'p', type: 'polygon' as const, x: 0, y: 0, points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 0, y: 12 }], properties: {} }; expect(mapObjectAtPoint(polygon, { x: 2, y: 2 })).toBe(true); expect(mapObjectAtPoint(polygon, { x: 11, y: 11 }, 0)).toBe(false); });
  it('hit-tests polylines by segment tolerance', () => { const polyline = { id: 'l', type: 'polyline' as const, x: 4, y: 5, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], properties: {} }; expect(mapObjectAtPoint(polyline, { x: 9, y: 6 }, 2)).toBe(true); expect(mapObjectAtPoint(polyline, { x: 9, y: 10 }, 2)).toBe(false); });
  it('moves all shapes and integer-resizes bounded shapes', () => { const rectangle = { id: 'r', type: 'rectangle' as const, x: 4, y: 5, width: 8, height: 9, properties: {} }; expect(transformMapObject(rectangle, 'move', { x: 2.4, y: -3.6 })).toMatchObject({ x: 6, y: 1 }); expect(transformMapObject(rectangle, 'resize', { x: -20, y: 2 })).toMatchObject({ width: 1, height: 11 }); });
  it('moves and compatibly resizes tile objects without changing raw GID identity or rotation', () => {
    const tile = { id: 'tile', type: 'tile' as const, gid: 0xe000_0011, x: 12, y: 18, width: 16, height: 24, rotation: 30, name: 'Chest', className: 'loot', properties: { locked: true } };
    expect(transformMapObject(tile, 'move', { x: 2.4, y: -3.6 })).toEqual({ ...tile, x: 14, y: 14 });
    expect(transformMapObject(tile, 'resize', { x: 5.6, y: -40 })).toEqual({ ...tile, width: 22, height: 1 });
  });
  it('moves an exact multi-selection together without changing order, local points, or unselected shapes', () => {
    const source: CollisionShape[] = [
      { id: 'rectangle', type: 'rectangle' as const, x: 4, y: 5, width: 8, height: 9, properties: { solid: true } },
      { id: 'ellipse', type: 'ellipse' as const, x: 30, y: 40, width: 5, height: 6, properties: {} },
      { id: 'polygon', type: 'polygon' as const, x: -2, y: 3, points: [{ x: 0, y: 0 }, { x: 7, y: 1 }, { x: 2, y: 8 }], properties: { slope: 'left' } },
    ];
    const moved = moveMapObjectSelection(source, ['polygon', 'rectangle'], { x: 2.4, y: -3.6 });
    expect(moved).toEqual([
      { ...source[0], x: 6, y: 1 },
      source[1],
      { ...source[2], x: 0, y: -1 },
    ]);
    expect(moved[1]).toBe(source[1]);
    expect(source.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 4, y: 5 }, { x: 30, y: 40 }, { x: -2, y: 3 }]);
    expect(() => moveMapObjectSelection(source, ['rectangle', 'rectangle'], { x: 1, y: 1 })).toThrow(/unique/);
    expect(() => moveMapObjectSelection(source, ['missing'], { x: 1, y: 1 })).toThrow(/must exist/);
  });
  it('moves a polygon point without shifting its local origin', () => { const polygon = { id: 'p', type: 'polygon' as const, x: 10, y: 20, points: [{ x: 0, y: 0 }, { x: 8, y: 2 }], properties: {} }; expect(moveMapObjectPoint(polygon, 1, { x: 2.4, y: -1.6 })).toMatchObject({ x: 10, y: 20, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }); });
  it('inserts a projected integer point on the nearest segment and enforces topology minimums', () => { const polygon = { id: 'p', type: 'polygon' as const, x: 10, y: 20, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], properties: {} }; const nearest = nearestMapObjectSegment(polygon, { x: 15, y: 21 })!; expect(nearest).toMatchObject({ segmentIndex: 0, point: { x: 15, y: 20 }, distance: 1 }); const inserted = insertMapObjectPoint(polygon, nearest.segmentIndex, nearest.point); expect(inserted.points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]); expect(deleteMapObjectPoint(inserted, 1).points).toEqual(polygon.points); expect(() => deleteMapObjectPoint(polygon, 0)).toThrow(/at least 3/); });
});
