import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  TransactionConflictError,
  applyTransaction,
  createId,
  createIllustrationDocument,
  createPixelDocument,
  duplicatePixelFrame,
  findDocumentAssetReferences,
  nowIso,
  pixelCelForFrame,
  readPixel,
  setPixelFrameCelsLinked,
  writePixels,
  type CanvasTransaction,
  type DocumentAsset,
  type ImageObject,
  type RasterStroke,
  type ShapeObject,
} from '@aidraw/core';

function shapeTransaction(documentId: string, layerId: string, expectedRevision?: number): CanvasTransaction {
  const timestamp = nowIso();
  const object: ShapeObject = {
    id: createId('shape'), revision: 0, name: 'Coral rectangle', createdAt: timestamp, updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id, layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x: 10, y: 12 }, type: 'shape', shape: 'rectangle', width: 120, height: 80,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'solid', color: '#27213c' }, width: 2, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
  return {
    id: createId('tx'), clientOperationId: createId('op'), documentId, actor: HUMAN_ACTOR, label: 'Add rectangle', createdAt: timestamp,
    operations: expectedRevision === undefined
      ? [{ kind: 'illustration.object.add', object }]
      : [{ kind: 'illustration.object.replace', object: { ...object, revision: expectedRevision }, expectedRevision }],
  };
}

describe('transaction reducer', () => {
  it('replaces and exactly restores illustration artboard geometry', () => {
    const document = createIllustrationDocument(); const artboard = { width: 640, height: 360, background: null, colorSpace: 'srgb' as const, dpi: 144 };
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Resize artboard', createdAt: nowIso(), operations: [{ kind: 'illustration.artboard.replace', artboard, expectedRevision: 0 }] };
    const applied = applyTransaction(document, transaction); if (applied.document.kind !== 'illustration') throw new Error('Expected illustration'); expect(applied.document.artboard).toEqual(artboard);
    const restored = applyTransaction(applied.document, applied.inverse).document; if (restored.kind !== 'illustration') throw new Error('Expected illustration'); expect(restored.artboard).toEqual(document.artboard);
    expect(() => applyTransaction(document, { ...transaction, operations: [{ kind: 'illustration.artboard.replace', artboard, expectedRevision: 9 }] })).toThrow(TransactionConflictError);
  });

  it('translates an expanded artboard, editable content, guides, paint, and animation as one reversible operation', () => {
    const document = createIllustrationDocument('Outpaint'); document.artboard = { ...document.artboard, width: 20, height: 10 };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); const paint = Object.values(document.layers).find((layer) => layer.type === 'paint'); if (!vector || vector.type !== 'vector' || !paint || paint.type !== 'paint') throw new Error('Expected illustration layers');
    const timestamp = nowIso(); const base = (id: string, x: number, y: number): ShapeObject => ({ id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y }, type: 'shape', shape: 'rectangle', width: 2, height: 2, fill: { kind: 'solid', color: '#ffffff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } });
    const root = base('root', 2, 3); const child = base('child', 4, 5); const group = { id: 'group', revision: 0, name: 'Group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM, x: 1, y: 1 }, type: 'group' as const, childIds: [child.id] };
    document.objects = { [root.id]: root, [child.id]: child, [group.id]: group }; vector.objectIds.push(root.id, child.id, group.id); document.guides = [{ id: 'v', orientation: 'vertical', position: 2, color: '#ff0000', locked: false }, { id: 'h', orientation: 'horizontal', position: 3, color: '#00ff00', locked: false }];
    paint.strokes.push({ id: 'stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 1, y: 2, pressure: 0.5 }], color: '#000000', size: 2, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' }); paint.tileAssetIds = { '0,0': 'stale-cache' }; paint.tileCache = { version: 1, strokeCount: 1, strokesSha256: 'a'.repeat(64) };
    document.animation.keyframeIds = ['root-key', 'child-key']; document.animation.keyframes = { 'root-key': { id: 'root-key', revision: 0, name: 'Root', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, objectId: root.id, timeMs: 0, transform: { ...root.transform }, opacity: 1, visible: true, easing: 'linear' }, 'child-key': { id: 'child-key', revision: 0, name: 'Child', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, objectId: child.id, timeMs: 0, transform: { ...child.transform }, opacity: 1, visible: true, easing: 'linear' } };
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Expand for outpaint', createdAt: timestamp, operations: [{ kind: 'illustration.artboard.translate', artboard: { ...document.artboard, width: 27, height: 19 }, offsetX: 3, offsetY: 4, expectedRevision: 0 }] };
    const applied = applyTransaction(document, transaction); if (applied.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(applied.document.artboard).toMatchObject({ width: 27, height: 19 }); expect(applied.document.objects[root.id].transform).toMatchObject({ x: 5, y: 7 }); expect(applied.document.objects[group.id].transform).toMatchObject({ x: 4, y: 5 }); expect(applied.document.objects[child.id].transform).toMatchObject({ x: 4, y: 5 }); expect(paint.tileAssetIds).toEqual({ '0,0': 'stale-cache' });
    const shiftedPaint = applied.document.layers[paint.id]; if (shiftedPaint.type !== 'paint') throw new Error('Expected paint'); expect(shiftedPaint.strokes[0].points[0]).toMatchObject({ x: 4, y: 6 }); expect(shiftedPaint.tileAssetIds).toEqual({}); expect(shiftedPaint.tileCache).toBeUndefined(); expect(applied.document.guides.map((guide) => guide.position)).toEqual([5, 7]); expect(applied.document.animation.keyframes['root-key'].transform).toMatchObject({ x: 5, y: 7 }); expect(applied.document.animation.keyframes['child-key'].transform).toMatchObject({ x: 4, y: 5 });
    const restored = applyTransaction(applied.document, applied.inverse).document; if (restored.kind !== 'illustration') throw new Error('Expected illustration'); expect(restored.artboard).toEqual(document.artboard); expect(restored.objects[root.id].transform).toMatchObject({ x: 2, y: 3 }); expect(restored.objects[group.id].transform).toMatchObject({ x: 1, y: 1 }); const restoredPaint = restored.layers[paint.id]; if (restoredPaint.type !== 'paint') throw new Error('Expected paint'); expect(restoredPaint.strokes[0].points[0]).toMatchObject({ x: 1, y: 2 }); expect(restored.guides.map((guide) => guide.position)).toEqual([2, 3]);
  });

  it('applies compact pixel regions atomically, undoes them, and rejects off-canvas sprite writes', () => {
    const document = createPixelDocument('sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const cel = Object.values(sprite.cels)[0];
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Compact stripe', createdAt: nowIso(), operations: [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: [{ x: 2, y: 3, length: 12, index: 6 }], expectedRevision: cel.revision }] };
    const applied = applyTransaction(document, transaction); if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const appliedSprite = applied.document.pixelAssets[sprite.id]; if (appliedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(Array.from({ length: 12 }, (_, offset) => readPixel(appliedSprite.cels[cel.id], 2 + offset, 3))).toEqual(new Array(12).fill(6));
    const restored = applyTransaction(applied.document, applied.inverse).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredSprite = restored.pixelAssets[sprite.id]; if (restoredSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(Array.from({ length: 12 }, (_, offset) => readPixel(restoredSprite.cels[cel.id], 2 + offset, 3))).toEqual(new Array(12).fill(0));
    expect(() => applyTransaction(document, { ...transaction, id: createId('tx'), clientOperationId: createId('op'), operations: [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: [{ x: 60, y: 3, length: 8, index: 6 }] }] })).toThrow(/outside sprite/);
  });

  it('materializes linked dependents before frame deletion and exactly restores the link graph on undo', () => {
    const document = createPixelDocument('sprite'); const initial = document.pixelAssets[document.activeAssetId];
    if (initial.type !== 'sprite') throw new Error('Expected sprite');
    const firstFrameId = initial.frameIds[0]; const layerId = initial.layerIds[0]; const firstCel = pixelCelForFrame(initial, layerId, firstFrameId)!;
    writePixels(firstCel, [{ x: 4, y: 5, index: 6 }]);
    const duplicate = duplicatePixelFrame(initial, firstFrameId, { actorId: HUMAN_ACTOR.id, timestamp: nowIso(), createId: (prefix) => `${prefix}-two` });
    const withSecond = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add second frame', createdAt: nowIso(), operations: [{ kind: 'pixel.frame.add', spriteId: initial.id, ...duplicate, expectedRevision: initial.revision }] }).document;
    if (withSecond.kind !== 'pixel') throw new Error('Expected pixel document'); const secondSprite = withSecond.pixelAssets[initial.id]; if (secondSprite.type !== 'sprite') throw new Error('Expected sprite');
    const linkedAsset = setPixelFrameCelsLinked(secondSprite, duplicate.frame.id, true);
    const linkedDocument = applyTransaction(withSecond, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Link frame', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: linkedAsset, expectedRevision: secondSprite.revision }] }).document;
    if (linkedDocument.kind !== 'pixel') throw new Error('Expected pixel document'); const linkedSprite = linkedDocument.pixelAssets[initial.id]; if (linkedSprite.type !== 'sprite') throw new Error('Expected sprite');
    const removed = applyTransaction(linkedDocument, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Delete source frame', createdAt: nowIso(), operations: [{ kind: 'pixel.frame.delete', spriteId: linkedSprite.id, frameId: firstFrameId, expectedRevision: linkedSprite.revision }] });
    if (removed.document.kind !== 'pixel') throw new Error('Expected pixel document'); const remaining = removed.document.pixelAssets[initial.id]; if (remaining.type !== 'sprite') throw new Error('Expected sprite');
    const remainingCel = Object.values(remaining.cels)[0]; expect(remainingCel.linkedToCelId).toBeUndefined(); expect(readPixel(remainingCel, 4, 5)).toBe(6);
    const restored = applyTransaction(removed.document, removed.inverse).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document'); const restoredSprite = restored.pixelAssets[initial.id]; if (restoredSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(restoredSprite.frameIds).toEqual(linkedSprite.frameIds); expect(Object.values(restoredSprite.cels).find((cel) => cel.frameId === duplicate.frame.id)?.linkedToCelId).toBe(firstCel.id);
  });

  it('applies an atomic object addition and provides an exact inverse', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const transaction = shapeTransaction(document.id, vector.id);
    const applied = applyTransaction(document, transaction);
    if (applied.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(Object.keys(applied.document.objects)).toHaveLength(1);
    expect(applied.document.revision).toBe(1);
    expect(applied.document.activity[0].actor.id).toBe('human');

    const undone = applyTransaction(applied.document, applied.inverse);
    if (undone.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(Object.keys(undone.document.objects)).toHaveLength(0);
    expect(undone.document.revision).toBe(2);
  });

  it('validates mask ownership and blocks deletion or cross-layer movement while referenced', () => {
    const document = createIllustrationDocument(); const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso(); const base = (id: string, name: string): ShapeObject => ({ id, revision: 0, name, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ffffff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } });
    const mask = base('mask', 'Mask'); const content = base('content', 'Content'); document.objects = { [mask.id]: mask, [content.id]: content }; vector.objectIds.push(mask.id, content.id);
    const transaction = (label: string, operations: CanvasTransaction['operations']): CanvasTransaction => ({ id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label, createdAt: timestamp, operations });
    const masked = applyTransaction(document, transaction('Set mask', [{ kind: 'illustration.object.replace', object: { ...content, maskObjectId: mask.id }, expectedRevision: 0 }])).document; if (masked.kind !== 'illustration') throw new Error('Expected illustration');
    expect(() => applyTransaction(masked, transaction('Delete mask', [{ kind: 'illustration.object.delete', objectId: mask.id, expectedRevision: 0 }]))).toThrow(/Clear the object mask/);
    expect(() => applyTransaction(document, transaction('Self mask', [{ kind: 'illustration.object.replace', object: { ...content, maskObjectId: content.id }, expectedRevision: 0 }]))).toThrow(/path-capable object/);
    const target = { ...vector, id: 'target-layer', name: 'Target', objectIds: [] }; masked.layers[target.id] = target; masked.layerIds.push(target.id);
    expect(() => applyTransaction(masked, transaction('Move mask', [{ kind: 'illustration.object.move', objectId: mask.id, layerId: target.id, expectedRevision: 0 }]))).toThrow(/another layer/);
    const cleared = applyTransaction(masked, transaction('Clear mask', [{ kind: 'illustration.object.replace', object: { ...masked.objects[content.id], maskObjectId: undefined }, expectedRevision: 1 }])).document;
    expect(() => applyTransaction(cleared, transaction('Delete former mask', [{ kind: 'illustration.object.delete', objectId: mask.id, expectedRevision: 0 }]))).not.toThrow();
  });

  it('blocks deleting a vector layer used as a clipping mask', () => {
    const document = createIllustrationDocument(); const target = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'paint')!; const timestamp = nowIso();
    const mask = { id: 'layer-mask', revision: 0, name: 'Layer mask', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: false, locked: false, opacity: 1, blendMode: 'normal' as const, type: 'vector' as const, objectIds: [] };
    const withMask = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add mask', createdAt: timestamp, operations: [{ kind: 'illustration.layer.add', layer: mask }, { kind: 'illustration.layer.replace', layer: { ...target, maskLayerId: mask.id }, expectedRevision: target.revision }] }).document;
    expect(() => applyTransaction(withMask, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Delete mask', createdAt: timestamp, operations: [{ kind: 'illustration.layer.delete', layerId: mask.id, expectedRevision: 0 }] })).toThrow(/Clear the clipping mask/);
  });

  it('preserves a trusted paint prefix cache across appends and rejects replacement-supplied cache data', () => {
    const document = createIllustrationDocument('Paint cache reducer');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'paint');
    if (!layer || layer.type !== 'paint') throw new Error('Expected paint layer');
    const stroke = (id: string, color: string): RasterStroke => ({ id, actorId: HUMAN_ACTOR.id, points: [{ x: 1, y: 1, pressure: 0.5 }, { x: 5, y: 5, pressure: 0.5 }], color, size: 2, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    layer.strokes = [stroke('base', '#ff0000')];
    layer.tileAssetIds = { '0,0': 'trusted-tile' };
    layer.tileCache = { version: 1, strokeCount: 1, strokesSha256: 'a'.repeat(64) };
    const transaction = (label: string, operations: CanvasTransaction['operations']): CanvasTransaction => ({ id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label, createdAt: nowIso(), operations });

    const appended = applyTransaction(document, transaction('Append stroke', [{ kind: 'illustration.paint.stroke', layerId: layer.id, stroke: stroke('tail', '#0000ff'), expectedRevision: layer.revision }])).document;
    if (appended.kind !== 'illustration') throw new Error('Expected illustration'); const appendedLayer = appended.layers[layer.id]; if (appendedLayer.type !== 'paint') throw new Error('Expected paint layer');
    expect(appendedLayer.tileCache?.strokeCount).toBe(1); expect(appendedLayer.tileAssetIds).toEqual({ '0,0': 'trusted-tile' });

    const renamed = applyTransaction(appended, transaction('Rename paint', [{ kind: 'illustration.layer.replace', layer: { ...appendedLayer, name: 'Renamed', tileAssetIds: { '0,0': 'forged-tile' } }, expectedRevision: appendedLayer.revision }])).document;
    if (renamed.kind !== 'illustration') throw new Error('Expected illustration'); const renamedLayer = renamed.layers[layer.id]; if (renamedLayer.type !== 'paint') throw new Error('Expected paint layer');
    expect(renamedLayer.tileAssetIds).toEqual({ '0,0': 'trusted-tile' });

    const editedPrefix = { ...renamedLayer, strokes: [stroke('base', '#00ff00'), ...renamedLayer.strokes.slice(1)], tileAssetIds: { '0,0': 'forged-tile' }, tileCache: { version: 1 as const, strokeCount: 1, strokesSha256: 'b'.repeat(64) } };
    const invalidated = applyTransaction(renamed, transaction('Rewrite cached stroke', [{ kind: 'illustration.layer.replace', layer: editedPrefix, expectedRevision: renamedLayer.revision }])).document;
    if (invalidated.kind !== 'illustration') throw new Error('Expected illustration'); const invalidatedLayer = invalidated.layers[layer.id]; if (invalidatedLayer.type !== 'paint') throw new Error('Expected paint layer');
    expect(invalidatedLayer.tileAssetIds).toEqual({}); expect(invalidatedLayer.tileCache).toBeUndefined(); expect(invalidatedLayer.strokes[0].color).toBe('#00ff00');
  });

  it('rejects stale entity revisions without mutating the source', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const added = applyTransaction(document, shapeTransaction(document.id, vector.id)).document;
    if (added.kind !== 'illustration') throw new Error('Expected illustration');
    const object = Object.values(added.objects)[0];
    const stale: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: added.id, actor: HUMAN_ACTOR, label: 'Stale move', createdAt: nowIso(),
      operations: [{ kind: 'illustration.object.replace', object: { ...object, transform: { ...object.transform, x: 44 } }, expectedRevision: 99 }],
    };
    expect(() => applyTransaction(added, stale)).toThrow(TransactionConflictError);
    expect(Object.values(added.objects)[0].transform.x).toBe(10);
  });

  it('moves layers into groups and restores their prior order on undo', () => {
    const document = createIllustrationDocument(); const timestamp = nowIso(); const vectorId = document.layerIds.find((id) => document.layers[id].type === 'vector')!;
    const group = { id: createId('layer'), revision: 0, name: 'Folder', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, type: 'group' as const, childIds: [] };
    const added = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add group', createdAt: timestamp, operations: [{ kind: 'illustration.layer.add', layer: group }] }).document;
    const moved = applyTransaction(added, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Group layer', createdAt: timestamp, operations: [{ kind: 'illustration.layer.move', layerId: vectorId, parentId: group.id, expectedRevision: 0 }] });
    if (moved.document.kind !== 'illustration') throw new Error('Expected illustration');
    const movedGroup = moved.document.layers[group.id]; expect(moved.document.layerIds).not.toContain(vectorId); if (movedGroup.type !== 'group') throw new Error('Expected group'); expect(movedGroup.childIds).toContain(vectorId);
    const restored = applyTransaction(moved.document, moved.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.layerIds).toContain(vectorId); expect(restored.layers[vectorId].parentId).toBeUndefined();
  });

  it('reorders vector objects with a revision-checked, exactly undoable move', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const first = applyTransaction(document, shapeTransaction(document.id, vector.id)).document;
    const second = applyTransaction(first, shapeTransaction(document.id, vector.id)).document;
    if (second.kind !== 'illustration') throw new Error('Expected illustration');
    const layerBefore = second.layers[vector.id];
    if (layerBefore.type !== 'vector') throw new Error('Expected vector layer');
    const [firstId, secondId] = layerBefore.objectIds;

    const moved = applyTransaction(second, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: second.id, actor: HUMAN_ACTOR,
      label: 'Move object up', createdAt: nowIso(),
      operations: [{ kind: 'illustration.object.move', objectId: firstId, layerId: vector.id, index: 1, expectedRevision: second.objects[firstId].revision }],
    });
    if (moved.document.kind !== 'illustration') throw new Error('Expected illustration');
    const movedLayer = moved.document.layers[vector.id];
    if (movedLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(movedLayer.objectIds).toEqual([secondId, firstId]);
    expect(moved.document.objects[firstId].revision).toBe(1);

    const restored = applyTransaction(moved.document, moved.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    const restoredLayer = restored.layers[vector.id];
    if (restoredLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(restoredLayer.objectIds).toEqual([firstId, secondId]);
  });

  it('moves an object across vector layers and restores its source layer on undo', () => {
    const document = createIllustrationDocument();
    const source = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const timestamp = nowIso();
    const target = {
      id: createId('layer'), revision: 0, name: 'Foreground', createdAt: timestamp, updatedAt: timestamp,
      createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
      type: 'vector' as const, objectIds: [],
    };
    const withLayer = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Add vector layer', createdAt: timestamp, operations: [{ kind: 'illustration.layer.add', layer: target }],
    }).document;
    const withObject = applyTransaction(withLayer, shapeTransaction(document.id, source.id)).document;
    if (withObject.kind !== 'illustration') throw new Error('Expected illustration');
    const objectId = Object.keys(withObject.objects)[0];
    const moved = applyTransaction(withObject, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Move to foreground', createdAt: timestamp,
      operations: [{ kind: 'illustration.object.move', objectId, layerId: target.id, expectedRevision: withObject.objects[objectId].revision }],
    });
    if (moved.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(moved.document.objects[objectId].layerId).toBe(target.id);
    const targetLayer = moved.document.layers[target.id];
    if (targetLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(targetLayer.objectIds).toContain(objectId);

    const restored = applyTransaction(moved.document, moved.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.objects[objectId].layerId).toBe(source.id);
    const sourceLayer = restored.layers[source.id];
    if (sourceLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(sourceLayer.objectIds).toContain(objectId);
  });

  it('rejects referenced asset deletion and supports an explicit ordered cascade with an exact inverse', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    if (vector.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const asset: DocumentAsset = { id: 'asset-image', name: 'Referenced image', mimeType: 'image/png', byteLength: 0, sha256: '0'.repeat(64), source: 'embedded' };
    const object: ImageObject = {
      id: 'image-object', revision: 0, name: 'Image object', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM },
      type: 'image', assetId: asset.id, width: 1, height: 1, filters: [],
    };
    document.assets[asset.id] = asset;
    document.objects[object.id] = object;
    vector.objectIds.push(object.id);
    const deletion = (operations: CanvasTransaction['operations']): CanvasTransaction => ({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Delete embedded image', createdAt: timestamp, operations,
    });

    expect(() => applyTransaction(document, deletion([{ kind: 'asset.delete', assetId: asset.id }]))).toThrow(/still referenced by objects\.image-object\.assetId/);
    const removed = applyTransaction(document, deletion([
      { kind: 'illustration.object.delete', objectId: object.id, expectedRevision: 0 },
      { kind: 'asset.delete', assetId: asset.id },
    ]));
    if (removed.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(removed.document.assets[asset.id]).toBeUndefined();
    expect(removed.document.objects[object.id]).toBeUndefined();

    const restored = applyTransaction(removed.document, removed.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.assets[asset.id]).toEqual(asset);
    expect(restored.objects[object.id]).toEqual(object);
  });

  it('reports linked-preview and provenance references to embedded assets', () => {
    const document = createPixelDocument('project');
    const asset: DocumentAsset = { id: 'source-image', name: 'Source', mimeType: 'image/png', byteLength: 0, sha256: '0'.repeat(64), source: 'embedded' };
    document.assets[asset.id] = asset;
    document.linkedAssets.push({ id: 'link-1', name: 'Linked source', mode: 'linked', cachedPreviewAssetId: asset.id });
    document.provenance.push({
      id: 'provenance-1', assetId: asset.id, provider: 'external', modelOrWorkflow: 'manual', sourceAssetIds: [asset.id], maskAssetId: asset.id, createdAt: nowIso(),
    });
    expect(findDocumentAssetReferences(document, asset.id)).toEqual(expect.arrayContaining([
      'linkedAssets.link-1.cachedPreviewAssetId',
      'provenance.provenance-1.assetId',
      'provenance.provenance-1.sourceAssetIds.0',
      'provenance.provenance-1.maskAssetId',
    ]));
  });

  it('revision-checks whole-project link replacement and rebases its undo', () => {
    const document = createPixelDocument('project');
    const linkedAssets = [{ id: 'link-1', name: 'tiles.png', mode: 'embedded' as const, sha256: 'a'.repeat(64), cachedPreviewAssetId: 'cache-1' }];
    const transaction = (expectedRevision: number): CanvasTransaction => ({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Replace project links', createdAt: nowIso(), operations: [{ kind: 'pixel.links.replace', linkedAssets, expectedRevision }],
    });

    expect(() => applyTransaction(document, transaction(document.revision + 1))).toThrow(/changed before the project-link update/);
    const applied = applyTransaction(document, transaction(document.revision));
    if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(applied.document.linkedAssets).toEqual(linkedAssets);
    const restored = applyTransaction(applied.document, applied.inverse).document;
    if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(restored.linkedAssets).toEqual([]);
  });
});
