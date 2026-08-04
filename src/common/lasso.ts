import type { WorldBounds } from './selection-transform';

export interface LassoPoint { x: number; y: number }
export type SelectionCombination = 'replace' | 'add' | 'subtract' | 'intersect';

export function pointInPolygon(point: LassoPoint, polygon: LassoPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]; const b = polygon[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function lassoSelectsBounds(polygon: LassoPoint[], bounds: WorldBounds, containment = false): boolean {
  const corners = [{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height }];
  if (containment) return corners.every((point) => pointInPolygon(point, polygon));
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if ([...corners, center].some((point) => pointInPolygon(point, polygon))) return true;
  return polygon.some((point) => point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height);
}

export function combineSelection(current: string[], incoming: string[], mode: SelectionCombination): string[] {
  const selected = new Set(current); const next = new Set(incoming);
  if (mode === 'replace') return [...next];
  if (mode === 'add') { for (const id of next) selected.add(id); return [...selected]; }
  if (mode === 'subtract') { for (const id of next) selected.delete(id); return [...selected]; }
  return current.filter((id) => next.has(id));
}
