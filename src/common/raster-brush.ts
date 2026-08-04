import { rasterBrushDabs, type RasterStroke } from '@aidraw/core';

export interface RasterBrushContext {
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  filter: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
}

function legacyStroke(context: RasterBrushContext, stroke: RasterStroke): void {
  if (!stroke.points.length) return;
  context.save();
  context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
  context.globalAlpha *= stroke.opacity * stroke.flow;
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.size;
  context.lineCap = stroke.preset === 'marker' ? 'square' : 'round';
  context.lineJoin = 'round';
  context.filter = stroke.preset === 'soft-round' || stroke.preset === 'airbrush' ? `blur(${stroke.size * (stroke.preset === 'airbrush' ? 0.35 : 0.18)}px)` : 'none';
  context.beginPath();
  context.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
  if (stroke.points.length === 1) context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
  context.stroke();
  context.restore();
}

function paintSpeckles(context: RasterBrushContext, radius: number, granulation: number, variation: number): void {
  const count = Math.round(2 + granulation * 7);
  for (let index = 0; index < count; index += 1) {
    const phase = variation * 97.13 + index * 2.399;
    const distance = radius * (0.12 + (Math.sin(phase * 1.7) * 0.5 + 0.5) * 0.72);
    const speckle = Math.max(0.25, radius * (0.015 + granulation * 0.022));
    context.beginPath();
    context.arc(Math.cos(phase) * distance, Math.sin(phase) * distance, speckle, 0, Math.PI * 2);
    context.fill();
  }
}

export function renderRasterStroke(context: RasterBrushContext, stroke: RasterStroke): void {
  if (!stroke.dynamics) { legacyStroke(context, stroke); return; }
  const dabs = rasterBrushDabs(stroke);
  context.save();
  context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
  context.fillStyle = stroke.color;
  context.strokeStyle = stroke.color;
  for (const dab of dabs) {
    context.save();
    context.translate(dab.x, dab.y);
    context.rotate(dab.rotation);
    context.globalAlpha *= dab.opacity;
    if (dab.tip === 'watercolor') {
      context.filter = `blur(${Math.max(0.35, dab.radiusX * (0.025 + dab.wetness * 0.035))}px)`;
      context.globalAlpha *= 0.32 + dab.wetness * 0.28;
      context.beginPath();
      context.ellipse(0, 0, dab.radiusX, dab.radiusY, 0, 0, Math.PI * 2);
      context.fill();
      context.filter = 'none';
      context.globalAlpha *= 0.48;
      context.lineWidth = Math.max(0.45, dab.radiusX * (0.025 + dab.wetness * 0.025));
      context.beginPath();
      context.ellipse(0, 0, dab.radiusX * 0.94, dab.radiusY * 0.94, 0, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha *= Math.max(0.08, dab.granulation * 0.55);
      paintSpeckles(context, dab.radiusX, dab.granulation, dab.variation);
    } else {
      const softness = Math.max(0, 1 - dab.hardness);
      context.filter = softness > 0.02 ? `blur(${Math.max(0.25, dab.radiusX * softness * 0.22)}px)` : 'none';
      context.beginPath();
      context.ellipse(0, 0, dab.radiusX, dab.radiusY, 0, 0, Math.PI * 2);
      context.fill();
      if (dab.tip === 'chalk' && dab.granulation > 0) {
        context.filter = 'none';
        context.globalAlpha *= 0.32 * dab.granulation;
        paintSpeckles(context, dab.radiusX, dab.granulation, dab.variation);
      }
    }
    context.restore();
  }
  context.restore();
}
