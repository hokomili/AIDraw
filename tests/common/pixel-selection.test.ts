import { describe, expect, it } from 'vitest';
import { pixelSelectionBounds, transformPixelSelection } from '../../src/common/pixel-selection';

const points = [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 3 }];
const values = new Map([['1,2', 1], ['2,2', 2], ['1,3', 3], ['2,3', 4]]);
const read = (x: number, y: number) => values.get(`${x},${y}`) ?? 0;

describe('pixel selection transforms', () => {
  it('deduplicates points and computes integer bounds', () => {
    expect(pixelSelectionBounds([...points, points[0]])).toEqual({ x: 1, y: 2, width: 2, height: 2 });
  });

  it('moves captured pixels, clears the source, and reports the new selection', () => {
    const result = transformPixelSelection(points, read, 'move', { width: 10, height: 10 }, { x: 3, y: -1 });
    expect(result.selection).toEqual([{ x: 4, y: 1 }, { x: 5, y: 1 }, { x: 4, y: 2 }, { x: 5, y: 2 }]);
    expect(result.changes.filter((change) => change.index === 0)).toHaveLength(4);
    expect(result.changes.find((change) => change.x === 5 && change.y === 2)?.index).toBe(4);
    expect(result.destinationBounds).toEqual({ x: 4, y: 1, width: 2, height: 2 });
  });

  it('flips horizontally and vertically without changing selection bounds', () => {
    const horizontal = transformPixelSelection(points, read, 'flip-horizontal', { width: 10, height: 10 });
    expect(horizontal.changes.find((change) => change.x === 1 && change.y === 2)?.index).toBe(2);
    expect(horizontal.changes.find((change) => change.x === 2 && change.y === 3)?.index).toBe(3);
    const vertical = transformPixelSelection(points, read, 'flip-vertical', { width: 10, height: 10 });
    expect(vertical.changes.find((change) => change.x === 1 && change.y === 2)?.index).toBe(3);
    expect(vertical.changes.find((change) => change.x === 2 && change.y === 3)?.index).toBe(2);
  });

  it('rotates a non-square selection 90 degrees around its top-left', () => {
    const row = [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }];
    const clockwise = transformPixelSelection(row, (x) => x, 'rotate-clockwise', { width: 10, height: 10 });
    expect(clockwise.selection).toEqual([{ x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }]);
    expect(clockwise.changes.find((change) => change.x === 1 && change.y === 4)?.index).toBe(3);
    const counter = transformPixelSelection(row, (x) => x, 'rotate-counterclockwise', { width: 10, height: 10 });
    expect(counter.changes.find((change) => change.x === 1 && change.y === 2)?.index).toBe(3);
  });

  it('clips destinations outside the sprite and counts dropped cells', () => {
    const result = transformPixelSelection(points, read, 'move', { width: 4, height: 4 }, { x: 2, y: 0 });
    expect(result.dropped).toBe(2);
    expect(result.selection).toEqual([{ x: 3, y: 2 }, { x: 3, y: 3 }]);
  });
});
