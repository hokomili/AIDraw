import type { IllustrationDocument, IllustrationObject, PointSample } from '@aidraw/core';
import { CANVAS_STROKE_MITER_LIMIT } from '../../common/canvas-stroke';
import { objectWorldBounds } from '../../common/selection-transform';
import { outlinePath, pressureOutline } from './geometry';

/**
 * Builds the established local path used by transformed masks. Click testing
 * opts into the two separately rendered arrowhead segments without silently
 * widening that pre-existing mask contract.
 */
export function localObjectPath(object: IllustrationObject, includeRenderedArrowhead = false): Path2D | undefined {
  const path = new Path2D();
  if (object.type === 'path') return new Path2D(object.pathData);
  if (object.type === 'vector-stroke') return outlinePath(pressureOutline(object.points, object.brush));
  if (object.type === 'shape') {
    if (object.shape === 'rectangle') path.roundRect(0, 0, object.width, object.height, object.cornerRadius ?? 0);
    else if (object.shape === 'ellipse') path.ellipse(object.width / 2, object.height / 2, Math.abs(object.width / 2), Math.abs(object.height / 2), 0, 0, Math.PI * 2);
    else if (object.shape === 'line' || object.shape === 'arrow') {
      path.moveTo(0, 0); path.lineTo(object.width, object.height);
      if (object.shape === 'arrow' && includeRenderedArrowhead) {
        const angle = Math.atan2(object.height, object.width);
        const head = Math.max(10, object.stroke.width * 4);
        path.moveTo(object.width, object.height); path.lineTo(object.width - Math.cos(angle - 0.5) * head, object.height - Math.sin(angle - 0.5) * head);
        path.moveTo(object.width, object.height); path.lineTo(object.width - Math.cos(angle + 0.5) * head, object.height - Math.sin(angle + 0.5) * head);
      }
    } else {
      const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6);
      const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
      for (let index = 0; index < count; index += 1) {
        const pointRadius = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius;
        const angle = -Math.PI / 2 + index / count * Math.PI * 2;
        const x = object.width / 2 + Math.cos(angle) * pointRadius;
        const y = object.height / 2 + Math.sin(angle) * pointRadius;
        if (!index) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
    }
    return path;
  }
  if (object.type === 'text' || object.type === 'image') { path.rect(0, 0, object.width, object.height); return path; }
  return undefined;
}

export function objectMatrix(object: IllustrationObject): DOMMatrix2DInit {
  const value = object.transform; const angle = value.rotation * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle); const skewX = Math.tan(value.skewX * Math.PI / 180); const skewY = Math.tan(value.skewY * Math.PI / 180);
  return { a: cosine * value.scaleX - sine * skewY, b: sine * value.scaleX + cosine * skewY, c: cosine * skewX - sine * value.scaleY, d: sine * skewX + cosine * value.scaleY, e: value.x, f: value.y };
}

function matrixToLocal(value: DOMMatrix2DInit, point: PointSample): { x: number; y: number } {
  const local = new DOMMatrix([value.a!, value.b!, value.c!, value.d!, value.e!, value.f!]).inverse().transformPoint(new DOMPoint(point.x, point.y));
  return { x: local.x, y: local.y };
}

export function worldToLocal(object: IllustrationObject, point: PointSample): { x: number; y: number } {
  return matrixToLocal(objectMatrix(object), point);
}

function invertibleObjectMatrix(object: IllustrationObject): DOMMatrix2DInit | undefined {
  const value = objectMatrix(object);
  const determinant = value.a! * value.d! - value.b! * value.c!;
  return Number.isFinite(determinant) && determinant !== 0 ? value : undefined;
}

/**
 * Returns topmost-first click hits. Supported painted geometry is authoritative:
 * an exact miss does not degrade to its rectangular bounds. Bounds remain the
 * deliberate fallback for groups, malformed paths, non-invertible transforms,
 * paintless objects, and a temporarily unavailable Canvas hit-test context.
 */
export function hitTestAll(document: IllustrationDocument, point: PointSample, context?: CanvasRenderingContext2D, viewScale = 1): IllustrationObject[] {
  return Object.values(document.objects).reverse().filter((object) => {
    if (!object.visible || object.locked) return false;
    const bounds = objectWorldBounds(object); const tolerance = 8 / Math.max(0.05, viewScale);
    const boundsHit = () => point.x >= bounds.x - tolerance && point.y >= bounds.y - tolerance && point.x <= bounds.x + bounds.width + tolerance && point.y <= bounds.y + bounds.height + tolerance;
    let localPath: Path2D | undefined;
    try { localPath = localObjectPath(object, true); } catch { return boundsHit(); }
    if (!context || !localPath) return boundsHit();
    const fillRule = object.type === 'path' ? object.fillRule : 'nonzero';
    const hasFill = object.type === 'vector-stroke' || object.type === 'text' || object.type === 'image'
      || ((object.type === 'shape' || object.type === 'path') && object.fill.kind !== 'none');
    const hasStroke = (object.type === 'shape' || object.type === 'path') && object.stroke.paint.kind !== 'none' && object.stroke.width > 0;
    if (!hasFill && !hasStroke) return boundsHit();
    try {
      const matrix = invertibleObjectMatrix(object);
      if (!matrix) return boundsHit();
      const local = matrixToLocal(matrix, point);
      const localTolerance = 8 / Math.max(0.05, viewScale * Math.max(Math.abs(object.transform.scaleX), Math.abs(object.transform.scaleY), 0.05));
      context.save();
      try {
        context.setTransform(1, 0, 0, 1, 0, 0);
        if (hasFill && context.isPointInPath(localPath, local.x, local.y, fillRule)) return true;
        if (hasFill) {
          context.lineWidth = localTolerance * 2;
          context.lineCap = 'round'; context.lineJoin = 'round'; context.setLineDash([]);
          if (context.isPointInStroke(localPath, local.x, local.y)) return true;
        }
        if (hasStroke) {
          context.lineWidth = object.stroke.width + localTolerance * 2;
          context.lineCap = object.stroke.lineCap; context.lineJoin = object.stroke.lineJoin; context.setLineDash(object.stroke.dash);
          context.miterLimit = CANVAS_STROKE_MITER_LIMIT;
          if (context.isPointInStroke(localPath, local.x, local.y)) return true;
        }
        return false;
      } finally { context.restore(); }
    } catch { return boundsHit(); }
  });
}
