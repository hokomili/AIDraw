import type { IllustrationObject, Transform } from '@aidraw/core';
import { approximateLocalObjectBounds } from './illustration-geometry';

export interface WorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export type ScaleHandle = 'north-west' | 'north-east' | 'south-east' | 'south-west';
export type SelectionHandle = ScaleHandle | 'rotate';

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function objectMatrix(transform: Transform): Matrix {
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const skewX = Math.tan(transform.skewX * Math.PI / 180);
  const skewY = Math.tan(transform.skewY * Math.PI / 180);
  return {
    a: cosine * transform.scaleX - sine * skewY,
    b: sine * transform.scaleX + cosine * skewY,
    c: cosine * skewX - sine * transform.scaleY,
    d: sine * skewX + cosine * transform.scaleY,
    e: transform.x,
    f: transform.y,
  };
}

function transformPoint(matrix: Matrix, x: number, y: number): Point2D {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

export function objectWorldBounds(object: IllustrationObject): WorldBounds {
  const local = approximateLocalObjectBounds(object);
  const matrix = objectMatrix(object.transform);
  const corners = [
    transformPoint(matrix, local.x, local.y),
    transformPoint(matrix, local.x + local.width, local.y),
    transformPoint(matrix, local.x + local.width, local.y + local.height),
    transformPoint(matrix, local.x, local.y + local.height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) };
}

export function selectionWorldBounds(objects: IllustrationObject[]): WorldBounds | undefined {
  if (!objects.length) return undefined;
  const bounds = objects.map(objectWorldBounds);
  const left = Math.min(...bounds.map((entry) => entry.x));
  const top = Math.min(...bounds.map((entry) => entry.y));
  const right = Math.max(...bounds.map((entry) => entry.x + entry.width));
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.height));
  return { x: left, y: top, width: Math.max(0.001, right - left), height: Math.max(0.001, bottom - top) };
}

export function selectionHandlePoints(bounds: WorldBounds, viewScale: number): Record<SelectionHandle, Point2D> {
  const safeScale = Math.max(0.01, viewScale);
  const rotateOffset = 28 / safeScale;
  return {
    'north-west': { x: bounds.x, y: bounds.y },
    'north-east': { x: bounds.x + bounds.width, y: bounds.y },
    'south-east': { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    'south-west': { x: bounds.x, y: bounds.y + bounds.height },
    rotate: { x: bounds.x + bounds.width / 2, y: bounds.y - rotateOffset },
  };
}

export function hitSelectionHandle(point: Point2D, bounds: WorldBounds, viewScale: number): SelectionHandle | undefined {
  const radius = 9 / Math.max(0.01, viewScale);
  const points = selectionHandlePoints(bounds, viewScale);
  const ordered: SelectionHandle[] = ['rotate', 'north-west', 'north-east', 'south-east', 'south-west'];
  return ordered.find((handle) => Math.hypot(point.x - points[handle].x, point.y - points[handle].y) <= radius);
}

function scaleFactors(bounds: WorldBounds, handle: ScaleHandle, pointer: Point2D, uniform: boolean): { x: number; y: number; anchor: Point2D } {
  const east = handle === 'north-east' || handle === 'south-east';
  const south = handle === 'south-east' || handle === 'south-west';
  const anchor = {
    x: east ? bounds.x : bounds.x + bounds.width,
    y: south ? bounds.y : bounds.y + bounds.height,
  };
  let x = east ? (pointer.x - anchor.x) / bounds.width : (anchor.x - pointer.x) / bounds.width;
  let y = south ? (pointer.y - anchor.y) / bounds.height : (anchor.y - pointer.y) / bounds.height;
  x = Math.max(0.01, Math.min(1_000, x));
  y = Math.max(0.01, Math.min(1_000, y));
  if (uniform) {
    const value = Math.max(x, y);
    x = value;
    y = value;
  }
  return { x, y, anchor };
}

export function scaleSelection(
  objects: IllustrationObject[],
  bounds: WorldBounds,
  handle: ScaleHandle,
  pointer: Point2D,
  uniform = false,
): IllustrationObject[] {
  const factors = scaleFactors(bounds, handle, pointer, uniform);
  return objects.map((source) => {
    const object = structuredClone(source);
    object.transform = {
      ...object.transform,
      x: factors.anchor.x + (source.transform.x - factors.anchor.x) * factors.x,
      y: factors.anchor.y + (source.transform.y - factors.anchor.y) * factors.y,
      scaleX: source.transform.scaleX * factors.x,
      scaleY: source.transform.scaleY * factors.y,
    };
    return object;
  });
}

export function rotateSelection(
  objects: IllustrationObject[],
  bounds: WorldBounds,
  start: Point2D,
  pointer: Point2D,
  snapDegrees?: number,
): IllustrationObject[] {
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const pointerAngle = Math.atan2(pointer.y - center.y, pointer.x - center.x);
  let delta = (pointerAngle - startAngle) * 180 / Math.PI;
  if (snapDegrees && snapDegrees > 0) delta = Math.round(delta / snapDegrees) * snapDegrees;
  const radians = delta * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return objects.map((source) => {
    const object = structuredClone(source);
    const offsetX = source.transform.x - center.x;
    const offsetY = source.transform.y - center.y;
    object.transform = {
      ...object.transform,
      x: center.x + offsetX * cosine - offsetY * sine,
      y: center.y + offsetX * sine + offsetY * cosine,
      rotation: source.transform.rotation + delta,
    };
    return object;
  });
}
