import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, createIllustrationDocument, nowIso, type IllustrationLayer, type TextObject } from '@aidraw/core';
import { illustrationTransformMatrix } from '@common/psd-text';
import { exportDocument } from '@main/export-document';
import { importDocument } from '@main/import-document';

function flatten(layers: PsdLayer[] | undefined): PsdLayer[] {
  return (layers ?? []).flatMap((layer) => [layer, ...flatten(layer.children)]);
}

describe('PSD interchange', () => {
  it('round-trips layer groups, editable text metadata, and faithful raster fallbacks', async () => {
    const document = createIllustrationDocument('Layered poster'); document.artboard = { ...document.artboard, width: 180, height: 100, background: null };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer'); vector.name = 'Typography';
    const timestamp = nowIso(); const group: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'Artwork', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'group', childIds: [vector.id] };
    vector.parentId = group.id; document.layerIds = [group.id, ...document.layerIds.filter((id) => id !== vector.id)]; document.layers[group.id] = group;
    const text: TextObject = { id: createId('text'), revision: 0, name: 'Golden title', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, type: 'text', text: 'Golden rail', width: 140, height: 32, transform: { ...IDENTITY_TRANSFORM, x: 12, y: 18, scaleX: 1.25, scaleY: 0.8, rotation: 17, skewX: 8, skewY: -3 }, visible: true, locked: false, opacity: 1, blendMode: 'normal', align: 'center', lineHeight: 1.35, ranges: [{ start: 0, end: 6, fontFamily: 'ArialMT', fontSize: 22, fontWeight: 700, fontStyle: 'normal', color: '#c98e23', letterSpacing: 0.99 }, { start: 6, end: 11, fontFamily: 'ArialMT', fontSize: 22, fontWeight: 400, fontStyle: 'italic', color: '#3d2a10', letterSpacing: 0, underline: true }] };
    document.objects[text.id] = text; vector.objectIds.push(text.id);
    const emptyText: TextObject = { ...structuredClone(text), id: createId('text'), name: 'Empty placeholder', text: '', ranges: [] }; document.objects[emptyText.id] = emptyText; vector.objectIds.push(emptyText.id);

    const artifact = await exportDocument(document, 'psd'); const decoded = readPsd(artifact.data, { useImageData: true, logMissingFeatures: false }); const layers = flatten(decoded.children);
    expect(decoded.children?.some((layer) => layer.name === 'Artwork' && layer.children?.some((child) => child.name === 'Typography'))).toBe(true);
    const editable = layers.find((layer) => layer.text?.text === text.text); expect(editable?.hidden).toBe(true); expect(editable?.text?.styleRuns).toHaveLength(2); expect(editable?.text?.boxBounds).toEqual([0, 0, 140, 32]); expect(editable?.text?.style?.leading).toBeCloseTo(29.7, 8);
    expect(layers.filter((layer) => layer.text)).toHaveLength(1);
    expect(layers.some((layer) => layer.name === 'Typography · visual fallback' && layer.imageData)).toBe(true);
    expect(artifact.report.warnings).toContainEqual(expect.stringMatching(/hidden editable PSD text/));

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-psd-'));
    try {
      const path = join(directory, 'roundtrip.psd'); await writeFile(path, artifact.data); const imported = await importDocument(path, false); const reopened = imported.documents[0];
      if (reopened.kind !== 'illustration') throw new Error('Expected illustration');
      const importedGroup = Object.values(reopened.layers).find((layer) => layer.type === 'group' && layer.name === 'Artwork'); expect(importedGroup?.type).toBe('group');
      const importedText = Object.values(reopened.objects).find((object) => object.type === 'text' && object.text === text.text); expect(importedText).toMatchObject({ visible: true, align: 'center', width: 140, height: 32 });
      if (!importedText || importedText.type !== 'text') throw new Error('Expected imported editable text');
      expect(importedText.lineHeight).toBeCloseTo(1.35, 10);
      const expectedMatrix = illustrationTransformMatrix(text.transform); const importedMatrix = illustrationTransformMatrix(importedText.transform);
      for (let index = 0; index < 6; index += 1) expect(importedMatrix[index]).toBeCloseTo(expectedMatrix[index], 8);
      expect(reopened.layers[importedText.layerId]?.visible).toBe(false);
      expect(importedText.ranges).toMatchObject([{ start: 0, end: 6, fontSize: 22, fontWeight: 700, color: '#c98e23', letterSpacing: 0.99 }, { start: 6, end: 11, fontStyle: 'italic', color: '#3d2a10', underline: true }]);
      expect(Object.values(reopened.objects).some((object) => object.type === 'image' && object.visible && /raster fallback|visual fallback/.test(object.name))).toBe(true);
      expect(imported.warnings).toContainEqual(expect.stringMatching(/layer hierarchy/)); expect(imported.warnings).toContainEqual(expect.stringMatching(/hidden editable text/));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
