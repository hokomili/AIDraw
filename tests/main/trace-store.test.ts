import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createId, nowIso, type Actor, type CanvasTransaction } from '@aidraw/core';
import type { TransactionTraceEntry } from '@common/contracts';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { TransactionTraceStore } from '@main/trace-store';

const temporaryPaths: string[] = [];
const services: DocumentService[] = [];
afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Trace-store fixture teardown failed.');
});

describe('durable autonomous transaction traces', () => {
  it('survives recovery compaction and retains the complete attributed transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-trace-'));
    temporaryPaths.push(root);
    const journal = new RecoveryJournal(join(root, 'recovery'));
    const traces = new TransactionTraceStore(join(root, 'traces'));
    const service = new DocumentService(journal, '1.0.0', traces);
    services.push(service);
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
    services.push(recovered);
    expect(await recovered.recover()).toBe(1);
    expect(recovered.getDocument(document.id)?.name).toBe('Made headlessly');
    expect((await recovered.findTrace(document.id, transaction.id))?.transaction.actor.name).toBe('Headless agent');
  });

  it('keeps malformed local and imported trace records outside inspection and replay lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-trace-policy-')); temporaryPaths.push(root);
    const traceRoot = join(root, 'traces');
    const traces = new TransactionTraceStore(traceRoot);
    const actor: Actor = { id: 'agent-trace-policy', kind: 'agent', name: 'Trace policy agent', color: '#2fa7a0' };
    const documentId = 'document-trace-policy';
    const transaction: CanvasTransaction = {
      id: 'trace-policy-valid', clientOperationId: 'trace-policy-valid-operation', documentId, actor,
      label: 'Valid local trace', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Valid trace name' }],
    };
    const valid: TransactionTraceEntry = { version: 1, documentId, revision: 1, recordedAt: nowIso(), outcome: 'committed', transaction };
    const malformed = { ...valid, transaction: { ...transaction, operations: [{ kind: 'document.rename', name: '' }] } };
    const tracePath = join(traceRoot, `${createHash('sha256').update(documentId).digest('hex')}.jsonl`);
    await mkdir(traceRoot, { recursive: true });
    await writeFile(tracePath, `${JSON.stringify(valid)}\n${JSON.stringify(malformed)}\n{}\n`, 'utf8');

    expect(await traces.list(documentId)).toEqual([valid]);
    expect(await traces.find(documentId, transaction.id)).toEqual(valid);
    expect(await traces.find(documentId, 'missing-or-malformed')).toBeUndefined();

    const second: TransactionTraceEntry = {
      ...valid, revision: 2, recordedAt: nowIso(), outcome: 'undo',
      transaction: { ...transaction, id: 'trace-policy-second', clientOperationId: 'trace-policy-second-operation', label: 'Second valid trace' },
    };
    expect(await traces.import(documentId, [valid, malformed as unknown as TransactionTraceEntry, second])).toBe(1);
    expect(await traces.list(documentId)).toEqual([valid, second]);
    expect((await readFile(tracePath, 'utf8')).split(/\r?\n/).filter(Boolean)).toHaveLength(4);
  });
});
