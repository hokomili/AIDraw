import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createIllustrationDocument, nowIso, type GroupObject, type ShapeObject } from '@aidraw/core';
import { materializePaintTiles } from '@main/persistence';
import { renderIllustration } from '@main/render-document';

describe('native illustration rendering', () => {
  it('renders persisted sparse paint tiles plus newly appended editable strokes without visual drift', async () => {
    const document = createIllustrationDocument('Sparse paint cache');
    document.artboard = { ...document.artboard, width: 520, height: 80, background: null };
    const paint = Object.values(document.layers).find((entry) => entry.type === 'paint');
    if (!paint || paint.type !== 'paint') throw new Error('Paint layer missing');
    paint.strokes.push({ id: 'cross-tile', actorId: HUMAN_ACTOR.id, points: [{ x: 8, y: 24, pressure: 0.5 }, { x: 512, y: 24, pressure: 0.5 }], color: '#d94a67', size: 12, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const uncached = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 520, 80).data;
    materializePaintTiles(document);
    expect(paint.tileCache?.strokeCount).toBe(1);
    expect(Object.keys(paint.tileAssetIds)).toHaveLength(3);
    const cached = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 520, 80).data;
    expect(Buffer.from(cached)).toEqual(Buffer.from(uncached));

    paint.strokes.push({ id: 'tail-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 260, y: 40, pressure: 0.5 }, { x: 260, y: 72, pressure: 0.5 }], color: '#3344cc', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const cachedWithTail = (await renderIllustration(document)).getContext('2d').getImageData(0, 0, 520, 80).data;
    const sourceOnly = structuredClone(document); const sourcePaint = Object.values(sourceOnly.layers).find((entry) => entry.type === 'paint'); if (!sourcePaint || sourcePaint.type !== 'paint') throw new Error('Paint layer missing'); sourcePaint.tileAssetIds = {}; delete sourcePaint.tileCache;
    const fullStrokeRender = (await renderIllustration(sourceOnly)).getContext('2d').getImageData(0, 0, 520, 80).data;
    expect(Buffer.from(cachedWithTail)).toEqual(Buffer.from(fullStrokeRender));
  });

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

  it('applies ordered adjustment stacks to non-image vector objects', async () => {
    const document = createIllustrationDocument('Vector adjustments'); document.artboard = { ...document.artboard, width: 40, height: 40, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape: ShapeObject = {
      id: 'adjusted-shape', revision: 0, name: 'Adjusted shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', filters: [{ type: 'brightness', value: -1 }, { type: 'contrast', value: 0.25 }], transform: { ...IDENTITY_TRANSFORM, x: 10, y: 10 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ffcc55' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[shape.id] = shape; if (layer.type === 'vector') layer.objectIds.push(shape.id);
    const data = (await renderIllustration(document)).getContext('2d').getImageData(20, 20, 1, 1).data;
    expect([...data.slice(0, 3)]).toEqual([0, 0, 0]); expect(data[3]).toBe(255);
  });

  it('isolates group opacity and filters before compositing overlapping children', async () => {
    const document = createIllustrationDocument('Isolated group'); document.artboard = { ...document.artboard, width: 50, height: 30, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; const timestamp = nowIso();
    const shape = (id: string, x: number): ShapeObject => ({
      id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x, y: 5 },
      type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#ff8844' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    });
    const first = shape('first', 5); const second = shape('second', 15);
    const group: GroupObject = { id: 'group', revision: 0, name: 'Filtered group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 0.5, blendMode: 'normal', filters: [{ type: 'brightness', value: -1 }], transform: IDENTITY_TRANSFORM, type: 'group', childIds: [first.id, second.id] };
    document.objects[first.id] = first; document.objects[second.id] = second; document.objects[group.id] = group; if (layer.type === 'vector') layer.objectIds.push(first.id, second.id, group.id);
    const context = (await renderIllustration(document)).getContext('2d'); const edge = context.getImageData(8, 10, 1, 1).data; const overlap = context.getImageData(18, 10, 1, 1).data;
    expect([...edge.slice(0, 3)]).toEqual([0, 0, 0]); expect([...overlap.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(overlap[3]).toBe(edge[3]); expect(edge[3]).toBeGreaterThanOrEqual(126); expect(edge[3]).toBeLessThanOrEqual(129);
  });

  it('applies a layer filter to its isolated composite', async () => {
    const document = createIllustrationDocument('Filtered layer'); document.artboard = { ...document.artboard, width: 30, height: 30, background: '' };
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!; layer.filters = [{ type: 'brightness', value: -1 }]; const timestamp = nowIso();
    const shape: ShapeObject = { id: 'layer-shape', revision: 0, name: 'Layer shape', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM, x: 5, y: 5 }, type: 'shape', shape: 'rectangle', width: 20, height: 20, fill: { kind: 'solid', color: '#55bbff' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    document.objects[shape.id] = shape; if (layer.type === 'vector') layer.objectIds.push(shape.id);
    expect([...(await renderIllustration(document)).getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)]).toEqual([0, 0, 0]);
  });
});
