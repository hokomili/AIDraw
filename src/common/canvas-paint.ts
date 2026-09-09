import type { PaintStyle } from '@aidraw/core';
import { colorWithOpacity } from './color';

interface GradientStops {
  addColorStop(offset: number, color: string): void;
}

interface GradientContext<G extends GradientStops> {
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): G;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): G;
}

/** Paint endpoints are local object pixels. Radial endpoints mean center and radius point. */
export function canvasPaint<G extends GradientStops>(context: GradientContext<G>, style: PaintStyle): string | G | undefined {
  if (style.kind === 'none') return undefined;
  if (style.kind === 'solid') return style.color;
  const radius = Math.hypot(style.x2 - style.x1, style.y2 - style.y1);
  // SVG radial gradients with a zero radius use the final stop's color.
  if (style.kind === 'radial-gradient' && radius === 0) {
    const last = style.stops[style.stops.length - 1];
    return last ? colorWithOpacity(last.color, last.opacity) : undefined;
  }
  const gradient = style.kind === 'linear-gradient'
    ? context.createLinearGradient(style.x1, style.y1, style.x2, style.y2)
    : context.createRadialGradient(style.x1, style.y1, 0, style.x1, style.y1, radius);
  for (const stop of style.stops) gradient.addColorStop(stop.offset, colorWithOpacity(stop.color, stop.opacity));
  return gradient;
}
