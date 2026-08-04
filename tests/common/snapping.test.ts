import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, nowIso, type ShapeObject } from '@aidraw/core';
import { snapObjectTransform } from '../../src/common/snapping';

function shape(id: string, x = 0, y = 0): ShapeObject {
  const timestamp = nowIso(); return { id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: 'layer', visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y }, type: 'shape', shape: 'rectangle', width: 20, height: 10, fill: { kind: 'solid', color: '#ffffff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
}

describe('illustration snapping', () => {
  it('snaps transformed world bounds to persistent guides', () => {
    const document = createIllustrationDocument(); const object = shape('moving'); document.objects[object.id] = object; document.guides = [{ id: 'guide', orientation: 'vertical', position: 123, color: '#2fa7a0', locked: false }]; document.snapSettings = { artboard: false, objects: false, guides: true, grid: false, pixel: false, gridSize: 16, tolerance: 8 };
    expect(snapObjectTransform(document, object, { ...object.transform, x: 118 })).toMatchObject({ transform: { x: 123 }, guideX: 123 });
  });

  it('honors object bounds and independent grid/pixel toggles', () => {
    const document = createIllustrationDocument(); const moving = shape('moving'); const target = shape('target', 50, 30); document.objects = { [moving.id]: moving, [target.id]: target };
    document.snapSettings = { artboard: false, objects: true, guides: false, grid: false, pixel: false, gridSize: 16, tolerance: 5 };
    expect(snapObjectTransform(document, moving, { ...moving.transform, x: 31, y: 20 })).toMatchObject({ transform: { x: 30, y: 20 }, guideX: 50, guideY: 30 });
    document.snapSettings = { ...document.snapSettings, objects: false, grid: true, gridSize: 8 };
    const grid = snapObjectTransform(document, moving, { ...moving.transform, x: 14.4, y: 17.2 }).transform;
    expect(grid.x).toBeCloseTo(14); expect(grid.y).toBe(16);
  });

  it('returns raw transforms when tolerance is disabled', () => {
    const document = createIllustrationDocument(); const object = shape('moving'); document.snapSettings = { artboard: true, objects: true, guides: true, grid: true, pixel: true, gridSize: 8, tolerance: 0 };
    expect(snapObjectTransform(document, object, { ...object.transform, x: 1.25 }).transform.x).toBe(1.25);
  });
});
