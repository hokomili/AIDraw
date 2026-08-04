import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type ShapeObject } from '@aidraw/core';
import { alignIllustrationObjects, distributeIllustrationObjects } from '../../src/common/alignment';
import { objectWorldBounds } from '../../src/common/selection-transform';

function shape(id: string, x: number, width = 20, rotation = 0): ShapeObject {
  const timestamp = nowIso(); return { id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: 'layer', visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y: 20, rotation }, type: 'shape', shape: 'rectangle', width, height: 10, fill: { kind: 'solid', color: '#fff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
}

describe('illustration alignment and distribution', () => {
  it('aligns rotated world bounds to a key object without moving the key', () => {
    const objects = [shape('a', 10, 20, 30), shape('key', 90, 30)]; const aligned = alignIllustrationObjects(objects, 'right', 'key-object', { x: 0, y: 0, width: 200, height: 100 }, 'key');
    expect(objectWorldBounds(aligned[0]).x + objectWorldBounds(aligned[0]).width).toBeCloseTo(120);
    expect(aligned[1].transform).toEqual(objects[1].transform);
  });

  it('distributes centers and equal visual gaps while preserving input order', () => {
    const objects = [shape('a', 0, 10), shape('b', 40, 30), shape('c', 100, 20)];
    const centered = distributeIllustrationObjects(objects, 'x', 'centers'); expect(centered.map((object) => object.id)).toEqual(['a', 'b', 'c']); expect(objectWorldBounds(centered[1]).x + 15).toBeCloseTo(57.5);
    const spaced = distributeIllustrationObjects(objects, 'x', 'spacing'); const bounds = spaced.map(objectWorldBounds); expect(bounds[1].x - (bounds[0].x + bounds[0].width)).toBeCloseTo(bounds[2].x - (bounds[1].x + bounds[1].width));
  });
});
