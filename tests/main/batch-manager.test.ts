import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIllustrationDocument, nowIso, type Actor, type CanvasTransaction } from '@aidraw/core';
import { BatchManager, batchTransactionFingerprint, type BatchManagerOptions } from '../../src/main/batch-manager';
import { DocumentService } from '../../src/main/document-service';
import { RecoveryJournal } from '../../src/main/journal';
import { TransactionTraceStore } from '../../src/main/trace-store';
import { PlaybackScheduler } from '../../src/main/playback-scheduler';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('durable transaction batch manager', () => {
  it('sequences commits, reports idempotent retries, and preserves committed work on cancellation', async () => {
    const { documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 3, 'Three-step creature', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'batch-step-0', firstActor, 'Step zero');
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true, expectedSequence: 0 });
    const dispatched = await manager.dispatchPrepared(metadata, transaction, () => documents.apply(transaction));
    const committed = await dispatched.dispatched!;
    expect(committed.status).toBe('committed');
    const progressed = await manager.finish(metadata, transaction, committed);
    expect(progressed).toMatchObject({ kind: 'batch', status: 'queued', progress: 1 / 3, result: { nextSequence: 1, totalTransactions: 3 } });
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: false, duplicate: true, expectedSequence: 1, response: { status: 'duplicate' } });
    const revisionAfterFirst = documents.getDocument(document.id)!.revision;
    expect(await manager.prepare({ ...metadata, sequence: 1 }, transaction, firstActor)).toMatchObject({
      accepted: false,
      expectedSequence: 1,
      response: { status: 'conflict', message: expect.stringContaining('fresh idempotency key') },
    });
    expect(documents.getDocument(document.id)!.revision).toBe(revisionAfterFirst);
    expect(await manager.prepare({ ...metadata, sequence: 2 }, renameTransaction(document.id, 'batch-step-2', firstActor, 'Step two'), firstActor)).toMatchObject({ accepted: false, expectedSequence: 1, response: { status: 'conflict' } });
    expect(await manager.cancel(started.job.id, firstActor.id)).toMatchObject({ status: 'cancelled', progress: 1 / 3 });
    expect(await manager.prepare({ ...metadata, sequence: 1 }, renameTransaction(document.id, 'batch-step-1', firstActor, 'Step one'), firstActor)).toMatchObject({ accepted: false, response: { status: 'cancelled' } });
    expect(documents.getDocument(document.id)?.name).toBe('Step zero');
  });

  it('requires the opaque resume token and rebinds ownership to a new authenticated session', async () => {
    const { manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Reconnectable batch', firstActor);
    expect(await manager.resume(started.job.id, 'not-the-token-but-long-enough-to-parse', secondActor)).toBeUndefined();
    const resumed = await manager.resume(started.job.id, started.resumeToken, secondActor);
    expect(resumed).toMatchObject({ actor: secondActor, status: 'queued', result: { nextSequence: 0 } });
  });

  it('retains the exact document incarnation binding across recovery restart', async () => {
    const { root, statePath, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Incarnation-stable restart', firstActor);
    const incarnationId = documents.getDocumentIncarnation(document.id);
    await documents.compactRecovery();
    await documents.flushRecovery();

    const restartedDocuments = new DocumentService(
      new RecoveryJournal(join(root, 'journal')),
      '1.0.0',
      new TransactionTraceStore(join(root, 'traces')),
    );
    services.push(restartedDocuments);
    expect(await restartedDocuments.recover()).toBe(1);
    expect(restartedDocuments.getDocumentIncarnation(document.id)).toBe(incarnationId);
    const restarted = new BatchManager(restartedDocuments, statePath);
    await restarted.initialize();
    expect(await restarted.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'queued', actor: secondActor, result: { nextSequence: 0 } });
  });

  it('retires prepared authority instead of dispatching against a same-ID replacement incarnation', async () => {
    const { documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 1, 'Exact incarnation only', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'old-incarnation-step', firstActor, 'Must not reach replacement');
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });
    const priorIncarnation = documents.getDocumentIncarnation(document.id);

    expect(await documents.close(document.id, true)).toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Same ID, different incarnation'); replacement.id = document.id;
    documents.addDocument(replacement);
    expect(documents.getDocumentIncarnation(document.id)).not.toBe(priorIncarnation);
    const dispatch = vi.fn(() => documents.apply(transaction));
    expect(await manager.dispatchPrepared(metadata, transaction, dispatch)).toMatchObject({
      accepted: false,
      response: { status: 'conflict', message: expect.stringContaining('different document incarnation') },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await manager.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({
      status: 'cancelled', progress: 0, result: { documentId: document.id, nextSequence: 0 },
    });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Same ID, different incarnation', revision: 0 });
  });

  it('rechecks incarnation after dispatched-ledger persistence and before the scheduler callback', async () => {
    const ledgerEntered = deferred(); const releaseLedger = deferred(); let blockReplacement = false;
    const { documents, manager, document } = await fixture({
      replaceFile: async (source, destination) => {
        if (blockReplacement) { ledgerEntered.resolve(); await releaseLedger.promise; }
        await rename(source, destination);
      },
    });
    const started = await manager.start(document.id, 1, 'Dispatch-bound incarnation', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'dispatch-incarnation-barrier', firstActor, 'Must not dispatch');
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });

    blockReplacement = true;
    const dispatchCallback = vi.fn(() => documents.apply(transaction));
    const pendingDispatch = manager.dispatchPrepared(metadata, transaction, dispatchCallback);
    await ledgerEntered.promise;
    expect(await documents.close(document.id, true)).toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Replacement during ledger write'); replacement.id = document.id;
    documents.addDocument(replacement);
    releaseLedger.resolve();

    await expect(pendingDispatch).resolves.toMatchObject({
      accepted: false,
      response: { status: 'conflict', message: expect.stringContaining('before scheduler dispatch') },
    });
    expect(dispatchCallback).not.toHaveBeenCalled();
    expect(await manager.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'cancelled', progress: 0 });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Replacement during ledger write', revision: 0 });
  });

  it('carries durable batch incarnation authority through delayed animated scheduler settlement', async () => {
    const { documents, manager, document } = await fixture();
    const scheduler = new PlaybackScheduler(documents);
    const started = await manager.start(document.id, 1, 'Delayed exact-incarnation batch', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'delayed-incarnation-step', firstActor, 'Must not reach replacement');
    transaction.playback = { mode: 'animated', speed: 4 };
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });
    const dispatch = await manager.dispatchPrepared(metadata, transaction, () => scheduler.submit(transaction, {
      requestFingerprint: batchTransactionFingerprint(transaction),
    }));
    if (!dispatch.accepted || !dispatch.dispatched) throw new Error('Expected delayed scheduler dispatch.');

    await expect(documents.close(document.id, true)).resolves.toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Batch same-ID replacement'); replacement.id = document.id;
    documents.addDocument(replacement);
    const response = await dispatch.dispatched;
    expect(response).toMatchObject({ status: 'conflict', message: expect.stringContaining('incarnation changed') });
    await expect(manager.finish(metadata, transaction, response)).resolves.toMatchObject({
      status: 'failed', progress: 0, error: { code: 'batch_document_incarnation_changed', retryable: false },
    });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Batch same-ID replacement', revision: 0 });
  });

  it('records a settled old-incarnation dispatch without carrying batch authority into its same-ID replacement', async () => {
    const { documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Retired dispatch settlement', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'retired-incarnation-commit', firstActor, 'Committed only to predecessor');
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });
    const dispatch = await manager.dispatchPrepared(metadata, transaction, () => documents.apply(transaction));
    const response = await dispatch.dispatched!;
    expect(response).toMatchObject({ status: 'committed', transactionId: transaction.id });

    expect(await documents.close(document.id, true)).toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Unmodified replacement'); replacement.id = document.id;
    documents.addDocument(replacement);
    expect(await manager.cancel(started.job.id, firstActor.id)).toMatchObject({
      status: 'failed',
      error: { code: 'batch_document_incarnation_changed', retryable: false },
    });
    expect(await manager.finish(metadata, transaction, response)).toMatchObject({
      status: 'cancelled',
      progress: 0.5,
      result: { nextSequence: 1, transactionIds: [transaction.id] },
      message: expect.stringContaining('retired document incarnation'),
    });
    expect(await manager.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'cancelled', progress: 0.5 });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Unmodified replacement', revision: 0 });
  });

  it('retires unresolved dispatched authority before any trace reconciliation on a same-ID replacement', async () => {
    const { statePath, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 1, 'No cross-incarnation reconciliation', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'never-reconcile-replacement', firstActor, 'Must remain unresolved');
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });
    expect(await manager.dispatchPrepared(metadata, transaction, () => 'dispatch-admitted')).toMatchObject({ accepted: true, dispatched: 'dispatch-admitted' });

    expect(await documents.close(document.id, true)).toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Replacement without trace lookup'); replacement.id = document.id;
    documents.addDocument(replacement);
    const traceLookup = vi.spyOn(documents, 'findTrace');
    const recovered = new BatchManager(documents, statePath);
    await recovered.initialize();

    expect(traceLookup).not.toHaveBeenCalled();
    expect(await recovered.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({
      status: 'failed', progress: 0,
      error: { code: 'batch_document_incarnation_changed', retryable: false },
      result: { nextSequence: 0, transactionIds: [] },
    });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Replacement without trace lookup', revision: 0 });
  });

  it('reconciles a crash after canonical commit from the durable transaction trace', async () => {
    const { root, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Crash-safe batch', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'crash-window-step', firstActor, 'Committed before crash');
    await manager.prepare(metadata, transaction, firstActor);
    const dispatched = await manager.dispatchPrepared(metadata, transaction, () => documents.apply(transaction, { requestFingerprint: batchTransactionFingerprint(transaction) }));
    expect(await dispatched.dispatched).toMatchObject({ status: 'committed' });
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
    await manager.prepare({ jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 }, renameTransaction(document.id, 'never-committed', firstActor, 'Never committed'), firstActor);
    await manager.flush();
    const recovered = new BatchManager(documents, join(root, 'batches.json'));
    await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toMatchObject({ status: 'queued', progress: 0, result: { nextSequence: 0 } });
  });

  it('keeps a live owner busy but reopens a chunk proven undispatched without restart', async () => {
    const { manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Runtime cancellation recovery', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'cancel-before-dispatch', firstActor, 'Cancelled before dispatch');
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });
    expect(await manager.preflight(metadata, document.id, 'cancel-before-dispatch')).toMatchObject({ accepted: false, response: { status: 'busy' } });
    expect(await manager.abandonUndispatched(metadata, transaction)).toMatchObject({ status: 'queued', progress: 0, result: { nextSequence: 0 } });
    expect(await manager.preflight(metadata, document.id, 'cancel-before-dispatch')).toMatchObject({ accepted: true, expectedSequence: 0 });
    expect(await manager.prepare(metadata, transaction, secondActor)).toMatchObject({ accepted: true, expectedSequence: 0 });
    const secondDispatch = await manager.dispatchPrepared(metadata, transaction, () => Promise.resolve({ status: 'cancelled' as const, message: 'Cancelled test retry.' }));
    expect(await manager.finish(metadata, transaction, await secondDispatch.dispatched!)).toMatchObject({ status: 'queued', progress: 0 });
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
    const transaction = renameTransaction(document.id, 'atomic-step-0', firstActor, 'Atomic step zero');
    await expect(manager.prepare(metadata, transaction, firstActor)).rejects.toThrow('Injected batch-ledger replacement failure.');
    expect(await readFile(statePath)).toEqual(beforePrepare);
    expect((await readdir(root)).filter((entry) => entry.startsWith('batches.json.') && entry.endsWith('.tmp'))).toEqual([]);

    rejectReplacement = false;
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true, expectedSequence: 0 });
    const dispatch = await manager.dispatchPrepared(metadata, transaction, () => documents.apply(transaction, { requestFingerprint: batchTransactionFingerprint(transaction) }));
    const committed = await dispatch.dispatched!;
    expect(committed).toMatchObject({ status: 'committed', transactionId: 'tx-atomic-step-0' });
    const beforeFinish = await readFile(statePath);

    rejectReplacement = true;
    await expect(manager.finish(metadata, transaction, committed)).rejects.toThrow('Injected batch-ledger replacement failure.');
    expect(await readFile(statePath)).toEqual(beforeFinish);
    expect((await readdir(root)).filter((entry) => entry.startsWith('batches.json.') && entry.endsWith('.tmp'))).toEqual([]);

    rejectReplacement = false;
    expect(await manager.preflight(metadata, document.id, 'atomic-step-0')).toMatchObject({ accepted: false, duplicate: true, expectedSequence: 1, response: { status: 'duplicate' } });
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: false, duplicate: true, expectedSequence: 1, response: { status: 'duplicate' } });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Atomic step zero', revision: 1 });
    const nextMetadata = { ...metadata, sequence: 1 };
    const invalidResultTransaction = renameTransaction(document.id, 'atomic-step-1', firstActor, 'Atomic step one');
    expect(await manager.prepare(nextMetadata, invalidResultTransaction, firstActor)).toMatchObject({ accepted: true, expectedSequence: 1 });
    const invalidDispatch = await manager.dispatchPrepared(nextMetadata, invalidResultTransaction, () => Promise.resolve({ status: 'committed' as const }));
    expect(await manager.finish(nextMetadata, invalidResultTransaction, await invalidDispatch.dispatched!)).toMatchObject({
      status: 'failed',
      progress: 0.5,
      error: { code: 'batch_ambiguous_outcome', retryable: false },
      result: { nextSequence: 1 },
    });
    expect(await manager.prepare(nextMetadata, invalidResultTransaction, firstActor)).toMatchObject({ accepted: false, response: { status: 'conflict' } });
    if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('never completes a dispatched ownerless chunk from an unrelated trace sharing only the client operation id', async () => {
    const { statePath, documents, manager, document } = await fixture();
    const prior = { ...renameTransaction(document.id, 'shared-operation-id', firstActor, 'Unrelated earlier mutation'), id: 'tx-unrelated-shared-operation' };
    expect(await documents.apply(prior)).toMatchObject({ status: 'committed', transactionId: prior.id });

    const started = await manager.start(document.id, 1, 'Exact correlation', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = { ...renameTransaction(document.id, 'shared-operation-id', firstActor, 'Must never replay'), id: 'tx-exact-batch-owner' };
    expect(await manager.prepare(metadata, transaction, firstActor)).toMatchObject({ accepted: true });
    expect(await manager.dispatchPrepared(metadata, transaction, () => 'dispatch-admitted')).toMatchObject({ accepted: true, dispatched: 'dispatch-admitted' });
    await manager.flush();

    const recovered = new BatchManager(documents, statePath);
    await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toMatchObject({
      status: 'failed', progress: 0,
      error: { code: 'batch_ambiguous_outcome', retryable: false },
      result: { nextSequence: 0, transactionIds: [] },
    });
    expect(await recovered.preflight(metadata, document.id, transaction.clientOperationId)).toMatchObject({ accepted: false, response: { status: 'conflict', transactionId: transaction.id } });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Unrelated earlier mutation', revision: 1 });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ batches: [{ inFlight: { transactionId: transaction.id, requestFingerprint: batchTransactionFingerprint(transaction), phase: 'dispatched' } }] });
  });

  it('never completes a dispatched ownerless chunk from the same transaction id bound to different request bytes', async () => {
    const { statePath, documents, manager, document } = await fixture();
    const sharedTransactionId = 'tx-shared-but-not-the-same-request';
    const unrelated = { ...renameTransaction(document.id, 'unrelated-request', firstActor, 'Unrelated request bytes'), id: sharedTransactionId };
    expect(await documents.apply(unrelated)).toMatchObject({ status: 'committed', transactionId: sharedTransactionId });

    const started = await manager.start(document.id, 1, 'Request fingerprint correlation', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = { ...renameTransaction(document.id, 'actual-batch-request', firstActor, 'Must remain ambiguous'), id: sharedTransactionId };
    expect(batchTransactionFingerprint(transaction)).not.toBe(batchTransactionFingerprint(unrelated));
    await manager.prepare(metadata, transaction, firstActor);
    await manager.dispatchPrepared(metadata, transaction, () => 'dispatch-admitted');

    const recovered = new BatchManager(documents, statePath);
    await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toMatchObject({
      status: 'failed', progress: 0,
      error: { code: 'batch_ambiguous_outcome', retryable: false },
      result: { nextSequence: 0, transactionIds: [] },
    });
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Unrelated request bytes', revision: 1 });
  });

  it('fails closed after trace publication and batch finalization both fail, including across a real document restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-batch-trace-failure-')); temporaryPaths.push(root);
    const journalRoot = join(root, 'journal');
    class FailingAppendTraceStore extends TransactionTraceStore {
      override async append(): Promise<void> { throw new Error('Injected transaction-trace append failure.'); }
    }
    const traces = new FailingAppendTraceStore(join(root, 'traces'));
    const documents = new DocumentService(new RecoveryJournal(journalRoot), '1.0.0', traces); services.push(documents); documents.initialize();
    const document = documents.snapshot().activeDocument!;
    let rejectFinish = false;
    const statePath = join(root, 'batches.json');
    const manager = new BatchManager(documents, statePath, {
      replaceFile: async (source, destination) => {
        if (rejectFinish) throw new Error('Injected post-commit ledger finalization failure.');
        await rename(source, destination);
      },
    });
    await manager.initialize();
    const started = await manager.start(document.id, 1, 'Trace loss ambiguity', firstActor);
    const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'trace-and-ledger-failure', firstActor, 'Committed once despite trace loss');
    await manager.prepare(metadata, transaction, firstActor);
    const dispatch = await manager.dispatchPrepared(metadata, transaction, () => documents.apply(transaction, { requestFingerprint: batchTransactionFingerprint(transaction) }));
    const committed = await dispatch.dispatched!;
    expect(committed).toMatchObject({ status: 'committed', revision: 1, transactionId: transaction.id });
    rejectFinish = true;
    await expect(manager.finish(metadata, transaction, committed)).rejects.toThrow('Injected post-commit ledger finalization failure.');
    await documents.flushRecovery();

    const restartedDocuments = new DocumentService(new RecoveryJournal(journalRoot), '1.0.0', traces); services.push(restartedDocuments);
    expect(await restartedDocuments.recover()).toBe(1);
    expect(restartedDocuments.getDocument(document.id)).toMatchObject({ name: 'Committed once despite trace loss', revision: 1 });
    const recovered = new BatchManager(restartedDocuments, statePath);
    await recovered.initialize();
    expect(await recovered.preflight(metadata, document.id, transaction.clientOperationId)).toMatchObject({
      accepted: false, expectedSequence: 0,
      response: { status: 'conflict', transactionId: transaction.id, message: expect.stringContaining('cannot prove') },
    });
    expect(restartedDocuments.getDocument(document.id)?.revision).toBe(1);
  });

  it.each(['EACCES', 'EIO'] as const)('propagates %s ledger reads without replacing valid disk or live state', async (code) => {
    let failRead = false;
    const options: BatchManagerOptions = {
      readStateFile: async (path, encoding) => {
        if (failRead) throw Object.assign(new Error(`Injected ${code} batch-ledger read failure.`), { code });
        return readFile(path, encoding);
      },
    };
    const { statePath, manager, document } = await fixture(options);
    const started = await manager.start(document.id, 2, 'Read failure preservation', firstActor);
    const before = await readFile(statePath);
    failRead = true;
    await expect(manager.initialize()).rejects.toMatchObject({ code });
    expect(await readFile(statePath)).toEqual(before);
    expect(await manager.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'queued', progress: 0, actor: secondActor });
  });

  it('fails closed on malformed ledger JSON without replacing valid disk or live state', async () => {
    const { statePath, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Malformed ledger preservation', firstActor);
    const malformed = Buffer.from('{"version":1,"batches":[', 'utf8');
    await writeFile(statePath, malformed);

    await expect(manager.initialize()).rejects.toThrow('durable batch ledger is malformed');
    expect(await readFile(statePath)).toEqual(malformed);
    expect(await manager.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'queued', progress: 0, actor: secondActor });
  });

  it('propagates transaction-trace read failure without rewriting a dispatched ledger marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-batch-trace-read-')); temporaryPaths.push(root);
    let failRead = false;
    class FailingReadTraceStore extends TransactionTraceStore {
      override async find(documentId: string, transactionId: string) {
        if (failRead) throw Object.assign(new Error('Injected EIO trace read failure.'), { code: 'EIO' });
        return super.find(documentId, transactionId);
      }
    }
    const documents = new DocumentService(new RecoveryJournal(join(root, 'journal')), '1.0.0', new FailingReadTraceStore(join(root, 'traces'))); services.push(documents); documents.initialize();
    const document = documents.snapshot().activeDocument!; const statePath = join(root, 'batches.json'); const manager = new BatchManager(documents, statePath); await manager.initialize();
    const started = await manager.start(document.id, 1, 'Trace read failure', firstActor); const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'trace-read-owner', firstActor, 'Never dispatched by test');
    await manager.prepare(metadata, transaction, firstActor);
    await manager.dispatchPrepared(metadata, transaction, () => true);
    const before = await readFile(statePath); failRead = true;
    const recovered = new BatchManager(documents, statePath);
    await expect(recovered.initialize()).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(statePath)).toEqual(before);
  });

  it('treats job publication as advisory so a throwing listener cannot strand prepared ownership', async () => {
    const { documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 1, 'Advisory publication', firstActor); const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'publication-failure-step', firstActor, 'Publication stays advisory');
    const throwing = (event: { type?: string }) => { if (event.type === 'job') throw new Error('Injected job publication failure.'); };
    let healthyDeliveries = 0;
    documents.on('event', throwing);
    documents.on('event', () => { healthyDeliveries += 1; });
    await expect(manager.prepare(metadata, transaction, firstActor)).resolves.toMatchObject({ accepted: true });
    expect(await manager.abandonUndispatched(metadata, transaction)).toMatchObject({ status: 'queued', progress: 0 });
    expect(await manager.prepare(metadata, transaction, secondActor)).toMatchObject({ accepted: true, expectedSequence: 0 });
    expect(healthyDeliveries).toBeGreaterThan(0);
  });

  it('removes pruned durable batches from the public job mirror after ledger replacement', async () => {
    const { statePath, documents, manager, document } = await fixture({ maxBatches: 2 });
    const first = await manager.start(document.id, 1, 'First retained batch', firstActor);
    await manager.cancel(first.job.id, firstActor.id);
    const second = await manager.start(document.id, 1, 'Second retained batch', firstActor);
    await manager.cancel(second.job.id, firstActor.id);
    expect(documents.getJob(first.job.id)).toMatchObject({ kind: 'batch', status: 'cancelled' });
    const third = await manager.start(document.id, 1, 'Replacement retained batch', firstActor);

    expect(documents.getJob(first.job.id)).toBeUndefined();
    expect(documents.getJob(second.job.id)).toMatchObject({ kind: 'batch', status: 'cancelled' });
    expect(documents.getJob(third.job.id)).toMatchObject({ kind: 'batch', status: 'queued' });
    expect(documents.listJobs().filter((job) => job.kind === 'batch').map((job) => job.id)).toEqual([second.job.id, third.job.id]);
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { batches: Array<{ jobId: string }> }).batches.map((state) => state.jobId)).toEqual([second.job.id, third.job.id]);
  });

  it('retains exact dispatched ownership through cancellation until a paused canonical commit settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-batch-cancel-settle-')); temporaryPaths.push(root);
    const appendEntered = deferred(); const appendRelease = deferred();
    class BlockingJournal extends RecoveryJournal {
      override async append(documentId: string, transaction: CanvasTransaction): Promise<void> {
        appendEntered.resolve();
        await appendRelease.promise;
        return super.append(documentId, transaction);
      }
    }
    const statePath = join(root, 'batches.json');
    const documents = new DocumentService(new BlockingJournal(join(root, 'journal')), '1.0.0', new TransactionTraceStore(join(root, 'traces'))); services.push(documents); documents.initialize();
    const document = documents.snapshot().activeDocument!; const manager = new BatchManager(documents, statePath); await manager.initialize();
    const started = await manager.start(document.id, 1, 'Cancellation settlement', firstActor); const metadata = { jobId: started.job.id, resumeToken: started.resumeToken, sequence: 0 };
    const transaction = renameTransaction(document.id, 'cancel-during-commit', firstActor, 'Committed before cancellation settled');
    await manager.prepare(metadata, transaction, firstActor);
    const dispatch = await manager.dispatchPrepared(metadata, transaction, () => documents.apply(transaction, { requestFingerprint: batchTransactionFingerprint(transaction) }));
    await appendEntered.promise;
    expect(documents.getDocument(document.id)).toMatchObject({ name: 'Committed before cancellation settled', revision: 1 });
    expect(await manager.cancel(started.job.id, firstActor.id)).toMatchObject({ status: 'running', progress: 0, result: { nextSequence: 0 } });
    expect(await manager.preflight(metadata, document.id, transaction.clientOperationId)).toMatchObject({ accepted: false, response: { status: 'busy', transactionId: transaction.id } });
    appendRelease.resolve();
    const response = await dispatch.dispatched!;
    expect(response).toMatchObject({ status: 'committed', transactionId: transaction.id });
    expect(await manager.finish(metadata, transaction, response)).toMatchObject({
      status: 'cancelled', progress: 1,
      result: { nextSequence: 1, transactionIds: [transaction.id] },
      message: expect.stringContaining('no dispatched work was lost or replayed'),
    });
    const recovered = new BatchManager(documents, statePath); await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toMatchObject({ status: 'cancelled', progress: 1, result: { nextSequence: 1, transactionIds: [transaction.id] } });
  });

  it('admits only strict writer-shaped records and clears stale resume capability on invalid reload', async () => {
    const { statePath, documents, manager, document } = await fixture();
    const started = await manager.start(document.id, 2, 'Strict recovery', firstActor);
    const ledger = JSON.parse(await readFile(statePath, 'utf8')) as { version: 2; batches: Array<Record<string, unknown>> };
    const valid = ledger.batches[0]!;
    const invalidRecords = [
      { ...structuredClone(valid), jobId: 'batch-extra-field', unexpected: true },
      { ...structuredClone(valid), jobId: 'batch-progress-mismatch', nextSequence: 1 },
      { ...structuredClone(valid), jobId: 'batch-invalid-flight', status: 'running', inFlight: {} },
      { ...structuredClone(valid), jobId: 'batch-invalid-actor', actor: { ...(valid.actor as Record<string, unknown>), administrator: true } },
    ];
    await writeFile(statePath, JSON.stringify({ version: 2, batches: [valid, ...invalidRecords] }), 'utf8');

    const recovered = new BatchManager(documents, statePath);
    await recovered.initialize();
    for (const record of invalidRecords) expect(await recovered.resume(String(record.jobId), started.resumeToken, firstActor)).toBeUndefined();
    expect(await recovered.resume(started.job.id, started.resumeToken, secondActor)).toMatchObject({ status: 'queued', progress: 0, actor: secondActor });

    await writeFile(statePath, JSON.stringify({ version: 2, batches: [valid], unexpected: true }), 'utf8');
    await recovered.initialize();
    expect(await recovered.resume(started.job.id, started.resumeToken, firstActor)).toBeUndefined();
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ version: 2, batches: [] });
    expect(documents.getJob(started.job.id)).toBeUndefined();
  });
});
