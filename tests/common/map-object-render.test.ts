import { describe, expect, it } from 'vitest';
import type { CollisionShape } from '@aidraw/core';
import { drawMapObjectOverlay, mapObjectIntersectsRasterRegion, mapObjectProjectedRenderBounds, mapObjectsIntersectingRasterRegion } from '../../src/common/map-object-render';

class RecordingContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth = 0;
  miterLimit = 10;
  readonly calls: Array<[string, ...unknown[]]> = [];
  beginPath() { this.calls.push(['beginPath']); }
  closePath() { this.calls.push(['closePath']); }
  rect(...values: number[]) { this.calls.push(['rect', ...values]); }
  ellipse(...values: number[]) { this.calls.push(['ellipse', ...values]); }
  moveTo(...values: number[]) { this.calls.push(['moveTo', ...values]); }
  lineTo(...values: number[]) { this.calls.push(['lineTo', ...values]); }
  arc(...values: number[]) { this.calls.push(['arc', ...values]); }
  fill() { this.calls.push(['fill']); }
  stroke() { this.calls.push(['stroke']); }
  fillRect(...values: number[]) { this.calls.push(['fillRect', ...values]); }
  strokeRect(...values: number[]) { this.calls.push(['strokeRect', ...values]); }
  setLineDash(values: number[]) { this.calls.push(['setLineDash', ...values]); }
}

function shape(type: CollisionShape['type'], overrides: Partial<CollisionShape> = {}): CollisionShape {
  return { id: `shape-${type}`, type, x: 10, y: 20, width: 30, height: 40, properties: {}, ...overrides };
}

describe('shared map-object overlay rendering', () => {
  it('draws and handles a selected rectangle with scale-stable styling', () => {
    const context = new RecordingContext();
    drawMapObjectOverlay(context, shape('rectangle'), { selected: true, unitScale: 2 });
    expect({ fillStyle: context.fillStyle, strokeStyle: context.strokeStyle, lineWidth: context.lineWidth }).toEqual({ fillStyle: '#fff', strokeStyle: '#7454d8', lineWidth: 1 });
    expect(context.calls).toEqual([
      ['setLineDash'], ['beginPath'], ['rect', 10, 20, 30, 40], ['fill'], ['stroke'], ['setLineDash'],
      ['fillRect', 38, 58, 4, 4], ['strokeRect', 38, 58, 4, 4],
    ]);
  });

  it('draws an unselected ellipse with the canonical appearance', () => {
    const context = new RecordingContext();
    drawMapObjectOverlay(context, shape('ellipse'));
    expect({ fillStyle: context.fillStyle, strokeStyle: context.strokeStyle, lineWidth: context.lineWidth }).toEqual({ fillStyle: 'rgba(49,166,160,.15)', strokeStyle: '#2b958e', lineWidth: 1.25 });
    expect(context.calls).toEqual([
      ['setLineDash'], ['beginPath'], ['ellipse', 25, 40, 15, 20, 0, 0, Math.PI * 2], ['fill'], ['stroke'], ['setLineDash'],
    ]);
  });

  it('closes and fills polygon points but leaves a polyline open and unfilled', () => {
    const points = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }];
    const polygon = new RecordingContext();
    drawMapObjectOverlay(polygon, shape('polygon', { points }));
    expect(polygon.calls).toEqual([
      ['setLineDash'], ['beginPath'], ['moveTo', 10, 20], ['lineTo', 18, 20], ['lineTo', 18, 26], ['closePath'], ['fill'], ['stroke'], ['setLineDash'],
    ]);

    const polyline = new RecordingContext();
    drawMapObjectOverlay(polyline, shape('polyline', { points }), { unitScale: 2 });
    expect(polyline.calls).toEqual([
      ['setLineDash', 2.5, 1.5], ['beginPath'], ['moveTo', 10, 20], ['lineTo', 18, 20], ['lineTo', 18, 26], ['stroke'], ['setLineDash'],
    ]);
  });

  it('draws selected point handles at canonical object coordinates', () => {
    const context = new RecordingContext();
    drawMapObjectOverlay(context, shape('polygon', { points: [{ x: 2, y: 3 }] }), { selected: true, unitScale: 2 });
    expect(context.calls.slice(-4)).toEqual([
      ['beginPath'], ['arc', 12, 23, 2, 0, Math.PI * 2], ['fill'], ['stroke'],
    ]);
  });

  it('projects conservative stroke and handle bounds through an affine map matrix', () => {
    expect(mapObjectProjectedRenderBounds(shape('rectangle'), { a: 2, b: 1, c: -1, d: 0.5, e: 100, f: 50 }))
      .toEqual({ x: 41.25, y: 60.625, width: 137.5, height: 68.75 });
    expect(mapObjectProjectedRenderBounds(shape('rectangle'), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, { selected: true, unitScale: 2 }))
      .toEqual({ x: 5, y: 15, width: 40, height: 50 });
  });

  it('filters projected objects conservatively without changing retained order', () => {
    const edge = shape('rectangle', { id: 'edge', x: 10.7, y: 1, width: 1, height: 1 });
    const target = shape('ellipse', { id: 'target', x: 2, y: 2, width: 1, height: 1 });
    const far = shape('rectangle', { id: 'far', x: 100, y: 100, width: 1, height: 1 });
    const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const region = { x: 0, y: 0, width: 10, height: 10 };
    expect(mapObjectIntersectsRasterRegion(edge, matrix, region, { unitScale: 10 })).toBe(false);
    expect(mapObjectsIntersectingRasterRegion([edge, far, target], matrix, region, { unitScale: 10, selectedId: edge.id }).map(({ id }) => id))
      .toEqual(['edge', 'target']);
  });

  it('fails closed on invalid projection or raster geometry', () => {
    const object = shape('rectangle'); const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    expect(() => mapObjectProjectedRenderBounds(object, { ...matrix, a: Number.NaN })).toThrow(/matrix must be finite/);
    expect(() => mapObjectProjectedRenderBounds(object, matrix, { unitScale: 0 })).toThrow(/positive and finite/);
    expect(() => mapObjectIntersectsRasterRegion(object, matrix, { x: 0, y: 0, width: 0, height: 10 })).toThrow(/dimensions must be positive/);
  });
});
