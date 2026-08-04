import { describe, expect, it } from 'vitest';
import { CanvasOperationSchema, HUMAN_ACTOR, applyTransaction, createId, createPixelDocument, cycledPaletteIndex, nowIso, validatePaletteCycle } from '@aidraw/core';

describe('indexed palette contracts', () => {
  it('cycles only the named range in forward or reverse order', () => {
    const forward = { id: 'water', name: 'Water', fromIndex: 2, toIndex: 4, direction: 'forward' as const, stepMs: 120 };
    expect([1, 2, 3, 4, 5].map((index) => cycledPaletteIndex(index, forward, 1))).toEqual([1, 3, 4, 2, 5]);
    expect(cycledPaletteIndex(2, { ...forward, direction: 'reverse' }, 1)).toBe(4);
    expect(() => validatePaletteCycle(forward, 5)).not.toThrow();
    expect(() => validatePaletteCycle({ ...forward, fromIndex: 0 }, 5)).toThrow(/non-transparent/);
  });

  it('validates, applies, and exactly undoes named cycle libraries', () => {
    const document = createPixelDocument('sprite');
    const cycle = { id: 'fire', name: 'Fire', fromIndex: 3, toIndex: 6, direction: 'reverse' as const, stepMs: 80 };
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.palette-cycles.replace', cycles: [cycle] }).success).toBe(true);
    const applied = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add cycle', createdAt: nowIso(), operations: [{ kind: 'pixel.palette-cycles.replace', cycles: [cycle] }] });
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document'); expect(applied.document.paletteCycles).toEqual([cycle]);
    const restored = applyTransaction(applied.document, applied.inverse).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document'); expect(restored.paletteCycles).toEqual([]);
  });

  it('keeps index zero transparent and prevents palette edits that invalidate cycle ranges', () => {
    const document = createPixelDocument('sprite');
    expect(CanvasOperationSchema.safeParse({ kind: 'pixel.palette.replace', palette: [{ id: 'bad', name: 'Bad', color: '#ffffff' }] }).success).toBe(false);
    const withCycle = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add cycle', createdAt: nowIso(), operations: [{ kind: 'pixel.palette-cycles.replace', cycles: [{ id: 'tail', name: 'Tail', fromIndex: 12, toIndex: 15, direction: 'forward', stepMs: 100 }] }] }).document;
    expect(() => applyTransaction(withCycle, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Shrink palette', createdAt: nowIso(), operations: [{ kind: 'pixel.palette.replace', palette: document.palette.slice(0, 8) }] })).toThrow(/cycle range/);
  });
});
