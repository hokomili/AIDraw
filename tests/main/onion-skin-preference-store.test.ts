import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument } from '@aidraw/core';
import {
  DEFAULT_ONION_SKIN_PREFERENCES,
  type OnionSkinPreferences,
} from '../../src/common/onion-skin';
import { exportDocument } from '../../src/main/export-document';
import {
  INVALID_ONION_SKIN_PREFERENCE_WARNING,
  MAX_ONION_SKIN_PREFERENCE_FILE_BYTES,
  OnionSkinPreferenceStore,
} from '../../src/main/onion-skin-preference-store';
import { writeNativeDocument } from '../../src/main/persistence';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(label: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `aidraw-onion-preferences-${label}-`));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'settings', 'onion-skin.json') };
}

function preferences(overrides: Partial<OnionSkinPreferences> = {}): OnionSkinPreferences {
  return { ...DEFAULT_ONION_SKIN_PREFERENCES, ...overrides };
}

describe('main-owned onion skin preference storage', () => {
  it('uses safe defaults when missing and round-trips one strict private v1 value across restart', async () => {
    const value = await fixture('restart');
    const first = new OnionSkinPreferenceStore(value.path);
    await expect(first.bootstrap()).resolves.toEqual({ preferences: DEFAULT_ONION_SKIN_PREFERENCES });

    const saved = preferences({ enabled: false, previousFrames: 4, nextFrames: 0, previousOpacity: 0.75, nextOpacity: 0.25, previousTint: '#123ABC', nextTint: '#fedCBA' });
    await expect(first.save(saved)).resolves.toEqual(saved);
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 1, preferences: saved });
    if (process.platform !== 'win32') {
      expect((await stat(dirname(value.path))).mode & 0o777).toBe(0o700);
      expect((await stat(value.path)).mode & 0o777).toBe(0o600);
    }

    const restarted = new OnionSkinPreferenceStore(value.path);
    await expect(restarted.bootstrap()).resolves.toEqual({ preferences: saved });
  });

  it('rejects partial, unknown, invalid, and oversized files without partially hydrating and warns once', async () => {
    const cases: Array<string | Buffer> = [
      JSON.stringify({ version: 1, preferences: { ...DEFAULT_ONION_SKIN_PREFERENCES, enabled: false, nextTint: undefined } }),
      JSON.stringify({ version: 1, preferences: DEFAULT_ONION_SKIN_PREFERENCES, unexpected: true }),
      JSON.stringify({ version: 2, preferences: preferences({ previousFrames: 4 }) }),
      JSON.stringify({ version: 1, preferences: preferences({ previousFrames: 5 }) }),
      Buffer.alloc(MAX_ONION_SKIN_PREFERENCE_FILE_BYTES + 1, 0x78),
    ];

    for (const [index, contents] of cases.entries()) {
      const value = await fixture(`invalid-${index}`);
      await mkdir(dirname(value.path), { recursive: true });
      await writeFile(value.path, contents);
      const prior = await readFile(value.path);
      const store = new OnionSkinPreferenceStore(value.path);
      await expect(store.bootstrap()).resolves.toEqual({
        preferences: DEFAULT_ONION_SKIN_PREFERENCES,
        warning: INVALID_ONION_SKIN_PREFERENCE_WARNING,
      });
      await expect(store.bootstrap()).resolves.toEqual({ preferences: DEFAULT_ONION_SKIN_PREFERENCES });
      expect(await readFile(value.path)).toEqual(prior);
    }
  });

  it('serializes rapid saves, hydrates the latest successful intent, and recovers after replacement failure', async () => {
    const value = await fixture('ordering');
    const initial = preferences({ previousFrames: 2 });
    await new OnionSkinPreferenceStore(value.path).save(initial);

    let replacements = 0;
    let failNext = false;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const replaceFile = vi.fn(async (source: string, destination: string) => {
      replacements += 1;
      if (failNext) { failNext = false; throw new Error('Injected onion preference replacement failure.'); }
      if (replacements === 1) { markFirstStarted(); await firstRelease; }
      await rename(source, destination);
    });
    const store = new OnionSkinPreferenceStore(value.path, { replaceFile });
    await store.initialize();
    const first = preferences({ enabled: false, previousFrames: 3 });
    const second = preferences({ enabled: true, previousFrames: 4, nextTint: '#112233' });
    const firstSave = store.save(first);
    await firstStarted;
    const secondSave = store.save(second);
    const laterBootstrap = store.bootstrap();
    await Promise.resolve();
    expect(replaceFile).toHaveBeenCalledOnce();
    releaseFirst();

    await expect(Promise.all([firstSave, secondSave])).resolves.toEqual([first, second]);
    await expect(laterBootstrap).resolves.toEqual({ preferences: second });
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 1, preferences: second });

    const prior = await readFile(value.path);
    const third = preferences({ enabled: false, nextFrames: 4, previousTint: '#A0B0C0' });
    failNext = true;
    await expect(store.save(third)).rejects.toThrow('Injected onion preference replacement failure.');
    expect(await readFile(value.path)).toEqual(prior);
    await expect(store.bootstrap()).resolves.toEqual({ preferences: second });
    expect((await readdir(dirname(value.path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

    await expect(store.save(third)).resolves.toEqual(third);
    await expect(new OnionSkinPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences: third });
  });

  it('does not alter canonical document state, native entries, or export output', async () => {
    const value = await fixture('document-invariance');
    const document = createPixelDocument('sprite', 'Onion preference invariance');
    const canonicalBefore = structuredClone(document);
    const exportBefore = await exportDocument(document, 'png');
    const nativeBeforePath = await writeNativeDocument(join(value.directory, 'before.aidraw'), document, 'test');
    const nativeBefore = unzipSync(new Uint8Array(await readFile(nativeBeforePath)));

    await new OnionSkinPreferenceStore(value.path).save(preferences({ enabled: false, previousFrames: 4, nextOpacity: 0.9 }));

    const exportAfter = await exportDocument(document, 'png');
    const nativeAfterPath = await writeNativeDocument(join(value.directory, 'after.aidraw'), document, 'test');
    const nativeAfter = unzipSync(new Uint8Array(await readFile(nativeAfterPath)));
    expect(document).toEqual(canonicalBefore);
    expect(exportAfter).toEqual(exportBefore);
    expect(Object.keys(nativeAfter).sort()).toEqual(Object.keys(nativeBefore).sort());
    for (const name of Object.keys(nativeBefore)) expect(nativeAfter[name]).toEqual(nativeBefore[name]);
    expect(Buffer.from(nativeAfter['document.json']).toString('utf8')).not.toContain('onionSkin');
  });
});
