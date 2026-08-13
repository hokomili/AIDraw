import { describe, expect, it } from 'vitest';
import { captureGridSelection, combineGridSelection, placeGridClipboard, rasterizeGridLasso, scaleGridSelection, transformGridSelection } from '../../src/common/grid-selection';

describe('generic grid selections', () => {
  it('preserves 32-bit tile GIDs across move and rotation', () => {
    const values = new Map([['1,1', 0x8000_0005], ['2,1', 0x4000_0006]]);
    const moved = transformGridSelection([{ x: 1, y: 1 }, { x: 2, y: 1 }], (x, y) => values.get(x + ',' + y) ?? 0, 'rotate-clockwise', { width: 8, height: 8 }, {}, 0);
    expect(moved.changes).toEqual(expect.arrayContaining([{ x: 1, y: 1, value: 0x8000_0005 }, { x: 1, y: 2, value: 0x4000_0006 }, { x: 2, y: 1, value: 0 }]));
    const counter = transformGridSelection([{ x: 1, y: 1 }, { x: 2, y: 1 }], (x, y) => values.get(x + ',' + y) ?? 0, 'rotate-counterclockwise', { width: 8, height: 8 }, {}, 0);
    expect(counter.changes).toEqual(expect.arrayContaining([{ x: 1, y: 1, value: 0x4000_0006 }, { x: 1, y: 2, value: 0x8000_0005 }, { x: 2, y: 1, value: 0 }]));
  });

  it('supports unbounded negative infinite-map destinations', () => {
    const moved = transformGridSelection([{ x: 0, y: 0 }], () => 9, 'move', undefined, { x: -12, y: -7 }, 0);
    expect(moved).toMatchObject({ selection: [{ x: -12, y: -7 }], dropped: 0 });
  });

  it('combines exact selections and rasterizes a freeform grid lasso', () => {
    const current = [{ x: 1, y: 1 }, { x: 2, y: 1 }]; const incoming = [{ x: 2, y: 1 }, { x: 3, y: 1 }];
    expect(combineGridSelection(current, incoming, 'add')).toHaveLength(3);
    expect(combineGridSelection(current, incoming, 'subtract')).toEqual([{ x: 1, y: 1 }]);
    expect(combineGridSelection(current, incoming, 'intersect')).toEqual([{ x: 2, y: 1 }]);
    const lasso = rasterizeGridLasso([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 3 }]);
    expect(lasso).toEqual(expect.arrayContaining([{ x: 2, y: 1 }, { x: 2, y: 2 }]));
    expect(lasso).not.toContainEqual({ x: 0, y: 3 });
  });

  it('captures irregular values, places them at an integer origin, and clips finite destinations', () => {
    const clipboard = captureGridSelection([{ x: 4, y: 5 }, { x: 6, y: 5 }], (x) => x + 10);
    expect(clipboard).toMatchObject({ originX: 4, originY: 5, width: 3, height: 1, cells: [{ x: 0, y: 0, value: 14 }, { x: 2, y: 0, value: 16 }] });
    const placed = placeGridClipboard(clipboard, { x: 2, y: 3 }, { width: 4, height: 4 });
    expect(placed).toMatchObject({ changes: [{ x: 2, y: 3, value: 14 }], selection: [{ x: 2, y: 3 }], dropped: 1 });
  });

  it('scales an irregular selection by independent integer factors without interpolating values', () => {
    const values = new Map([['1,1', 7], ['3,1', 9]]);
    const result = scaleGridSelection([{ x: 1, y: 1 }, { x: 3, y: 1 }], (x, y) => values.get(x + ',' + y) ?? 0, 2, 3, { width: 10, height: 10 }, 0);
    expect(result.selection).toHaveLength(12);
    expect(result.changes).toEqual(expect.arrayContaining([{ x: 1, y: 1, value: 7 }, { x: 2, y: 3, value: 7 }, { x: 5, y: 1, value: 9 }, { x: 6, y: 3, value: 9 }, { x: 3, y: 1, value: 0 }]));
  });
});
