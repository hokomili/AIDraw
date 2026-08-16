import {
  HUMAN_ACTOR,
  applyTransaction,
  createPixelDocument,
  duplicatePixelFrame,
  nowIso,
  pixelCelForFrame,
  readPixel,
  setPixelFrameCelsLinked,
  type CanvasTransaction,
  type PixelDocument,
  type PixelSprite,
} from '@aidraw/core';
import type { PixelSelectionFragment } from '@common/document-fragment';
import { planPixelSelectionPaste, planPixelSelectionPngPaste } from '@common/pixel-selection-clipboard';
import { describe, expect, it } from 'vitest';

function spriteTarget(document: PixelDocument) {
  const sprite = document.pixelAssets[document.activeAssetId] as PixelSprite;
  const frameId = sprite.frameIds[0];
  const cel = Object.values(sprite.cels).find((candidate) => candidate.frameId === frameId);
  if (!cel) throw new Error('Expected an editable cel');
  return { sprite, frameId, cel };
}

function selection(sourceDocumentId: string, palette: string[], cells: PixelSelectionFragment['grid']['cells'], width = 1, height = 1): PixelSelectionFragment {
  return {
    version: 1,
    kind: 'pixel-selection',
    sourceDocumentId,
    palette,
    grid: { version: 1, originX: 0, originY: 0, width, height, cells },
  };
}

describe('indexed pixel-selection clipboard planning', () => {
  it('appends missing colors and commits selection plus palette as one undoable human transaction', () => {
    const document = createPixelDocument('sprite', 'Destination');
    const { sprite, frameId, cel } = spriteTarget(document);
    const beforePalette = structuredClone(document.palette);
    const fragment = selection('other-document', ['#00000000', '#1234ab'], [
      { x: 0, y: 0, value: 1 },
      { x: 1, y: 0, value: 0 },
    ], 2, 1);
    const plan = planPixelSelectionPaste({
      document,
      spriteId: sprite.id,
      frameId,
      celId: cel.id,
      origin: { x: 3, y: 4 },
      createPaletteEntryId: () => 'pasted-color',
    }, fragment);

    expect(plan).toMatchObject({
      bounds: { x: 3, y: 4, width: 2, height: 1 },
      selection: [{ x: 3, y: 4 }, { x: 4, y: 4 }],
      dropped: 0,
      addedPaletteEntries: 1,
    });
    expect(plan.expectedDocumentRevision).toBeUndefined();
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['pixel.palette.replace', 'pixel.cel.set']);
    expect(plan.operations[1]).toMatchObject({
      kind: 'pixel.cel.set',
      expectedRevision: cel.revision,
      changes: [{ x: 3, y: 4, index: document.palette.length }, { x: 4, y: 4, index: 0 }],
    });

    const transaction: CanvasTransaction = {
      id: 'paste-transaction',
      clientOperationId: 'paste-selection',
      documentId: document.id,
      actor: HUMAN_ACTOR,
      label: 'Paste pixel selection',
      createdAt: nowIso(),
      operations: plan.operations,
      playback: { mode: 'instant', speed: 1 },
    };
    const committed = applyTransaction(document, transaction);
    if (committed.document.kind !== 'pixel') throw new Error('Expected a pixel document');
    const committedTarget = spriteTarget(committed.document);
    expect(committed.document.revision).toBe(document.revision + 1);
    expect(committed.document.activity.at(-1)).toMatchObject({ transactionId: transaction.id, actor: HUMAN_ACTOR, operationCount: 2 });
    expect(committed.document.palette.at(-1)).toEqual({ id: 'pasted-color', name: `Pasted ${document.palette.length}`, color: '#1234ab' });
    expect(readPixel(committedTarget.cel, 3, 4)).toBe(document.palette.length);

    const undone = applyTransaction(committed.document, committed.inverse, { recordActivity: false });
    if (undone.document.kind !== 'pixel') throw new Error('Expected a pixel document');
    expect(undone.document.palette).toEqual(beforePalette);
    expect(readPixel(spriteTarget(undone.document).cel, 3, 4)).toBe(0);
  });

  it('uses the effective frame palette and preserves an exact same-document duplicate index', () => {
    const overridden = createPixelDocument('sprite', 'Frame palette target');
    const overrideTarget = spriteTarget(overridden);
    overrideTarget.sprite.paletteOverrides[overrideTarget.frameId] = structuredClone(overridden.palette);
    overrideTarget.sprite.paletteOverrides[overrideTarget.frameId][1].color = '#1234ab';
    const overridePlan = planPixelSelectionPaste({
      document: overridden,
      spriteId: overrideTarget.sprite.id,
      frameId: overrideTarget.frameId,
      celId: overrideTarget.cel.id,
      origin: { x: 1, y: 1 },
    }, selection('other-document', ['#00000000', '#1234ab'], [{ x: 0, y: 0, value: 1 }]));
    expect(overridePlan.addedPaletteEntries).toBe(0);
    expect(overridePlan.operations).toEqual([
      expect.objectContaining({ kind: 'pixel.cel.set', changes: [{ x: 1, y: 1, index: 1 }] }),
    ]);

    const duplicate = createPixelDocument('sprite', 'Duplicate palette target');
    const duplicateTarget = spriteTarget(duplicate);
    duplicate.palette[2].color = duplicate.palette[1].color;
    const duplicatePlan = planPixelSelectionPaste({
      document: duplicate,
      spriteId: duplicateTarget.sprite.id,
      frameId: duplicateTarget.frameId,
      celId: duplicateTarget.cel.id,
      origin: { x: 2, y: 2 },
    }, selection(duplicate.id, duplicate.palette.map((entry) => entry.color), [{ x: 0, y: 0, value: 2 }]));
    expect(duplicatePlan.operations).toEqual([
      expect.objectContaining({ kind: 'pixel.cel.set', changes: [{ x: 2, y: 2, index: 2 }] }),
    ]);
  });

  it('admits the resolved writable source cel for an active linked-frame exposure', () => {
    const document = createPixelDocument('sprite', 'Linked exposure target');
    const first = spriteTarget(document);
    const duplicate = duplicatePixelFrame(first.sprite, first.frameId, {
      actorId: HUMAN_ACTOR.id,
      timestamp: nowIso(),
      createId: (prefix) => `${prefix}-linked`,
    });
    first.sprite.frameIds.push(duplicate.frame.id);
    first.sprite.frames[duplicate.frame.id] = duplicate.frame;
    for (const cel of duplicate.cels) first.sprite.cels[cel.id] = cel;
    const linked = setPixelFrameCelsLinked(first.sprite, duplicate.frame.id, true);
    document.pixelAssets[linked.id] = linked;
    const resolved = pixelCelForFrame(linked, first.cel.layerId, duplicate.frame.id);
    expect(resolved?.id).toBe(first.cel.id);
    const rawLinked = Object.values(linked.cels).find((cel) => cel.frameId === duplicate.frame.id)!;
    expect(() => planPixelSelectionPaste({
      document,
      spriteId: linked.id,
      frameId: duplicate.frame.id,
      celId: rawLinked.id,
      origin: { x: 5, y: 6 },
    }, selection(document.id, document.palette.map((entry) => entry.color), [{ x: 0, y: 0, value: 1 }]))).toThrow(/writable exposure/);

    const plan = planPixelSelectionPaste({
      document,
      spriteId: linked.id,
      frameId: duplicate.frame.id,
      celId: resolved!.id,
      origin: { x: 5, y: 6 },
    }, selection(document.id, document.palette.map((entry) => entry.color), [{ x: 0, y: 0, value: 1 }]));
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'pixel.cel.set', celId: first.cel.id, changes: [{ x: 5, y: 6, index: 1 }] }),
    ]);

    const pngPlan = planPixelSelectionPngPaste({
      document,
      spriteId: linked.id,
      frameId: duplicate.frame.id,
      celId: resolved!.id,
      origin: { x: 7, y: 8 },
    }, {
      width: 2,
      height: 1,
      changes: [{ x: 0, y: 0, index: 1 }, { x: 1, y: 0, index: 0 }],
    });
    expect(pngPlan).toMatchObject({
      expectedDocumentRevision: document.revision,
      selection: [{ x: 7, y: 8 }, { x: 8, y: 8 }],
      operations: [expect.objectContaining({
        kind: 'pixel.cel.set',
        celId: first.cel.id,
        changes: [{ x: 7, y: 8, index: 1 }, { x: 8, y: 8, index: 0 }],
      })],
    });
  });

  it('requires a complete bounded standard-PNG cell rectangle before returning one no-palette operation', () => {
    const document = createPixelDocument('sprite', 'PNG planner bounds');
    const { sprite, frameId, cel } = spriteTarget(document);
    const target = { document, spriteId: sprite.id, frameId, celId: cel.id, origin: { x: 0, y: 0 } };
    expect(() => planPixelSelectionPngPaste(target, {
      width: 2,
      height: 1,
      changes: [{ x: 0, y: 0, index: 1 }],
    })).toThrow(/every visible and transparent cell/);
    expect(() => planPixelSelectionPngPaste(target, {
      width: 2,
      height: 1,
      changes: [{ x: 0, y: 0, index: 1 }, { x: 0, y: 0, index: 1 }],
    })).toThrow(/duplicate/);
    expect(() => planPixelSelectionPngPaste(target, {
      width: 1_001,
      height: 1_000,
      changes: [],
    })).toThrow(/one million cells/);
    sprite.layers[cel.layerId].locked = true;
    expect(() => planPixelSelectionPngPaste(target, {
      width: 1,
      height: 1,
      changes: [{ x: 0, y: 0, index: 1 }],
    })).toThrow(/visible, unlocked pixel layer/);
  });

  it('clips deterministically and refuses a missing color before returning operations when the palette is full', () => {
    const document = createPixelDocument('sprite', 'Bounded target');
    const { sprite, frameId, cel } = spriteTarget(document);
    const clipped = planPixelSelectionPaste({
      document,
      spriteId: sprite.id,
      frameId,
      celId: cel.id,
      origin: { x: sprite.width - 1, y: 0 },
    }, selection(document.id, document.palette.map((entry) => entry.color), [
      { x: 0, y: 0, value: 1 },
      { x: 1, y: 0, value: 1 },
    ], 2, 1));
    expect(clipped).toMatchObject({ dropped: 1, selection: [{ x: sprite.width - 1, y: 0 }], bounds: { x: sprite.width - 1, y: 0, width: 1, height: 1 } });

    document.palette = Array.from({ length: 256 }, (_, index) => index === 0
      ? structuredClone(document.palette[0])
      : { id: `full-${index}`, name: `Full ${index}`, color: `#${index.toString(16).padStart(6, '0')}` });
    const beforeFailure = JSON.stringify(document);
    expect(() => planPixelSelectionPaste({
      document,
      spriteId: sprite.id,
      frameId,
      celId: cel.id,
      origin: { x: 0, y: 0 },
    }, selection('other-document', ['#00000000', '#fedcba'], [{ x: 0, y: 0, value: 1 }]))).toThrow(/palette is full/);
    expect(JSON.stringify(document)).toBe(beforeFailure);
  });
});
