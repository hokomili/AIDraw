import { DOMMatrix, DOMPoint, Path2D, createCanvas } from '@napi-rs/canvas';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createIllustrationDocument,
  type GroupObject,
  type IllustrationDocument,
  type IllustrationObject,
  type PathObject,
  type ShapeObject,
} from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import { hitTestAll, localObjectPath, objectMatrix } from '../../src/renderer/canvas/illustration-hit-test';

Object.assign(globalThis, { DOMMatrix, DOMPoint, Path2D });

const timestamp = '2026-08-12T00:00:00.000Z';
const noStroke = { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
const visibleStroke = { paint: { kind: 'solid' as const, color: '#231f32' }, width: 2, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };

function base(id: string) {
  return {
    id,
    revision: 0,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    layerId: 'vector-layer',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
    transform: structuredClone(IDENTITY_TRANSFORM),
  };
}

function ellipse(id: string, x = 0, y = 0): ShapeObject {
  return {
    ...base(id),
    transform: { ...IDENTITY_TRANSFORM, x, y },
    type: 'shape',
    shape: 'ellipse',
    width: 100,
    height: 100,
    fill: { kind: 'solid', color: '#8268dd' },
    stroke: noStroke,
  };
}

function documentWith(...objects: IllustrationObject[]): IllustrationDocument {
  const document = createIllustrationDocument('Click geometry');
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
  if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
  document.objects = {};
  layer.objectIds = [];
  for (const object of objects) {
    object.layerId = layer.id;
    document.objects[object.id] = object;
    layer.objectIds.push(object.id);
  }
  return document;
}

function context(): CanvasRenderingContext2D {
  return createCanvas(1, 1).getContext('2d') as unknown as CanvasRenderingContext2D;
}

function hitIds(document: IllustrationDocument, x: number, y: number, viewScale = 1): string[] {
  return hitTestAll(document, { x, y, pressure: 0.5 }, context(), viewScale).map(({ id }) => id);
}

describe('illustration click hit testing', () => {
  it('treats a supported silhouette miss as final instead of falling through to bounds', () => {
    const document = documentWith(ellipse('ellipse'));
    expect(hitIds(document, 5, 5)).toEqual([]);
    expect(hitIds(document, 50, 1)).toEqual(['ellipse']);
  });

  it('honors an even-odd fill hole and the existing scale-adjusted edge affordance', () => {
    const object: PathObject = {
      ...base('donut'),
      type: 'path',
      pathData: 'M0 0H100V100H0Z M25 25H75V75H25Z',
      closed: true,
      fillRule: 'evenodd',
      fill: { kind: 'solid', color: '#ff6b7a' },
      stroke: noStroke,
    };
    const document = documentWith(object);
    expect(hitIds(document, 50, 50)).toEqual([]);
    expect(hitIds(document, 10, 10)).toEqual(['donut']);
    expect(hitIds(document, 22, 50)).toEqual(['donut']);
  });

  it('uses the rendered arrowhead and full per-side stroke tolerance', () => {
    const object: ShapeObject = {
      ...base('arrow'),
      type: 'shape',
      shape: 'arrow',
      width: 100,
      height: 0,
      fill: { kind: 'none' },
      stroke: visibleStroke,
    };
    const document = documentWith(object);
    expect(hitIds(document, 92, 4, 4)).toEqual(['arrow']);
    expect(hitIds(document, 50, 3, 4)).toEqual(['arrow']);
    expect(hitIds(document, 50, 5, 4)).toEqual([]);
  });

  it('opts arrowheads into click geometry without widening the established mask path', () => {
    const object: ShapeObject = {
      ...base('arrow'),
      type: 'shape',
      shape: 'arrow',
      width: 100,
      height: 0,
      fill: { kind: 'none' },
      stroke: visibleStroke,
    };
    const canvasContext = context();
    canvasContext.lineWidth = 2;
    const maskPath = localObjectPath(object);
    const clickPath = localObjectPath(object, true);
    expect(maskPath && canvasContext.isPointInStroke(maskPath, 92, 4)).toBe(false);
    expect(clickPath && canvasContext.isPointInStroke(clickPath, 92, 4)).toBe(true);
  });

  it('evaluates the supported path after its complete affine transform', () => {
    const object = ellipse('affine');
    object.transform = { x: 180, y: 40, scaleX: 2, scaleY: 0.5, rotation: 30, skewX: 15, skewY: -5 };
    const matrix = objectMatrix(object);
    const transform = new DOMMatrix([matrix.a!, matrix.b!, matrix.c!, matrix.d!, matrix.e!, matrix.f!]);
    const center = transform.transformPoint(new DOMPoint(50, 50));
    const emptyCorner = transform.transformPoint(new DOMPoint(5, 5));
    const document = documentWith(object);
    expect(hitIds(document, center.x, center.y)).toEqual(['affine']);
    expect(hitIds(document, emptyCorner.x, emptyCorner.y)).toEqual([]);
  });

  it('retains bounds fallback for unsupported, non-invertible, or paintless objects', () => {
    const group: GroupObject = { ...base('group'), type: 'group', childIds: [] };
    const singular = ellipse('singular', 360);
    singular.transform.scaleX = 0;
    const paintless: PathObject = {
      ...base('paintless'),
      transform: { ...IDENTITY_TRANSFORM, x: 120 },
      type: 'path',
      pathData: 'M0 0H40V40H0Z',
      closed: true,
      fillRule: 'nonzero',
      fill: { kind: 'none' },
      stroke: noStroke,
    };
    const malformed: PathObject = {
      ...base('malformed'),
      transform: { ...IDENTITY_TRANSFORM, x: 240 },
      type: 'path',
      pathData: 'not-a-path',
      closed: false,
      fillRule: 'nonzero',
      fill: { kind: 'solid', color: '#31a6a0' },
      stroke: noStroke,
    };
    const document = documentWith(group, paintless, malformed, singular);
    expect(hitIds(document, 50, 50)).toEqual(['group']);
    expect(hitIds(document, 140, 20)).toEqual(['paintless']);
    expect(hitIds(document, 290, 50)).toEqual(['malformed']);
    expect(hitIds(document, 360, 50)).toEqual(['singular']);
  });

  it('returns topmost-first hits, skips locked/hidden objects, and restores Canvas state', () => {
    const bottom = ellipse('bottom');
    const top = ellipse('top');
    const locked = { ...ellipse('locked'), locked: true };
    const hidden = { ...ellipse('hidden'), visible: false };
    const document = documentWith(bottom, top, locked, hidden);
    const canvasContext = context();
    canvasContext.lineWidth = 37;
    canvasContext.lineCap = 'square';
    canvasContext.setLineDash([3, 5]);
    expect(hitTestAll(document, { x: 50, y: 50, pressure: 0.5 }, canvasContext, 1).map(({ id }) => id)).toEqual(['top', 'bottom']);
    expect(canvasContext.lineWidth).toBe(37);
    expect(canvasContext.lineCap).toBe('square');
    expect(canvasContext.getLineDash()).toEqual([3, 5]);
  });
});
