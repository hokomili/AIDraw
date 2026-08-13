import { describe, expect, it } from 'vitest';
import { CanvasOperationSchema, HUMAN_ACTOR, applyTransaction, createId, createPixelDocument, createPixelSprite, cycledPaletteIndex, nowIso, readPixel, validatePaletteCycle, writePixels, type CanvasOperation } from '@aidraw/core';

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

  it('keeps every live pixel ingress and frame lifecycle aligned with the current palette', () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0]; const missingIndex = document.palette.length; const baseline = structuredClone(document);
    const replacement = structuredClone(sprite); writePixels(Object.values(replacement.cels)[0], [{ x: 1, y: 1, index: missingIndex }]);
    const misalignedOverride = structuredClone(sprite); misalignedOverride.paletteOverrides[sprite.frameIds[0]] = structuredClone(document.palette);
    [misalignedOverride.paletteOverrides[sprite.frameIds[0]][0].id, misalignedOverride.paletteOverrides[sprite.frameIds[0]][1].id] = [document.palette[1].id, document.palette[0].id];
    const added = createPixelSprite('Invalid added sprite', 8, 8); writePixels(Object.values(added.cels)[0], [{ x: 1, y: 1, index: missingIndex }]);
    const frame = { ...structuredClone(sprite.frames[sprite.frameIds[0]]), id: 'invalid-palette-frame', name: 'Invalid palette frame' };
    const frameCel = { ...structuredClone(cel), id: 'invalid-palette-cel', frameId: frame.id, chunks: {} }; writePixels(frameCel, [{ x: 1, y: 1, index: missingIndex }]);
    const operations: CanvasOperation[] = [
      { kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 1, y: 1, index: missingIndex }], expectedRevision: cel.revision },
      { kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: [{ x: 1, y: 1, length: 2, index: missingIndex }], expectedRevision: cel.revision },
      { kind: 'pixel.stamps.replace', stamps: [{ id: 'invalid-palette-stamp', name: 'Invalid palette stamp', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: missingIndex }] }] },
      { kind: 'pixel.frame.add', spriteId: sprite.id, frame, cels: [frameCel], expectedRevision: sprite.revision },
      { kind: 'pixel.asset.add', asset: added },
      { kind: 'pixel.asset.replace', asset: replacement, expectedRevision: sprite.revision },
      { kind: 'pixel.asset.replace', asset: misalignedOverride, expectedRevision: sprite.revision },
    ];
    for (const operation of operations) {
      expect(() => applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Reject invalid palette reference', createdAt: nowIso(), operations: [operation] })).toThrow(/palette (?:index|override)/);
      expect(document).toEqual(baseline);
    }
    const expanded = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Expand then use palette', createdAt: nowIso(),
      operations: [
        { kind: 'pixel.palette.replace', palette: [...document.palette, { id: 'new-palette-slot', name: 'New palette slot', color: '#123456ff' }] },
        { kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 1, y: 1, index: missingIndex }], expectedRevision: cel.revision },
      ],
    }).document;
    if (expanded.kind !== 'pixel') throw new Error('Expected pixel document');
    const expandedSprite = expanded.pixelAssets[expanded.activeAssetId]; if (expandedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(readPixel(Object.values(expandedSprite.cels)[0], 1, 1)).toBe(missingIndex);

    const deletionSource = structuredClone(document); const deletionSprite = deletionSource.pixelAssets[deletionSource.activeAssetId]; if (deletionSprite.type !== 'sprite') throw new Error('Expected sprite');
    const deletionFrame = { ...frame, id: 'palette-override-delete-frame', name: 'Palette override delete frame' };
    const deletionCel = { ...frameCel, id: 'palette-override-delete-cel', frameId: deletionFrame.id, chunks: {} };
    deletionSprite.frames[deletionFrame.id] = deletionFrame; deletionSprite.frameIds.push(deletionFrame.id); deletionSprite.cels[deletionCel.id] = deletionCel;
    deletionSprite.paletteOverrides[deletionFrame.id] = structuredClone(deletionSource.palette); deletionSprite.paletteOverrides[deletionFrame.id][1].color = '#abcdef';
    const deletion = applyTransaction(deletionSource, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: deletionSource.id, actor: HUMAN_ACTOR, label: 'Delete frame palette override', createdAt: nowIso(),
      operations: [{ kind: 'pixel.frame.delete', spriteId: deletionSprite.id, frameId: deletionFrame.id, expectedRevision: deletionSprite.revision }],
    });
    if (deletion.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const deletedSprite = deletion.document.pixelAssets[deletionSprite.id]; if (deletedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(deletedSprite.paletteOverrides[deletionFrame.id]).toBeUndefined();
    const restored = applyTransaction(deletion.document, deletion.inverse, { recordActivity: false }).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredSprite = restored.pixelAssets[deletionSprite.id]; if (restoredSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(restoredSprite.paletteOverrides[deletionFrame.id]).toEqual(deletionSprite.paletteOverrides[deletionFrame.id]);
  });
});
