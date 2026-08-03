import type { IllustrationObject } from '@aidraw/core';

export interface LocalObjectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function numericPathBounds(pathData: string): LocalObjectBounds | undefined {
  const values = pathData
    .match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
    ?.map(Number)
    .filter(Number.isFinite) ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    xs.push(values[index]);
    ys.push(values[index + 1]);
  }
  if (!xs.length) return undefined;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * Returns inexpensive local bounds for editor hit-testing and alignment.
 * Path control points deliberately participate in the bounds: the result can
 * be a little generous, but never collapses a large curve to a 100 px box.
 */
export function approximateLocalObjectBounds(object: IllustrationObject): LocalObjectBounds {
  if (object.type === 'shape' || object.type === 'text' || object.type === 'image') {
    return { x: 0, y: 0, width: Math.max(1, Math.abs(object.width)), height: Math.max(1, Math.abs(object.height)) };
  }
  if (object.type === 'path') return numericPathBounds(object.pathData) ?? { x: 0, y: 0, width: 100, height: 100 };
  if (object.type === 'vector-stroke' && object.points.length) {
    const xs = object.points.map((point) => point.x);
    const ys = object.points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };
  }
  return { x: 0, y: 0, width: 100, height: 100 };
}
