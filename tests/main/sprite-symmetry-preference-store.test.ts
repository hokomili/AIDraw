import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument } from '@aidraw/core';
import { DEFAULT_SPRITE_SYMMETRY_PREFERENCES, type SpriteSymmetryPreferences } from '../../src/common/sprite-symmetry';
import {
  INVALID_SPRITE_SYMMETRY_PREFERENCE_WARNING,
  MAX_SPRITE_SYMMETRY_PREFERENCE_FILE_BYTES,
  SpriteSymmetryPreferenceStore,
} from '../../src/main/sprite-symmetry-preference-store';
import { exportDocument } from '../../src/main/export-document';
import { writeNativeDocument } from '../../src/main/persistence';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture(label: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `aidraw-symmetry-preferences-${label}-`));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'settings', 'sprite-symmetry.json') };
}

function preferences(horizontalAxis = 2.5): SpriteSymmetryPreferences {
  return { mode: 'both', bindings: [{ documentId: 'doc', spriteId: 'sprite', width: 8, height: 6, horizontalAxis, verticalAxis: 3 }] };
}

describe('main-owned sprite symmetry preference storage', () => {
  it('uses safe defaults when missing and round-trips one strict private v1 value across restart', async () => {
    const value = await fixture('restart');
    const first = new SpriteSymmetryPreferenceStore(value.path);
    await expect(first.bootstrap()).resolves.toEqual({ preferences: DEFAULT_SPRITE_SYMMETRY_PREFERENCES });
    const saved = preferences();
    await expect(first.save(saved)).resolves.toEqual(saved);
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 1, preferences: saved });
    if (process.platform !== 'win32') {
      expect((await stat(dirname(value.path))).mode & 0o777).toBe(0o700);
      expect((await stat(value.path)).mode & 0o777).toBe(0o600);
    }
    await expect(new SpriteSymmetryPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences: saved });
  });

  it('rejects malformed complete files as a whole, preserves them, and warns only once', async () => {
    const cases: Array<string | Buffer> = [
      JSON.stringify({ version: 1, preferences: { mode: 'both', bindings: [{ documentId: 'doc' }] } }),
      JSON.stringify({ version: 2, preferences: preferences() }),
      JSON.stringify({ version: 1, preferences: preferences(), extra: true }),
      Buffer.alloc(MAX_SPRITE_SYMMETRY_PREFERENCE_FILE_BYTES + 1, 0x78),
    ];
    for (const [index, contents] of cases.entries()) {
      const value = await fixture(`invalid-${index}`);
      await mkdir(dirname(value.path), { recursive: true }); await writeFile(value.path, contents);
      const prior = await readFile(value.path); const store = new SpriteSymmetryPreferenceStore(value.path);
      await expect(store.bootstrap()).resolves.toEqual({ preferences: DEFAULT_SPRITE_SYMMETRY_PREFERENCES, warning: INVALID_SPRITE_SYMMETRY_PREFERENCE_WARNING });
      await expect(store.bootstrap()).resolves.toEqual({ preferences: DEFAULT_SPRITE_SYMMETRY_PREFERENCES });
      expect(await readFile(value.path)).toEqual(prior);
    }
  });

  it('serializes rapid saves and remains retryable without replacing prior durable bytes on failure', async () => {
    const value = await fixture('ordering');
    const initial = preferences(1); await new SpriteSymmetryPreferenceStore(value.path).save(initial);
    let replacements = 0; let failNext = false; let start!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; }); const released = new Promise<void>((resolve) => { release = resolve; });
    const replaceFile = vi.fn(async (source: string, destination: string) => {
      replacements += 1; if (failNext) { failNext = false; throw new Error('Injected symmetry preference replacement failure.'); }
      if (replacements === 1) { start(); await released; } await rename(source, destination);
    });
    const store = new SpriteSymmetryPreferenceStore(value.path, { replaceFile }); await store.initialize();
    const first = preferences(1.5); const second = preferences(2.5);
    const firstSave = store.save(first); await started; const secondSave = store.save(second); const bootstrap = store.bootstrap(); release();
    await expect(Promise.all([firstSave, secondSave])).resolves.toEqual([first, second]);
    await expect(bootstrap).resolves.toEqual({ preferences: second });
    const prior = await readFile(value.path); failNext = true;
    await expect(store.save(preferences(3.5))).rejects.toThrow('Injected symmetry preference replacement failure.');
    expect(await readFile(value.path)).toEqual(prior);
    expect((await readdir(dirname(value.path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    await expect(store.save(preferences(3.5))).resolves.toEqual(preferences(3.5));
  });

  it('does not alter canonical state, activity/history, native entries, or export output', async () => {
    const value = await fixture('document-invariance');
    const document = createPixelDocument('sprite', 'Symmetry preference invariance');
    const canonicalBefore = structuredClone(document);
    const exportBefore = await exportDocument(document, 'png');
    const nativeBefore = unzipSync(new Uint8Array(await readFile(await writeNativeDocument(join(value.directory, 'before.aidraw'), document, 'test'))));

    await new SpriteSymmetryPreferenceStore(value.path).save(preferences());

    const exportAfter = await exportDocument(document, 'png');
    const nativeAfter = unzipSync(new Uint8Array(await readFile(await writeNativeDocument(join(value.directory, 'after.aidraw'), document, 'test'))));
    expect(document).toEqual(canonicalBefore);
    expect(document.activity).toEqual(canonicalBefore.activity);
    expect(exportAfter).toEqual(exportBefore);
    expect(Object.keys(nativeAfter).sort()).toEqual(Object.keys(nativeBefore).sort());
    for (const name of Object.keys(nativeBefore)) expect(nativeAfter[name]).toEqual(nativeBefore[name]);
    expect(Buffer.from(nativeAfter['document.json']).toString('utf8')).not.toContain('symmetry');
  });
});
