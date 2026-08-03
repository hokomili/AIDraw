import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createId, nowIso, type Actor, type CanvasTransaction } from '@aidraw/core';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { TransactionTraceStore } from '@main/trace-store';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('durable autonomous transaction traces', () => {
  it('survives recovery compaction and retains the complete attributed transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-trace-'));
    temporaryPaths.push(root);
    const journal = new RecoveryJournal(join(root, 'recovery'));
    const traces = new TransactionTraceStore(join(root, 'traces'));
    const service = new DocumentService(journal, '1.0.0', traces);
    service.initialize();
    await service.compactRecovery();
    const document = service.snapshot().activeDocument!;
    const actor: Actor = { id: 'agent-headless', kind: 'agent', name: 'Headless agent', color: '#2fa7a0' };
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: 'headless-rename', documentId: document.id, actor,
      label: 'Autonomous rename', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Made headlessly' }],
      playback: { mode: 'animated', speed: 1 },
    };

    expect((await service.apply(transaction)).status).toBe('committed');
    await service.compactRecovery();
    const entries = await traces.list(document.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ documentId: document.id, revision: 1, outcome: 'committed' });
    const { createdAt: committedAt, ...committedTransaction } = entries[0].transaction;
    const { createdAt: proposedAt, ...proposedTransaction } = transaction;
    expect(committedTransaction).toEqual(proposedTransaction);
    expect(Number.isNaN(Date.parse(committedAt))).toBe(false);
    expect(Date.parse(committedAt)).toBeGreaterThanOrEqual(Date.parse(proposedAt));

    const recovered = new DocumentService(journal, '1.0.0', traces);
    expect(await recovered.recover()).toBe(1);
    expect(recovered.getDocument(document.id)?.name).toBe('Made headlessly');
    expect((await recovered.findTrace(document.id, transaction.id))?.transaction.actor.name).toBe('Headless agent');
  });
});
