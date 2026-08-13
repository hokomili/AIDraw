import { mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR } from '@aidraw/core';
import { InterchangeReportStore } from '@main/interchange-report-store';

describe('interchange report store', () => {
  it('persists inspectable fidelity details and filters them by document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-reports-'));
    const path = join(directory, 'reports', 'interchange.json');
    const store = new InterchangeReportStore(path);
    const fidelity = [{ code: 'flattened-layer' as const, subjectType: 'layer' as const, subjectId: 'layer-glow', subjectName: 'Glow layer', detail: 'A group mask requires flattening.' }];
    const report = await store.record({ kind: 'export', status: 'completed', actor: HUMAN_ACTOR, documentIds: ['doc-a'], documentNames: ['Poster'], format: 'psd', sourcePaths: [], destinationPaths: ['C:/art/poster.psd'], warnings: ['One effect was flattened.'], rasterized: ['Glow layer'], fidelity });
    expect(report).toMatchObject({ kind: 'export', format: 'psd', warnings: ['One effect was flattened.'], rasterized: ['Glow layer'], fidelity });
    await expect(new InterchangeReportStore(path).list('doc-a')).resolves.toEqual([report]);
    await expect(new InterchangeReportStore(path).list('doc-b')).resolves.toEqual([]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, reports: [{ id: report.id }] });
  });

  it('ignores invalid persisted reports without blocking startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-reports-corrupt-'));
    const path = join(directory, 'interchange.json');
    await writeFile(path, JSON.stringify({ version: 1, reports: [{ id: 'bad', kind: 'delete-everything' }] }));
    await expect(new InterchangeReportStore(path).list()).resolves.toEqual([]);
  });

  it('loads version-one reports created before structured reasons as an empty list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-reports-legacy-'));
    const path = join(directory, 'interchange.json');
    await writeFile(path, JSON.stringify({ version: 1, reports: [{ id: 'legacy', kind: 'export', status: 'completed', actor: HUMAN_ACTOR, createdAt: '2026-01-01T00:00:00.000Z', documentIds: ['doc-a'], documentNames: ['Poster'], format: 'png', sourcePaths: [], destinationPaths: ['poster.png'], warnings: [], rasterized: [] }] }));
    await expect(new InterchangeReportStore(path).list()).resolves.toMatchObject([{ id: 'legacy', fidelity: [] }]);
  });

  it('serializes concurrent records and preserves live reports when replacement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-reports-transactional-'));
    const path = join(directory, 'reports', 'interchange.json');
    let replacementCount = 0;
    let rejectReplacement = false;
    let markFirstReplacement!: () => void;
    let releaseFirstReplacement!: () => void;
    const firstReplacement = new Promise<void>((resolve) => { markFirstReplacement = resolve; });
    const firstReplacementRelease = new Promise<void>((resolve) => { releaseFirstReplacement = resolve; });
    const store = new InterchangeReportStore(path, {
      replaceFile: async (source, destination) => {
        if (rejectReplacement) throw new Error('Injected interchange-report replacement failure.');
        replacementCount += 1;
        if (replacementCount === 1) { markFirstReplacement(); await firstReplacementRelease; }
        await rename(source, destination);
      },
    });
    const input = (documentId: string): Parameters<InterchangeReportStore['record']>[0] => ({
      kind: 'export',
      status: 'completed',
      actor: HUMAN_ACTOR,
      documentIds: [documentId],
      documentNames: [documentId],
      format: 'png',
      sourcePaths: [],
      destinationPaths: [`${documentId}.png`],
      warnings: [],
      rasterized: [],
      fidelity: [],
    });

    const firstRecord = store.record(input('doc-one'));
    await firstReplacement;
    const secondRecord = store.record(input('doc-two'));
    await Promise.resolve();
    expect(replacementCount).toBe(1);
    releaseFirstReplacement();
    const [first, second] = await Promise.all([firstRecord, secondRecord]);
    expect((await new InterchangeReportStore(path).list()).map((report) => report.id)).toEqual([second.id, first.id]);

    const beforeFailure = await readFile(path);
    rejectReplacement = true;
    await expect(store.record(input('doc-phantom'))).rejects.toThrow('Injected interchange-report replacement failure.');
    expect(await readFile(path)).toEqual(beforeFailure);
    expect((await store.list()).map((report) => report.id)).toEqual([second.id, first.id]);
    expect((await readdir(join(directory, 'reports'))).filter((entry) => entry.startsWith('interchange.json.') && entry.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
