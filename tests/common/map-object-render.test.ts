import { describe, expect, it } from 'vitest';
import type { CollisionShape } from '@aidraw/core';
import { drawMapObjectOverlay } from '../../src/common/map-object-render';

class RecordingContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth = 0;
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
});
