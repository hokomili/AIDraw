import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, nowIso, type ShapeObject } from '@aidraw/core';
import { renderIllustration } from '@main/render-document';

describe('native illustration rendering', () => {
  it('applies non-destructive blur to vector objects', async () => {
    const document = createIllustrationDocument('Vector blur'); document.artboard = { ...document.artboard, width: 80, height: 60, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape: ShapeObject = {
      id: 'blurred-shape', revision: 0, name: 'Blurred shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', blur: 6, transform: { ...IDENTITY_TRANSFORM, x: 30, y: 20 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ffcc55' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[shape.id] = shape; if (layer.type === 'vector') layer.objectIds.push(shape.id);
    const canvas = await renderIllustration(document); const context = canvas.getContext('2d');
    expect(context.getImageData(27, 30, 1, 1).data[3]).toBeGreaterThan(0);
    expect(context.getImageData(40, 30, 1, 1).data[3]).toBeGreaterThan(context.getImageData(27, 30, 1, 1).data[3]);
  });
});
