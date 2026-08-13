import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  applyTransaction,
  capturePixelStamp,
  createId,
  createPixelDocument,
  nowIso,
  placePixelStamp,
  transformPixelStamp,
  validatePixelStamp,
} from '@aidraw/core';

describe('reusable pixel stamps', () => {
  it('captures an exact indexed irregular selection with a centered anchor', () => {
    const stamp = capturePixelStamp('bird', ' Bird ', [{ x: 10, y: 20 }, { x: 12, y: 20 }, { x: 11, y: 22 }], (x, y) => x + y === 30 ? 4 : 7);
    expect(stamp).toMatchObject({ id: 'bird', name: 'Bird', width: 3, height: 3, anchorX: 1, anchorY: 1 });
    expect(stamp.cells).toEqual([{ x: 0, y: 0, index: 4 }, { x: 2, y: 0, index: 7 }, { x: 1, y: 2, index: 7 }]);
  });

  it('flips and rotates cells and anchors without changing palette indices', () => {
    const source = { id: 'shape', name: 'Shape', width: 3, height: 2, anchorX: 0, anchorY: 1, cells: [{ x: 0, y: 0, index: 2 }, { x: 2, y: 1, index: 5 }] };
    expect(transformPixelStamp(source, 'flip-horizontal')).toMatchObject({ width: 3, height: 2, anchorX: 2, anchorY: 1, cells: [{ x: 2, y: 0, index: 2 }, { x: 0, y: 1, index: 5 }] });
    expect(transformPixelStamp(source, 'rotate-clockwise')).toMatchObject({ width: 2, height: 3, anchorX: 0, anchorY: 0, cells: [{ x: 1, y: 0, index: 2 }, { x: 0, y: 2, index: 5 }] });
    expect(transformPixelStamp(source, 'rotate-counterclockwise')).toMatchObject({ width: 2, height: 3, anchorX: 1, anchorY: 2, cells: [{ x: 0, y: 2, index: 2 }, { x: 1, y: 0, index: 5 }] });
  });

  it('places relative to the anchor and reports clipped cells', () => {
    const source = { id: 'shape', name: 'Shape', width: 3, height: 1, anchorX: 1, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }, { x: 1, y: 0, index: 3 }, { x: 2, y: 0, index: 4 }] };
    expect(placePixelStamp(source, 0, 2, { width: 3, height: 3 })).toEqual({ changes: [{ x: 0, y: 2, index: 3 }, { x: 1, y: 2, index: 4 }], dropped: 1 });
  });

  it('validates, persists, and exactly undoes a stamp library replacement', () => {
    const stamp = { id: 'dot', name: 'Dot', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 3 }] };
    expect(() => validatePixelStamp(stamp)).not.toThrow();
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.stamps.replace', stamps: [stamp] }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.stamps.replace', stamps: [{ ...stamp, cells: [...stamp.cells, stamp.cells[0]] }] }).success).toBe(false);
    const document = createPixelDocument('sprite');
    const applied = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Save stamp', createdAt: nowIso(), operations: [{ kind: 'pixel.stamps.replace', stamps: [stamp] }] });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document'); expect(applied.document.stamps).toEqual([stamp]);
    const restored = applyTransaction(applied.document, applied.inverse).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document'); expect(restored.stamps).toEqual([]);
  });
});
