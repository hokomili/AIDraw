import { describe, expect, it } from 'vitest';
import { MAX_GRID_LASSO_VERTICES, appendGridLassoPoint, captureGridSelection, combineGridSelection, createGridLassoDraft, placeGridClipboard, rasterizeGridLasso, scaleGridSelection, transformGridSelection } from '../../src/common/grid-selection';
import { pointInPolygon } from '../../src/common/lasso';

function referenceLasso(path: Array<{ x: number; y: number }>): string[] {
  const boundary = new Set<string>();
  for (let index = 0; index < path.length; index += 1) {
    const from = path[index]; const to = path[(index + 1) % path.length];
    let x = from.x; let y = from.y; const dx = Math.abs(to.x - from.x); const dy = -Math.abs(to.y - from.y); const sx = from.x < to.x ? 1 : -1; const sy = from.y < to.y ? 1 : -1; let error = dx + dy;
    for (;;) { boundary.add(`${x},${y}`); if (x === to.x && y === to.y) break; const doubled = 2 * error; if (doubled >= dy) { error += dy; x += sx; } if (doubled <= dx) { error += dx; y += sy; } }
  }
  const minX = Math.min(...path.map((point) => point.x)); const maxX = Math.max(...path.map((point) => point.x));
  const minY = Math.min(...path.map((point) => point.y)); const maxY = Math.max(...path.map((point) => point.y));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) if (pointInPolygon({ x, y }, path)) boundary.add(`${x},${y}`);
  return [...boundary].sort();
}

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

  it('preserves exact straight lasso edges while bounding sampled path vertices', () => {
    let draft = createGridLassoDraft({ x: 0, y: 0 });
    for (let x = 1; x <= 10_000; x += 1) draft = appendGridLassoPoint(draft, { x, y: 0 })!;
    for (let y = 1; y <= 20; y += 1) draft = appendGridLassoPoint(draft, { x: 10_000, y })!;
    expect(draft.points).toEqual([{ x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 10_000, y: 20 }]);

    let turns = createGridLassoDraft({ x: 0, y: 0 });
    for (let index = 1; index < MAX_GRID_LASSO_VERTICES; index += 1) {
      turns = appendGridLassoPoint(turns, { x: index, y: index % 2 })!;
    }
    expect(turns.points).toHaveLength(MAX_GRID_LASSO_VERTICES);
    expect(appendGridLassoPoint(turns, { x: MAX_GRID_LASSO_VERTICES, y: 0 })).toBeUndefined();
    expect(() => createGridLassoDraft({ x: 0.5, y: 0 })).toThrow(/safe-integer/);
    expect(() => appendGridLassoPoint(createGridLassoDraft({ x: 0, y: 0 }), { x: Number.MAX_SAFE_INTEGER, y: 0 })).toThrow(/unsafe coordinate range/);
  });

  it('fails before raster work when a lasso exceeds its vertex or candidate-cell ceiling', () => {
    const tooManyVertices = Array.from({ length: MAX_GRID_LASSO_VERTICES + 1 }, (_, index) => ({ x: index, y: index % 2 }));
    expect(() => rasterizeGridLasso(tooManyVertices)).toThrow(/4,096 path vertices/);
    expect(() => rasterizeGridLasso([{ x: 0, y: 0 }, { x: 1_000, y: 0 }, { x: 1_000, y: 999 }, { x: 0, y: 999 }]))
      .toThrow(/one million candidate cells/);
    expect(() => rasterizeGridLasso([{ x: 0, y: 0 }, { x: 0, y: 999_999 }, { x: 0, y: 1 }, { x: 0, y: 999_998 }, { x: 0, y: 2 }, { x: 0, y: 999_997 }]))
      .toThrow(/four million boundary steps/);
    expect(() => rasterizeGridLasso([{ x: Number.MAX_SAFE_INTEGER + 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]))
      .toThrow(/safe-integer/);

    const broad = appendGridLassoPoint(createGridLassoDraft({ x: 0, y: 0 }), { x: 1_000, y: 0 })!;
    expect(() => appendGridLassoPoint(broad, { x: 1_000, y: 999 })).toThrow(/one million candidate cells/);
    let longBoundary = appendGridLassoPoint(createGridLassoDraft({ x: 0, y: 0 }), { x: 0, y: 999_999 })!;
    longBoundary = appendGridLassoPoint(longBoundary, { x: 0, y: 1 })!;
    longBoundary = appendGridLassoPoint(longBoundary, { x: 0, y: 999_998 })!;
    longBoundary = appendGridLassoPoint(longBoundary, { x: 0, y: 2 })!;
    expect(() => appendGridLassoPoint(longBoundary, { x: 0, y: 999_997 })).toThrow(/four million boundary steps/);
  });

  it('matches the prior exact even-odd point test across horizontal, vertical, concave, and crossing scanlines', () => {
    const polygons = [
      [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 3, y: 5 }],
      [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 8 }, { x: 1, y: 5 }, { x: 0, y: 8 }],
      [{ x: -4, y: -3 }, { x: 4, y: 4 }, { x: -4, y: 4 }, { x: 4, y: -3 }],
    ];
    for (const polygon of polygons) {
      expect(rasterizeGridLasso(polygon).map((point) => `${point.x},${point.y}`).sort()).toEqual(referenceLasso(polygon));
    }
    let state = 0x71a5_50f2;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let fixture = 0; fixture < 48; fixture += 1) {
      const polygon: Array<{ x: number; y: number }> = []; const used = new Set<string>();
      while (polygon.length < 3 + fixture % 6) {
        const point = { x: random() % 17 - 8, y: random() % 17 - 8 }; const key = `${point.x},${point.y}`;
        if (!used.has(key)) { used.add(key); polygon.push(point); }
      }
      expect(rasterizeGridLasso(polygon).map((point) => `${point.x},${point.y}`).sort(), `fixture ${fixture}`).toEqual(referenceLasso(polygon));
    }
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
