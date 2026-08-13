import { describe, expect, it } from 'vitest';
import {
  createPixelCelReader,
  createPixelDocument,
  ellipsePixels,
  floodPixelRegion,
  pixelPerfectStrokePoints,
  replacePixelRegion,
  writePixels,
} from '@aidraw/core';

function sorted(points: Array<{ x: number; y: number }>) {
  return [...points].sort((left, right) => left.y - right.y || left.x - right.x);
}

describe('bounded pixel tool kernels', () => {
  it('decodes sparse cel chunks once through a reusable reader', () => {
    const document = createPixelDocument('sprite');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 1, y: 2, index: 7 }, { x: 34, y: 3, index: 8 }]);
    const read = createPixelCelReader(cel);
    expect([read(1, 2), read(34, 3), read(2, 2), read(-1, -1)]).toEqual([7, 8, 0, 0]);
  });

  it('returns an exact four-connected region as ordered row runs', () => {
    const rows = [
      [1, 1, 0, 1, 1],
      [1, 0, 0, 1, 1],
      [1, 1, 1, 1, 0],
      [0, 0, 0, 1, 0],
    ];
    expect(floodPixelRegion({ width: 5, height: 4, start: { x: 0, y: 0 }, read: (x, y) => rows[y][x] })).toEqual({
      ok: true,
      cellCount: 12,
      runs: [
        { x: 0, y: 0, length: 2 }, { x: 3, y: 0, length: 2 },
        { x: 0, y: 1, length: 1 }, { x: 3, y: 1, length: 2 },
        { x: 0, y: 2, length: 4 }, { x: 3, y: 3, length: 1 },
      ],
    });
  });

  it('matches a reference four-neighbor traversal across deterministic barrier fields', () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      let state = seed;
      const next = () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state; };
      const width = 9; const height = 7;
      const cells = Array.from({ length: width * height }, () => next() % 4 === 0 ? 0 : 1);
      const start = { x: next() % width, y: next() % height };
      const target = cells[start.y * width + start.x];
      const reference = new Set<string>(); const pending = [start];
      while (pending.length) {
        const point = pending.pop()!; const key = `${point.x},${point.y}`;
        if (reference.has(key) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height || cells[point.y * width + point.x] !== target) continue;
        reference.add(key); pending.push({ x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y }, { x: point.x, y: point.y - 1 }, { x: point.x, y: point.y + 1 });
      }
      const actual = floodPixelRegion({ width, height, start, read: (x, y) => cells[y * width + x] });
      if (!actual.ok) throw new Error('Small reference field unexpectedly exceeded pixel-tool limits.');
      const expanded = new Set(pixelRegionPointsForTest(actual.runs).map((point) => `${point.x},${point.y}`));
      expect([...expanded].sort(), `seed ${seed}`).toEqual([...reference].sort());
      expect(actual.cellCount).toBe(reference.size);
    }
  });

  it('allows a tiny connected island inside an 8,192-square sprite', () => {
    let reads = 0;
    const result = floodPixelRegion({
      width: 8_192,
      height: 8_192,
      start: { x: 4_096, y: 4_096 },
      read: (x, y) => { reads += 1; return x === 4_096 && y === 4_096 ? 9 : 0; },
    });
    expect(result).toEqual({ ok: true, cellCount: 1, runs: [{ x: 4_096, y: 4_096, length: 1 }] });
    expect(reads).toBeLessThanOrEqual(8);
  });

  it('fails atomically at changed-cell and row-run limits', () => {
    expect(floodPixelRegion({ width: 3, height: 3, start: { x: 0, y: 0 }, read: () => 1, maxCells: 4 })).toEqual({ ok: false, reason: 'cells', limit: 4 });
    const rows = [
      [1, 0, 0, 0, 1],
      [1, 1, 1, 1, 1],
      [1, 0, 0, 0, 1],
    ];
    expect(floodPixelRegion({ width: 5, height: 3, start: { x: 2, y: 1 }, read: (x, y) => rows[y][x], maxRuns: 2 })).toEqual({ ok: false, reason: 'runs', limit: 2 });
  });

  it('compacts replacement matches and rejects an oversized target before reading it', () => {
    const rows = [
      [2, 2, 1, 2],
      [1, 2, 2, 1],
    ];
    expect(replacePixelRegion({ width: 4, height: 2, matchIndex: 2, read: (x, y) => rows[y][x] })).toEqual({
      ok: true,
      cellCount: 5,
      runs: [{ x: 0, y: 0, length: 2 }, { x: 3, y: 0, length: 1 }, { x: 1, y: 1, length: 2 }],
    });
    let reads = 0;
    expect(replacePixelRegion({ width: 101, height: 100, matchIndex: 2, maxCells: 10_000, read: () => { reads += 1; return 2; } })).toEqual({ ok: false, reason: 'cells', limit: 10_000 });
    expect(reads).toBe(0);
  });

  it('cleans staircase corners while preserving later revisits', () => {
    expect(pixelPerfectStrokePoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
    const revisited = pixelPerfectStrokePoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 1 }]);
    expect(revisited.filter((point) => point.x === 0 && point.y === 0)).toHaveLength(2);
  });

  it('keeps exact symmetric ellipse, point, and line goldens', () => {
    expect(sorted(ellipsePixels(0, 0, 4, 2))).toEqual([
      { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
      { x: 0, y: 1 }, { x: 4, y: 1 },
      { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 },
    ]);
    const symmetric = new Set(ellipsePixels(0, 0, 5, 3).map((point) => `${point.x},${point.y}`));
    for (const key of symmetric) {
      const [x, y] = key.split(',').map(Number);
      expect(symmetric.has(`${5 - x},${y}`)).toBe(true);
      expect(symmetric.has(`${x},${3 - y}`)).toBe(true);
    }
    expect(ellipsePixels(3, 4, 3, 4)).toEqual([{ x: 3, y: 4 }]);
    expect(ellipsePixels(1, 2, 4, 2)).toEqual([{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }]);
    expect(ellipsePixels(2, 1, 2, 3)).toEqual([{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }]);
  });

  it('keeps small ellipse outlines symmetric and eight-connected', () => {
    for (let right = 1; right <= 12; right += 1) for (let bottom = 1; bottom <= 12; bottom += 1) {
      const outline = new Set(ellipsePixels(0, 0, right, bottom).map((point) => `${point.x},${point.y}`));
      for (const key of outline) {
        const [x, y] = key.split(',').map(Number);
        expect(outline.has(`${right - x},${y}`)).toBe(true);
        expect(outline.has(`${x},${bottom - y}`)).toBe(true);
      }
      const pending = [outline.values().next().value as string];
      const visited = new Set(pending);
      while (pending.length) {
        const [x, y] = pending.pop()!.split(',').map(Number);
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighbor = `${x + offsetX},${y + offsetY}`;
          if ((offsetX || offsetY) && outline.has(neighbor) && !visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
        }
      }
      expect(visited.size, `${right + 1}×${bottom + 1} ellipse disconnected`).toBe(outline.size);
    }
  });
});

function pixelRegionPointsForTest(runs: Array<{ x: number; y: number; length: number }>) {
  return runs.flatMap((run) => Array.from({ length: run.length }, (_, offset) => ({ x: run.x + offset, y: run.y })));
}
