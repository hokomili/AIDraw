import { describe, expect, it } from 'vitest';
import { applyCanvasStrokeStyle, CANVAS_STROKE_MITER_LIMIT, type CanvasStrokeContext } from '../../src/common/canvas-stroke';

function target(globalAlpha = 0.8): { context: CanvasStrokeContext; dash: () => number[] } {
  let segments: number[] = [];
  const context: CanvasStrokeContext = {
    globalAlpha,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 3,
    setLineDash(value) { segments = [...value]; },
  };
  return { context, dash: () => segments };
}

describe('canonical Canvas stroke style', () => {
  it('applies opacity, width, cap, join, dash, and an explicit miter limit', () => {
    const { context, dash } = target();
    const stroke = { paint: { kind: 'solid' as const, color: '#ff6b7a' }, width: 7, opacity: 0.25, lineCap: 'square' as const, lineJoin: 'bevel' as const, dash: [9, 3] };
    applyCanvasStrokeStyle(context, stroke);
    expect(context).toMatchObject({ globalAlpha: 0.2, lineWidth: 7, lineCap: 'square', lineJoin: 'bevel', miterLimit: CANVAS_STROKE_MITER_LIMIT });
    expect(dash()).toEqual([9, 3]);
    expect(stroke.dash).toEqual([9, 3]);
  });

  it('multiplies caller-owned composite alpha without retaining caller dash aliases', () => {
    const { context, dash } = target(0.5);
    const stroke = { paint: { kind: 'none' as const }, width: 0, opacity: 0, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [4, 2] };
    applyCanvasStrokeStyle(context, stroke);
    stroke.dash[0] = 99;
    expect(context.globalAlpha).toBe(0);
    expect(dash()).toEqual([4, 2]);
  });
});
