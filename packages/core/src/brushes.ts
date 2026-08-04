import type { PointSample, RasterBrushDynamics, RasterBrushPreset, RasterStroke } from './model';

export type BuiltInRasterBrushId = 'hard-round' | 'soft-round' | 'pencil' | 'marker' | 'airbrush' | 'eraser' | 'watercolor';

const roundDynamics = {
  tip: 'round' as const,
  spacing: 0.12,
  stabilization: 0.15,
  scatter: 0,
  sizeJitter: 0,
  opacityJitter: 0,
  angle: 0,
  roundness: 1,
  wetness: 0,
  granulation: 0,
};

export const BUILT_IN_RASTER_BRUSH_PRESETS: Record<BuiltInRasterBrushId, RasterBrushPreset> = {
  'hard-round': { id: 'hard-round', name: 'Hard round', size: 12, opacity: 1, hardness: 1, flow: 1, dynamics: roundDynamics },
  'soft-round': { id: 'soft-round', name: 'Soft round', size: 28, opacity: 0.8, hardness: 0.25, flow: 0.65, dynamics: { ...roundDynamics, spacing: 0.09 } },
  pencil: { id: 'pencil', name: 'Pencil', size: 4, opacity: 1, hardness: 1, flow: 0.9, dynamics: { ...roundDynamics, tip: 'chalk', spacing: 0.08, stabilization: 0.08, sizeJitter: 0.08, opacityJitter: 0.12, granulation: 0.35 } },
  marker: { id: 'marker', name: 'Marker', size: 28, opacity: 0.78, hardness: 0.85, flow: 0.72, dynamics: { ...roundDynamics, tip: 'flat', spacing: 0.07, angle: -12, roundness: 0.3 } },
  airbrush: { id: 'airbrush', name: 'Airbrush', size: 60, opacity: 0.5, hardness: 0.08, flow: 0.2, dynamics: { ...roundDynamics, spacing: 0.07, scatter: 0.12, sizeJitter: 0.12, opacityJitter: 0.18 } },
  eraser: { id: 'eraser', name: 'Eraser', size: 24, opacity: 1, hardness: 1, flow: 1, dynamics: roundDynamics },
  watercolor: { id: 'watercolor', name: 'Watercolor wash', size: 48, opacity: 0.55, hardness: 0.18, flow: 0.18, dynamics: { ...roundDynamics, tip: 'watercolor', spacing: 0.06, stabilization: 0.35, scatter: 0.12, sizeJitter: 0.22, opacityJitter: 0.28, roundness: 0.78, wetness: 0.82, granulation: 0.58 } },
};

export interface RasterBrushDab {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
  opacity: number;
  hardness: number;
  wetness: number;
  granulation: number;
  tip: RasterBrushDynamics['tip'];
  variation: number;
}

export function resolveRasterBrushPreset(id: string, custom: RasterBrushPreset[] = []): RasterBrushPreset {
  const authored = custom.find((preset) => preset.id === id);
  return structuredClone(authored ?? BUILT_IN_RASTER_BRUSH_PRESETS[id as BuiltInRasterBrushId] ?? BUILT_IN_RASTER_BRUSH_PRESETS['hard-round']);
}

export function rasterBrushDynamics(preset: RasterBrushPreset, seed: number): RasterBrushDynamics {
  return { ...preset.dynamics, seed: seed >>> 0 };
}

export function stabilizeRasterPoints(points: PointSample[], amount: number): PointSample[] {
  if (points.length < 3 || amount <= 0) return points.map((point) => ({ ...point }));
  const alpha = Math.max(0.08, 1 - Math.min(1, amount) * 0.88);
  const result: PointSample[] = [{ ...points[0] }];
  let x = points[0].x; let y = points[0].y; let pressure = points[0].pressure;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]; x += (point.x - x) * alpha; y += (point.y - y) * alpha; pressure += (point.pressure - pressure) * alpha;
    result.push({ ...point, x, y, pressure });
  }
  return result;
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000; };
}

function strokeSeed(stroke: RasterStroke): number {
  let hash = stroke.dynamics?.seed ?? 2_166_136_261;
  for (let index = 0; index < stroke.id.length; index += 1) hash = Math.imul(hash ^ stroke.id.charCodeAt(index), 16_777_619);
  return hash >>> 0;
}

export function rasterBrushDabs(stroke: RasterStroke): RasterBrushDab[] {
  if (!stroke.points.length) return [];
  const dynamics = stroke.dynamics ?? { ...roundDynamics, seed: 0 };
  const points = stabilizeRasterPoints(stroke.points, dynamics.stabilization);
  const random = randomSource(strokeSeed(stroke));
  const spacing = Math.max(0.5, stroke.size * dynamics.spacing);
  const dabs: RasterBrushDab[] = [];
  const add = (x: number, y: number, pressure: number) => {
    if (dabs.length >= 200_000) return;
    const variation = random(); const scatterAngle = random() * Math.PI * 2; const scatterDistance = (random() * 2 - 1) * dynamics.scatter * stroke.size;
    const sizeFactor = Math.max(0.08, (0.55 + Math.max(0, Math.min(1, pressure)) * 0.9) * (1 + (random() * 2 - 1) * dynamics.sizeJitter));
    const opacityFactor = Math.max(0.01, 1 - random() * dynamics.opacityJitter);
    const radiusX = Math.max(0.25, stroke.size * sizeFactor / 2);
    dabs.push({
      x: x + Math.cos(scatterAngle) * scatterDistance,
      y: y + Math.sin(scatterAngle) * scatterDistance,
      radiusX,
      radiusY: Math.max(0.25, radiusX * dynamics.roundness),
      rotation: dynamics.angle * Math.PI / 180,
      opacity: Math.max(0.001, Math.min(1, stroke.opacity * stroke.flow * opacityFactor)),
      hardness: stroke.hardness,
      wetness: dynamics.wetness,
      granulation: dynamics.granulation,
      tip: dynamics.tip,
      variation,
    });
  };
  add(points[0].x, points[0].y, points[0].pressure);
  let carry = 0;
  for (let index = 1; index < points.length && dabs.length < 200_000; index += 1) {
    const from = points[index - 1]; const to = points[index]; const dx = to.x - from.x; const dy = to.y - from.y; const distance = Math.hypot(dx, dy);
    if (distance <= 0.0001) continue;
    for (let along = spacing - carry; along <= distance; along += spacing) { const ratio = along / distance; add(from.x + dx * ratio, from.y + dy * ratio, from.pressure + (to.pressure - from.pressure) * ratio); }
    carry = (carry + distance) % spacing;
  }
  return dabs;
}
