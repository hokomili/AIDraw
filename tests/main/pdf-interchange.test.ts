import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, nowIso, type ShapeObject } from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import { exportDocument } from '@main/export-document';
import { renderDocument } from '@main/render-document';
import { runImportUtilityRequest } from '@main/utility-import';

const fixturePath = fileURLToPath(new URL('../fixtures/pdf/libreoffice-clipped-transparency.pdf', import.meta.url));
const goldenPath = fileURLToPath(new URL('../fixtures/pdf/libreoffice-clipped-transparency-poppler.png', import.meta.url));
const invisibleTextSafetyWarning = 'Invisible imported PDF text remains searchable and selectable even when visible artwork covers it; do not treat covering artwork as redaction.';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function visualDifference(actual: Uint8ClampedArray, expected: Uint8ClampedArray) {
  if (actual.byteLength !== expected.byteLength) throw new Error('Visual comparison requires equal RGBA geometry.');
  let absoluteDelta = 0;
  let largeChannelDeltas = 0;
  for (let offset = 0; offset < actual.byteLength; offset += 1) {
    const delta = Math.abs(actual[offset] - expected[offset]);
    absoluteDelta += delta;
    if (delta > 32) largeChannelDeltas += 1;
  }
  return {
    meanAbsoluteChannelDelta: absoluteDelta / actual.byteLength,
    largeChannelDeltaRatio: largeChannelDeltas / actual.byteLength,
  };
}

function expectOpaqueBlackInterior(canvas: Canvas): void {
  const inset = 1;
  const rgba = canvas.getContext('2d').getImageData(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2).data;
  expect(rgba.every((channel, index) => index % 4 === 3 ? channel === 255 : channel === 0)).toBe(true);
}

async function extractedPdfText(bytes: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: Uint8Array.from(bytes) });
  try {
    const page = await loading.promise.then((source) => source.getPage(1));
    const text = await page.getTextContent();
    return text.items.flatMap((item) => 'str' in item && item.str ? [item.str] : []);
  } finally {
    await loading.destroy();
  }
}

describe('third-party PDF interchange', () => {
  it('preserves LibreOffice clipped transparency in the raster fallback', async () => {
    const [fixtureBytes, goldenBytes] = await Promise.all([readFile(fixturePath), readFile(goldenPath)]);
    expect(sha256(fixtureBytes)).toBe('829ec316be8eddc2e35b9e88e232c3debc8776e573082f7bfe8c147d1c475e19');
    expect(sha256(goldenBytes)).toBe('44a8335475cac323623d9d99723d8519c8007cc7725dcfaf1523209e9a65eaa0');
    expect(fixtureBytes.toString('latin1')).toContain('LibreOfficeDev 26.8.0.0.alpha0');

    const imported = await runImportUtilityRequest({ id: 'libreoffice-clipped-transparency', kind: 'import-document', filePath: fixturePath, pixelMode: false });
    expect(imported.documents).toHaveLength(1);
    expect(imported.warnings).toEqual([
      'PDF pages retain a faithful raster fallback. Extracted text is placed on a hidden editable layer and retained invisibly on PDF re-export when supported; unsupported operators and effects remain rasterized.',
    ]);
    const document = imported.documents[0];
    if (document.kind !== 'illustration') throw new Error('Expected a LibreOffice illustration import.');
    expect(document.artboard).toMatchObject({ width: 241, height: 151, background: null });

    const textLayer = Object.values(document.layers).find((layer) => layer.type === 'vector' && layer.name === 'Editable PDF text (hidden)');
    expect(textLayer).toMatchObject({ type: 'vector', interchangeRole: 'pdf-extracted-text', visible: false });
    if (!textLayer || textLayer.type !== 'vector') throw new Error('Expected the hidden editable PDF text layer.');
    const extractedText = textLayer.objectIds.flatMap((id) => {
      const object = document.objects[id];
      return object?.type === 'text' ? [object.text] : [];
    });
    expect(extractedText).toEqual([
      'LibreOffice PDF',
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const actualCanvas = await renderDocument(document);
    const expectedImage = await loadImage(goldenBytes);
    const expectedCanvas = createCanvas(expectedImage.width, expectedImage.height);
    expectedCanvas.getContext('2d').drawImage(expectedImage, 0, 0);
    expect({ width: actualCanvas.width, height: actualCanvas.height }).toEqual({ width: expectedCanvas.width, height: expectedCanvas.height });
    const actualRgba = actualCanvas.getContext('2d').getImageData(0, 0, actualCanvas.width, actualCanvas.height).data;
    const expectedRgba = expectedCanvas.getContext('2d').getImageData(0, 0, expectedCanvas.width, expectedCanvas.height).data;
    expect(actualRgba.every((channel, index) => index % 4 !== 3 || channel === 255)).toBe(true);
    const difference = visualDifference(actualRgba, expectedRgba);
    expect(difference.meanAbsoluteChannelDelta).toBeLessThan(8);
    expect(difference.largeChannelDeltaRatio).toBeLessThan(0.05);
  });

  it('re-exports imported text as invisible searchable content without changing the raster fallback', async () => {
    const goldenBytes = await readFile(goldenPath);
    const imported = await runImportUtilityRequest({ id: 'libreoffice-roundtrip-import', kind: 'import-document', filePath: fixturePath, pixelMode: false });
    const document = imported.documents[0];
    if (document.kind !== 'illustration') throw new Error('Expected a LibreOffice illustration import.');
    const importedTextLayer = Object.values(document.layers).find((layer) => layer.interchangeRole === 'pdf-extracted-text');
    if (!importedTextLayer) throw new Error('Expected importer-authored PDF text semantics.');
    const untagged = structuredClone(document);
    delete untagged.layers[importedTextLayer.id].interchangeRole;
    const untaggedExport = await exportDocument(untagged, 'pdf');
    expect(untaggedExport.report).toEqual({ warnings: [], rasterized: [] });
    expect(await extractedPdfText(untaggedExport.data)).toEqual([]);

    const unsupported = structuredClone(document);
    const unsupportedLayer = unsupported.layers[importedTextLayer.id];
    if (unsupportedLayer.type !== 'vector') throw new Error('Expected an imported PDF text layer.');
    const unsupportedObject = unsupported.objects[unsupportedLayer.objectIds[0]];
    if (unsupportedObject.type !== 'text') throw new Error('Expected imported PDF text.');
    unsupportedObject.text = '漢';
    unsupportedObject.ranges = [{ ...unsupportedObject.ranges[0], start: 0, end: 1 }];
    const unsupportedExport = await exportDocument(unsupported, 'pdf');
    expect(unsupportedExport.report).toMatchObject({
      warnings: [
        'Some imported PDF text could not remain searchable because it contains glyphs outside the built-in PDF font.',
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        invisibleTextSafetyWarning,
        '2 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });
    expect(unsupportedExport.report.fidelity?.map((entry) => entry.code)).toEqual([
      'searchable-text-omitted',
      'searchable-text-retained', 'font-substitution',
      'searchable-text-retained', 'font-substitution',
    ]);
    expect(unsupportedExport.report.fidelity?.[0]).toMatchObject({ subjectType: 'object', subjectId: unsupportedObject.id, subjectName: unsupportedObject.name });
    expect(await extractedPdfText(unsupportedExport.data)).toEqual([
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const transformed = structuredClone(document);
    const transformedLayer = transformed.layers[importedTextLayer.id];
    if (transformedLayer.type !== 'vector') throw new Error('Expected an imported PDF text layer.');
    transformed.objects[transformedLayer.objectIds[0]].transform.rotation = 1;
    const transformedExport = await exportDocument(transformed, 'pdf');
    expect(transformedExport.report).toMatchObject({
      warnings: [
        'Some imported PDF text could not remain searchable because its transform or effects require rasterization.',
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        invisibleTextSafetyWarning,
        '2 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });
    expect(transformedExport.report.fidelity?.map((entry) => entry.code)).toEqual([
      'searchable-text-omitted',
      'searchable-text-retained', 'font-substitution',
      'searchable-text-retained', 'font-substitution',
    ]);
    expect(await extractedPdfText(transformedExport.data)).toEqual([
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const exported = await exportDocument(document, 'pdf');
    expect(exported.report).toMatchObject({
      warnings: [
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        invisibleTextSafetyWarning,
        '3 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });
    expect(exported.report.fidelity?.map((entry) => entry.code)).toEqual([
      'searchable-text-retained', 'font-substitution',
      'searchable-text-retained', 'font-substitution',
      'searchable-text-retained', 'font-substitution',
    ]);
    expect(new Set(exported.report.fidelity?.map((entry) => entry.subjectId))).toEqual(new Set(importedTextLayer.type === 'vector' ? importedTextLayer.objectIds : []));

    expect(await extractedPdfText(exported.data)).toEqual([
      'LibreOffice PDF',
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-pdf-roundtrip-'));
    try {
      const path = join(directory, 'roundtrip.pdf');
      await writeFile(path, exported.data);
      const reopened = await runImportUtilityRequest({ id: 'libreoffice-roundtrip-reimport', kind: 'import-document', filePath: path, pixelMode: false });
      expect(reopened.documents).toHaveLength(1);
      const reopenedDocument = reopened.documents[0];
      if (reopenedDocument.kind !== 'illustration') throw new Error('Expected a re-imported LibreOffice illustration.');
      const actualCanvas = await renderDocument(reopenedDocument);
      const expectedImage = await loadImage(goldenBytes);
      const expectedCanvas = createCanvas(expectedImage.width, expectedImage.height);
      expectedCanvas.getContext('2d').drawImage(expectedImage, 0, 0);
      expect({ width: actualCanvas.width, height: actualCanvas.height }).toEqual({ width: expectedCanvas.width, height: expectedCanvas.height });
      const actualRgba = actualCanvas.getContext('2d').getImageData(0, 0, actualCanvas.width, actualCanvas.height).data;
      const expectedRgba = expectedCanvas.getContext('2d').getImageData(0, 0, expectedCanvas.width, expectedCanvas.height).data;
      expect(actualRgba.every((channel, index) => index % 4 !== 3 || channel === 255)).toBe(true);
      const difference = visualDifference(actualRgba, expectedRgba);
      expect(difference.meanAbsoluteChannelDelta).toBeLessThan(8);
      expect(difference.largeChannelDeltaRatio).toBeLessThan(0.05);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('warns that covering imported searchable text is not redaction', async () => {
    const imported = await runImportUtilityRequest({ id: 'libreoffice-covering-overlay-import', kind: 'import-document', filePath: fixturePath, pixelMode: false });
    const document = imported.documents[0];
    if (document.kind !== 'illustration') throw new Error('Expected a LibreOffice illustration import.');
    const visibleVectorLayer = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector' && layer.visible);
    if (!visibleVectorLayer || visibleVectorLayer.type !== 'vector') throw new Error('Expected the visible PDF fallback layer.');
    const timestamp = nowIso();
    const overlay: ShapeObject = {
      id: 'covering-overlay', revision: 0, name: 'Opaque covering artwork', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: visibleVectorLayer.id, type: 'shape', shape: 'rectangle', width: document.artboard.width, height: document.artboard.height,
      transform: { ...IDENTITY_TRANSFORM }, visible: true, locked: false, opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#000000' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    document.objects[overlay.id] = overlay;
    visibleVectorLayer.objectIds.push(overlay.id);
    expectOpaqueBlackInterior(await renderDocument(document));

    const exported = await exportDocument(document, 'pdf');
    expect(exported.report).toMatchObject({
      warnings: [
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        invisibleTextSafetyWarning,
        '3 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });
    expect(exported.report.fidelity?.filter((entry) => entry.code === 'searchable-text-retained')).toHaveLength(3);
    expect(exported.report.fidelity?.filter((entry) => entry.code === 'font-substitution')).toHaveLength(3);
    expect(await extractedPdfText(exported.data)).toEqual([
      'LibreOffice PDF',
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const directory = await mkdtemp(join(tmpdir(), 'aidraw-pdf-overlay-'));
    try {
      const path = join(directory, 'covered.pdf');
      await writeFile(path, exported.data);
      const reopened = await runImportUtilityRequest({ id: 'libreoffice-covering-overlay-reimport', kind: 'import-document', filePath: path, pixelMode: false });
      const reopenedDocument = reopened.documents[0];
      if (reopenedDocument?.kind !== 'illustration') throw new Error('Expected a re-imported covered PDF illustration.');
      expect(reopenedDocument.artboard).toMatchObject({ width: 241, height: 151 });
      expectOpaqueBlackInterior(await renderDocument(reopenedDocument));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
