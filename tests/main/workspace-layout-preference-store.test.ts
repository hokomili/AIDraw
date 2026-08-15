import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument } from '@aidraw/core';
import {
  DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
  MAX_INSPECTOR_EXPANDED_WIDTH,
  MIN_INSPECTOR_EXPANDED_WIDTH,
  type WorkspaceLayoutPreferences,
} from '../../src/common/workspace-layout';
import { exportDocument } from '../../src/main/export-document';
import { writeNativeDocument } from '../../src/main/persistence';
import {
  INVALID_WORKSPACE_LAYOUT_PREFERENCE_WARNING,
  MAX_WORKSPACE_LAYOUT_PREFERENCE_FILE_BYTES,
  WorkspaceLayoutPreferenceStore,
} from '../../src/main/workspace-layout-preference-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(label: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `aidraw-workspace-layout-${label}-`));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'settings', 'workspace-layout.json') };
}

function preferences(overrides: Partial<WorkspaceLayoutPreferences> = {}): WorkspaceLayoutPreferences {
  return { ...DEFAULT_WORKSPACE_LAYOUT_PREFERENCES, ...overrides };
}

describe('main-owned workspace layout preference storage', () => {
  it('uses safe defaults, migrates the strict predecessor v1 value, and round-trips private v2 state', async () => {
    const value = await fixture('restart');
    const first = new WorkspaceLayoutPreferenceStore(value.path);
    await expect(first.bootstrap()).resolves.toEqual({ preferences: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES });

    const saved = preferences({ inspectorCollapsed: true, inspectorExpandedWidth: 472, mapSetupExpanded: true });
    await expect(first.save(saved)).resolves.toEqual(saved);
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 2, preferences: saved });
    if (process.platform !== 'win32') {
      expect((await stat(dirname(value.path))).mode & 0o777).toBe(0o700);
      expect((await stat(value.path)).mode & 0o777).toBe(0o600);
    }
    await expect(new WorkspaceLayoutPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences: saved });

    const predecessor = await fixture('version-one');
    await mkdir(dirname(predecessor.path), { recursive: true });
    await writeFile(predecessor.path, JSON.stringify({
      version: 1,
      preferences: { inspectorCollapsed: true, inspectorExpandedWidth: 456 },
    }));
    await expect(new WorkspaceLayoutPreferenceStore(predecessor.path).bootstrap()).resolves.toEqual({
      preferences: { inspectorCollapsed: true, inspectorExpandedWidth: 456, mapSetupExpanded: false },
    });
  });

  it('rejects partial, unknown, invalid, and oversized files as a whole and warns once', async () => {
    const cases: Array<string | Buffer> = [
      JSON.stringify({ version: 1, preferences: { inspectorCollapsed: true } }),
      JSON.stringify({ version: 1, preferences: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES }),
      JSON.stringify({ version: 1, preferences: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES, unexpected: true }),
      JSON.stringify({ version: 2, preferences: { inspectorCollapsed: false, inspectorExpandedWidth: 318 } }),
      JSON.stringify({ version: 3, preferences: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES }),
      JSON.stringify({ version: 2, preferences: preferences({ inspectorExpandedWidth: MIN_INSPECTOR_EXPANDED_WIDTH - 1 }) }),
      JSON.stringify({ version: 2, preferences: preferences({ inspectorExpandedWidth: MAX_INSPECTOR_EXPANDED_WIDTH + 1 }) }),
      Buffer.alloc(MAX_WORKSPACE_LAYOUT_PREFERENCE_FILE_BYTES + 1, 0x78),
    ];

    for (const [index, contents] of cases.entries()) {
      const value = await fixture(`invalid-${index}`);
      await mkdir(dirname(value.path), { recursive: true });
      await writeFile(value.path, contents);
      const prior = await readFile(value.path);
      const store = new WorkspaceLayoutPreferenceStore(value.path);
      await expect(store.bootstrap()).resolves.toEqual({
        preferences: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES,
        warning: INVALID_WORKSPACE_LAYOUT_PREFERENCE_WARNING,
      });
      await expect(store.bootstrap()).resolves.toEqual({ preferences: DEFAULT_WORKSPACE_LAYOUT_PREFERENCES });
      expect(await readFile(value.path)).toEqual(prior);
    }
  });

  it('serializes rapid saves, preserves predecessor bytes on failure, and permits a later retry', async () => {
    const value = await fixture('ordering');
    const initial = preferences({ inspectorExpandedWidth: 336 });
    await new WorkspaceLayoutPreferenceStore(value.path).save(initial);

    let replacements = 0;
    let failNext = false;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const replaceFile = vi.fn(async (source: string, destination: string) => {
      replacements += 1;
      if (failNext) { failNext = false; throw new Error('Injected workspace layout replacement failure.'); }
      if (replacements === 1) { markFirstStarted(); await firstRelease; }
      await rename(source, destination);
    });
    const store = new WorkspaceLayoutPreferenceStore(value.path, { replaceFile });
    await store.initialize();
    const first = preferences({ inspectorCollapsed: true, inspectorExpandedWidth: 360, mapSetupExpanded: true });
    const second = preferences({ inspectorCollapsed: false, inspectorExpandedWidth: 488, mapSetupExpanded: false });
    const firstSave = store.save(first);
    await firstStarted;
    const secondSave = store.save(second);
    const laterBootstrap = store.bootstrap();
    await Promise.resolve();
    expect(replaceFile).toHaveBeenCalledOnce();
    releaseFirst();

    await expect(Promise.all([firstSave, secondSave])).resolves.toEqual([first, second]);
    await expect(laterBootstrap).resolves.toEqual({ preferences: second });
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({ version: 2, preferences: second });

    const prior = await readFile(value.path);
    const third = preferences({ inspectorCollapsed: true, inspectorExpandedWidth: 504, mapSetupExpanded: true });
    failNext = true;
    await expect(store.save(third)).rejects.toThrow('Injected workspace layout replacement failure.');
    expect(await readFile(value.path)).toEqual(prior);
    await expect(store.bootstrap()).resolves.toEqual({ preferences: second });
    expect((await readdir(dirname(value.path))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

    await expect(store.save(third)).resolves.toEqual(third);
    await expect(new WorkspaceLayoutPreferenceStore(value.path).bootstrap()).resolves.toEqual({ preferences: third });
  });

  it('does not alter canonical state, native entries, or export output', async () => {
    const value = await fixture('document-invariance');
    const document = createPixelDocument('sprite', 'Workspace layout invariance');
    const canonicalBefore = structuredClone(document);
    const exportBefore = await exportDocument(document, 'png');
    const nativeBeforePath = await writeNativeDocument(join(value.directory, 'before.aidraw'), document, 'test');
    const nativeBefore = unzipSync(new Uint8Array(await readFile(nativeBeforePath)));

    await new WorkspaceLayoutPreferenceStore(value.path).save(preferences({ inspectorCollapsed: true, inspectorExpandedWidth: 480, mapSetupExpanded: true }));

    const exportAfter = await exportDocument(document, 'png');
    const nativeAfterPath = await writeNativeDocument(join(value.directory, 'after.aidraw'), document, 'test');
    const nativeAfter = unzipSync(new Uint8Array(await readFile(nativeAfterPath)));
    expect(document).toEqual(canonicalBefore);
    expect(exportAfter).toEqual(exportBefore);
    expect(Object.keys(nativeAfter).sort()).toEqual(Object.keys(nativeBefore).sort());
    for (const name of Object.keys(nativeBefore)) expect(nativeAfter[name]).toEqual(nativeBefore[name]);
    expect(Buffer.from(nativeAfter['document.json']).toString('utf8')).not.toContain('inspectorExpandedWidth');
    expect(Buffer.from(nativeAfter['document.json']).toString('utf8')).not.toContain('mapSetupExpanded');
  });
});
