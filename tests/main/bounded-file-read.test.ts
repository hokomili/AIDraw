import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoundedRegularFile, type BoundedFileHandle } from '../../src/main/bounded-file-read';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const options = {
  maxBytes: 4,
  notFileMessage: 'not a file',
  tooLargeMessage: 'too large',
  changedMessage: 'changed',
};

describe('bounded regular-file reads', () => {
  it('accepts the exact byte boundary and rejects non-files before reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-bounded-read-')); temporaryDirectories.push(directory);
    const path = join(directory, 'boundary.bin'); const bytes = Buffer.from([1, 2, 3, 4]); await writeFile(path, bytes);
    await expect(readBoundedRegularFile(path, options)).resolves.toEqual(bytes);
    await expect(readBoundedRegularFile(directory, options)).rejects.toThrow('not a file');
  });

  it('rejects an over-ceiling stat without issuing a data read and still closes the handle', async () => {
    const read = vi.fn<BoundedFileHandle['read']>(); const close = vi.fn(async () => undefined);
    const handle: BoundedFileHandle = { stat: async () => ({ isFile: () => true, size: 5 }), read, close };
    await expect(readBoundedRegularFile('/approved/oversized', options, async () => handle, async () => ({ isFile: () => true, size: 4 }))).rejects.toThrow('too large');
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });

  it('reads at most the declared size plus one byte and rejects growth or shrinkage', async () => {
    const growthReads: number[] = []; const growthClose = vi.fn(async () => undefined);
    const growth: BoundedFileHandle = {
      stat: async () => ({ isFile: () => true, size: 2 }),
      read: async (buffer, offset, length) => {
        growthReads.push(length); Buffer.from([1, 2, 3]).copy(buffer, offset); return { bytesRead: 3 };
      },
      close: growthClose,
    };
    await expect(readBoundedRegularFile('/approved/growing', options, async () => growth, async () => ({ isFile: () => true, size: 2 }))).rejects.toThrow('changed');
    expect(growthReads).toEqual([3]); expect(growthClose).toHaveBeenCalledOnce();

    let call = 0; const shrinkClose = vi.fn(async () => undefined);
    const shrink: BoundedFileHandle = {
      stat: async () => ({ isFile: () => true, size: 3 }),
      read: async (buffer, offset) => {
        if (call++ > 0) return { bytesRead: 0 };
        Buffer.from([1, 2]).copy(buffer, offset); return { bytesRead: 2 };
      },
      close: shrinkClose,
    };
    await expect(readBoundedRegularFile('/approved/shrinking', options, async () => shrink, async () => ({ isFile: () => true, size: 3 }))).rejects.toThrow('changed');
    expect(shrinkClose).toHaveBeenCalledOnce();
  });

  it('routes every approved interchange/native/palette/relink reader through the shared cap', async () => {
    const [imports, sprites, persistence, main] = await Promise.all([
      readFile(join(process.cwd(), 'src/main/import-document.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/main/sprite-sheet-preview.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/main/persistence.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8'),
    ]);
    expect(imports).toContain('return readBoundedRegularFile(filePath');
    expect(sprites).toContain('return readBoundedRegularFile(filePath');
    expect(persistence).toContain('const bytes = await readBoundedRegularFile(filePath');
    expect(main).toContain('readApprovedPaletteSource(requestedPath)');
    expect(main).toContain('readApprovedProjectLinkSource(requestedPath');
    expect([imports, sprites, persistence, main].join('\n')).not.toContain('await readFile(');
  });
});
