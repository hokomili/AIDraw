import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readPixel } from '@aidraw/core';
import { afterEach, describe, expect, it } from 'vitest';
import { exportDocument } from '@main/export-document';
import { readNativeDocument, writeNativeDocument } from '@main/persistence';
import { runImportUtilityRequest } from '@main/utility-import';
import { displayImageDimensions, inspectImageHeader, validateInlineDocumentAsset, type ImageHeader } from '@main/transaction-policy';

const fixturePath = fileURLToPath(new URL('../fixtures/raster/exif-orientation-6.jpeg.base64', import.meta.url));
const fixtureSha256 = '127b13e4ae8a15d43738a0c221d364b019bfb548b66f01c7cdb1e40bc599a3a6';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureBytes(): Promise<Buffer> {
  return Buffer.from((await readFile(fixturePath, 'utf8')).replace(/\s/g, ''), 'base64');
}

async function rgba(bytes: Buffer): Promise<Uint8ClampedArray> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
}

function sample(source: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  return Array.from(source.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
}

function littleEndianOrientation(bytes: Buffer, orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): Buffer {
  const output = Buffer.from(bytes);
  output.write('II', 12, 'ascii');
  output.writeUInt16LE(42, 14);
  output.writeUInt32LE(8, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(0x0112, 22);
  output.writeUInt16LE(3, 24);
  output.writeUInt32LE(1, 26);
  output.writeUInt16LE(orientation, 30);
  output.writeUInt16LE(0, 32);
  output.writeUInt32LE(0, 34);
  return output;
}

describe('standalone raster interchange', () => {
  it('parses bounded JPEG EXIF orientation without changing encoded geometry', async () => {
    const bytes = await fixtureBytes();
    expect(bytes.byteLength).toBe(948);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixtureSha256);
    expect(inspectImageHeader(bytes)).toEqual({ mimeType: 'image/jpeg', width: 24, height: 16, orientation: 6 });
    expect(displayImageDimensions(inspectImageHeader(bytes))).toEqual({ width: 16, height: 24 });

    for (const orientation of [1, 2, 3, 4] as const) {
      expect(displayImageDimensions({ mimeType: 'image/jpeg', width: 24, height: 16, orientation })).toEqual({ width: 24, height: 16 });
    }
    for (const orientation of [5, 6, 7, 8] as const) {
      expect(displayImageDimensions({ mimeType: 'image/jpeg', width: 24, height: 16, orientation })).toEqual({ width: 16, height: 24 });
    }
    expect(displayImageDimensions({ mimeType: 'image/png', width: 24, height: 16 } as ImageHeader)).toEqual({ width: 24, height: 16 });

    const littleEndian = littleEndianOrientation(bytes, 8);
    expect(inspectImageHeader(littleEndian)).toEqual({ mimeType: 'image/jpeg', width: 24, height: 16, orientation: 8 });
    await expect(loadImage(littleEndian)).resolves.toMatchObject({ width: 16, height: 24 });

    const malformedIfdOffset = Buffer.from(bytes);
    malformedIfdOffset.writeUInt32BE(0xffff_ffff, 16);
    expect(inspectImageHeader(malformedIfdOffset)).toEqual({ mimeType: 'image/jpeg', width: 24, height: 16 });
  });

  it('imports orientation 6 at display geometry, retains source bytes, and re-exports exact decoded pixels', async () => {
    const bytes = await fixtureBytes();
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-exif-orientation-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'camera-orientation-6.jpg');
    await writeFile(sourcePath, bytes);

    const imported = await runImportUtilityRequest({ id: 'exif-orientation-6-illustration', kind: 'import-document', filePath: sourcePath, pixelMode: false });
    expect(imported.warnings).toEqual(['JPEG EXIF orientation 6 was applied; display geometry is 16×24 from 24×16 encoded pixels.']);
    const document = imported.documents[0];
    if (document.kind !== 'illustration') throw new Error('Expected an illustration import.');
    expect(document.artboard).toMatchObject({ width: 16, height: 24, background: null });
    const image = Object.values(document.objects).find((object) => object.type === 'image');
    if (!image || image.type !== 'image') throw new Error('Expected an imported image object.');
    expect(image).toMatchObject({ width: 16, height: 24, sourceWidth: 16, sourceHeight: 24 });
    const asset = document.assets[image.assetId];
    expect(asset).toMatchObject({ mimeType: 'image/jpeg', byteLength: 948, sha256: fixtureSha256, data: bytes.toString('base64') });
    await expect(validateInlineDocumentAsset(asset)).resolves.toBeUndefined();

    const nativePath = await writeNativeDocument(join(directory, 'orientation-roundtrip'), document, '0.1.0-alpha.1');
    const reopened = (await readNativeDocument(nativePath)).document;
    expect(reopened).toMatchObject({ kind: 'illustration', artboard: { width: 16, height: 24, background: null } });
    const reopenedAsset = reopened.assets[image.assetId];
    expect(reopenedAsset).toMatchObject({ mimeType: 'image/jpeg', byteLength: 948, sha256: fixtureSha256, data: bytes.toString('base64') });

    const exported = await exportDocument(reopened, 'png');
    const [expectedRgba, actualRgba] = await Promise.all([rgba(bytes), rgba(exported.data)]);
    expect(actualRgba).toEqual(expectedRgba);
    expect([
      sample(actualRgba, 16, 2, 2),
      sample(actualRgba, 16, 13, 2),
      sample(actualRgba, 16, 2, 21),
      sample(actualRgba, 16, 13, 21),
    ]).toEqual([
      [49, 87, 212, 255],
      [239, 48, 56, 255],
      [242, 213, 60, 255],
      [39, 179, 92, 255],
    ]);
  });

  it('quantizes the decoder-oriented display instead of stretching encoded coordinates', async () => {
    const bytes = await fixtureBytes();
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-exif-orientation-pixel-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'camera-orientation-6.jpg');
    await writeFile(sourcePath, bytes);

    const imported = await runImportUtilityRequest({ id: 'exif-orientation-6-pixel', kind: 'import-document', filePath: sourcePath, pixelMode: true });
    expect(imported.warnings).toEqual([
      'JPEG EXIF orientation 6 was applied; display geometry is 16×24 from 24×16 encoded pixels.',
      'Full-color image quantized to the active indexed palette; the source image is embedded for reproducibility.',
    ]);
    const document = imported.documents[0];
    if (document.kind !== 'pixel') throw new Error('Expected a pixel import.');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected a sprite import.');
    expect(sprite).toMatchObject({ width: 16, height: 24 });
    const cel = Object.values(sprite.cels)[0];
    expect([
      document.palette[readPixel(cel, 2, 2)].id,
      document.palette[readPixel(cel, 13, 2)].id,
      document.palette[readPixel(cel, 2, 21)].id,
      document.palette[readPixel(cel, 13, 21)].id,
    ]).toEqual(['ocean', 'coral', 'gold', 'moss']);
    expect(Object.values(document.assets)).toContainEqual(expect.objectContaining({ mimeType: 'image/jpeg', sha256: fixtureSha256, data: bytes.toString('base64') }));
  });
});
