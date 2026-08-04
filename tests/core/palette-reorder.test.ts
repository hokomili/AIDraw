import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, applyTransaction, createId, createPixelDocument, nowIso, readPixel, replaceAndDeletePaletteIndexOperations, writePixels } from '@aidraw/core';

describe('indexed palette reorder', () => {
  it('atomically remaps pixels, stamps, and frame overrides and has an exact inverse', () => {
    const source = createPixelDocument('sprite', 'Palette reorder'); const sprite = source.pixelAssets[source.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    writePixels(cel, [{ x: 1, y: 2, index: 2 }, { x: 2, y: 2, index: 3 }]); source.stamps = [{ id: 'stamp', name: 'Colors', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }] }]; const frameId = sprite.frameIds[0]; sprite.paletteOverrides[frameId] = structuredClone(source.palette); sprite.paletteOverrides[frameId][2].color = '#123456';
    const ids = source.palette.map((entry) => entry.id); [ids[2], ids[3]] = [ids[3], ids[2]];
    const applied = applyTransaction(source, { id: createId('tx'), clientOperationId: 'palette-reorder', documentId: source.id, actor: HUMAN_ACTOR, label: 'Reorder', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.palette.reorder', entryIds: ids, expectedRevision: source.revision }] });
    const next = applied.document; if (next.kind !== 'pixel') throw new Error('Expected pixel document'); const nextSprite = next.pixelAssets[sprite.id]; if (nextSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(readPixel(Object.values(nextSprite.cels)[0], 1, 2)).toBe(3); expect(readPixel(Object.values(nextSprite.cels)[0], 2, 2)).toBe(2); expect(next.stamps[0].cells[0].index).toBe(3); expect(nextSprite.paletteOverrides[frameId][3].color).toBe('#123456');
    const restored = applyTransaction(next, applied.inverse, { recordActivity: false }).document;
    expect({ ...restored, revision: source.revision, updatedAt: source.updatedAt, dirty: source.dirty, activity: source.activity }).toEqual(source);
  });

  it('rejects moving transparent index zero or omitting an entry', () => {
    const source = createPixelDocument('sprite'); const ids = source.palette.map((entry) => entry.id); const transaction = (entryIds: string[]) => ({ id: createId('tx'), clientOperationId: createId('op'), documentId: source.id, actor: HUMAN_ACTOR, label: 'Bad reorder', createdAt: nowIso(), playback: { mode: 'instant' as const, speed: 1 }, operations: [{ kind: 'pixel.palette.reorder' as const, entryIds }] });
    expect(() => applyTransaction(source, transaction([ids[1], ids[0], ...ids.slice(2)]))).toThrow(/Transparent/);
    expect(() => applyTransaction(source, transaction(ids.slice(0, -1)))).toThrow(/every current/);
  });

  it('keeps palette overrides aligned on append and permits only unused, uncustomized tail removal', () => {
    const source = createPixelDocument('sprite'); const sprite = source.pixelAssets[source.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const frameId = sprite.frameIds[0]; sprite.paletteOverrides[frameId] = structuredClone(source.palette); const added = { id: 'new-color', name: 'New', color: '#123456' };
    const add = applyTransaction(source, { id: createId('tx'), clientOperationId: 'add-color', documentId: source.id, actor: HUMAN_ACTOR, label: 'Add', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.palette.replace', palette: [...source.palette, added] }] }); const next = add.document; if (next.kind !== 'pixel') throw new Error('Expected pixel'); const nextSprite = next.pixelAssets[sprite.id]; if (nextSprite.type !== 'sprite') throw new Error('Expected sprite'); expect(nextSprite.paletteOverrides[frameId].at(-1)).toEqual(added);
    const restored = applyTransaction(next, add.inverse, { recordActivity: false }).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel'); const restoredSprite = restored.pixelAssets[sprite.id]; if (restoredSprite.type !== 'sprite') throw new Error('Expected sprite'); expect(restoredSprite.paletteOverrides[frameId]).toEqual(source.palette);
    const used = structuredClone(next); if (used.kind !== 'pixel') throw new Error('Expected pixel'); const usedSprite = used.pixelAssets[sprite.id]; if (usedSprite.type !== 'sprite') throw new Error('Expected sprite'); writePixels(Object.values(usedSprite.cels)[0], [{ x: 0, y: 0, index: used.palette.length - 1 }]);
    expect(() => applyTransaction(used, { id: createId('tx'), clientOperationId: 'delete-used', documentId: used.id, actor: HUMAN_ACTOR, label: 'Delete', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.palette.replace', palette: used.palette.slice(0, -1) }] })).toThrow(/still used/);
  });

  it('replaces a used/customized index everywhere, deletes it, repairs cycles, and restores content on undo', () => {
    const source = createPixelDocument('sprite', 'Replace-delete'); const sprite = source.pixelAssets[source.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0]; const frameId = sprite.frameIds[0];
    writePixels(cel, [{ x: 1, y: 1, index: 2 }, { x: 2, y: 1, index: 3 }, { x: 3, y: 1, index: 4 }]);
    source.stamps = [{ id: 'source-stamp', name: 'Source', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, index: 2 }] }];
    sprite.paletteOverrides[frameId] = structuredClone(source.palette); sprite.paletteOverrides[frameId][2].color = '#123456'; sprite.paletteOverrides[frameId][3].color = '#abcdef';
    source.paletteCycles = [{ id: 'range', name: 'Range', fromIndex: 1, toIndex: 4, direction: 'forward', stepMs: 100 }];
    const applied = applyTransaction(source, { id: createId('tx'), clientOperationId: 'replace-delete', documentId: source.id, actor: HUMAN_ACTOR, label: 'Replace and delete', createdAt: nowIso(), operations: replaceAndDeletePaletteIndexOperations(source, 2, 3) });
    const next = applied.document; if (next.kind !== 'pixel') throw new Error('Expected pixel'); const nextSprite = next.pixelAssets[sprite.id]; if (nextSprite.type !== 'sprite') throw new Error('Expected sprite'); const nextCel = Object.values(nextSprite.cels)[0];
    expect(next.palette).toHaveLength(source.palette.length - 1); expect(next.palette.some((entry) => entry.id === source.palette[2].id)).toBe(false);
    expect([readPixel(nextCel, 1, 1), readPixel(nextCel, 2, 1), readPixel(nextCel, 3, 1)]).toEqual([2, 2, 3]);
    expect(next.stamps[0].cells[0].index).toBe(2); expect(nextSprite.paletteOverrides[frameId][2].color).toBe('#abcdef'); expect(next.paletteCycles[0]).toMatchObject({ fromIndex: 1, toIndex: 3 });
    const restored = applyTransaction(next, applied.inverse, { recordActivity: false }).document;
    const comparable = structuredClone(restored); if (comparable.kind !== 'pixel') throw new Error('Expected pixel'); const comparableSprite = comparable.pixelAssets[sprite.id]; if (comparableSprite.type !== 'sprite') throw new Error('Expected sprite'); comparableSprite.revision = sprite.revision; comparableSprite.updatedAt = sprite.updatedAt;
    expect({ ...comparable, revision: source.revision, updatedAt: source.updatedAt, dirty: source.dirty, activity: source.activity }).toEqual(source);
  });
});
