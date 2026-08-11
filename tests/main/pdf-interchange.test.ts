import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { exportDocument } from '@main/export-document';
import { renderDocument } from '@main/render-document';
import { runImportUtilityRequest } from '@main/utility-import';

const fixturePath = fileURLToPath(new URL('../fixtures/pdf/libreoffice-clipped-transparency.pdf', import.meta.url));
const goldenPath = fileURLToPath(new URL('../fixtures/pdf/libreoffice-clipped-transparency-poppler.png', import.meta.url));

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
    expect(unsupportedExport.report).toEqual({
      warnings: [
        'Some imported PDF text could not remain searchable because it contains glyphs outside the built-in PDF font.',
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        '2 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });
    expect(await extractedPdfText(unsupportedExport.data)).toEqual([
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const transformed = structuredClone(document);
    const transformedLayer = transformed.layers[importedTextLayer.id];
    if (transformedLayer.type !== 'vector') throw new Error('Expected an imported PDF text layer.');
    transformed.objects[transformedLayer.objectIds[0]].transform.rotation = 1;
    const transformedExport = await exportDocument(transformed, 'pdf');
    expect(transformedExport.report).toEqual({
      warnings: [
        'Some imported PDF text could not remain searchable because its transform or effects require rasterization.',
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        '2 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });
    expect(await extractedPdfText(transformedExport.data)).toEqual([
      'CLIPPED TRANSPARENCY',
      'external producer fixture',
    ]);

    const exported = await exportDocument(document, 'pdf');
    expect(exported.report).toEqual({
      warnings: [
        'PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.',
        '3 imported PDF text runs were retained as invisible searchable content.',
      ],
      rasterized: [],
    });

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
});
