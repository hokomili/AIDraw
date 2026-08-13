import { describe, expect, it } from 'vitest';
import { isometricTileRenderCells } from '../../src/common/tile-render-order';

describe('tile render order', () => {
  it('streams isometric sparse cells right-down independently of chunk insertion order', () => {
    const chunks = [
      { id: 'front-band', x: 0, y: 2, width: 2, height: 2, values: [5, 0, 6, 0] },
      { id: 'back-right', x: 2, y: 0, width: 2, height: 2, values: [3, 0, 4, 0] },
      { id: 'back-left', x: 0, y: 0, width: 2, height: 2, values: [1, 0, 2, 0] },
    ];
    const before = structuredClone(chunks);
    expect([...isometricTileRenderCells(chunks, (chunk) => chunk.values)]).toEqual([
      { x: 0, y: 0, raw: 1 }, { x: 2, y: 0, raw: 3 },
      { x: 0, y: 1, raw: 2 }, { x: 2, y: 1, raw: 4 },
      { x: 0, y: 2, raw: 5 }, { x: 0, y: 3, raw: 6 },
    ]);
    expect(chunks).toEqual(before);
  });

  it('skips a chunk when its decoded payload does not match its declared geometry', () => {
    const chunks = [{ x: 0, y: 0, width: 2, height: 2, values: [1, 2, 3] }];
    expect([...isometricTileRenderCells(chunks, (chunk) => chunk.values)]).toEqual([]);
  });
});
