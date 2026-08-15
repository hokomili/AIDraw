import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument } from '@aidraw/core';
import {
  SHORTCUT_ACTION_IDS_V1,
  assignShortcut,
  defaultShortcutPreferences,
  type ShortcutPreferences,
} from '../../src/common/shortcut-preferences';
import { exportDocument } from '../../src/main/export-document';
import { writeNativeDocument } from '../../src/main/persistence';
import {
  INVALID_SHORTCUT_PREFERENCE_WARNING,
  MAX_SHORTCUT_PREFERENCE_FILE_BYTES,
  ShortcutPreferenceStore,
} from '../../src/main/shortcut-preference-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(label: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `aidraw-shortcuts-${label}-`));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'settings', 'shortcuts.json') };
}

function assigned(actionId: Parameters<typeof assignShortcut>[1], chord: string): ShortcutPreferences {
  const result = assignShortcut(defaultShortcutPreferences(), actionId, chord);
  if (!result.accepted) throw new Error(result.reason);
  return result.preferences;
}

function versionOnePreferences(): { bindings: Record<string, string> } {
  const defaults = defaultShortcutPreferences();
  return {
    bindings: Object.fromEntries(SHORTCUT_ACTION_IDS_V1.map((id) => [id, defaults.bindings[id]])),
  };
}

describe('main-owned shortcut preference storage', () => {
  it('uses complete defaults when missing and round-trips one strict private v2 map across restart', async () => {
    const value = await fixture('restart');
    await expect(new ShortcutPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences: defaultShortcutPreferences() });
    const preferences = assigned('toggle-inspector', 'Primary+B');
    await new ShortcutPreferenceStore(value.path).save(preferences);
    await expect(new ShortcutPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences });
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 2, preferences });
  });

  it('hydrates an exact v1 map without rewriting it, preserves every old remap, and allocates only new actions', async () => {
    const value = await fixture('v1-migration');
    const legacy = versionOnePreferences();
    legacy.bindings['tool:illustration:select'] = 'D';
    legacy.bindings['tool:pixel:wand'] = 'C';
    const bytes = Buffer.from(JSON.stringify({ version: 1, preferences: legacy }));
    await mkdir(dirname(value.path), { recursive: true });
    await writeFile(value.path, bytes);

    const bootstrap = await new ShortcutPreferenceStore(value.path).bootstrap();
    for (const id of SHORTCUT_ACTION_IDS_V1) expect(bootstrap.preferences.bindings[id]).toBe(legacy.bindings[id]);
    expect(bootstrap.preferences.bindings['tool:illustration:node']).toBe('F');
    expect(bootstrap.preferences.bindings['tool:illustration:crop']).toBe('C');
    expect(bootstrap.preferences.bindings['tool:pixel:replace']).toBe('A');
    expect(await readFile(value.path)).toEqual(bytes);

    await new ShortcutPreferenceStore(value.path).save(bootstrap.preferences);
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({
      version: 2,
      preferences: bootstrap.preferences,
    });
  });

  it('rejects partial, unknown, conflicting, and oversized durable maps as a whole and warns once', async () => {
    const defaults = defaultShortcutPreferences();
    const partial = structuredClone(defaults) as { bindings: Record<string, string> };
    delete partial.bindings['tool:pixel:tile-object'];
    const partialV1 = versionOnePreferences();
    delete partialV1.bindings['tool:pixel:fill'];
    const cases: Array<string | Buffer> = [
      JSON.stringify({ version: 2, preferences: partial }),
      JSON.stringify({ version: 2, preferences: { bindings: { ...defaults.bindings, unexpected: 'K' } } }),
      JSON.stringify({ version: 2, preferences: { bindings: { ...defaults.bindings, 'tool:pixel:fill': 'E' } } }),
      JSON.stringify({ version: 1, preferences: partialV1 }),
      JSON.stringify({ version: 1, preferences: { bindings: { ...versionOnePreferences().bindings, unexpected: 'K' } } }),
      JSON.stringify({ version: 1, preferences: { bindings: { ...versionOnePreferences().bindings, 'tool:pixel:fill': 'E' } } }),
      JSON.stringify({ version: 3, preferences: defaults }),
      Buffer.alloc(MAX_SHORTCUT_PREFERENCE_FILE_BYTES + 1, 0x78),
    ];
    for (const [index, contents] of cases.entries()) {
      const value = await fixture(`invalid-${index}`);
      await mkdir(dirname(value.path), { recursive: true });
      await writeFile(value.path, contents);
      const prior = await readFile(value.path);
      const store = new ShortcutPreferenceStore(value.path);
      await expect(store.bootstrap()).resolves.toEqual({
        preferences: defaults,
        warning: INVALID_SHORTCUT_PREFERENCE_WARNING,
      });
      await expect(store.bootstrap()).resolves.toEqual({ preferences: defaults });
      expect(await readFile(value.path)).toEqual(prior);
    }
  });

  it('serializes rapid saves, preserves predecessor bytes on failure, and permits a later retry', async () => {
    const value = await fixture('ordering');
    const initial = assigned('toggle-inspector', 'Primary+B');
    await new ShortcutPreferenceStore(value.path).save(initial);
    let replacements = 0;
    let failNext = false;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const replaceFile = vi.fn(async (source: string, destination: string) => {
      replacements += 1;
      if (failNext) { failNext = false; throw new Error('Injected shortcut replacement failure.'); }
      if (replacements === 1) { markFirstStarted(); await firstRelease; }
      await rename(source, destination);
    });
    const store = new ShortcutPreferenceStore(value.path, { replaceFile });
    await store.initialize();
    const first = assigned('toggle-inspector', 'Primary+G');
    const second = assigned('toggle-inspector', 'Primary+K');
    const firstSave = store.save(first);
    await firstStarted;
    const secondSave = store.save(second);
    const laterBootstrap = store.bootstrap();
    releaseFirst();
    await expect(Promise.all([firstSave, secondSave])).resolves.toEqual([first, second]);
    await expect(laterBootstrap).resolves.toEqual({ preferences: second });
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 2, preferences: second });

    const prior = await readFile(value.path);
    const third = assigned('toggle-inspector', 'Primary+L');
    failNext = true;
    await expect(store.save(third)).rejects.toThrow('Injected shortcut replacement failure.');
    expect(await readFile(value.path)).toEqual(prior);
    expect((await readdir(dirname(value.path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    await expect(store.save(third)).resolves.toEqual(third);
    await expect(new ShortcutPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences: third });
  });

  it('does not alter canonical state, native entries, or export output', async () => {
    const value = await fixture('invariance');
    const document = createPixelDocument('sprite', 'Shortcut invariance');
    const canonicalBefore = structuredClone(document);
    const exportBefore = await exportDocument(document, 'png');
    const nativeBefore = unzipSync(new Uint8Array(await readFile(await writeNativeDocument(join(value.directory, 'before.aidraw'), document, 'test'))));

    await new ShortcutPreferenceStore(value.path).save(assigned('tool:pixel:pencil', 'Q'));

    const exportAfter = await exportDocument(document, 'png');
    const nativeAfter = unzipSync(new Uint8Array(await readFile(await writeNativeDocument(join(value.directory, 'after.aidraw'), document, 'test'))));
    expect(document).toEqual(canonicalBefore);
    expect(exportAfter).toEqual(exportBefore);
    expect(Object.keys(nativeAfter).sort()).toEqual(Object.keys(nativeBefore).sort());
    for (const name of Object.keys(nativeBefore)) expect(nativeAfter[name]).toEqual(nativeBefore[name]);
    expect(Buffer.from(nativeAfter['document.json']).toString('utf8')).not.toContain('shortcut');
  });
});
