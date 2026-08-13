import type { StrokeStyle } from '@aidraw/core';

export const CANVAS_STROKE_MITER_LIMIT = 10;

export interface CanvasStrokeContext {
  globalAlpha: number;
  lineWidth: number;
  lineCap: StrokeStyle['lineCap'];
  lineJoin: StrokeStyle['lineJoin'];
  miterLimit: number;
  setLineDash(segments: number[]): void;
}

/** Applies the complete canonical stroke geometry and opacity to saved Canvas state. */
export function applyCanvasStrokeStyle(context: CanvasStrokeContext, stroke: StrokeStyle): void {
  context.globalAlpha *= stroke.opacity;
  context.lineWidth = stroke.width;
  context.lineCap = stroke.lineCap;
  context.lineJoin = stroke.lineJoin;
  context.miterLimit = CANVAS_STROKE_MITER_LIMIT;
  context.setLineDash(stroke.dash);
}
