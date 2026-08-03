import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HUMAN_ACTOR, createId, createIllustrationDocument, createPixelDocument, nowIso, type CanvasTransaction } from '@aidraw/core';
import { RecoveryJournal } from '@main/journal';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('crash recovery journal', () => {
  it('restores the latest snapshot and replays committed transactions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Before crash');
    await journal.compact(document);
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Rename', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Recovered drawing' }] };
    await journal.append(document.id, transaction);
    const recovered = await journal.recover();
    expect(recovered).toHaveLength(1); expect(recovered[0].name).toBe('Recovered drawing'); expect(recovered[0].dirty).toBe(true);
  });

  it('removes both committed and temporary recovery state for an explicit discard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createIllustrationDocument('Discard me');
    await journal.compact(document);
    await journal.remove(document.id);

    expect(await journal.read(document.id)).toEqual([]);
    expect(await journal.recover()).toEqual([]);
  });

  it('keeps the last good snapshot when a trailing agent transaction is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-recovery-')); temporaryPaths.push(root);
    const journal = new RecoveryJournal(root); const document = createPixelDocument('sprite', 'Good sprite snapshot');
    await journal.compact(document);
    const asset = document.pixelAssets[document.activeAssetId];
    const malformed = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Malformed nested sprite', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.replace', asset: { ...asset, cels: { broken: { id: 'broken' } } } }],
    } as unknown as CanvasTransaction;
    await journal.append(document.id, malformed);

    const recovered = await journal.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].name).toBe('Good sprite snapshot');
  });
});
