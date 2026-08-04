import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nowIso, type Actor, type CanvasTransaction } from '@aidraw/core';
import { BatchManager } from '../../src/main/batch-manager';
import { DocumentService } from '../../src/main/document-service';
import { RecoveryJournal } from '../../src/main/journal';
import { TransactionTraceStore } from '../../src/main/trace-store';

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const firstActor: Actor = { id: 'batch-agent-a', kind: 'agent', name: 'Batch A', color: '#8268dd' };
const secondActor: Actor = { id: 'batch-agent-b', kind: 'agent', name: 'Batch B', color: '#2fa7a0' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-batch-')); temporaryPaths.push(root);
  const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces')));
  documents.initialize();
  const manager = new BatchManager(documents, join(root, 'batches.json'));
  await manager.initialize();
  return { root, documents, manager, document: documents.snapshot().activeDocument! };
}

function renameTransaction(documentId: string, clientOperationId: string, actor: Actor, name: string): CanvasTransaction {
  return { id: `tx-${clientOperationId}`, clientOperationId, documentId, actor, label: name, createdAt: nowIso(), operations: [{ kind: 'document.rename', name }], playback: { mode: 'instant', speed: 1 } };
}

describe('durable transaction batch manager', () => {
  it('sequences commits, reports idempotent retries, and preserves committed work on cancellation', async () => {
    const { documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 3, 'Three-step creature', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    expect(await manager.prepare(metadata, document.id, 'batch-step-0', firstActor)).toMatchObject({ accepted: true, expectedSequence: 0 });
    const committed = await documents.apply(renameTransaction(document.id, 'batch-step-0', firstActor, 'Step zero'));
    expect(committed.status).toBe('committed');
    const progressed = await manager.finish(metadata, 'batch-step-0', committed);
    expect(progressed).toMatchObject({ kind: 'batch', status: 'queued', progress: 1 / 3, result: { nextSequence: 1, totalTransactions: 3 } });
    expect(await manager.prepare(metadata, document.id, 'batch-step-0', firstActor)).toMatchObject({ accepted: false, duplicate: true, expectedSequence: 1, response: { status: 'duplicate' } });
    expect(await manager.prepare({ ...metadata, sequence: 2 }, document.id, 'batch-step-2', firstActor)).toMatchObject({ accepted: false, expectedSequence: 1, response: { status: 'conflict' } });
    expect(await manager.cancel(started.job.id, firstActor.id)).toMatchObject({ status: 'cancelled', progress: 1 / 3 });
    expect(await manager.prepare({ ...metadata, sequence: 1 }, document.id, 'batch-step-1', firstActor)).toMatchObject({ accepted: false, response: { status: 'cancelled' } });
    expect(documents.getDocument(document.id)?.name).toBe('Step zero');
  });

  it('requires the opaque resume token and rebinds ownership to a new authenticated session', async () => {
    const { manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Reconnectable batch', firstActor);
    expect(await manager.resume(started.job.id, 'not-the-token-but-long-enough-to-parse', secondActor)).toBeUndefined();
    const resumed = await manager.resume(started.job.id, started.resumeToken, secondActor);
    expect(resumed).toMatchObject({ actor: secondActor, status: 'queued', result: { nextSequence: 0 } });
  });

  it('reconciles a crash after canonical commit from the durable transaction trace', async () => {
    const { root, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Crash-safe batch', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    await manager.prepare(metadata, document.id, 'crash-window-step', firstActor);
    expect(await documents.apply(renameTransaction(document.id, 'crash-window-step', firstActor, 'Committed before crash'))).toMatchObject({ status: 'committed' });
    await manager.flush();

    const recovered = new BatchManager(documents, join(root, 'batches.json'));
    await recovered.initialize();
    const resumed = await recovered.resume(started.job.id, started.resumeToken, secondActor);
    expect(resumed).toMatchObject({ status: 'queued', progress: 0.5, result: { nextSequence: 1, transactionIds: ['tx-crash-window-step'] } });
    expect(resumed?.message).toMatch(/Recovered 1 of 2|Resume at transaction 2/);
  });

  it('reopens an uncommitted in-flight chunk at the same sequence', async () => {
    const { root, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Interrupted batch', firstActor);
    await manager.prepare({ jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 }, document.id, 'never-committed', firstActor);
    await manager.flush();
    const recovered = new BatchManager(documents, join(root, 'batches.json'));
    await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toMatchObject({ status: 'queued', progress: 0, result: { nextSequence: 0 } });
  });
});
