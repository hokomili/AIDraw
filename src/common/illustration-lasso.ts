import { getStroke } from 'perfect-freehand';
import paper from 'paper';
import type { IllustrationObject, ShapeObject, Transform } from '@aidraw/core';
import { lassoSelectsBounds, type LassoPoint } from './lasso';
import { objectWorldBounds } from './selection-transform';

const GEOMETRY_EPSILON = 1e-7;

interface ObjectGeometry {
  fill?: paper.PathItem;
  centerlines: paper.Path[];
  roots: paper.Item[];
}

function pathArea(path: paper.PathItem): number {
  return 'area' in path ? (path as paper.Path | paper.CompoundPath).area : 0;
}

function samePoint(left: LassoPoint, right: LassoPoint): boolean {
  return Math.abs(left.x - right.x) <= GEOMETRY_EPSILON && Math.abs(left.y - right.y) <= GEOMETRY_EPSILON;
}

function cleanPolygon(points: readonly LassoPoint[]): LassoPoint[] {
  const clean: LassoPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (!clean.length || !samePoint(clean[clean.length - 1], point)) clean.push({ x: point.x, y: point.y });
  }
  if (clean.length > 1 && samePoint(clean[0], clean[clean.length - 1])) clean.pop();
  return clean;
}

function objectMatrix(scope: paper.PaperScope, transform: Transform): paper.Matrix {
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const skewX = Math.tan(transform.skewX * Math.PI / 180);
  const skewY = Math.tan(transform.skewY * Math.PI / 180);
  return new scope.Matrix(
    cosine * transform.scaleX - sine * skewY,
    sine * transform.scaleX + cosine * skewY,
    cosine * skewX - sine * transform.scaleY,
    sine * skewX + cosine * transform.scaleY,
    transform.x,
    transform.y,
  );
}

function transformItem(scope: paper.PaperScope, item: paper.PathItem, transform: Transform): paper.PathItem {
  item.transform(objectMatrix(scope, transform));
  return item;
}

function pathLeaves(scope: paper.PaperScope, item: paper.PathItem): paper.Path[] {
  if (item instanceof scope.CompoundPath) return item.children.filter((child): child is paper.Path => child instanceof scope.Path);
  return item instanceof scope.Path ? [item] : [];
}

function shapePath(scope: paper.PaperScope, object: ShapeObject): { root: paper.PathItem; centerlines?: paper.Path[] } {
  if (object.shape === 'rectangle') {
    const radius = Math.min(object.cornerRadius ?? 0, object.width / 2, object.height / 2);
    return { root: new scope.Path.Rectangle(new scope.Rectangle(0, 0, object.width, object.height), new scope.Size(radius, radius)) };
  }
  if (object.shape === 'ellipse') return { root: new scope.Path.Ellipse(new scope.Rectangle(0, 0, object.width, object.height)) };
  if (object.shape === 'line' || object.shape === 'arrow') {
    const main = new scope.Path([new scope.Point(0, 0), new scope.Point(object.width, object.height)]);
    if (object.shape === 'line') return { root: main, centerlines: [main] };
    const angle = Math.atan2(object.height, object.width);
    const head = Math.max(10, object.stroke.width * 4);
    const first = new scope.Path([
      new scope.Point(object.width, object.height),
      new scope.Point(object.width - Math.cos(angle - 0.5) * head, object.height - Math.sin(angle - 0.5) * head),
    ]);
    const second = new scope.Path([
      new scope.Point(object.width, object.height),
      new scope.Point(object.width - Math.cos(angle + 0.5) * head, object.height - Math.sin(angle + 0.5) * head),
    ]);
    const compound = new scope.CompoundPath({ children: [main, first, second] });
    return { root: compound, centerlines: [main, first, second] };
  }
  const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6);
  const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
  const path = new scope.Path();
  for (let index = 0; index < count; index += 1) {
    const pointRadius = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius;
    const angle = -Math.PI / 2 + index / count * Math.PI * 2;
    path.add(new scope.Point(
      object.width / 2 + Math.cos(angle) * pointRadius,
      object.height / 2 + Math.sin(angle) * pointRadius,
    ));
  }
  path.closed = true;
  return { root: path };
}

function geometryForObject(scope: paper.PaperScope, object: IllustrationObject): ObjectGeometry | undefined {
  if (object.type === 'group') return undefined;
  if (object.type === 'vector-stroke') {
    const outline = getStroke(
      object.points.map((point) => [point.x, point.y, point.pressure] as [number, number, number]),
      object.brush,
    );
    if (outline.length < 3) return undefined;
    const path = new scope.Path(outline.map(([x, y]) => new scope.Point(x, y)));
    path.closed = true;
    transformItem(scope, path, object.transform);
    return { fill: path, centerlines: [], roots: [path] };
  }
  if (object.type === 'text' || object.type === 'image') {
    const path = new scope.Path.Rectangle(new scope.Rectangle(0, 0, object.width, object.height));
    if (path.isEmpty()) return undefined;
    transformItem(scope, path, object.transform);
    return { fill: path, centerlines: [], roots: [path] };
  }
  if (object.type === 'shape') {
    const geometry = shapePath(scope, object);
    transformItem(scope, geometry.root, object.transform);
    const fill = object.fill.kind !== 'none' && !geometry.root.isEmpty() ? geometry.root : undefined;
    const centerlines = object.stroke.paint.kind !== 'none' && object.stroke.width > 0
      ? geometry.centerlines ?? pathLeaves(scope, geometry.root)
      : [];
    if (fill || centerlines.length) return { fill, centerlines, roots: [geometry.root] };
    geometry.root.remove();
    return undefined;
  }
  const root = scope.PathItem.create(object.pathData);
  root.closed = object.closed;
  root.fillRule = object.fillRule;
  transformItem(scope, root, object.transform);
  const fill = object.fill.kind !== 'none' && !root.isEmpty() ? root : undefined;
  const centerlines = object.stroke.paint.kind !== 'none' && object.stroke.width > 0 ? pathLeaves(scope, root) : [];
  if (fill || centerlines.length) return { fill, centerlines, roots: [root] };
  root.remove();
  return undefined;
}

function boundsOverlap(left: paper.Rectangle, right: paper.Rectangle): boolean {
  return left.right >= right.left - GEOMETRY_EPSILON
    && left.left <= right.right + GEOMETRY_EPSILON
    && left.bottom >= right.top - GEOMETRY_EPSILON
    && left.top <= right.bottom + GEOMETRY_EPSILON;
}

function boundsContain(outer: paper.Rectangle, inner: paper.Rectangle): boolean {
  return inner.left >= outer.left - GEOMETRY_EPSILON
    && inner.right <= outer.right + GEOMETRY_EPSILON
    && inner.top >= outer.top - GEOMETRY_EPSILON
    && inner.bottom <= outer.bottom + GEOMETRY_EPSILON;
}

function pointInsideOrOn(path: paper.PathItem, point: paper.Point): boolean {
  return path.contains(point) || path.getNearestPoint(point).getDistance(point) <= GEOMETRY_EPSILON;
}

function fillIntersectsLasso(fill: paper.PathItem, lasso: paper.PathItem): boolean {
  if (!boundsOverlap(fill.bounds, lasso.bounds)) return false;
  if (fill.intersects(lasso)) return true;
  const overlap = fill.intersect(lasso, { insert: false });
  try {
    return !overlap.isEmpty() && Math.abs(pathArea(overlap)) > GEOMETRY_EPSILON;
  } finally {
    overlap.remove();
  }
}

function fillContainedByLasso(fill: paper.PathItem, lasso: paper.PathItem): boolean {
  if (!boundsContain(lasso.bounds, fill.bounds)) return false;
  const outside = fill.subtract(lasso, { insert: false });
  try {
    return outside.isEmpty() || Math.abs(pathArea(outside)) <= GEOMETRY_EPSILON;
  } finally {
    outside.remove();
  }
}

function representativePoint(path: paper.Path): paper.Point | undefined {
  if (path.length > GEOMETRY_EPSILON) return path.getPointAt(path.length / 2);
  return path.firstSegment?.point;
}

function centerlineIntersectsLasso(path: paper.Path, lasso: paper.PathItem): boolean {
  if (!boundsOverlap(path.bounds, lasso.bounds)) return false;
  if (path.getIntersections(lasso).length > 0) return true;
  const point = representativePoint(path);
  return point ? pointInsideOrOn(lasso, point) : false;
}

function centerlineContainedByLasso(path: paper.Path, lasso: paper.PathItem): boolean {
  if (!boundsContain(lasso.bounds, path.bounds)) return false;
  if (path.length <= GEOMETRY_EPSILON) {
    const point = representativePoint(path);
    return point ? pointInsideOrOn(lasso, point) : false;
  }
  const offsets = [0, path.length, ...path.getIntersections(lasso).map((location) => location.offset)]
    .filter((offset) => Number.isFinite(offset))
    .sort((left, right) => left - right)
    .filter((offset, index, values) => index === 0 || Math.abs(offset - values[index - 1]) > GEOMETRY_EPSILON);
  for (const offset of offsets) {
    const point = path.getPointAt(Math.min(path.length, Math.max(0, offset)));
    if (point && !pointInsideOrOn(lasso, point)) return false;
  }
  for (let index = 1; index < offsets.length; index += 1) {
    const point = path.getPointAt((offsets[index - 1] + offsets[index]) / 2);
    if (point && !pointInsideOrOn(lasso, point)) return false;
  }
  return true;
}

function geometrySelectsLasso(geometry: ObjectGeometry, lasso: paper.PathItem, containment: boolean): boolean {
  if (containment) {
    return (!geometry.fill || fillContainedByLasso(geometry.fill, lasso))
      && geometry.centerlines.every((path) => centerlineContainedByLasso(path, lasso));
  }
  return Boolean(geometry.fill && fillIntersectsLasso(geometry.fill, lasso))
    || geometry.centerlines.some((path) => centerlineIntersectsLasso(path, lasso));
}

/**
 * Selects canonical illustration geometry in input order. Filled shapes and
 * paths use their fill silhouette; unfilled paths use their centerline;
 * pressure strokes use their generated outline; image and text objects use
 * their transformed object frame. Unsupported groups and malformed path data
 * retain the prior transformed-bounds fallback so they remain selectable.
 */
export function lassoSelectsIllustrationObjects(
  polygon: readonly LassoPoint[],
  objects: readonly IllustrationObject[],
  containment = false,
): string[] {
  const clean = cleanPolygon(polygon);
  if (clean.length < 3) return [];
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(1, 1));
  const lasso = new scope.Path(clean.map((point) => new scope.Point(point.x, point.y)));
  lasso.closed = true;
  lasso.fillRule = 'evenodd';
  if (lasso.bounds.width <= GEOMETRY_EPSILON || lasso.bounds.height <= GEOMETRY_EPSILON) {
    scope.project.remove();
    return [];
  }
  const selected: string[] = [];
  try {
    for (const object of objects) {
      if (!object.visible) continue;
      let geometry: ObjectGeometry | undefined;
      try {
        geometry = geometryForObject(scope, object);
        const hit = geometry
          ? geometrySelectsLasso(geometry, lasso, containment)
          : lassoSelectsBounds(clean, objectWorldBounds(object), containment);
        if (hit) selected.push(object.id);
      } catch {
        if (lassoSelectsBounds(clean, objectWorldBounds(object), containment)) selected.push(object.id);
      } finally {
        for (const root of geometry?.roots ?? []) root.remove();
      }
    }
  } finally {
    scope.project.remove();
  }
  return selected;
}
