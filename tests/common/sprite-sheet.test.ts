import { describe, expect, it } from 'vitest';
import { calculateSpriteSheetLayout, spriteSheetPreviewDimensions, validateSpriteSheetSliceOptions, type SpriteSheetSliceOptions } from '../../src/common/sprite-sheet';

const defaults: SpriteSheetSliceOptions = { frameWidth: 16, frameHeight: 16, marginX: 1, marginY: 1, spacingX: 2, spacingY: 2, order: 'rows', durationMs: 100, trimTransparent: false, skipEmpty: false };

describe('sprite-sheet slicing', () => {
  it('bounds preview geometry deterministically without enlarging small sources', () => {
    expect(spriteSheetPreviewDimensions(320, 200)).toEqual({ width: 320, height: 200 });
    expect(spriteSheetPreviewDimensions(8_192, 4_096)).toEqual({ width: 640, height: 320 });
    expect(spriteSheetPreviewDimensions(4_096, 8_192)).toEqual({ width: 240, height: 480 });
    expect(spriteSheetPreviewDimensions(7, 8_192)).toEqual({ width: 1, height: 480 });
  });

  it('calculates row-major rectangles with symmetric margins and spacing', () => {
    const layout = calculateSpriteSheetLayout(56, 38, defaults);
    expect(layout).toMatchObject({ columns: 3, rows: 2, availableFrames: 6 });
    expect(layout.frames.map(({ x, y }) => [x, y])).toEqual([[1, 1], [19, 1], [37, 1], [1, 19], [19, 19], [37, 19]]);
  });

  it('supports column-major order and an explicit frame limit', () => {
    const layout = calculateSpriteSheetLayout(56, 38, { ...defaults, order: 'columns', frameCount: 4 });
    expect(layout.frames.map(({ row, column }) => [row, column])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it('rejects invalid bounds and layouts without complete frames', () => {
    expect(() => validateSpriteSheetSliceOptions({ ...defaults, durationMs: 0 })).toThrow('Frame duration');
    expect(() => calculateSpriteSheetLayout(10, 10, defaults)).toThrow('no complete frame');
    expect(() => calculateSpriteSheetLayout(56, 38, { ...defaults, order: 'diagonal' as 'rows' })).toThrow('rows or columns');
  });
});
