import type { CollisionShape } from '@aidraw/core';

export interface MapPoint { x: number; y: number }
export type MapObjectTransformMode = 'move' | 'resize';

function segmentProjection(point: MapPoint, start: MapPoint, end: MapPoint): { point: MapPoint; distance: number } {
  const dx = end.x - start.x; const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return { point: start, distance: Math.hypot(point.x - start.x, point.y - start.y) };
  const time = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  const projected = { x: start.x + dx * time, y: start.y + dy * time };
  return { point: projected, distance: Math.hypot(point.x - projected.x, point.y - projected.y) };
}

function polygonContains(point: MapPoint, points: MapPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const a = points[current]; const b = points[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function mapObjectBounds(object: CollisionShape): { x: number; y: number; width: number; height: number } {
  if ((object.type === 'polygon' || object.type === 'polyline') && object.points?.length) { const xs = object.points.map((point) => object.x + point.x); const ys = object.points.map((point) => object.y + point.y); const x = Math.min(...xs); const y = Math.min(...ys); return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) }; }
  return { x: object.x, y: object.y, width: Math.max(1, object.width ?? 1), height: Math.max(1, object.height ?? 1) };
}

export function mapObjectAtPoint(object: CollisionShape, point: MapPoint, tolerance = 2): boolean {
  const bounds = mapObjectBounds(object); if (point.x < bounds.x - tolerance || point.y < bounds.y - tolerance || point.x > bounds.x + bounds.width + tolerance || point.y > bounds.y + bounds.height + tolerance) return false;
  if (object.type === 'rectangle') return point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
  if (object.type === 'ellipse') { const radiusX = bounds.width / 2; const radiusY = bounds.height / 2; return ((point.x - bounds.x - radiusX) / radiusX) ** 2 + ((point.y - bounds.y - radiusY) / radiusY) ** 2 <= 1; }
  const points = (object.points ?? []).map((entry) => ({ x: object.x + entry.x, y: object.y + entry.y })); if (points.length < 2) return false;
  if (object.type === 'polygon' && polygonContains(point, points)) return true;
  const segmentCount = object.type === 'polygon' ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) if (segmentProjection(point, points[index], points[(index + 1) % points.length]).distance <= tolerance) return true;
  return false;
}

export function transformMapObject(source: CollisionShape, mode: MapObjectTransformMode, delta: MapPoint): CollisionShape {
  const object = structuredClone(source); const deltaX = Math.round(delta.x); const deltaY = Math.round(delta.y);
  if (mode === 'move') { object.x += deltaX; object.y += deltaY; }
  else { if (object.type !== 'rectangle' && object.type !== 'ellipse') throw new Error('Only rectangle and ellipse map objects have width/height resize handles.'); object.width = Math.max(1, (object.width ?? 1) + deltaX); object.height = Math.max(1, (object.height ?? 1) + deltaY); }
  return object;
}

export function moveMapObjectSelection(source: readonly CollisionShape[], selectedIds: readonly string[], delta: MapPoint): CollisionShape[] {
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) throw new Error('Map object selection IDs must be unique.');
  let matched = 0;
  const result = source.map((object) => {
    if (!selected.has(object.id)) return object;
    matched += 1;
    return transformMapObject(object, 'move', delta);
  });
  if (matched !== selected.size) throw new Error('Every selected map object must exist in the source collection.');
  return result;
}

export function moveMapObjectPoint(source: CollisionShape, pointIndex: number, delta: MapPoint): CollisionShape {
  if (source.type !== 'polygon' && source.type !== 'polyline') throw new Error('Only polygon and polyline map objects have editable points.');
  if (!source.points?.[pointIndex]) throw new Error(`Map object point ${pointIndex} does not exist.`);
  const object = structuredClone(source); const point = object.points![pointIndex];
  object.points![pointIndex] = { x: Math.round(point.x + delta.x), y: Math.round(point.y + delta.y) };
  return object;
}

export function nearestMapObjectSegment(source: CollisionShape, point: MapPoint): { segmentIndex: number; point: MapPoint; distance: number } | undefined {
  if ((source.type !== 'polygon' && source.type !== 'polyline') || !source.points || source.points.length < 2) return undefined;
  const count = source.type === 'polygon' ? source.points.length : source.points.length - 1; let best: { segmentIndex: number; point: MapPoint; distance: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const start = source.points[index]; const end = source.points[(index + 1) % source.points.length]; const projected = segmentProjection({ x: point.x - source.x, y: point.y - source.y }, start, end);
    const candidate = { segmentIndex: index, point: { x: source.x + projected.point.x, y: source.y + projected.point.y }, distance: projected.distance };
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  return best;
}

export function insertMapObjectPoint(source: CollisionShape, segmentIndex: number, point: MapPoint): CollisionShape {
  if ((source.type !== 'polygon' && source.type !== 'polyline') || !source.points) throw new Error('Only polygon and polyline map objects accept inserted points.');
  const segmentCount = source.type === 'polygon' ? source.points.length : source.points.length - 1; if (segmentIndex < 0 || segmentIndex >= segmentCount) throw new Error(`Map object segment ${segmentIndex} does not exist.`);
  const object = structuredClone(source); object.points!.splice(segmentIndex + 1, 0, { x: Math.round(point.x - source.x), y: Math.round(point.y - source.y) }); return object;
}

export function deleteMapObjectPoint(source: CollisionShape, pointIndex: number): CollisionShape {
  if ((source.type !== 'polygon' && source.type !== 'polyline') || !source.points?.[pointIndex]) throw new Error(`Map object point ${pointIndex} does not exist.`);
  const minimum = source.type === 'polygon' ? 3 : 2; if (source.points.length <= minimum) throw new Error(`${source.type === 'polygon' ? 'Polygons' : 'Polylines'} require at least ${minimum} points.`);
  const object = structuredClone(source); object.points!.splice(pointIndex, 1); return object;
}
