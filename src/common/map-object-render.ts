import type { CollisionShape } from '@aidraw/core';
import { mapObjectBounds } from './map-objects';

export interface MapObjectAffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface MapObjectRasterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MapObjectCanvasContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  miterLimit: number;
  beginPath(): void;
  closePath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  setLineDash(segments: number[]): void;
}

const MAP_OBJECT_MITER_LIMIT = 10;

export interface MapObjectRenderOptions {
  selected?: boolean;
  /** Projected canvas units per canonical map-object pixel. */
  unitScale?: number;
}

function assertFiniteGeometry(values: readonly number[], message: string): void {
  if (!values.every(Number.isFinite)) throw new RangeError(message);
}

/**
 * Returns a conservative raster AABB for the complete AIDraw object overlay.
 * The default Canvas miter limit is 10; selected point/resize handles fit
 * inside the same larger expansion. Four expanded corners suffice because the
 * object projection is affine for both supported map orientations.
 */
export function mapObjectProjectedRenderBounds(
  object: CollisionShape,
  matrix: MapObjectAffineMatrix,
  options: MapObjectRenderOptions = {},
): MapObjectRasterRegion {
  assertFiniteGeometry([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f], 'Map object projection matrix must be finite.');
  const unitScale = options.unitScale ?? 1;
  if (!Number.isFinite(unitScale) || unitScale <= 0) throw new RangeError('Map object projection unit scale must be positive and finite.');
  const selected = options.selected ?? false;
  const lineWidth = (selected ? 2 : 1.25) / unitScale;
  const padding = Math.max(lineWidth * MAP_OBJECT_MITER_LIMIT / 2, selected ? 5 / unitScale : 0);
  const bounds = mapObjectBounds(object);
  const left = bounds.x - padding; const top = bounds.y - padding;
  const right = bounds.x + bounds.width + padding; const bottom = bounds.y + bounds.height + padding;
  const points = [
    { x: matrix.a * left + matrix.c * top + matrix.e, y: matrix.b * left + matrix.d * top + matrix.f },
    { x: matrix.a * right + matrix.c * top + matrix.e, y: matrix.b * right + matrix.d * top + matrix.f },
    { x: matrix.a * left + matrix.c * bottom + matrix.e, y: matrix.b * left + matrix.d * bottom + matrix.f },
    { x: matrix.a * right + matrix.c * bottom + matrix.e, y: matrix.b * right + matrix.d * bottom + matrix.f },
  ];
  const xs = points.map(({ x }) => x); const ys = points.map(({ y }) => y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function mapObjectIntersectsRasterRegion(
  object: CollisionShape,
  matrix: MapObjectAffineMatrix,
  region: MapObjectRasterRegion,
  options: MapObjectRenderOptions = {},
): boolean {
  assertFiniteGeometry([region.x, region.y, region.width, region.height], 'Map object raster region must be finite.');
  if (region.width <= 0 || region.height <= 0) throw new RangeError('Map object raster region dimensions must be positive.');
  const bounds = mapObjectProjectedRenderBounds(object, matrix, options);
  return bounds.x + bounds.width > region.x && bounds.y + bounds.height > region.y
    && bounds.x < region.x + region.width && bounds.y < region.y + region.height;
}

export function mapObjectsIntersectingRasterRegion<T extends CollisionShape>(
  objects: readonly T[],
  matrix: MapObjectAffineMatrix,
  region: MapObjectRasterRegion,
  options: { unitScale?: number; selectedId?: string } = {},
): T[] {
  return objects.filter((object) => mapObjectIntersectsRasterRegion(object, matrix, region, {
    unitScale: options.unitScale,
    selected: object.id === options.selectedId,
  }));
}

/**
 * Draws the application-owned map-object overlay shared by the editor and
 * headless observation/export. The object remains metadata in Tiled output;
 * this function owns only AIDraw's visible canvas representation.
 */
export function drawMapObjectOverlay(
  context: MapObjectCanvasContext,
  object: CollisionShape,
  options: MapObjectRenderOptions = {},
): void {
  const selected = options.selected ?? false;
  const unitScale = Math.max(0.001, options.unitScale ?? 1);
  const width = object.width ?? 1;
  const height = object.height ?? 1;

  context.fillStyle = selected ? 'rgba(130,104,221,.22)' : 'rgba(49,166,160,.15)';
  context.strokeStyle = selected ? '#7454d8' : '#2b958e';
  context.lineWidth = (selected ? 2 : 1.25) / unitScale;
  context.miterLimit = MAP_OBJECT_MITER_LIMIT;
  context.setLineDash(object.type === 'polyline' ? [5 / unitScale, 3 / unitScale] : []);
  context.beginPath();
  if (object.type === 'rectangle') context.rect(object.x, object.y, width, height);
  else if (object.type === 'ellipse') context.ellipse(object.x + width / 2, object.y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
  else if (object.points?.length) {
    object.points.forEach((point, index) => {
      if (index) context.lineTo(object.x + point.x, object.y + point.y);
      else context.moveTo(object.x + point.x, object.y + point.y);
    });
    if (object.type === 'polygon') context.closePath();
  }
  if (object.type !== 'polyline') context.fill();
  context.stroke();
  context.setLineDash([]);

  if (selected && (object.type === 'rectangle' || object.type === 'ellipse')) {
    const handleSize = 8 / unitScale;
    context.fillStyle = '#fff';
    context.fillRect(object.x + width - handleSize / 2, object.y + height - handleSize / 2, handleSize, handleSize);
    context.strokeStyle = '#7454d8';
    context.strokeRect(object.x + width - handleSize / 2, object.y + height - handleSize / 2, handleSize, handleSize);
  }
  if (selected && object.points) {
    const radius = 4 / unitScale;
    for (const point of object.points) {
      context.fillStyle = '#fff';
      context.beginPath();
      context.arc(object.x + point.x, object.y + point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#7454d8';
      context.stroke();
    }
  }
}
