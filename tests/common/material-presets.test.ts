import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  applyTransaction,
  createId,
  createIllustrationDocument,
  nowIso,
  type CanvasTransaction,
  type ShapeObject,
} from '@aidraw/core';
import { buildPolishedGoldMaterial } from '@common/material-presets';

describe('polished gold material preset', () => {
  it('builds an undoable editable reflection stack around one source shape', () => {
    const document = createIllustrationDocument('Gold test');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const timestamp = nowIso();
    const shape: ShapeObject = {
      id: createId('shape'), revision: 0, name: 'Wristband silhouette', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 120, y: 80 },
      type: 'shape', shape: 'rectangle', width: 420, height: 110, cornerRadius: 32,
      fill: { kind: 'solid', color: '#b08b50' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    const add: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add silhouette', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object: shape }] };
    const withShape = applyTransaction(document, add).document as typeof document;
    const material = buildPolishedGoldMaterial(withShape, withShape.objects[shape.id]);
    const applied = applyTransaction(withShape, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Apply gold', createdAt: timestamp, operations: material.operations }).document as typeof document;

    expect(applied.layers[material.groupLayerId].type).toBe('group');
    expect(applied.layers[material.materialLayerId].type).toBe('vector');
    expect(applied.objects[shape.id].layerId).toBe(material.materialLayerId);
    const base = applied.objects[shape.id]; if (base.type !== 'shape') throw new Error('Expected material base shape');
    expect(base.fill.kind).toBe('linear-gradient');
    expect(material.selectedObjectIds).toHaveLength(6);
    const overlays = material.selectedObjectIds.slice(1).map((id) => applied.objects[id]);
    expect(overlays.every((object) => object.maskObjectId === shape.id)).toBe(true);
    expect(overlays.some((object) => (object.blur ?? 0) >= 10)).toBe(true);
    expect(overlays.some((object) => object.blendMode === 'screen')).toBe(true);
  });

  it('rejects objects that cannot act as vector material silhouettes', () => {
    const document = createIllustrationDocument('Gold test');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    expect(() => buildPolishedGoldMaterial(document, {
      id: 'text', revision: 0, name: 'Text', createdAt: nowIso(), updatedAt: nowIso(), createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM,
      type: 'text', text: 'Gold', width: 100, height: 40, align: 'left', lineHeight: 1, ranges: [],
    })).toThrow('shape or path');
  });
});
