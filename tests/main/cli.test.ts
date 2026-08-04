import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPixelDocument, writePixels } from '@aidraw/core';
import { executeBatchExport, parseCliArguments } from '@main/cli';
import { writeNativeDocument } from '@main/persistence';
import { parseGIF } from 'gifuct-js';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('AIDraw CLI', () => {
  it('parses Aseprite-style headless presentation export arguments', () => {
    expect(parseCliArguments([])).toBeUndefined();
    expect(parseCliArguments(['-b', 'slime.aidraw', '--scale', '8', '--save-as', 'slime-x8.gif'])).toEqual({
      kind: 'batch-export', inputPath: 'slime.aidraw', outputPath: 'slime-x8.gif', format: undefined, scale: 8, animationTag: undefined, overwrite: false,
    });
    expect(() => parseCliArguments(['--batch', 'slime.aidraw', '--scale', '1.5', '--save-as', 'slime.gif'])).toThrow('integer from 1 to 64');
  });

  it('exports a scaled GIF without starting the editor engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-cli-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'CLI sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    writePixels(Object.values(sprite.cels)[0], [{ x: 2, y: 3, index: 4 }]);
    sprite.tags = [{ id: 'idle-tag', name: 'Idle', fromFrameId: sprite.frameIds[0], toFrameId: sprite.frameIds[0], direction: 'forward', color: '#9b87f5' }];
    const inputPath = join(root, 'sprite.aidraw'); const outputPath = join(root, 'sprite-x8.gif');
    await writeNativeDocument(inputPath, document, 'test');
    const command = parseCliArguments(['--batch', inputPath, '--scale', '8', '--animation-tag', 'Idle', '--save-as', outputPath]);
    if (command?.kind !== 'batch-export') throw new Error('Expected batch command');
    const result = await executeBatchExport(command); const bytes = await readFile(outputPath); const parsed = parseGIF(Uint8Array.from(bytes).buffer);
    expect(result.scale).toBe(8); expect(result.outputPath).toBe(outputPath);
    expect(parsed.lsd.width).toBe(sprite.width * 8); expect(parsed.lsd.height).toBe(sprite.height * 8);
    await expect(executeBatchExport(command)).rejects.toThrow('Pass --overwrite');
    await expect(executeBatchExport({ ...command, overwrite: true })).resolves.toMatchObject({ scale: 8, format: 'gif' });
    await expect(executeBatchExport({ ...command, animationTag: 'Missing', overwrite: true })).rejects.toThrow('does not exist');
  });
});
