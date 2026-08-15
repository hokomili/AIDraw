import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  applyTransaction,
  bitmapFontCharacterError,
  bitmapTextCells,
  captureBitmapGlyph,
  createDefaultBitmapFont,
  createId,
  createPixelDocument,
  mapBitmapFontGlyphSheet,
  measureBitmapText,
  minimumBitmapFontLineHeight,
  nowIso,
  upsertBitmapFontGlyph,
} from '@aidraw/core';

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

  it('captures only selected nonzero indexed cells inside bounded glyph geometry', () => {
    const visited: string[] = [];
    const capture = captureBitmapGlyph([{ x: 4, y: 2 }, { x: 5, y: 3 }, { x: 6, y: 4 }], (x, y) => { visited.push(`${x},${y}`); return 7; });
    expect(capture).toEqual({
      glyph: { width: 3, advance: 4, rows: ['#..', '.#.', '..#'] },
      bounds: { x: 4, y: 2, width: 3, height: 3 },
      selectedCellCount: 3,
      inkCellCount: 3,
    });
    expect(visited).toEqual(['4,2', '5,3', '6,4']);

    const withIndexZeroSelection = captureBitmapGlyph([{ x: 0, y: 0 }, { x: 1, y: 0 }], (x) => x === 0 ? 3 : 0, 5);
    expect(withIndexZeroSelection.glyph).toEqual({ width: 2, advance: 5, rows: ['#.'] });
    expect(withIndexZeroSelection).toMatchObject({ selectedCellCount: 2, inkCellCount: 1 });
    expect(captureBitmapGlyph([{ x: 0, y: 0 }], () => 255).glyph.rows).toEqual(['#']);
  });

  it('fails closed on ambiguous, oversized, all-zero, or non-indexed glyph captures', () => {
    expect(() => captureBitmapGlyph([], () => 1)).toThrow(/Select at least one/);
    expect(() => captureBitmapGlyph([{ x: 0, y: 0 }, { x: 64, y: 0 }], () => 1)).toThrow(/64 × 64/);
    expect(() => captureBitmapGlyph(Array.from({ length: 4_097 }, (_, x) => ({ x, y: 0 })), () => 1)).toThrow(/4,096/);
    expect(() => captureBitmapGlyph([{ x: 0, y: 0 }], () => 0)).toThrow(/no nonzero palette indices/);
    expect(() => captureBitmapGlyph([{ x: 0, y: 0 }], () => Number.NaN)).toThrow(/palette indices/);
    expect(() => captureBitmapGlyph([{ x: 0, y: 0 }], () => 1, 0)).toThrow(/advance/);
  });

  it('immutably maps one Unicode character and reuses it in deterministic text layout', () => {
    const source = createDefaultBitmapFont();
    const mapped = upsertBitmapFontGlyph(source, '🦊', { width: 3, advance: 4, rows: ['#.#', '.#.', '###'] }, 8);
    expect(source.glyphs['🦊']).toBeUndefined();
    expect(mapped).not.toBe(source);
    expect(mapped.glyphs.A).toEqual(source.glyphs.A);
    expect(mapped.glyphs['🦊']).toEqual({ width: 3, advance: 4, rows: ['#.#', '.#.', '###'] });
    expect(measureBitmapText(mapped, '🦊')).toMatchObject({ width: 3, height: 8 });
    expect(bitmapTextCells(mapped, '🦊')).toEqual([
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
    ]);
    expect(bitmapFontCharacterError('')).toMatch(/exactly one/);
    expect(bitmapFontCharacterError('AB')).toMatch(/exactly one/);
    expect(bitmapFontCharacterError('\n')).toMatch(/exactly one/);
    expect(minimumBitmapFontLineHeight(source, { width: 1, advance: 1, rows: Array.from({ length: 9 }, () => '#') })).toBe(9);
    expect(() => upsertBitmapFontGlyph(source, '@', { width: 1, advance: 1, rows: ['#'] }, 6)).toThrow(/from 7 through 128/);
  });

  it('commits and exactly undoes a mapped document font through the canonical transaction', () => {
    const document = createPixelDocument('sprite', 'Glyph mapping');
    const original = document.bitmapFonts[0];
    const mapped = upsertBitmapFontGlyph(original, '@', { width: 2, advance: 3, rows: ['##', '.#'] });
    const applied = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Map bitmap font glyph', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.bitmap-fonts.replace', fonts: document.bitmapFonts.map((font) => font.id === mapped.id ? mapped : font) }],
    });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(applied.document.revision).toBe(document.revision + 1);
    expect(applied.document.activity.at(-1)).toMatchObject({ label: 'Map bitmap font glyph', operationCount: 1 });
    expect(bitmapTextCells(applied.document.bitmapFonts[0], '@')).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(restored.bitmapFonts).toEqual(document.bitmapFonts);
  });

  it('maps a uniform indexed glyph sheet in explicit row-major order without mutating its inputs', () => {
    const source = createDefaultBitmapFont();
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 3, y: 1 }]; const visited: string[] = [];
    const mapped = mapBitmapFontGlyphSheet(source, points, (x, y) => { visited.push(`${x},${y}`); return x < 2 && x === y ? 7 : 0; }, '🦊 ', 2);
    expect(mapped).toMatchObject({
      bounds: { x: 0, y: 0, width: 4, height: 2 },
      characterCount: 2, columns: 2, rows: 1, cellWidth: 2, cellHeight: 2,
      advance: 2, lineHeight: 8, selectedCellCount: 3, inkCellCount: 2,
      blankGlyphCount: 1, newGlyphCount: 1, replacedGlyphCount: 1,
    });
    expect(mapped.mappings).toEqual([
      { character: '🦊', glyph: { width: 2, advance: 2, rows: ['#.', '.#'] }, inkCellCount: 2, replaced: false },
      { character: ' ', glyph: { width: 2, advance: 2, rows: ['..', '..'] }, inkCellCount: 0, replaced: true },
    ]);
    expect(source.glyphs['🦊']).toBeUndefined();
    expect(source.glyphs[' ']).toEqual({ width: 3, advance: 4, rows: ['...', '...', '...', '...', '...', '...', '...'] });
    expect(visited).toEqual(['0,0', '1,1', '3,1']);
    expect(bitmapTextCells(mapped.font, '🦊 ')).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);

    const document = createPixelDocument('sprite', 'Glyph sheet mapping');
    const applied = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Map bitmap font glyph sheet', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.bitmap-fonts.replace', fonts: document.bitmapFonts.map((font) => font.id === mapped.font.id ? mapped.font : font) }],
    });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(applied.document.revision).toBe(document.revision + 1);
    expect(applied.document.activity.at(-1)).toMatchObject({ label: 'Map bitmap font glyph sheet', operationCount: 1 });
    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(restored.bitmapFonts).toEqual(document.bitmapFonts);
  });

  it('fails closed on ambiguous glyph-sheet order, geometry, resources, indices, or trailing ink', () => {
    const font = createDefaultBitmapFont(); const points = [{ x: 0, y: 0 }];
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, '', 1)).toThrow(/at least one character/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, 'AA', 1)).toThrow(/duplicates/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, 'A\n', 1)).toThrow(/without line breaks/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, 'AB', 3)).toThrow(/from 1 through 2/);
    expect(() => mapBitmapFontGlyphSheet(font, [{ x: 0, y: 0 }, { x: 2, y: 1 }], () => 1, 'AB', 2)).toThrow(/divide evenly/);
    expect(() => mapBitmapFontGlyphSheet(font, [{ x: 0, y: 0 }, { x: 64, y: 0 }], () => 1, 'A', 1)).toThrow(/1 × 1 through 64 × 64/);
    expect(() => mapBitmapFontGlyphSheet(font, [{ x: 0, y: 0 }, { x: 65_536, y: 0 }], () => 1, 'A', 1)).toThrow(/65,536 cells/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 0, 'A', 1)).toThrow(/no nonzero palette indices/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 256, 'A', 1)).toThrow(/indices from 0 through 255/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, 'A', 1, 0)).toThrow(/advance/);
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, 'A', 1, undefined, 6)).toThrow(/from 7 through 128/);
    const uniqueCharacters = Array.from({ length: 257 }, (_, index) => String.fromCodePoint(0x1000 + index)).join('');
    expect(() => mapBitmapFontGlyphSheet(font, points, () => 1, uniqueCharacters, 1)).toThrow(/limited to 256 characters/);
    const trailingGrid = Array.from({ length: 16 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4) }));
    expect(() => mapBitmapFontGlyphSheet(font, trailingGrid, (x, y) => x === 2 && y === 2 ? 1 : 0, 'ABC', 2)).toThrow(/Unused trailing/);
  });
});
