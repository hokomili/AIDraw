import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nowIso, type Actor, type CanvasTransaction } from '@aidraw/core';
import { BatchManager, type BatchManagerOptions } from '../../src/main/batch-manager';
import { DocumentService } from '../../src/main/document-service';
import { RecoveryJournal } from '../../src/main/journal';
import { TransactionTraceStore } from '../../src/main/trace-store';

const temporaryPaths: string[] = [];
const services: DocumentService[] = [];
afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Batch-manager fixture teardown failed.');
});

const firstActor: Actor = { id: 'batch-agent-a', kind: 'agent', name: 'Batch A', color: '#8268dd' };
const secondActor: Actor = { id: 'batch-agent-b', kind: 'agent', name: 'Batch B', color: '#2fa7a0' };

async function fixture(options: BatchManagerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-batch-')); temporaryPaths.push(root);
  const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces')));
  services.push(documents);
  documents.initialize();
  const statePath = join(root, 'batches.json');
  const manager = new BatchManager(documents, statePath, options);
  await manager.initialize();
  return { root, statePath, documents, manager, document: documents.snapshot().activeDocument! };
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
    const revisionAfterFirst = documents.getDocument(document.id)!.revision;
    expect(await manager.prepare({ ...metadata, sequence: 1 }, document.id, 'batch-step-0', firstActor)).toMatchObject({
      accepted: false,
      expectedSequence: 1,
      response: { status: 'conflict', message: expect.stringContaining('fresh idempotency key') },
    });
    expect(documents.getDocument(document.id)!.revision).toBe(revisionAfterFirst);
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

  it('publishes live progress only after atomic ledger replacement and leaves failed steps retryable', async () => {
    let rejectReplacement = false;
    const { root, statePath, documents, manager, document } = await fixture({
      replaceFile: async (source, destination) => {
        if (rejectReplacement) throw new Error('Injected batch-ledger replacement failure.');
        await rename(source, destination);
      },
    });
    const started = await manager.start(document.id, 2, 'Transactional ledger', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const beforePrepare = await readFile(statePath);

    rejectReplacement = true;
    await expect(manager.prepare(metadata, document.id, 'atomic-step-0', firstActor)).rejects.toThrow('Injected batch-ledger replacement failure.');
    expect(await readFile(statePath)).toEqual(beforePrepare);
    expect((await readdir(root)).filter((entry) => entry.startsWith('batches.json.') && entry.endsWith('.tmp'))).toEqual([]);

    rejectReplacement = false;
    expect(await manager.prepare(metadata, document.id, 'atomic-step-0', firstActor)).toMatchObject({ accepted: true, expectedSequence: 0 });
    const committed = await documents.apply(renameTransaction(document.id, 'atomic-step-0', firstActor, 'Atomic step zero'));
    expect(committed).toMatchObject({ status: 'committed', transactionId: 'tx-atomic-step-0' });
    const beforeFinish = await readFile(statePath);

    rejectReplacement = true;
    await expect(manager.finish(metadata, 'atomic-step-0', committed)).rejects.toThrow('Injected batch-ledger replacement failure.');
    expect(await readFile(statePath)).toEqual(beforeFinish);
    expect((await readdir(root)).filter((entry) => entry.startsWith('batches.json.') && entry.endsWith('.tmp'))).toEqual([]);

    rejectReplacement = false;
    expect(await manager.finish(metadata, 'atomic-step-0', committed)).toMatchObject({ status: 'queued', progress: 0.5, result: { nextSequence: 1 } });
    const nextMetadata = { ...metadata, sequence: 1 };
    expect(await manager.prepare(nextMetadata, document.id, 'atomic-step-1', firstActor)).toMatchObject({ accepted: true, expectedSequence: 1 });
    expect(await manager.finish(nextMetadata, 'atomic-step-1', { status: 'committed' })).toMatchObject({
      status: 'queued',
      progress: 0.5,
      error: { code: 'batch_invalid_result', retryable: true },
      result: { nextSequence: 1 },
    });
    expect(await manager.prepare(nextMetadata, document.id, 'atomic-step-1', firstActor)).toMatchObject({ accepted: true, expectedSequence: 1 });
    if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('admits only strict writer-shaped records and clears stale resume capability on invalid reload', async () => {
    const { statePath, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Strict recovery', firstActor);
    const ledger = JSON.parse(await readFile(statePath, 'utf8')) as { version: 1; batches: Array<Record<string, unknown>> };
    const valid = ledger.batches[0]!;
    const invalidRecords = [
      { ...structuredClone(valid), jobId: 'batch-extra-field', unexpected: true },
      { ...structuredClone(valid), jobId: 'batch-progress-mismatch', nextSequence: 1 },
      { ...structuredClone(valid), jobId: 'batch-invalid-flight', status: 'running', inFlight: {} },
      { ...structuredClone(valid), jobId: 'batch-invalid-actor', actor: { ...(valid.actor as Record<string, unknown>), administrator: true } },
    ];
    await writeFile(statePath, JSON.stringify({ version: 1, batches: [valid, ...invalidRecords] }), 'utf8');

    const recovered = new BatchManager(documents, statePath);
    await recovered.initialize();
    for (const record of invalidRecords) expect(await recovered.resume(String(record.jobId), started.resumeToken, firstActor)).toBeUndefined();
    expect(await recovered.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'queued', progress: 0, actor: secondActor });

    await writeFile(statePath, JSON.stringify({ version: 1, batches: [valid], unexpected: true }), 'utf8');
    await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toBeUndefined();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ version: 1, batches: [] });
  });
});
