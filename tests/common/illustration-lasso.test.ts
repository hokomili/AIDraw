import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  type GroupObject,
  type IllustrationObject,
  type PathObject,
  type ShapeObject,
  type VectorStrokeObject,
} from '@aidraw/core';
import { lassoSelectsIllustrationObjects } from '../../src/common/illustration-lasso';
import { lassoSelectsBounds } from '../../src/common/lasso';
import { objectWorldBounds } from '../../src/common/selection-transform';

const timestamp = '2026-08-12T00:00:00.000Z';
const noStroke = { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };
const visibleStroke = { paint: { kind: 'solid' as const, color: '#111111' }, width: 8, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] };

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

function ellipse(id = 'ellipse'): ShapeObject {
  return {
    ...base(id),
    type: 'shape',
    shape: 'ellipse',
    width: 100,
    height: 60,
    fill: { kind: 'solid', color: '#8268dd' },
    stroke: visibleStroke,
  };
}

function ellipseEnvelope(scale: number): Array<{ x: number; y: number }> {
  const sides = 16;
  const correction = scale / Math.cos(Math.PI / sides);
  return Array.from({ length: sides }, (_, index) => {
    const angle = (index + 0.5) * Math.PI * 2 / sides;
    return { x: 50 + Math.cos(angle) * 50 * correction, y: 30 + Math.sin(angle) * 30 * correction };
  });
}

describe('canonical illustration lasso geometry', () => {
  it('rejects a bounds-corner false positive while retaining curve intersection', () => {
    const object = ellipse();
    const corner = [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 8 }, { x: 1, y: 8 }];
    expect(lassoSelectsBounds(corner, objectWorldBounds(object))).toBe(true);
    expect(lassoSelectsIllustrationObjects(corner, [object])).toEqual([]);

    const curve = [{ x: -2, y: 27 }, { x: 3, y: 27 }, { x: 3, y: 33 }, { x: -2, y: 33 }];
    expect(lassoSelectsIllustrationObjects(curve, [object])).toEqual([object.id]);
  });

  it('uses the filled silhouette rather than its rectangular corners for containment', () => {
    const object = ellipse();
    const envelope = ellipseEnvelope(1.02);
    expect(lassoSelectsBounds(envelope, objectWorldBounds(object), true)).toBe(false);
    expect(lassoSelectsIllustrationObjects(envelope, [object], true)).toEqual([object.id]);
    expect(lassoSelectsIllustrationObjects(ellipseEnvelope(0.8), [object], true)).toEqual([]);
  });

  it('honors transformed even-odd path holes and preserves input order without mutation', () => {
    const donut: PathObject = {
      ...base('donut'),
      type: 'path',
      pathData: 'M 0 0 H 100 V 100 H 0 Z M 30 30 H 70 V 70 H 30 Z',
      closed: true,
      fill: { kind: 'solid', color: '#ff6b7a' },
      stroke: noStroke,
      fillRule: 'evenodd',
    };
    donut.transform = { ...donut.transform, x: 10, y: 20, rotation: 15, skewX: 8 };
    const control: ShapeObject = { ...ellipse('control'), transform: { ...IDENTITY_TRANSFORM, x: 200 } };
    const source: IllustrationObject[] = [control, donut];
    const before = structuredClone(source);

    const radians = donut.transform.rotation * Math.PI / 180;
    const skew = Math.tan(donut.transform.skewX * Math.PI / 180);
    const world = (x: number, y: number) => ({
      x: Math.cos(radians) * x + (Math.cos(radians) * skew - Math.sin(radians)) * y + donut.transform.x,
      y: Math.sin(radians) * x + (Math.sin(radians) * skew + Math.cos(radians)) * y + donut.transform.y,
    });
    const hole = [world(42, 42), world(58, 42), world(58, 58), world(42, 58)];
    expect(lassoSelectsIllustrationObjects(hole, source)).toEqual([]);
    const fill = [world(5, 5), world(20, 5), world(20, 20), world(5, 20)];
    expect(lassoSelectsIllustrationObjects(fill, source)).toEqual([donut.id]);
    expect(lassoSelectsIllustrationObjects(
      [{ x: -100, y: -100 }, { x: 400, y: -100 }, { x: 400, y: 300 }, { x: -100, y: 300 }],
      source,
    )).toEqual([control.id, donut.id]);
    expect(source).toEqual(before);
  });

  it('selects pressure outlines and stroke-only Bézier centerlines without their broad bounds', () => {
    const pressure: VectorStrokeObject = {
      ...base('pressure'),
      type: 'vector-stroke',
      points: [{ x: 0, y: 0, pressure: 1 }, { x: 50, y: 0, pressure: 1 }, { x: 100, y: 0, pressure: 1 }],
      brush: { size: 20, thinning: 0, smoothing: 0.5, streamline: 0, simulatePressure: false, color: '#111111' },
    };
    const outlineOnly = [{ x: 45, y: 7 }, { x: 55, y: 7 }, { x: 55, y: 10 }, { x: 45, y: 10 }];
    expect(lassoSelectsBounds(outlineOnly, objectWorldBounds(pressure))).toBe(false);
    expect(lassoSelectsIllustrationObjects(outlineOnly, [pressure])).toEqual([pressure.id]);

    const curve: PathObject = {
      ...base('curve'),
      type: 'path',
      pathData: 'M 0 50 C 25 0 75 100 100 50',
      closed: false,
      fill: { kind: 'none' },
      stroke: visibleStroke,
      fillRule: 'nonzero',
    };
    const emptyBoundsArea = [{ x: 45, y: 5 }, { x: 55, y: 5 }, { x: 55, y: 15 }, { x: 45, y: 15 }];
    expect(lassoSelectsBounds(emptyBoundsArea, objectWorldBounds(curve))).toBe(true);
    expect(lassoSelectsIllustrationObjects(emptyBoundsArea, [curve])).toEqual([]);
    const crossing = [{ x: 45, y: 45 }, { x: 55, y: 45 }, { x: 55, y: 55 }, { x: 45, y: 55 }];
    expect(lassoSelectsIllustrationObjects(crossing, [curve])).toEqual([curve.id]);
    expect(lassoSelectsIllustrationObjects([{ x: -5, y: -5 }, { x: 105, y: -5 }, { x: 105, y: 105 }, { x: -5, y: 105 }], [curve], true)).toEqual([curve.id]);
  });

  it('keeps transformed text/image frames exact and unsupported groups selectable by bounds', () => {
    const image: IllustrationObject = {
      ...base('image'),
      type: 'image',
      assetId: 'asset',
      width: 20,
      height: 10,
      filters: [],
      transform: { ...IDENTITY_TRANSFORM, x: 30, y: 40, rotation: 90 },
    };
    const group: GroupObject = { ...base('group'), type: 'group', childIds: [], transform: { ...IDENTITY_TRANSFORM, x: 200, y: 100 } };
    const malformed: PathObject = {
      ...base('malformed'), type: 'path', pathData: 'not-valid-path-data', closed: true,
      fill: { kind: 'solid', color: '#111111' }, stroke: noStroke, fillRule: 'nonzero',
      transform: { ...IDENTITY_TRANSFORM, x: 400, y: 100 },
    };
    const imageHit = [{ x: 21, y: 41 }, { x: 29, y: 41 }, { x: 29, y: 59 }, { x: 21, y: 59 }];
    const groupHit = [{ x: 210, y: 110 }, { x: 220, y: 110 }, { x: 220, y: 120 }, { x: 210, y: 120 }];
    const malformedHit = [{ x: 410, y: 110 }, { x: 420, y: 110 }, { x: 420, y: 120 }, { x: 410, y: 120 }];
    expect(lassoSelectsIllustrationObjects(imageHit, [group, image])).toEqual([image.id]);
    expect(lassoSelectsIllustrationObjects(groupHit, [group, image])).toEqual([group.id]);
    expect(lassoSelectsIllustrationObjects(malformedHit, [malformed])).toEqual([malformed.id]);
    expect(lassoSelectsIllustrationObjects(groupHit, [{ ...group, visible: false }, image])).toEqual([]);
    expect(lassoSelectsIllustrationObjects([{ x: 0, y: 0 }, { x: 1, y: 1 }], [image, group])).toEqual([]);
  });
});
