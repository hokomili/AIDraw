import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExportPublicationRefusalError,
  publishExportSet,
  type ExportPublicationFileSystem,
} from '@main/export-publication';
import { CLI_EXIT_CODES, runCliInvocation } from '@main/cli';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const realFileSystem: ExportPublicationFileSystem = {
  link: async (existingPath, newPath) => { await link(existingPath, newPath); },
  lstat: async (filePath) => lstat(filePath),
  mkdir: async (directoryPath, options) => { await mkdir(directoryPath, options); },
  readFile: async (filePath) => readFile(filePath),
  rename: async (source, destination) => { await rename(source, destination); },
  rmdir: async (directoryPath) => { await rmdir(directoryPath); },
  unlink: async (filePath) => { await unlink(filePath); },
  writeFile: async (filePath, data, options) => { await writeFile(filePath, data, options); },
};

function failOnce(
  operation: 'link' | 'rename' | 'unlink',
  predicate: (source: string, destination?: string) => boolean,
): ExportPublicationFileSystem {
  let failed = false;
  return {
    ...realFileSystem,
    [operation]: async (source: string, destination?: string) => {
      if (!failed && predicate(source, destination)) {
        failed = true;
        throw new Error(`injected ${operation} failure`);
      }
      if (operation === 'link') await realFileSystem.link(source, destination!);
      else if (operation === 'rename') await realFileSystem.rename(source, destination!);
      else await realFileSystem.unlink(source);
    },
  } as ExportPublicationFileSystem;
}

async function cliExitCodeFor(error: unknown): Promise<number> {
  return runCliInvocation({
    command: {
      kind: 'batch-export',
      inputPath: 'input.aidraw',
      outputPath: 'output.png',
      scale: 1,
      overwrite: false,
    },
    version: 'test',
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    executeBatch: async () => { throw error; },
  });
}

async function capturedFailure(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'aidraw-publication-'));
  temporaryPaths.push(value);
  return value;
}

describe('batch export publication sets', () => {
  it('refuses portable duplicate destinations and existing companion collisions before mutation', async () => {
    const directory = await root();
    const primary = join(directory, 'hero.png');
    const companion = join(directory, 'hero.json');
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('first') },
      { path: join(directory, 'HERO.PNG'), data: Buffer.from('second') },
    ], false)).rejects.toBeInstanceOf(ExportPublicationRefusalError);
    expect(await readdir(directory)).toEqual([]);

    await writeFile(companion, 'predecessor');
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('new primary') },
      { path: companion, data: Buffer.from('new companion') },
    ], false)).rejects.toThrow('complete publication set');
    await expect(readFile(companion, 'utf8')).resolves.toBe('predecessor');
    expect(await readdir(directory)).toEqual(['hero.json']);

    const nonFileOutput = join(directory, 'blocked.png');
    await mkdir(nonFileOutput);
    await expect(publishExportSet([{ path: nonFileOutput, data: Buffer.from('no') }], true)).rejects.toThrow('not a regular file');
    expect((await readdir(directory)).sort()).toEqual(['blocked.png', 'hero.json']);
  });

  it('removes every new member when a later no-clobber publication link fails', async () => {
    const directory = await root();
    const primary = join(directory, 'map.tmj');
    const companion = join(directory, 'terrain.png');
    const fileSystem = failOnce('link', (source, destination) => source.endsWith('1.tmp') && destination === companion);
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('map') },
      { path: companion, data: Buffer.from('tiles') },
    ], false, { fileSystem, transactionId: () => 'new-failure' })).rejects.toThrow('injected link failure');
    expect(await readdir(directory)).toEqual([]);
  });

  it('atomically refuses an absent destination that appears before its first publication', async () => {
    const directory = await root();
    const destination = join(directory, 'hero.png');
    const newcomer = Buffer.from('concurrent newcomer');
    let injected = false;
    const fileSystem: ExportPublicationFileSystem = {
      ...realFileSystem,
      link: async (existingPath, newPath) => {
        if (!injected && newPath === destination && existingPath.endsWith('0.tmp')) {
          injected = true;
          await realFileSystem.writeFile(destination, newcomer, { flag: 'wx' });
        }
        await realFileSystem.link(existingPath, newPath);
      },
    };
    const failure = await capturedFailure(publishExportSet([
      { path: destination, data: Buffer.from('exported bytes') },
    ], false, { fileSystem, transactionId: () => 'first-race' }));
    expect(failure).toBeInstanceOf(ExportPublicationRefusalError);
    expect(failure).toMatchObject({ message: expect.stringContaining('appeared during batch publication') });
    await expect(cliExitCodeFor(failure)).resolves.toBe(CLI_EXIT_CODES.refusal);
    await expect(readFile(destination)).resolves.toEqual(newcomer);
    expect(await readdir(directory)).toEqual(['hero.png']);
  });

  it('preserves a later newcomer and rolls back earlier new members after publication began', async () => {
    const directory = await root();
    const primary = join(directory, 'hero.png');
    const companion = join(directory, 'hero.json');
    const newcomer = Buffer.from('concurrent companion');
    let injected = false;
    const fileSystem: ExportPublicationFileSystem = {
      ...realFileSystem,
      link: async (existingPath, newPath) => {
        if (!injected && newPath === companion && existingPath.endsWith('1.tmp')) {
          injected = true;
          await realFileSystem.writeFile(companion, newcomer, { flag: 'wx' });
        }
        await realFileSystem.link(existingPath, newPath);
      },
    };
    const failure = await capturedFailure(publishExportSet([
      { path: primary, data: Buffer.from('exported primary') },
      { path: companion, data: Buffer.from('exported companion') },
    ], false, { fileSystem, transactionId: () => 'later-race' }));
    expect(failure).not.toBeInstanceOf(ExportPublicationRefusalError);
    expect(failure).toMatchObject({ message: expect.stringContaining('Batch export publication failed') });
    await expect(cliExitCodeFor(failure)).resolves.toBe(CLI_EXIT_CODES.runtimeFailure);
    await expect(readFile(companion)).resolves.toEqual(newcomer);
    await expect(readFile(primary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(directory)).toEqual(['hero.json']);
  });

  it('cleans every staged member when a later staging write fails before publication', async () => {
    const directory = await root();
    const primary = join(directory, 'map.tmj');
    const companion = join(directory, 'terrain.png');
    const fileSystem: ExportPublicationFileSystem = {
      ...realFileSystem,
      writeFile: async (filePath, data, options) => {
        if (filePath.endsWith('1.tmp')) throw new Error('injected staging write failure');
        await realFileSystem.writeFile(filePath, data, options);
      },
    };
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('map') },
      { path: companion, data: Buffer.from('tiles') },
    ], false, { fileSystem, transactionId: () => 'write-failure' })).rejects.toThrow('injected staging write failure');
    expect(await readdir(directory)).toEqual([]);
  });

  it('restores every overwritten member when a later publication rename fails', async () => {
    const directory = await root();
    const primary = join(directory, 'hero.png');
    const companion = join(directory, 'hero.json');
    await writeFile(primary, 'old primary');
    await writeFile(companion, 'old companion');
    const fileSystem = failOnce('rename', (source, destination) => source.endsWith('1.tmp') && destination === companion);
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('new primary') },
      { path: companion, data: Buffer.from('new companion') },
    ], true, { fileSystem, transactionId: () => 'overwrite-failure' })).rejects.toThrow('injected rename failure');
    await expect(readFile(primary, 'utf8')).resolves.toBe('old primary');
    await expect(readFile(companion, 'utf8')).resolves.toBe('old companion');
    expect((await readdir(directory)).sort()).toEqual(['hero.json', 'hero.png']);
  });

  it('preserves an overwrite destination that drifts after its private backup is linked', async () => {
    const directory = await root();
    const destination = join(directory, 'hero.png');
    const newcomer = Buffer.from('concurrent overwrite newcomer');
    await writeFile(destination, 'admitted predecessor');
    let injected = false;
    const fileSystem: ExportPublicationFileSystem = {
      ...realFileSystem,
      link: async (existingPath, newPath) => {
        await realFileSystem.link(existingPath, newPath);
        if (!injected && existingPath === destination && newPath.endsWith('.bak')) {
          injected = true;
          await realFileSystem.unlink(destination);
          await realFileSystem.writeFile(destination, newcomer, { flag: 'wx' });
        }
      },
    };
    const failure = await capturedFailure(publishExportSet([
      { path: destination, data: Buffer.from('replacement') },
    ], true, { fileSystem, transactionId: () => 'overwrite-race' }));
    expect(failure).toBeInstanceOf(ExportPublicationRefusalError);
    expect(failure).toMatchObject({ message: expect.stringContaining('changed before batch publication') });
    await expect(cliExitCodeFor(failure)).resolves.toBe(CLI_EXIT_CODES.refusal);
    await expect(readFile(destination)).resolves.toEqual(newcomer);
    expect(await readdir(directory)).toEqual(['hero.png']);
  });

  it('restores predecessor bytes even when cleanup fails after one backup was removed', async () => {
    const directory = await root();
    const primary = join(directory, 'map.tmx');
    const companion = join(directory, 'terrain.png');
    await writeFile(primary, 'old map');
    await writeFile(companion, 'old tiles');
    let backupCleanupCount = 0;
    const fileSystem = failOnce('unlink', (filePath) => {
      if (!filePath.endsWith('.bak')) return false;
      backupCleanupCount += 1;
      return backupCleanupCount === 2;
    });
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('new map') },
      { path: companion, data: Buffer.from('new tiles') },
    ], true, { fileSystem, transactionId: () => 'cleanup-failure' })).rejects.toThrow('injected unlink failure');
    await expect(readFile(primary, 'utf8')).resolves.toBe('old map');
    await expect(readFile(companion, 'utf8')).resolves.toBe('old tiles');
    expect((await readdir(directory)).sort()).toEqual(['map.tmx', 'terrain.png']);
  });

  it('publishes all members and removes transaction artifacts on success', async () => {
    const directory = await root();
    const primary = join(directory, 'hero.png');
    const companion = join(directory, 'hero.json');
    await expect(publishExportSet([
      { path: primary, data: Buffer.from('primary') },
      { path: companion, data: Buffer.from('companion') },
    ], false, { transactionId: () => 'success' })).resolves.toEqual([primary, companion]);
    await expect(readFile(primary, 'utf8')).resolves.toBe('primary');
    await expect(readFile(companion, 'utf8')).resolves.toBe('companion');
    expect((await readdir(directory)).sort()).toEqual(['hero.json', 'hero.png']);
  });
});
