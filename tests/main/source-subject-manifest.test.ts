import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSourceSubjectManifest,
  parsePorcelainV1Z,
  summarizeSourceSubjectManifest,
} from '../../scripts/source-subject-manifest.mjs';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('source-subject manifest', () => {
  it('represents a clean source subject as an exact empty manifest', async () => {
    const manifest = await buildSourceSubjectManifest(process.cwd(), Buffer.alloc(0));
    expect(manifest.records).toEqual([]);
    expect(manifest.bytes).toEqual(Buffer.alloc(0));
    expect(summarizeSourceSubjectManifest(manifest)).toMatchObject({
      clean: true,
      finalNewline: false,
      entries: 0,
      bytes: 0,
      sha256: createHash('sha256').digest('hex'),
    });
  });

  it('hashes and raw-byte-sorts a synthetic wholly unstaged subject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-source-subject-'));
    temporaryPaths.push(root);
    await writeFile(join(root, 'zeta.txt'), 'zeta');
    await writeFile(join(root, 'alpha.txt'), 'alpha');
    const status = Buffer.from('?? zeta.txt\0 M alpha.txt\0 D removed.txt\0');

    const manifest = await buildSourceSubjectManifest(root, status);
    expect(manifest.records.map((record) => record.path)).toEqual(['alpha.txt', 'removed.txt', 'zeta.txt']);
    expect(manifest.bytes.at(-1)).toBe(0x0a);
    expect(summarizeSourceSubjectManifest(manifest)).toMatchObject({
      clean: false,
      finalNewline: true,
      entries: 3,
      modified: 1,
      deleted: 1,
      added: 1,
    });
  });

  it('continues to reject staged, renamed, and malformed candidate records', () => {
    expect(() => parsePorcelainV1Z(Buffer.from('M  staged.txt\0'))).toThrow('empty Git index');
    expect(() => parsePorcelainV1Z(Buffer.from('R  renamed.txt\0old.txt\0'))).toThrow('Rename/copy');
    expect(() => parsePorcelainV1Z(Buffer.from('?? unterminated.txt'))).toThrow('final NUL');
  });
});
