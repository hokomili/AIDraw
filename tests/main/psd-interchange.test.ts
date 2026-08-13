import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageData } from '@napi-rs/canvas';
import { readPsd, writePsdBuffer, type Layer as PsdLayer } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, createIllustrationDocument, createPixelDocument, nowIso, writePixels, type IllustrationLayer, type PixelLayer, type ShapeObject, type TextObject } from '@aidraw/core';
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
    const timestamp = nowIso(); const group: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'Artwork', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: true, opacity: 0.8, blendMode: 'multiply', type: 'group', childIds: [vector.id] };
    vector.locked = true; vector.opacity = 0.6; vector.blendMode = 'screen';
    const emptyGroup: IllustrationLayer = { ...structuredClone(group), id: createId('layer'), name: 'Empty staging group', locked: false, opacity: 0.2, blendMode: 'difference', childIds: [] };
    vector.parentId = group.id; document.layerIds = [group.id, emptyGroup.id, ...document.layerIds.filter((id) => id !== vector.id)]; document.layers[group.id] = group; document.layers[emptyGroup.id] = emptyGroup;
    const text: TextObject = { id: createId('text'), revision: 0, name: 'Golden title', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, type: 'text', text: 'Golden rail', width: 140, height: 32, transform: { ...IDENTITY_TRANSFORM, x: 12, y: 18, scaleX: 1.25, scaleY: 0.8, rotation: 17, skewX: 8, skewY: -3 }, visible: true, locked: true, opacity: 0.4, blendMode: 'overlay', align: 'center', lineHeight: 1.35, ranges: [{ start: 0, end: 6, fontFamily: 'ArialMT', fontSize: 22, fontWeight: 700, fontStyle: 'normal', color: '#c98e23', letterSpacing: 0.99 }, { start: 6, end: 11, fontFamily: 'ArialMT', fontSize: 22, fontWeight: 400, fontStyle: 'italic', color: '#3d2a10', letterSpacing: 0, underline: true }] };
    document.objects[text.id] = text; vector.objectIds.push(text.id);
    const emptyText: TextObject = { ...structuredClone(text), id: createId('text'), name: 'Empty placeholder', text: '', ranges: [] }; document.objects[emptyText.id] = emptyText; vector.objectIds.push(emptyText.id);

    const artifact = await exportDocument(document, 'psd'); const decoded = readPsd(artifact.data, { useImageData: true, logMissingFeatures: false }); const layers = flatten(decoded.children);
    const decodedGroup = decoded.children?.find((layer) => layer.name === 'Artwork'); const decodedTypography = decodedGroup?.children?.find((layer) => layer.name === 'Typography');
    expect(decodedGroup).toMatchObject({ opacity: 0.8, blendMode: 'multiply', transparencyProtected: true, protected: { transparency: false } }); expect(decodedTypography).toMatchObject({ opacity: 0.6, blendMode: 'screen', transparencyProtected: true, protected: { transparency: false } });
    expect(decoded.children?.find((layer) => layer.name === 'Empty staging group')).toMatchObject({ opacity: 0.2, blendMode: 'difference', children: [] });
    const editable = layers.find((layer) => layer.text?.text === text.text); expect(editable?.hidden).toBe(true); expect(editable?.text?.styleRuns).toHaveLength(2); expect(editable?.text?.boxBounds).toEqual([0, 0, 140, 32]); expect(editable?.text?.style?.leading).toBeCloseTo(29.7, 8);
    expect(editable).toMatchObject({ opacity: 0.4, blendMode: 'overlay', transparencyProtected: true, protected: { transparency: false } });
    expect(layers.filter((layer) => layer.text)).toHaveLength(1);
    expect(layers.some((layer) => layer.name === 'Typography · visual fallback' && layer.imageData)).toBe(true);
    expect(artifact.report.warnings).toContainEqual(expect.stringMatching(/hidden editable PSD text/));
    expect(artifact.report.fidelity).toContainEqual({ code: 'raster-fallback', subjectType: 'layer', subjectId: vector.id, subjectName: vector.name, detail: expect.stringMatching(/PSD raster fallback/) });

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-psd-'));
    try {
      const path = join(directory, 'roundtrip.psd'); await writeFile(path, artifact.data); const imported = await importDocument(path, false); const reopened = imported.documents[0];
      if (reopened.kind !== 'illustration') throw new Error('Expected illustration');
      const importedGroup = Object.values(reopened.layers).find((layer) => layer.type === 'group' && layer.name === 'Artwork'); expect(importedGroup).toMatchObject({ type: 'group', locked: true, opacity: 0.8, blendMode: 'multiply' });
      const importedTypography = Object.values(reopened.layers).find((layer) => layer.type === 'group' && layer.name === 'Typography'); expect(importedTypography).toMatchObject({ type: 'group', locked: true, opacity: 0.6, blendMode: 'screen' });
      const importedEmpty = Object.values(reopened.layers).find((layer) => layer.name === 'Empty staging group'); expect(importedEmpty).toMatchObject({ type: 'group', opacity: 0.2, blendMode: 'difference', childIds: [] });
      const importedText = Object.values(reopened.objects).find((object) => object.type === 'text' && object.text === text.text); expect(importedText).toMatchObject({ name: 'Golden title', visible: true, locked: true, opacity: 0.4, blendMode: 'overlay', align: 'center', width: 140, height: 32 });
      if (!importedText || importedText.type !== 'text') throw new Error('Expected imported editable text');
      expect(importedText.lineHeight).toBeCloseTo(1.35, 10);
      const expectedMatrix = illustrationTransformMatrix(text.transform); const importedMatrix = illustrationTransformMatrix(importedText.transform);
      for (let index = 0; index < 6; index += 1) expect(importedMatrix[index]).toBeCloseTo(expectedMatrix[index], 8);
      expect(reopened.layers[importedText.layerId]).toMatchObject({ visible: false, locked: false, opacity: 1, blendMode: 'normal' });
      expect(importedText.ranges).toMatchObject([{ start: 0, end: 6, fontSize: 22, fontWeight: 700, color: '#c98e23', letterSpacing: 0.99 }, { start: 6, end: 11, fontStyle: 'italic', color: '#3d2a10', underline: true }]);
      expect(Object.values(reopened.objects).some((object) => object.type === 'image' && object.visible && /raster fallback|visual fallback/.test(object.name))).toBe(true);
      expect(imported.warnings).toContainEqual(expect.stringMatching(/layer hierarchy/)); expect(imported.warnings).toContainEqual(expect.stringMatching(/hidden editable text/));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('renders hidden illustration fallback sources without cloning or baking layer composite state', async () => {
    const document = createIllustrationDocument('Hidden source'); document.artboard = { ...document.artboard, width: 4, height: 4, background: null };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector');
    if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer');
    vector.name = 'Hidden quarter layer'; vector.visible = false; vector.opacity = 0.25; vector.blendMode = 'multiply';
    const timestamp = nowIso(); const shape: ShapeObject = { id: createId('shape'), revision: 0, name: 'Source red', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, type: 'shape', shape: 'rectangle', width: 4, height: 4, transform: IDENTITY_TRANSFORM, visible: true, locked: false, opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#ff0000' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    document.objects[shape.id] = shape; vector.objectIds.push(shape.id); const before = structuredClone(document);

    const artifact = await exportDocument(document, 'psd'); const decoded = readPsd(artifact.data, { useImageData: true, logMissingFeatures: false }); const layer = decoded.children?.find((entry) => entry.name === vector.name);
    expect(layer).toMatchObject({ hidden: true, opacity: Math.round(0.25 * 255) / 255, blendMode: 'multiply' });
    const alphas = layer?.imageData ? [...layer.imageData.data].filter((_value, index) => index % 4 === 3) : [];
    expect(Math.max(...alphas)).toBe(255);
    expect(document).toEqual(before);
    expect(artifact.report.fidelity).toContainEqual({ code: 'raster-fallback', subjectType: 'layer', subjectId: vector.id, subjectName: vector.name, detail: expect.any(String) });
  });

  it('writes the pixel layer hierarchy with raw source pixels and separate composite metadata', async () => {
    const document = createPixelDocument('sprite', 'Opacity sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite?.type !== 'sprite') throw new Error('Expected sprite'); const layer = sprite.layers[sprite.layerIds[0]]; const cel = Object.values(sprite.cels).find((entry) => entry.layerId === layer.id);
    if (!cel) throw new Error('Expected pixel cel'); writePixels(cel, [{ x: 0, y: 0, index: 2 }]);
    const timestamp = nowIso(); const group: PixelLayer = { id: createId('layer'), revision: 0, name: 'Pixel folder', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type: 'group', visible: true, locked: true, opacity: 0.8, blendMode: 'multiply', childIds: [layer.id] };
    const emptyGroup: PixelLayer = { ...structuredClone(group), id: createId('layer'), name: 'Empty pixel folder', locked: false, opacity: 0.2, blendMode: 'difference', childIds: [] };
    layer.parentId = group.id; layer.name = 'Hidden ink'; layer.visible = false; layer.locked = true; layer.opacity = 0.25; layer.blendMode = 'screen';
    sprite.layers[group.id] = group; sprite.layers[emptyGroup.id] = emptyGroup; sprite.layerIds = [group.id, emptyGroup.id];
    const secondFrameId = createId('frame'); sprite.frameIds.push(secondFrameId); sprite.frames[secondFrameId] = { id: secondFrameId, revision: 0, name: 'Later frame', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 100 };
    const artifact = await exportDocument(document, 'psd'); const decoded = readPsd(artifact.data, { useImageData: true, logMissingFeatures: false });
    const decodedGroup = decoded.children?.find((entry) => entry.name === group.name); const decodedLayer = decodedGroup?.children?.find((entry) => entry.name === layer.name);
    expect(decoded.children?.map((entry) => entry.name)).toEqual([group.name, emptyGroup.name]); expect(decodedGroup?.children?.map((entry) => entry.name)).toEqual([layer.name]);
    expect(decodedGroup).toMatchObject({ blendMode: 'multiply', transparencyProtected: true, protected: { transparency: false } }); expect(decodedGroup?.opacity).toBeCloseTo(0.8, 10);
    expect(decodedLayer).toMatchObject({ hidden: true, blendMode: 'screen', transparencyProtected: true, protected: { transparency: false } }); expect(decodedLayer?.opacity).toBeCloseTo(Math.round(0.25 * 255) / 255, 10);
    expect(decodedLayer?.imageData?.data[3]).toBe(255);
    expect(decoded.children?.find((entry) => entry.name === emptyGroup.name)).toMatchObject({ children: [], blendMode: 'difference' });
    expect(artifact.report.warnings).toContainEqual(expect.stringMatching(/current frame.*layer\/group hierarchy/i));
    expect(artifact.report.fidelity).toEqual([{ code: 'animation-frames-omitted', subjectType: 'document', subjectId: document.id, subjectName: document.name, detail: '1 later animation frame is not included in the PSD.' }]);
  });

  it('reports partial PSD locks without widening them to AIDraw lock-all', async () => {
    const pixel = () => new ImageData(Uint8ClampedArray.from([20, 40, 60, 255]), 1, 1);
    const bytes = writePsdBuffer({ width: 1, height: 1, imageData: pixel(), children: [{ name: 'Transparency only', transparencyProtected: true, protected: { transparency: true }, imageData: pixel() }] });
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-psd-lock-'));
    try {
      const path = join(directory, 'partial-lock.psd'); await writeFile(path, bytes); const imported = await importDocument(path, false); const reopened = imported.documents[0];
      if (reopened.kind !== 'illustration') throw new Error('Expected illustration');
      expect(Object.values(reopened.layers).find((layer) => layer.name === 'Transparency only')).toMatchObject({ locked: false });
      expect(imported.warnings).toContainEqual(expect.stringMatching(/partial .* lock.*imported unlocked/i));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
