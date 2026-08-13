import { mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DocumentPresetStore } from '@main/document-preset-store';

describe('document preset store', () => {
  it('round-trips strict reusable configurations and updates them atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-presets-'));
    const path = join(directory, 'settings', 'document-presets.json');
    const store = new DocumentPresetStore(path);
    const created = await store.save({ name: 'Tiny transparent', options: { kind: 'illustration', width: 128, height: 96, background: null } });
    expect(created).toMatchObject({ name: 'Tiny transparent', kind: 'illustration', options: { width: 128, height: 96, background: null } });

    const updated = await store.save({ id: created.id, name: 'Tiny paper', options: { kind: 'illustration', width: 160, height: 120, background: '#fffdf7' } });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.name).toBe('Tiny paper');
    await expect(new DocumentPresetStore(path).list()).resolves.toEqual([updated]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, presets: [{ id: created.id }] });
    await expect(store.delete(created.id)).resolves.toEqual({ deleted: true });
    await expect(new DocumentPresetStore(path).list()).resolves.toEqual([]);
  });

  it('ignores corrupt persisted entries and rejects invalid writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-presets-corrupt-'));
    const path = join(directory, 'document-presets.json');
    await writeFile(path, JSON.stringify({ version: 1, presets: [{ id: 'bad', name: '', kind: 'sprite', options: { kind: 'sprite', width: -1 }, createdAt: 'x', updatedAt: 'x' }] }));
    const store = new DocumentPresetStore(path);
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.save({ name: '', options: { kind: 'sprite', width: 32, height: 32 } })).rejects.toThrow('1 to 80');
    await expect(store.save({ name: 'Named document', options: { kind: 'sprite', name: 'Not reusable', width: 32, height: 32 } })).rejects.toThrow('cannot store');
  });

  it('serializes concurrent saves and preserves live presets when replacement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-presets-transactional-'));
    const path = join(directory, 'settings', 'document-presets.json');
    let replacementCount = 0;
    let rejectReplacement = false;
    let markFirstReplacement!: () => void;
    let releaseFirstReplacement!: () => void;
    const firstReplacement = new Promise<void>((resolve) => { markFirstReplacement = resolve; });
    const firstReplacementRelease = new Promise<void>((resolve) => { releaseFirstReplacement = resolve; });
    const store = new DocumentPresetStore(path, {
      replaceFile: async (source, destination) => {
        if (rejectReplacement) throw new Error('Injected document-preset replacement failure.');
        replacementCount += 1;
        if (replacementCount === 1) { markFirstReplacement(); await firstReplacementRelease; }
        await rename(source, destination);
      },
    });

    const firstSave = store.save({ name: 'Preset one', options: { kind: 'sprite', width: 16, height: 16 } });
    await firstReplacement;
    const secondSave = store.save({ name: 'Preset two', options: { kind: 'sprite', width: 32, height: 32 } });
    await Promise.resolve();
    expect(replacementCount).toBe(1);
    releaseFirstReplacement();
    const [first, second] = await Promise.all([firstSave, secondSave]);
    expect((await new DocumentPresetStore(path).list()).map((preset) => preset.id)).toEqual([first.id, second.id]);

    const beforeFailure = await readFile(path);
    rejectReplacement = true;
    await expect(store.save({ id: first.id, name: 'Phantom update', options: first.options })).rejects.toThrow('Injected document-preset replacement failure.');
    await expect(store.delete(first.id)).rejects.toThrow('Injected document-preset replacement failure.');
    expect(await readFile(path)).toEqual(beforeFailure);
    expect((await store.list()).find((preset) => preset.id === first.id)?.name).toBe('Preset one');
    expect((await readdir(join(directory, 'settings'))).filter((entry) => entry.startsWith('document-presets.json.') && entry.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
