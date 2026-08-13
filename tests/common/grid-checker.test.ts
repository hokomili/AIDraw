import { describe, expect, it } from 'vitest';

import {
  GRID_CHECKER_SHADOW_BLUR,
  GRID_CHECKER_SHADOW_OFFSET_Y,
  drawBoundedGridChecker,
  planGridChecker,
  type GridCheckerDrawingContext,
} from '../../src/common/grid-checker';

class RecordingContext implements GridCheckerDrawingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  shadowColor = 'transparent';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  readonly events: Array<Record<string, unknown>> = [];

  save(): void { this.events.push({ kind: 'save' }); }
  restore(): void { this.events.push({ kind: 'restore' }); }
  beginPath(): void { this.events.push({ kind: 'begin' }); }
  clip(): void { this.events.push({ kind: 'clip' }); }
  fill(): void { this.events.push({ kind: 'fill', fillStyle: this.fillStyle, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur }); }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.events.push({ kind: 'fillRect', x, y, width, height, fillStyle: this.fillStyle, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, shadowOffsetY: this.shadowOffsetY });
  }
  rect(x: number, y: number, width: number, height: number): void { this.events.push({ kind: 'rect', x, y, width, height }); }
}

describe('bounded grid checker rendering', () => {
  it('keeps a huge zoomed surface proportional to the viewport and shadows only one bounded source rectangle', () => {
    const context = new RecordingContext();
    const result = drawBoundedGridChecker(context, 524_288, 524_288, 4, { x: 500_000, y: 500_000, width: 1_280, height: 720 });
    expect(result).toMatchObject({
      visible: { x: 500_000, y: 500_000, width: 1_280, height: 720 },
      shadowSource: { x: 499_936, y: 499_936, width: 1_408, height: 848 },
      columnStart: 125_000,
      columnEnd: 125_320,
      rowStart: 125_000,
      rowEnd: 125_180,
      darkCellCount: 28_800,
    });
    const shadowFills = context.events.filter((event) => event.kind === 'fillRect');
    expect(shadowFills).toEqual([expect.objectContaining({
      width: 1_408,
      height: 848,
      shadowBlur: GRID_CHECKER_SHADOW_BLUR,
      shadowOffsetY: GRID_CHECKER_SHADOW_OFFSET_Y,
    })]);
    expect(context.events.filter((event) => event.kind === 'fill')).toEqual([
      expect.objectContaining({ fillStyle: '#e5e0d9', shadowColor: 'transparent', shadowBlur: 0 }),
    ]);
  });

  it('anchors checker parity to the complete surface and clips partial edge cells', () => {
    const context = new RecordingContext();
    const result = drawBoundedGridChecker(context, 10, 10, 4, { x: 3, y: 3, width: 6, height: 6 });
    expect(result).toMatchObject({ columnStart: 0, columnEnd: 3, rowStart: 0, rowEnd: 3, darkCellCount: 5 });
    expect(context.events).toContainEqual({ kind: 'rect', x: 3, y: 3, width: 6, height: 6 });
    expect(context.events).toContainEqual({ kind: 'rect', x: 8, y: 8, width: 4, height: 4 });
  });

  it('can retain only a nearby offscreen shadow and rejects invalid geometry', () => {
    const nearby = new RecordingContext();
    expect(drawBoundedGridChecker(nearby, 100, 100, 8, { x: 120, y: 0, width: 20, height: 20 })).toMatchObject({
      visible: undefined,
      shadowSource: { x: 56, y: 0, width: 44, height: 84 },
      darkCellCount: 0,
    });
    expect(nearby.events.filter((event) => event.kind === 'fillRect')).toHaveLength(1);

    const far = new RecordingContext();
    expect(drawBoundedGridChecker(far, 100, 100, 8, { x: 200, y: 0, width: 20, height: 20 }).shadowSource).toBeUndefined();
    expect(far.events).toEqual([]);
    expect(() => planGridChecker(100, 100, 0, { x: 0, y: 0, width: 10, height: 10 })).toThrow(/cell size/);
    expect(() => planGridChecker(100, 100, 8, { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 10 })).toThrow(/finite coordinates/);
  });
});
