import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  applyTransaction,
  captureTileStamp,
  createId,
  createPixelDocument,
  encodeTiledGid,
  nowIso,
  placeTileStamp,
  transformTileStamp,
} from '@aidraw/core';

describe('reusable tile stamps', () => {
  it('captures exact unsigned 32-bit GIDs and a centered anchor', () => {
    const transformed = encodeTiledGid(17, { hFlip: true, diagonal: true });
    const stamp = captureTileStamp('terrain', ' Terrain ', [{ x: -2, y: 3 }, { x: 0, y: 4 }], (x, y) => x === -2 && y === 3 ? transformed : 9);
    expect(stamp).toMatchObject({ id: 'terrain', name: 'Terrain', width: 3, height: 2, anchorX: 1, anchorY: 1 });
    expect(stamp.cells).toEqual([{ x: 0, y: 0, gid: transformed }, { x: 2, y: 1, gid: 9 }]);
  });

  it('transforms cells and anchors without losing Tiled transform flags', () => {
    const transformed = encodeTiledGid(3, { vFlip: true });
    const stamp = { id: 'slope', name: 'Slope', width: 3, height: 2, anchorX: 0, anchorY: 1, cells: [{ x: 0, y: 0, gid: transformed }, { x: 2, y: 1, gid: 8 }] };
    expect(transformTileStamp(stamp, 'flip-horizontal')).toMatchObject({ width: 3, height: 2, anchorX: 2, anchorY: 1, cells: [{ x: 2, y: 0, gid: transformed }, { x: 0, y: 1, gid: 8 }] });
    expect(transformTileStamp(stamp, 'rotate-clockwise')).toMatchObject({ width: 2, height: 3, anchorX: 0, anchorY: 0, cells: [{ x: 1, y: 0, gid: transformed }, { x: 0, y: 2, gid: 8 }] });
  });

  it('clips finite maps and permits negative infinite-map destinations', () => {
    const stamp = { id: 'row', name: 'Row', width: 3, height: 1, anchorX: 1, anchorY: 0, cells: [{ x: 0, y: 0, gid: 2 }, { x: 1, y: 0, gid: 3 }, { x: 2, y: 0, gid: 4 }] };
    expect(placeTileStamp(stamp, 0, 2, { width: 3, height: 3 })).toEqual({ changes: [{ x: 0, y: 2, gid: 3 }, { x: 1, y: 2, gid: 4 }], dropped: 1 });
    expect(placeTileStamp(stamp, -10, -4)).toMatchObject({ changes: [{ x: -11, y: -4, gid: 2 }, { x: -10, y: -4, gid: 3 }, { x: -9, y: -4, gid: 4 }], dropped: 0 });
  });

  it('validates, persists, and exactly undoes a tile stamp library replacement', () => {
    const stamp = { id: 'flagged', name: 'Flagged', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: encodeTiledGid(2, { hFlip: true }) }] };
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.tile-stamps.replace', stamps: [stamp] }).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.tile-stamps.replace', stamps: [{ ...stamp, cells: [...stamp.cells, stamp.cells[0]] }] }).success).toBe(false);
    const document = createPixelDocument('tilemap');
    const applied = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Save tile stamp', createdAt: nowIso(), operations: [{ kind: 'pixel.tile-stamps.replace', stamps: [stamp] }] });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(applied.document.tileStamps).toEqual([stamp]);
    const restored = applyTransaction(applied.document, applied.inverse).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(restored.tileStamps).toEqual([]);
  });
});
