import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createIllustrationDocument,
  type GroupObject,
  type ShapeObject,
} from '@aidraw/core';
import { illustrationRegionBacking, illustrationRegionCanRenderLocally } from '../../src/common/illustration-region';

const timestamp = '2026-08-12T00:00:00.000Z';

function rectangle(id: string, layerId: string): ShapeObject {
  return {
    id,
    revision: 0,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    layerId,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: structuredClone(IDENTITY_TRANSFORM),
    type: 'shape',
    shape: 'rectangle',
    width: 20,
    height: 20,
    fill: { kind: 'solid', color: '#8268dd' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
}

describe('bounded illustration raster regions', () => {
  it('expands requested pixels by a bounded in-artboard backing margin', () => {
    const document = createIllustrationDocument('Large regional illustration');
    document.artboard = { ...document.artboard, width: 8_192, height: 8_192 };
    expect(illustrationRegionBacking(document, { x: 4_000, y: 4_000, width: 1, height: 1 })).toEqual({ x: 3_996, y: 3_996, width: 9, height: 9 });
    expect(illustrationRegionBacking(document, { x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 5, height: 5 });
    expect(illustrationRegionBacking(document, { x: 8_191, y: 8_191, width: 1, height: 1 })).toEqual({ x: 8_187, y: 8_187, width: 5, height: 5 });
    expect(() => illustrationRegionBacking(document, { x: 8_192, y: 0, width: 1, height: 1 })).toThrow('Illustration raster region falls outside the artboard bounds.');
    expect(() => illustrationRegionBacking(document, { x: 0.5, y: 0, width: 1, height: 1 })).toThrow('Illustration raster regions must use nonnegative safe-integer coordinates');
  });

  it('admits integer-phase closed primitives but rejects richer raster dependencies', () => {
    const document = createIllustrationDocument('Regional eligibility');
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector');
    const paint = Object.values(document.layers).find((layer) => layer.type === 'paint');
    if (!vector || vector.type !== 'vector' || !paint || paint.type !== 'paint') throw new Error('Expected illustration layers');
    const object = rectangle('shape', vector.id);
    document.objects[object.id] = object; vector.objectIds.push(object.id);
    expect(illustrationRegionCanRenderLocally(document)).toBe(true);

    object.transform.x = 0.5;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.transform.x = 0;
    object.shape = 'ellipse';
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.shape = 'polygon'; object.sides = 7;
    expect(illustrationRegionCanRenderLocally(document)).toBe(true);
    object.sides = 7.5;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.sides = 1_001;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.shape = 'star'; object.sides = 5; object.innerRadius = 0.4;
    expect(illustrationRegionCanRenderLocally(document)).toBe(true);
    object.innerRadius = 1.1;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.shape = 'rectangle'; object.cornerRadius = 4;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.cornerRadius = 0; object.shape = 'line';
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.shape = 'rectangle';
    object.fill = { kind: 'linear-gradient', x1: 0, y1: 0, x2: 20, y2: 0, stops: [{ offset: 0, color: '#111111', opacity: 1 }, { offset: 1, color: '#eeeeee', opacity: 1 }] };
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.fill = { kind: 'solid', color: '#8268dd' };
    object.stroke = { ...object.stroke, paint: { kind: 'solid', color: '#111111' }, width: 1 };
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.stroke = { ...object.stroke, paint: { kind: 'none' }, width: 0 };

    vector.opacity = 0.6;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    vector.opacity = 1;
    vector.maskLayerId = paint.id;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    delete vector.maskLayerId;

    object.filters = [{ type: 'brightness', value: 0.2 }];
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    object.filters = []; object.shadow = { color: '#00000066', blur: 0, offsetX: 3, offsetY: 0 };
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    delete object.shadow;
    object.maskObjectId = 'mask';
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    delete object.maskObjectId;
    paint.tileAssetIds['0,0'] = 'stale-cache';
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    paint.tileAssetIds = {};
    paint.strokes.push({ id: 'soft', actorId: HUMAN_ACTOR.id, points: [{ x: 0, y: 0, pressure: 1 }], color: '#111111', size: 20, opacity: 1, hardness: 0, flow: 1, mode: 'paint', preset: 'soft-round' });
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    expect(illustrationRegionCanRenderLocally(document, vector.id)).toBe(true);
  });

  it('fails closed for transformed isolated groups while ignoring invisible effects', () => {
    const document = createIllustrationDocument('Regional groups');
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector');
    if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const child = rectangle('child', vector.id);
    const group: GroupObject = {
      id: 'group', revision: 0, name: 'group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: structuredClone(IDENTITY_TRANSFORM),
      type: 'group', childIds: [child.id],
    };
    document.objects = { [child.id]: child, [group.id]: group }; vector.objectIds = [child.id, group.id];
    expect(illustrationRegionCanRenderLocally(document)).toBe(true);
    group.childIds = [group.id];
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    group.childIds = [child.id];
    group.opacity = 0.5;
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    group.opacity = 1;
    group.transform = { ...group.transform, x: 7, y: -3 };
    expect(illustrationRegionCanRenderLocally(document)).toBe(true);
    group.transform = { ...group.transform, x: 7.5 };
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    group.transform = { ...group.transform, x: 7 };
    group.transform = { ...group.transform, rotation: 15 };
    expect(illustrationRegionCanRenderLocally(document)).toBe(false);
    group.visible = false; child.blur = 8;
    expect(illustrationRegionCanRenderLocally(document)).toBe(true);
  });
});
