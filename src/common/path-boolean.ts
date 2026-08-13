import paper from 'paper';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  nowIso,
  type IllustrationObject,
  type PathObject,
  type ShapeObject,
} from '@aidraw/core';

export type BooleanMode = 'union' | 'subtract' | 'intersect' | 'exclude';

function shapeItem(scope: paper.PaperScope, object: ShapeObject): paper.PathItem | undefined {
  if (object.shape === 'line' || object.shape === 'arrow') return undefined;
  if (object.shape === 'rectangle') return new scope.Path.Rectangle(new scope.Rectangle(0, 0, object.width, object.height), new scope.Size(object.cornerRadius ?? 0, object.cornerRadius ?? 0));
  if (object.shape === 'ellipse') return new scope.Path.Ellipse(new scope.Rectangle(0, 0, object.width, object.height));
  const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6); const path = new scope.Path(); const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
  for (let index = 0; index < count; index += 1) { const pointRadius = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius; const angle = -Math.PI / 2 + index / count * Math.PI * 2; path.add(new scope.Point(object.width / 2 + Math.cos(angle) * pointRadius, object.height / 2 + Math.sin(angle) * pointRadius)); }
  path.closed = true; return path;
}

function pathItem(scope: paper.PaperScope, object: IllustrationObject): paper.PathItem | undefined {
  const item = object.type === 'shape' ? shapeItem(scope, object) : object.type === 'path' ? scope.PathItem.create(object.pathData) : undefined;
  if (!item) return undefined;
  if (object.type === 'path') item.fillRule = object.fillRule;
  const transform = object.transform; const matrix = new scope.Matrix(); matrix.translate(transform.x, transform.y); matrix.rotate(transform.rotation, 0, 0); matrix.append(new scope.Matrix(transform.scaleX, Math.tan(transform.skewY * Math.PI / 180), Math.tan(transform.skewX * Math.PI / 180), transform.scaleY, 0, 0)); item.transform(matrix);
  return item;
}

export function createBooleanPath(first: IllustrationObject, second: IllustrationObject, mode: BooleanMode): PathObject {
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(1, 1));
  try {
    const a = pathItem(scope, first);
    const b = pathItem(scope, second);
    if (!a || !b) throw new Error('Boolean operations require two selected paths, rectangles, ellipses, polygons, or stars.');
    const result = mode === 'union' ? a.unite(b) : mode === 'subtract' ? a.subtract(b) : mode === 'intersect' ? a.intersect(b) : a.exclude(b);
    const pathData = result.pathData.trim();
    if (result.isEmpty() || !pathData) throw new Error('Boolean operation produced no filled geometry.');

    const source = first.type === 'shape' || first.type === 'path' ? first : undefined;
    const timestamp = nowIso();
    return {
      id: createId('path'),
      revision: 0,
      name: `${mode[0].toUpperCase()}${mode.slice(1)}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: HUMAN_ACTOR.id,
      layerId: first.layerId,
      visible: true,
      locked: false,
      opacity: first.opacity,
      blendMode: first.blendMode,
      transform: structuredClone(IDENTITY_TRANSFORM),
      type: 'path',
      pathData,
      closed: true,
      fillRule: result.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
      fill: structuredClone(source?.fill ?? { kind: 'solid', color: '#8268dd' }),
      stroke: structuredClone(source?.stroke ?? { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] }),
    };
  } finally {
    scope.project.remove();
  }
}
