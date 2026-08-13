import { getStroke } from 'perfect-freehand';
import type { PointSample } from '@aidraw/core';

export function pressureOutline(
  points: PointSample[],
  options: { size: number; thinning?: number; smoothing?: number; streamline?: number; simulatePressure?: boolean },
): number[][] {
  if (points.length === 0) return [];
  return getStroke(
    points.map((point) => [point.x, point.y, point.pressure] as [number, number, number]),
    {
      size: options.size,
      thinning: options.thinning ?? 0.55,
      smoothing: options.smoothing ?? 0.6,
      streamline: options.streamline ?? 0.45,
      simulatePressure: options.simulatePressure ?? false,
      easing: (value) => value,
      start: { taper: 0, cap: true },
      end: { taper: 0, cap: true },
    },
  );
}
export function outlinePath(points: number[][]): Path2D {
  const path = new Path2D();
  if (points.length < 2) return path;
  path.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    path.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) / 2, (current[1] + next[1]) / 2);
  }
  path.closePath();
  return path;
}

export function bresenham(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const targetX = Math.round(x1);
  const targetY = Math.round(y1);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    points.push({ x, y });
    if (x === targetX && y === targetY) break;
    const doubled = 2 * error;
    if (doubled >= dy) { error += dy; x += sx; }
    if (doubled <= dx) { error += dx; y += sy; }
  }
  return points;
}
