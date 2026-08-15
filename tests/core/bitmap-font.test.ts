import { describe, expect, it } from 'vitest';
import {
  CanvasOperationSchema,
  HUMAN_ACTOR,
  applyTransaction,
  bitmapFontCharacterError,
  bitmapFontCreationError,
  bitmapFontDeletionError,
  bitmapTextCells,
  captureBitmapGlyph,
  createDefaultBitmapFont,
  createEmptyBitmapFont,
  createId,
  createPixelDocument,
  deleteBitmapFont,
  deleteBitmapFontGlyph,
  editBitmapFontGlyph,
  mapBitmapFontGlyphSheet,
  measureBitmapText,
  minimumBitmapFontLineHeight,
  nowIso,
  orderedBitmapFontCharacters,
  renameBitmapFont,
  resizeBitmapGlyph,
  resolveBitmapFontCharacter,
  resolveBitmapFontId,
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

  it('plans explicitly named empty fonts and deterministic selection recovery without cloning bundled glyphs', () => {
    const source = [createDefaultBitmapFont()]; const before = structuredClone(source);
    const creation = createEmptyBitmapFont(source, { id: 'bitmap-font-empty', name: '  Dialogue  ', lineHeight: 12 });
    expect(creation.font).toEqual({ id: 'bitmap-font-empty', name: 'Dialogue', lineHeight: 12, glyphs: {} });
    expect(creation.font.glyphs).not.toEqual(source[0].glyphs);
    expect(creation.fonts).toEqual([source[0], creation.font]);
    expect(source).toEqual(before);
    expect(CanvasOperationSchema.parse({ kind: 'pixel.bitmap-fonts.replace', fonts: creation.fonts })).toBeTruthy();
    expect(bitmapTextCells(creation.font, 'AIDraw')).toEqual([]);
    expect(resolveBitmapFontId(creation.fonts, creation.font.id)).toBe(creation.font.id);
    expect(resolveBitmapFontId(creation.fonts, 'deleted-font')).toBe(source[0].id);

    const deletion = deleteBitmapFont(creation.fonts, source[0].id);
    expect(deletion).toEqual({ font: source[0], fonts: [creation.font], selectedFontId: creation.font.id });
    expect(creation.fonts).toEqual([source[0], creation.font]);
  });

  it('refuses invalid, full, stale, or last-font lifecycle requests before mutation', () => {
    const source = [createDefaultBitmapFont()];
    expect(bitmapFontCreationError(source, ' ', 8)).toMatch(/Enter a bitmap font name/);
    expect(bitmapFontCreationError(source, 'x'.repeat(201), 8)).toMatch(/200 characters/);
    expect(bitmapFontCreationError(source, 'Font', 0)).toMatch(/1 through 128/);
    expect(bitmapFontCreationError(source, 'Font', 129)).toMatch(/1 through 128/);
    expect(() => createEmptyBitmapFont(source, { id: '', name: 'Font', lineHeight: 8 })).toThrow(/needs an ID/);
    expect(() => createEmptyBitmapFont(source, { id: source[0].id, name: 'Font', lineHeight: 8 })).toThrow(/already in use/);
    const full = Array.from({ length: 64 }, (_, index) => ({ ...createDefaultBitmapFont(), id: `bitmap-font-${index}` }));
    expect(bitmapFontCreationError(full, 'Font 65', 8)).toMatch(/limited to 64 fonts/);
    expect(() => createEmptyBitmapFont(full, { id: 'bitmap-font-65', name: 'Font 65', lineHeight: 8 })).toThrow(/Delete one/);
    expect(bitmapFontDeletionError(source, 'missing')).toMatch(/no longer exists/);
    expect(bitmapFontDeletionError(source, source[0].id)).toMatch(/Keep at least one/);
    expect(() => deleteBitmapFont(source, source[0].id)).toThrow(/Create another font/);
    expect(source).toHaveLength(1);
  });

  it('creates and deletes font assets through one-operation inverses without changing raster document state', () => {
    const document = createPixelDocument('sprite', 'Font lifecycle');
    const visualState = { pixelAssets: structuredClone(document.pixelAssets), palette: structuredClone(document.palette), activeAssetId: document.activeAssetId };
    const creation = createEmptyBitmapFont(document.bitmapFonts, { id: 'bitmap-font-dialogue', name: 'Dialogue', lineHeight: 10 });
    const created = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Create bitmap font', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.bitmap-fonts.replace', fonts: creation.fonts }],
    });
    if (created.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(created.document.bitmapFonts).toEqual(creation.fonts);
    expect(created.document).toMatchObject(visualState);
    expect(created.document.activity.at(-1)).toMatchObject({ label: 'Create bitmap font', operationCount: 1 });
    const createRestored = applyTransaction(created.document, created.inverse, { recordActivity: false }).document;
    if (createRestored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(createRestored.bitmapFonts).toEqual(document.bitmapFonts);

    const deletion = deleteBitmapFont(created.document.bitmapFonts, creation.font.id);
    const deleted = applyTransaction(created.document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Delete bitmap font', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.bitmap-fonts.replace', fonts: deletion.fonts }],
    });
    if (deleted.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(deleted.document.bitmapFonts).toEqual(document.bitmapFonts);
    expect(deleted.document).toMatchObject(visualState);
    expect(deleted.document.revision).toBe(document.revision + 2);
    expect(deleted.document.activity.at(-1)).toMatchObject({ label: 'Delete bitmap font', operationCount: 1 });
    const deleteRestored = applyTransaction(deleted.document, deleted.inverse, { recordActivity: false }).document;
    if (deleteRestored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(deleteRestored.bitmapFonts).toEqual(creation.fonts);
    expect(deleteRestored).toMatchObject(visualState);
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

  it('renames and edits one observed font without changing its ID or untouched library content', () => {
    const first = createDefaultBitmapFont();
    const second = createEmptyBitmapFont([first], { id: 'bitmap-font-notes', name: 'Notes', lineHeight: 12 }).font;
    const source = [first, second]; const before = structuredClone(source);
    const renamed = renameBitmapFont(source, structuredClone(first), '  UI Symbols  ');
    expect(renamed.font).toMatchObject({ id: first.id, name: 'UI Symbols', lineHeight: first.lineHeight });
    expect(renamed.font.glyphs).toEqual(first.glyphs);
    expect(renamed.fonts[1]).toBe(second);
    expect(source).toEqual(before);

    const resized = resizeBitmapGlyph(renamed.font.glyphs.A, 7, 5);
    expect(resized.rows).toEqual(['.###...', '#...#..', '#...#..', '#####..', '#...#..']);
    const edited = editBitmapFontGlyph(renamed.fonts, structuredClone(renamed.font), 'A', { ...resized, advance: 8 }, 7);
    expect(edited.font).toMatchObject({ id: first.id, name: 'UI Symbols', lineHeight: 7 });
    expect(edited.font.glyphs.A).toEqual({ width: 7, advance: 8, rows: resized.rows });
    expect(edited.font.glyphs.B).toEqual(first.glyphs.B);
    expect(edited.fonts[1]).toBe(second);
    expect(renamed.font.glyphs.A).toEqual(first.glyphs.A);
  });

  it('fails stale edits closed and deterministically recovers after deleting the final mapping', () => {
    const font = createDefaultBitmapFont();
    const observed = structuredClone(font);
    const concurrentlyRenamed = { ...font, name: 'Changed elsewhere' };
    expect(() => renameBitmapFont([concurrentlyRenamed], observed, 'New name')).toThrow(/font changed/i);
    expect(() => editBitmapFontGlyph([concurrentlyRenamed], observed, 'A', observed.glyphs.A, observed.lineHeight)).toThrow(/font changed/i);
    expect(() => deleteBitmapFontGlyph([concurrentlyRenamed], observed, 'A')).toThrow(/font changed/i);
    expect(() => editBitmapFontGlyph([font], observed, '🦊', { width: 1, advance: 1, rows: ['#'] }, 8)).toThrow(/no longer exists/i);
    expect(() => deleteBitmapFontGlyph([font], observed, '🦊')).toThrow(/no longer exists/i);

    const single = upsertBitmapFontGlyph(createEmptyBitmapFont([font], { id: 'bitmap-font-one', name: 'One', lineHeight: 2 }).font, '🦊', { width: 1, advance: 2, rows: ['#'] }, 2);
    const deleted = deleteBitmapFontGlyph([font, single], structuredClone(single), '🦊');
    expect(deleted.font).toEqual({ ...single, glyphs: {} });
    expect(deleted.selectedCharacter).toBe('');
    expect(deleted.fonts[0]).toBe(font);
    expect(resolveBitmapFontCharacter(deleted.font, '🦊')).toBe('');
    expect(orderedBitmapFontCharacters(font).slice(0, 4)).toEqual([' ', '!', '+', ',']);
  });

  it('commits rename, glyph editing, and glyph deletion as exact whole-library inverses without raster changes', () => {
    const document = createPixelDocument('sprite', 'Font editing');
    const visualState = { pixelAssets: structuredClone(document.pixelAssets), palette: structuredClone(document.palette), activeAssetId: document.activeAssetId };
    const renamed = renameBitmapFont(document.bitmapFonts, structuredClone(document.bitmapFonts[0]), 'Interface');
    const edited = editBitmapFontGlyph(renamed.fonts, structuredClone(renamed.font), 'A', { width: 2, advance: 3, rows: ['#.', '##'] }, 8);
    const withoutQuestion = deleteBitmapFontGlyph(edited.fonts, structuredClone(edited.font), '?');
    const applied = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Edit bitmap font glyph', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 },
      operations: [{ kind: 'pixel.bitmap-fonts.replace', fonts: withoutQuestion.fonts }],
    });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(applied.document.bitmapFonts).toEqual(withoutQuestion.fonts);
    expect(applied.document.bitmapFonts[0].id).toBe(document.bitmapFonts[0].id);
    expect(applied.document.bitmapFonts[0].glyphs.A).toEqual({ width: 2, advance: 3, rows: ['#.', '##'] });
    expect(applied.document.bitmapFonts[0].glyphs['?']).toBeUndefined();
    expect(applied.document).toMatchObject(visualState);
    expect(applied.document.activity.at(-1)).toMatchObject({ label: 'Edit bitmap font glyph', operationCount: 1 });
    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(restored.bitmapFonts).toEqual(document.bitmapFonts);
    expect(restored).toMatchObject(visualState);
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
