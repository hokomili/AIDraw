import { describe, expect, it } from 'vitest';
import { CanvasOperationSchema, bitmapTextCells, createDefaultBitmapFont, measureBitmapText } from '@aidraw/core';

describe('bitmap fonts', () => {
  it('lays out deterministic reusable glyphs with alignment, spacing, and scale', () => {
    const font = createDefaultBitmapFont(); const first = bitmapTextCells(font, 'AI\n2', { x: 20, y: 3, align: 'center', letterSpacing: 1, lineSpacing: 1, scale: 2 });
    expect(first).toEqual(bitmapTextCells(font, 'AI\n2', { x: 20, y: 3, align: 'center', letterSpacing: 1, lineSpacing: 1, scale: 2 }));
    expect(new Set(first.map((point) => `${point.x},${point.y}`)).size).toBe(first.length);
    expect(measureBitmapText(font, 'AI', { letterSpacing: 1, scale: 2 })).toMatchObject({ width: 24, height: 16 });
  });

  it('strictly validates document-owned bitmap font libraries', () => {
    const font = createDefaultBitmapFont();
    expect(Object.values(font.glyphs).every((glyph) => glyph.rows.every((row) => row.length === glyph.width))).toBe(true);
    expect(CanvasOperationSchema.parse({ kind: 'pixel.bitmap-fonts.replace', fonts: [font] })).toBeTruthy();
    expect(() => CanvasOperationSchema.parse({ kind: 'pixel.bitmap-fonts.replace', fonts: [{ ...font, glyphs: { A: { width: 5, advance: 6, rows: ['###'] } } }] })).toThrow();
  });
});
