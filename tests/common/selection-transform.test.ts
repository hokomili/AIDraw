import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM, createIllustrationDocument, nowIso, type IllustrationObject } from '@aidraw/core';
import {
  hitSelectionHandle,
  objectWorldBounds,
  rotateSelection,
  scaleSelection,
  selectionHandlePoints,
  selectionWorldBounds,
} from '../../src/common/selection-transform';

function rectangle(id: string, x: number, y: number, width = 20, height = 10): IllustrationObject {
  const document = createIllustrationDocument('Bounds');
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
  const timestamp = nowIso();
  return {
    id,
    revision: 0,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: 'human',
    layerId: layer.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x, y },
    type: 'shape',
    shape: 'rectangle',
    width,
    height,
    fill: { kind: 'none' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
}

describe('selection transforms', () => {
  it('computes rotated world bounds and combined selection bounds', () => {
    const first = rectangle('first', 10, 20);
    first.transform.rotation = 90;
    expect(objectWorldBounds(first)).toEqual({ x: 0, y: 20, width: 10.000000000000002, height: 20 });
    const combined = selectionWorldBounds([first, rectangle('second', 40, 10, 5, 5)]);
    expect(combined).toEqual({ x: 0, y: 10, width: 45, height: 30 });
  });

  it('keeps transform handles a constant screen distance and hit area', () => {
    const bounds = { x: 10, y: 20, width: 100, height: 80 };
    expect(selectionHandlePoints(bounds, 2).rotate).toEqual({ x: 60, y: 6 });
    expect(hitSelectionHandle({ x: 60, y: 7 }, bounds, 2)).toBe('rotate');
    expect(hitSelectionHandle({ x: 110, y: 100 }, bounds, 2)).toBe('south-east');
    expect(hitSelectionHandle({ x: 60, y: 40 }, bounds, 2)).toBeUndefined();
  });

  it('scales a multi-object selection from the opposite corner', () => {
    const objects = [rectangle('first', 10, 20), rectangle('second', 30, 40)];
    const bounds = selectionWorldBounds(objects)!;
    const scaled = scaleSelection(objects, bounds, 'south-east', { x: 70, y: 80 });
    expect(scaled[0].transform).toMatchObject({ x: 10, y: 20, scaleX: 1.5, scaleY: 2 });
    expect(scaled[1].transform).toMatchObject({ x: 40, y: 60, scaleX: 1.5, scaleY: 2 });
    expect(objects[0].transform).toEqual({ ...IDENTITY_TRANSFORM, x: 10, y: 20 });
  });

  it('rotates every selected object around the group center and supports snapping', () => {
    const objects = [rectangle('first', 0, 0, 10, 10), rectangle('second', 20, 0, 10, 10)];
    const bounds = selectionWorldBounds(objects)!;
    const rotated = rotateSelection(objects, bounds, { x: 15, y: -10 }, { x: 30, y: 5 }, 15);
    expect(rotated[0].transform.x).toBeCloseTo(20);
    expect(rotated[0].transform.y).toBeCloseTo(-10);
    expect(rotated[0].transform.rotation).toBe(90);
    expect(rotated[1].transform.x).toBeCloseTo(20);
    expect(rotated[1].transform.y).toBeCloseTo(10);
    expect(rotated[1].transform.rotation).toBe(90);
  });
});
