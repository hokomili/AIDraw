import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageData } from '@napi-rs/canvas';
import { readPsd, writePsdBuffer, type Layer as PsdLayer } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, createIllustrationDocument, createPixelDocument, nowIso, readPixel, writePixels, type IllustrationLayer, type PixelLayer, type ShapeObject, type TextObject } from '@aidraw/core';
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

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-pixel-psd-hierarchy-'));
    try {
      const path = join(directory, 'pixel-hierarchy.psd'); await writeFile(path, artifact.data); const imported = await importDocument(path, true); const reopened = imported.documents[0];
      if (reopened.kind !== 'pixel') throw new Error('Expected pixel document');
      expect(reopened.assetIds).toHaveLength(1); const reopenedSprite = reopened.pixelAssets[reopened.activeAssetId]; if (reopenedSprite?.type !== 'sprite') throw new Error('Expected imported sprite');
      expect(reopenedSprite.width).toBe(sprite.width); expect(reopenedSprite.height).toBe(sprite.height); expect(reopenedSprite.frameIds).toHaveLength(1);
      expect(reopenedSprite.layerIds.map((id) => reopenedSprite.layers[id]?.name)).toEqual([group.name, emptyGroup.name]);
      const reopenedGroup = Object.values(reopenedSprite.layers).find((entry) => entry.name === group.name); const reopenedEmpty = Object.values(reopenedSprite.layers).find((entry) => entry.name === emptyGroup.name); const reopenedLayer = Object.values(reopenedSprite.layers).find((entry) => entry.name === layer.name);
      expect(reopenedGroup).toMatchObject({ type: 'group', visible: true, locked: true, opacity: 0.8, blendMode: 'multiply' });
      expect(reopenedEmpty).toMatchObject({ type: 'group', visible: true, locked: false, opacity: 0.2, blendMode: 'difference', childIds: [] });
      expect(reopenedLayer).toMatchObject({ type: 'pixel', parentId: reopenedGroup?.id, visible: false, locked: true, blendMode: 'screen' }); expect(reopenedLayer?.opacity).toBeCloseTo(Math.round(0.25 * 255) / 255, 10);
      if (!reopenedLayer) throw new Error('Expected imported raster layer'); const reopenedCel = Object.values(reopenedSprite.cels).find((entry) => entry.layerId === reopenedLayer.id); if (!reopenedCel) throw new Error('Expected imported raster cel');
      expect(readPixel(reopenedCel, 0, 0)).toBe(2); expect(imported.warnings).toContainEqual(expect.stringMatching(/one current-frame sprite hierarchy/i));

      const reexported = await exportDocument(reopened, 'psd'); const redecoded = readPsd(reexported.data, { useImageData: true, logMissingFeatures: false }); const redecodedGroup = redecoded.children?.find((entry) => entry.name === group.name); const redecodedLayer = redecodedGroup?.children?.find((entry) => entry.name === layer.name);
      expect(redecoded.children?.map((entry) => entry.name)).toEqual([group.name, emptyGroup.name]); expect(redecodedGroup?.children?.map((entry) => entry.name)).toEqual([layer.name]);
      expect(redecodedLayer).toMatchObject({ hidden: true, blendMode: 'screen', transparencyProtected: true, protected: { transparency: false } }); expect(redecodedLayer?.imageData?.data[3]).toBe(255);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps decoded PSD raster offsets in one pixel sprite without flattening folder structure', async () => {
    const source = new ImageData(Uint8ClampedArray.from([108, 59, 120, 255, 255, 107, 122, 255]), 2, 1); const composite = new ImageData(new Uint8ClampedArray(4 * 3 * 4), 4, 3);
    const bytes = writePsdBuffer({ width: 4, height: 3, imageData: composite, children: [{ name: 'Offset folder', children: [{ name: 'Signed crop', left: -1, top: 2, right: 1, bottom: 3, imageData: source }, { name: 'Non-raster metadata' }] }, { name: 'Empty folder', children: [] }] });
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-pixel-psd-offset-'));
    try {
      const path = join(directory, 'signed-offset.psd'); await writeFile(path, bytes); const imported = await importDocument(path, true); const document = imported.documents[0];
      if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Expected imported sprite');
      expect(sprite.layerIds.map((id) => sprite.layers[id]?.name)).toEqual(['Offset folder', 'Empty folder']);
      const group = Object.values(sprite.layers).find((entry) => entry.name === 'Offset folder'); const empty = Object.values(sprite.layers).find((entry) => entry.name === 'Empty folder'); const layer = Object.values(sprite.layers).find((entry) => entry.name === 'Signed crop');
      expect(group).toMatchObject({ type: 'group', childIds: [layer?.id] }); expect(empty).toMatchObject({ type: 'group', childIds: [] }); expect(layer).toMatchObject({ type: 'pixel', parentId: group?.id });
      if (!layer) throw new Error('Expected offset layer'); const cel = Object.values(sprite.cels).find((entry) => entry.layerId === layer.id); if (!cel) throw new Error('Expected offset cel');
      expect(readPixel(cel, -1, 2)).toBe(2); expect(readPixel(cel, 0, 2)).toBe(4); expect(readPixel(cel, 1, 2)).toBe(0);
      expect(imported.warnings).toContain('1 PSD layer without decoded raster pixels was omitted from the pixel sprite.');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps an editable fallback layer when a PSD has folders but no decoded raster leaf', async () => {
    const bytes = writePsdBuffer({ width: 2, height: 2, imageData: new ImageData(new Uint8ClampedArray(16), 2, 2), children: [{ name: 'Empty only', children: [] }, { name: 'Metadata only' }] });
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-pixel-psd-fallback-'));
    try {
      const path = join(directory, 'no-raster-layers.psd'); await writeFile(path, bytes); const imported = await importDocument(path, true); const document = imported.documents[0];
      if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Expected imported sprite');
      expect(sprite.layerIds.map((id) => sprite.layers[id]?.name)).toEqual(['Empty only', 'Pixels']);
      expect(Object.values(sprite.layers).find((layer) => layer.name === 'Empty only')).toMatchObject({ type: 'group', childIds: [] });
      const fallback = Object.values(sprite.layers).find((layer) => layer.name === 'Pixels'); expect(fallback).toMatchObject({ type: 'pixel', visible: true, opacity: 1, blendMode: 'normal' });
      expect(Object.values(sprite.cels)).toEqual([expect.objectContaining({ layerId: fallback?.id, chunks: {} })]);
      expect(imported.warnings).toContain('1 PSD layer without decoded raster pixels was omitted from the pixel sprite.');
    } finally { await rm(directory, { recursive: true, force: true }); }
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
      const pixelImported = await importDocument(path, true); const pixelDocument = pixelImported.documents[0]; if (pixelDocument.kind !== 'pixel') throw new Error('Expected pixel document');
      const sprite = pixelDocument.pixelAssets[pixelDocument.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Expected pixel sprite');
      expect(Object.values(sprite.layers).find((layer) => layer.name === 'Transparency only')).toMatchObject({ type: 'pixel', locked: false });
      expect(pixelImported.warnings).toContainEqual(expect.stringMatching(/partial .* lock.*imported unlocked/i));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
