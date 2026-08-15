import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HUMAN_ACTOR,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  nowIso,
  writePixels,
  writeTiles,
} from '@aidraw/core';
import {
  CLI_EXIT_CODES,
  CliRefusalError,
  executeBatchExport,
  parseCliArguments,
  runCliInvocation,
  type BatchExportResult,
  type CliCommand,
} from '@main/cli';
import { ExportPublicationRefusalError } from '@main/export-publication';
import { writeNativeDocument } from '@main/persistence';
import { parseGIF } from 'gifuct-js';
import { createCanvas } from '@napi-rs/canvas';
import UPNG from 'upng-js';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function addAnimationFrames(document: ReturnType<typeof createPixelDocument>): void {
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  sprite.width = 3;
  sprite.height = 1;
  const firstFrameId = sprite.frameIds[0];
  sprite.frames[firstFrameId].durationMs = 80;
  writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 2 }]);
  const timestamp = nowIso();
  for (let index = 1; index <= 2; index += 1) {
    const frameId = `cli-frame-${index + 1}`;
    const celId = `cli-cel-${index + 1}`;
    sprite.frameIds.push(frameId);
    sprite.frames[frameId] = {
      id: frameId,
      revision: 0,
      name: `Frame ${index + 1}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: HUMAN_ACTOR.id,
      durationMs: 80 + index * 40,
    };
    sprite.cels[celId] = {
      id: celId,
      revision: 0,
      name: `Frame ${index + 1} pixels`,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: HUMAN_ACTOR.id,
      layerId: sprite.layerIds[0],
      frameId,
      chunks: {},
    };
    writePixels(sprite.cels[celId], [{ x: index, y: 0, index: 2 + index }]);
  }
  sprite.tags = [{
    id: 'cli-tag',
    name: 'CLI Bounce',
    fromFrameId: firstFrameId,
    toFrameId: sprite.frameIds[2],
    direction: 'ping-pong',
    color: '#9b87f5',
  }];
}

function tiledDocument() {
  const document = createPixelDocument('project', 'CLI map');
  document.assetIds = [];
  document.pixelAssets = {};
  const sprite = createPixelSprite('CLI terrain pixels', 2, 1);
  writePixels(Object.values(sprite.cels)[0], [{ x: 0, y: 0, index: 3 }, { x: 1, y: 0, index: 4 }]);
  const tileset = createPixelTileset('CLI Terrain', sprite.id, 1, 1, 2, 1);
  tileset.firstGid = 17;
  const map = createPixelTilemap('CLI Map');
  map.width = 2;
  map.height = 1;
  map.tileWidth = 1;
  map.tileHeight = 1;
  map.tilesetIds = [tileset.id];
  const layer = map.layers[map.layerIds[0]];
  if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
  writeTiles(layer.chunks, [{ x: 0, y: 0, gid: 17 }, { x: 1, y: 0, gid: 18 }]);
  document.pixelAssets = { [sprite.id]: sprite, [tileset.id]: tileset, [map.id]: map };
  document.assetIds = [sprite.id, tileset.id, map.id];
  document.activeAssetId = map.id;
  return { document, map, tileset };
}

const noImageDecode = async () => undefined;

function batchCommand(overrides: Partial<Extract<CliCommand, { kind: 'batch-export' }>> = {}): Extract<CliCommand, { kind: 'batch-export' }> {
  return {
    kind: 'batch-export',
    inputPath: 'source.aidraw',
    outputPath: 'output.png',
    scale: 1,
    overwrite: false,
    ...overrides,
  };
}

const fakeBatchResult: BatchExportResult = {
  inputPath: '/source.aidraw',
  outputPath: '/output.png',
  companionPaths: [],
  format: 'png',
  scale: 1,
  byteLength: 4,
  warnings: [],
};

describe('AIDraw CLI', () => {
  it('parses Aseprite-style headless presentation export arguments', () => {
    expect(parseCliArguments([])).toBeUndefined();
    expect(parseCliArguments(['-b', 'slime.aidraw', '--scale', '8', '--save-as', 'slime-x8.gif'])).toEqual({
      kind: 'batch-export', inputPath: 'slime.aidraw', outputPath: 'slime-x8.gif', format: undefined, scale: 8, animationTag: undefined, overwrite: false,
    });
    expect(() => parseCliArguments(['--batch', 'slime.aidraw', '--scale', '1.5', '--save-as', 'slime.gif'])).toThrow('integer from 1 to 64');
    expect(parseCliArguments(['--batch', 'map.aidraw', '--save-as', 'map.tsj'])).toMatchObject({ format: undefined, outputPath: 'map.tsj' });
  });

  it('exports a scaled GIF without starting the editor engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-cli-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'CLI sprite'); const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    writePixels(Object.values(sprite.cels)[0], [{ x: 2, y: 3, index: 4 }]);
    const sourceCanvas = createCanvas(2, 2); sourceCanvas.getContext('2d').fillRect(0, 0, 2, 2); const sourceBytes = sourceCanvas.toBuffer('image/png');
    document.assets['cli-source-image'] = {
      id: 'cli-source-image', name: 'CLI source image', mimeType: 'image/png', byteLength: sourceBytes.byteLength,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'), source: 'embedded', data: sourceBytes.toString('base64'),
    };
    sprite.tags = [{ id: 'idle-tag', name: 'Idle', fromFrameId: sprite.frameIds[0], toFrameId: sprite.frameIds[0], direction: 'forward', color: '#9b87f5' }];
    const inputPath = join(root, 'sprite.aidraw'); const outputPath = join(root, 'sprite-x8.gif');
    await writeNativeDocument(inputPath, document, 'test');
    const command = parseCliArguments(['--batch', inputPath, '--scale', '8', '--animation-tag', 'Idle', '--save-as', outputPath]);
    if (command?.kind !== 'batch-export') throw new Error('Expected batch command');
    const decoder = vi.fn(async (_bytes: Buffer, expected: { mimeType: string; width: number; height: number }) => {
      expect(expected).toEqual({ mimeType: 'image/png', width: 2, height: 2 });
    });
    const result = await executeBatchExport(command, decoder); const bytes = await readFile(outputPath); const parsed = parseGIF(Uint8Array.from(bytes).buffer);
    expect(result.scale).toBe(8); expect(result.outputPath).toBe(outputPath);
    expect(decoder).toHaveBeenCalledOnce();
    expect(parsed.lsd.width).toBe(sprite.width * 8); expect(parsed.lsd.height).toBe(sprite.height * 8);
    await expect(executeBatchExport(command, decoder)).rejects.toThrow('Pass --overwrite');
    await expect(executeBatchExport({ ...command, overwrite: true }, decoder)).resolves.toMatchObject({ scale: 8, format: 'gif' });
    await expect(executeBatchExport({ ...command, animationTag: 'Missing', overwrite: true }, decoder)).rejects.toThrow('does not exist');
    await expect(executeBatchExport({ ...command, overwrite: true }, async () => { throw new Error('isolated decoder unavailable'); })).resolves.toMatchObject({
      warnings: expect.arrayContaining(['Embedded data for asset “CLI source image” is not a valid decodable image and was ignored.']),
    });
  });

  it('exports a scaled exact named tag as decoded APNG timing and pixels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-cli-apng-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'CLI APNG');
    addAnimationFrames(document);
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const inputPath = join(root, 'sprite.aidraw');
    const outputPath = join(root, 'sprite.apng');
    await writeNativeDocument(inputPath, document, 'test');
    const command = parseCliArguments(['--batch', inputPath, '--scale', '3', '--animation-tag', 'CLI Bounce', '--save-as', outputPath]);
    if (command?.kind !== 'batch-export') throw new Error('Expected batch command');
    const result = await executeBatchExport(command, noImageDecode);
    const decoded = UPNG.decode(Uint8Array.from(await readFile(outputPath)).buffer);
    const frames = UPNG.toRGBA8(decoded).map((frame) => Buffer.from(frame));
    expect(result).toMatchObject({ outputPath, companionPaths: [], format: 'apng', scale: 3 });
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Exported at 3× using nearest-neighbor pixel scaling.',
      'Exported animation tag “CLI Bounce” using ping-pong playback.',
    ]));
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: sprite.width * 3, height: sprite.height * 3 });
    expect(decoded.frames.map((frame) => frame.delay)).toEqual([80, 120, 160, 120]);
    expect(frames).toHaveLength(4);
    expect(frames[0].equals(frames[1])).toBe(false);
    expect(frames[1].equals(frames[3])).toBe(true);
    expect(frames[0].subarray(0, 4).equals(frames[0].subarray(4, 8))).toBe(true);

    const ambiguous = createPixelDocument('sprite', 'Ambiguous CLI tags');
    addAnimationFrames(ambiguous);
    const ambiguousSprite = ambiguous.pixelAssets[ambiguous.activeAssetId];
    if (ambiguousSprite.type !== 'sprite') throw new Error('Expected sprite');
    ambiguousSprite.tags.push({ ...ambiguousSprite.tags[0], id: 'duplicate-cli-tag', name: 'cli bounce' });
    const ambiguousInput = join(root, 'ambiguous.aidraw');
    const ambiguousOutput = join(root, 'ambiguous.apng');
    await writeNativeDocument(ambiguousInput, ambiguous, 'test');
    await expect(executeBatchExport(batchCommand({
      inputPath: ambiguousInput,
      outputPath: ambiguousOutput,
      format: 'apng',
      animationTag: 'CLI Bounce',
    }), noImageDecode)).rejects.toThrow('ambiguous; use an exact tag ID');
    await expect(readFile(ambiguousOutput)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a scaled named-tag sprite sheet with matching PNG and metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-cli-sheet-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'CLI sheet');
    addAnimationFrames(document);
    const inputPath = join(root, 'sprite.aidraw');
    const outputPath = join(root, 'hero-sheet.png');
    await writeNativeDocument(inputPath, document, 'test');
    const command = parseCliArguments(['--batch', inputPath, '--format', 'sprite-sheet', '--scale', '2', '--animation-tag', 'cli-tag', '--save-as', outputPath]);
    if (command?.kind !== 'batch-export') throw new Error('Expected batch command');
    const result = await executeBatchExport(command, noImageDecode);
    const companionPath = join(root, 'hero-sheet.json');
    const metadata = JSON.parse(await readFile(companionPath, 'utf8')) as {
      frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
      meta: { image: string; size: { w: number; h: number }; scale: number; selectedTagId: string; frameOrder: string[] };
    };
    const png = UPNG.decode(Uint8Array.from(await readFile(outputPath)).buffer);
    expect(result.companionPaths).toEqual([companionPath]);
    expect(metadata.meta).toMatchObject({
      image: 'hero-sheet.png',
      size: { w: png.width, h: png.height },
      scale: 2,
      selectedTagId: 'cli-tag',
      frameOrder: expect.arrayContaining(['cli-frame-2', 'cli-frame-3']),
    });
    expect(metadata.meta.frameOrder).toHaveLength(4);
    expect(Object.values(metadata.frames)).toHaveLength(4);
    for (const frame of Object.values(metadata.frames)) {
      expect(frame.frame.w).toBe(6);
      expect(frame.frame.h).toBe(2);
      expect(frame.frame.x + frame.frame.w).toBeLessThanOrEqual(png.width);
      expect(frame.frame.y + frame.frame.h).toBeLessThanOrEqual(png.height);
    }
  });

  it('publishes Tiled JSON/XML maps and standalone tilesets with every declared image companion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-cli-tiled-')); temporaryPaths.push(root);
    const { document, tileset } = tiledDocument();
    const mapInput = join(root, 'map.aidraw');
    await writeNativeDocument(mapInput, document, 'test');
    for (const [extension, format] of [['tmj', 'tiled-json'], ['tmx', 'tiled-xml']] as const) {
      const directory = join(root, extension);
      const outputPath = join(directory, `map.${extension}`);
      const command = parseCliArguments(['--batch', mapInput, '--save-as', outputPath]);
      if (command?.kind !== 'batch-export') throw new Error('Expected batch command');
      const result = await executeBatchExport(command, noImageDecode);
      const imagePath = join(directory, 'CLI Terrain.png');
      expect(result).toMatchObject({ outputPath, format, companionPaths: [imagePath] });
      const image = UPNG.decode(Uint8Array.from(await readFile(imagePath)).buffer);
      expect({ width: image.width, height: image.height }).toEqual({ width: 2, height: 1 });
      const body = await readFile(outputPath, 'utf8');
      if (extension === 'tmj') expect(JSON.parse(body).tilesets[0].image).toBe('CLI Terrain.png');
      else expect(body).toContain('<image source="CLI Terrain.png"');
    }

    document.activeAssetId = tileset.id;
    const tilesetInput = join(root, 'tileset.aidraw');
    await writeNativeDocument(tilesetInput, document, 'test');
    for (const extension of ['tsj', 'tsx'] as const) {
      const directory = join(root, extension);
      const outputPath = join(directory, `terrain.${extension}`);
      const command = parseCliArguments(['--batch', tilesetInput, '--save-as', outputPath]);
      if (command?.kind !== 'batch-export') throw new Error('Expected batch command');
      const result = await executeBatchExport(command, noImageDecode);
      expect(result.outputPath).toBe(outputPath);
      expect(result.companionPaths).toEqual([join(directory, 'CLI Terrain.png')]);
      const body = await readFile(outputPath, 'utf8');
      if (extension === 'tsj') expect(JSON.parse(body).image).toBe('CLI Terrain.png');
      else expect(body).toContain('<image source="CLI Terrain.png"');
    }
    await expect(executeBatchExport(batchCommand({
      inputPath: tilesetInput,
      outputPath: join(root, 'wrong.tmj'),
      format: 'tiled-json',
    }), noImageDecode)).rejects.toThrow('exports as .tsj');
  });

  it('returns the documented process exit taxonomy through the main CLI runner', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const base = { version: '9.8.7', executable: 'AIDraw', writeStdout: stdout, writeStderr: stderr };
    await expect(runCliInvocation({ ...base, command: { kind: 'help' } })).resolves.toBe(CLI_EXIT_CODES.success);
    await expect(runCliInvocation({ ...base, command: { kind: 'version' } })).resolves.toBe(CLI_EXIT_CODES.success);
    await expect(runCliInvocation({
      ...base,
      command: batchCommand(),
      executeBatch: vi.fn(async () => fakeBatchResult),
    })).resolves.toBe(CLI_EXIT_CODES.success);
    await expect(runCliInvocation({
      ...base,
      command: undefined,
      parseError: new CliRefusalError('invalid arguments'),
    })).resolves.toBe(CLI_EXIT_CODES.refusal);
    await expect(runCliInvocation({
      ...base,
      command: batchCommand(),
      executeBatch: vi.fn(async () => { throw new ExportPublicationRefusalError('destination collision'); }),
    })).resolves.toBe(CLI_EXIT_CODES.refusal);
    await expect(runCliInvocation({
      ...base,
      command: batchCommand(),
      executeBatch: vi.fn(async () => { throw new Error('read/export/publication failure'); }),
    })).resolves.toBe(CLI_EXIT_CODES.runtimeFailure);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"outputPath": "/output.png"'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Exit codes: 0 help/version/export success'));
    const mainSource = await readFile(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    expect(mainSource).toContain('const exitCode = await runCliInvocation({');
    expect(mainSource).toContain('app.exit(exitCode);');
  });
});
