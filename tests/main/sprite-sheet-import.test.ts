import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPixel } from '@aidraw/core';

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } }));

import { importSlicedSpriteSheetBytes } from '../../src/main/import-document';
import { inspectSpriteSheetFile, readBoundedSpriteSheetSource } from '../../src/main/sprite-sheet-preview';
import { MAX_INLINE_ASSET_BYTES } from '../../src/main/transaction-policy';
import { runImportUtilityRequest } from '../../src/main/utility-import';

const orientationFixture = fileURLToPath(new URL('../fixtures/raster/exif-orientation-6.jpeg.base64', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('sprite-sheet image import', () => {
  it('rejects an oversized retained source before parsing or native decode', async () => {
    await expect(importSlicedSpriteSheetBytes(Buffer.alloc(MAX_INLINE_ASSET_BYTES + 1), 'Oversized sheet', 'image/png', { frameWidth: 1, frameHeight: 1, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0, frameCount: 1, order: 'rows', durationMs: 100, trimTransparent: false, skipEmpty: false })).rejects.toThrow("Sprite-sheet source exceeds AIDraw's 1,500,000-byte editable-asset limit.");
  });

  it('rejects an oversized selected file before worker-owned read/decode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-sprite-sheet-preview-')); temporaryDirectories.push(directory);
    const path = join(directory, 'oversized.png');
    await writeFile(path, Buffer.alloc(MAX_INLINE_ASSET_BYTES + 1));
    await expect(readBoundedSpriteSheetSource(path)).rejects.toThrow("Sprite-sheet source exceeds AIDraw's 1,500,000-byte editable-asset limit.");
  });

  it('previews and slices the frozen orientation-6 JPEG in display geometry while retaining exact source bytes', async () => {
    const bytes = Buffer.from((await readFile(orientationFixture, 'utf8')).trim(), 'base64');
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-oriented-sprite-sheet-')); temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'orientation-6.jpeg'); await writeFile(sourcePath, bytes);
    const inspected = await inspectSpriteSheetFile(sourcePath);
    expect(inspected).toMatchObject({
      sha256: '127b13e4ae8a15d43738a0c221d364b019bfb548b66f01c7cdb1e40bc599a3a6',
      mimeType: 'image/jpeg', width: 16, height: 24,
    });
    expect(inspected.previewPng.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([inspected.previewPng.readUInt32BE(16), inspected.previewPng.readUInt32BE(20)]).toEqual([16, 24]);

    const options = {
      frameWidth: 8, frameHeight: 12, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0,
      frameCount: 4, order: 'rows', durationMs: 90, trimTransparent: false, skipEmpty: false,
    } as const;
    const imported = await runImportUtilityRequest({
      id: 'oriented-sprite-sheet', kind: 'import-document', filePath: sourcePath, pixelMode: true,
      spriteSheet: { options, name: 'Oriented sheet', mimeType: inspected.mimeType, expectedSha256: inspected.sha256 },
    });
    const document = imported.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect([sprite.width, sprite.height, sprite.frameIds.length]).toEqual([8, 12, 4]);
    expect(Object.values(document.assets)[0]).toMatchObject({
      mimeType: 'image/jpeg', byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64'),
    });
    const approvedAgentImport = await runImportUtilityRequest({
      id: 'agent-oriented-sprite-sheet', kind: 'import-document', filePath: sourcePath, pixelMode: true,
      spriteSheet: { options: { ...options, frameCount: 1 }, name: 'Agent oriented sheet' },
    });
    expect(Object.values(approvedAgentImport.documents[0].assets)[0]).toMatchObject({ mimeType: 'image/jpeg', data: bytes.toString('base64') });
    await expect(importSlicedSpriteSheetBytes(bytes, 'Mislabeled sheet', 'image/png', {
      frameWidth: 8, frameHeight: 12, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0,
      frameCount: 1, order: 'rows', durationMs: 90, trimTransparent: false, skipEmpty: false,
    })).rejects.toThrow('Sprite-sheet source MIME disagrees with its file header.');

    const changed = Buffer.from(bytes); changed[changed.byteLength - 1] ^= 0x01; await writeFile(sourcePath, changed);
    await expect(runImportUtilityRequest({
      id: 'changed-oriented-sprite-sheet', kind: 'import-document', filePath: sourcePath, pixelMode: true,
      spriteSheet: { options, name: 'Oriented sheet', mimeType: inspected.mimeType, expectedSha256: inspected.sha256 },
    })).rejects.toThrow('selected sprite-sheet file changed before the utility process read it');
  });

  it('slices, skips empty frames, trims a shared border, preserves timing, and embeds the source', async () => {
    const canvas = createCanvas(14, 4); const context = canvas.getContext('2d'); context.clearRect(0, 0, 14, 4);
    context.fillStyle = '#ff6b7a'; context.fillRect(1, 1, 1, 1);
    context.fillStyle = '#9be3c2'; context.fillRect(7, 2, 1, 1);
    const result = await importSlicedSpriteSheetBytes(canvas.toBuffer('image/png'), 'Tiny sheet', 'image/png', { frameWidth: 4, frameHeight: 4, marginX: 0, marginY: 0, spacingX: 1, spacingY: 0, frameCount: 3, order: 'rows', durationMs: 125, trimTransparent: true, skipEmpty: true });
    const document = result.documents[0]; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect([sprite.width, sprite.height, sprite.frameIds.length]).toEqual([2, 2, 2]);
    expect(sprite.frameIds.map((id) => sprite.frames[id].durationMs)).toEqual([125, 125]);
    const cels = sprite.frameIds.map((frameId) => Object.values(sprite.cels).find((cel) => cel.frameId === frameId)!);
    expect(readPixel(cels[0], 0, 0)).toBe(4); expect(readPixel(cels[1], 1, 1)).toBe(7);
    expect(Object.values(document.assets)[0]).toMatchObject({ source: 'imported', mimeType: 'image/png' });
    expect(result.warnings.join(' ')).toContain('Skipped 1 fully transparent frame');
    expect(result.warnings.join(' ')).toContain('Trimmed the shared transparent border');
  });

  it('wires selection and import through the supervised lane without browser-process image decode or source read', async () => {
    const [mainSource, workerSource] = await Promise.all([
      readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/main/utility-worker.ts'), 'utf8'),
    ]);
    const selectStart = mainSource.indexOf('handle(IPC.selectSpriteSheet');
    const importStart = mainSource.indexOf('handle(IPC.importSpriteSheet', selectStart);
    const exportStart = mainSource.indexOf('handle(IPC.exportActiveDocument', importStart);
    const selectSource = mainSource.slice(selectStart, importStart);
    const importSource = mainSource.slice(importStart, exportStart);
    expect(selectSource).toContain('rasterUtilities.inspectSpriteSheet(filePath)');
    expect(selectSource).not.toContain('nativeImage');
    expect(selectSource).not.toContain('readFile(');
    expect(importSource).not.toContain('readFile(');
    expect(mainSource).not.toContain('if (spriteSheet) { const bytes = await readFile(requestedPath)');
    expect(mainSource).toContain('importSpriteSheet(requestedPath, { options: spriteSheet, name: basename(requestedPath, extension) })');
    expect(workerSource).toContain("await import('./sprite-sheet-preview')");
    expect(workerSource).toContain('inspectSpriteSheetFile(request.filePath)');
  });
});
