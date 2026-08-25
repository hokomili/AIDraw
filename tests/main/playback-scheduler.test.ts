import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createIllustrationDocument,
  createId,
  nowIso,
  readPixel,
  type Actor,
  type CanvasOperation,
  type CanvasTransaction,
  type VectorStrokeObject,
} from '@aidraw/core';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { TransactionTraceStore } from '@main/trace-store';
import {
  estimatePublicMutationSamples,
  MAX_PUBLIC_MUTATIONS,
  MAX_PUBLIC_RETAINED_IMAGE_BYTES,
  operationSamples,
  PlaybackScheduler,
  transactionSamples,
  visibleOperations,
} from '@main/playback-scheduler';
import { TransactionImageWorkContext } from '@main/transaction-policy';

const temporaryPaths: string[] = [];
const services: DocumentService[] = [];
afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Playback-scheduler fixture teardown failed.');
});

async function serviceFixture(withTrace = false): Promise<DocumentService> {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-scheduler-'));
  temporaryPaths.push(root);
  const service = new DocumentService(
    new RecoveryJournal(join(root, 'journal')),
    '1.0.0',
    withTrace ? new TransactionTraceStore(join(root, 'traces')) : undefined,
  );
  services.push(service);
  service.initialize();
  await service.compactRecovery();
  return service;
}

function actor(id: string): Actor {
  return { id, kind: 'agent', name: id, color: '#2fa7a0' };
}

function renameTransaction(documentId: string, value: string, owner: Actor): CanvasTransaction {
  return {
    id: createId('tx'), clientOperationId: createId('op'), documentId, actor: owner,
    label: value, createdAt: nowIso(), operations: [{ kind: 'document.rename', name: value }], playback: { mode: 'animated', speed: 4 },
  };
}

function vectorStrokeTransaction(documentId: string, layerId: string, owner: Actor, pointCount = 2): CanvasTransaction {
  const timestamp = nowIso();
  const object: VectorStrokeObject = {
    id: createId('object'), revision: 0, name: 'Detached authoritative stroke', createdAt: timestamp, updatedAt: timestamp,
    createdBy: owner.id, layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM },
    type: 'vector-stroke', points: Array.from({ length: pointCount }, (_, index) => ({ x: index + 1, y: index + 2, pressure: 0.5 })),
    brush: { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true, color: '#000000' },
  };
  return {
    id: createId('tx'), clientOperationId: createId('op'), documentId, actor: owner,
    label: 'Detached authoritative stroke', createdAt: timestamp,
    operations: [{ kind: 'illustration.object.add', object }], playback: { mode: 'animated', speed: 4 },
  };
}

function transaction(operations: CanvasOperation[]): CanvasTransaction {
  return {
    id: createId('tx'),
    clientOperationId: createId('client-op'),
    documentId: createId('doc'),
    actor: HUMAN_ACTOR,
    label: 'Playback test',
    createdAt: nowIso(),
    operations,
    playback: { mode: 'animated', speed: 1 },
  };
}

describe('playback scheduler payload hardening', () => {
  it('keeps malformed pixel sample accounting finite', () => {
    const malformed = { kind: 'pixel.cel.set', spriteId: 'sprite-1', celId: 'cel-1' } as CanvasOperation;
    expect(operationSamples(malformed)).toBe(1);
    expect(transactionSamples(transaction([malformed]))).toBe(1);
    expect(Number.isFinite(transactionSamples(transaction([malformed])))).toBe(true);
  });

  it('does not reveal or throw on a malformed pixel change list', () => {
    const malformed = { kind: 'pixel.cel.set', spriteId: 'sprite-1', celId: 'cel-1' } as CanvasOperation;
    expect(() => visibleOperations([malformed], 1)).not.toThrow();
    expect(visibleOperations([malformed], 1)).toEqual([]);
  });

  it('does not reveal or throw on a malformed pressure-stroke point list', () => {
    const malformed = { kind: 'illustration.paint.stroke', layerId: 'paint-1', stroke: {} } as CanvasOperation;
    expect(operationSamples(malformed)).toBe(1);
    expect(() => visibleOperations([malformed], 1)).not.toThrow();
    expect(visibleOperations([malformed], 1)).toEqual([]);
  });

  it('reveals valid pixel changes progressively and clamps invalid progress', () => {
    const operation: CanvasOperation = {
      kind: 'pixel.cel.set',
      spriteId: 'sprite-1',
      celId: 'cel-1',
      changes: [{ x: 1, y: 2, index: 3 }, { x: 2, y: 2, index: 3 }],
    };
    expect(visibleOperations([operation], 0.5)).toEqual([{ ...operation, changes: [operation.changes[0]] }]);
    expect(visibleOperations([operation], Number.NaN)).toEqual([]);
  });

  it('accounts for and progressively reveals compact region cells rather than run count', () => {
    const operation: CanvasOperation = { kind: 'pixel.cel.region', spriteId: 'sprite-1', celId: 'cel-1', runs: [{ x: 0, y: 2, length: 8, index: 4 }, { x: 10, y: 2, length: 2, index: 6 }] };
    expect(operationSamples(operation)).toBe(10);
    expect(visibleOperations([operation], 0.5)).toEqual([{ ...operation, runs: [{ x: 0, y: 2, length: 5, index: 4 }] }]);
  });

  it('uses all four visible lanes and gives the next free lane to a different waiting actor', async () => {
    const service = await serviceFixture();
    const scheduler = new PlaybackScheduler(service);
    const documentId = service.snapshot().activeDocument!.id;
    const firstActor = actor('agent-a');
    const secondActor = actor('agent-b');
    const starts: Array<{ label: string; lane: number }> = [];
    const seen = new Set<string>();
    service.on('event', (event) => {
      if (event.type !== 'playback' || event.status !== 'playing' || seen.has(event.transactionId)) return;
      seen.add(event.transactionId);
      starts.push({ label: event.label, lane: event.lane });
    });

    const pending = [1, 2, 3, 4, 5].map((index) => scheduler.submit(renameTransaction(documentId, `A${index}`, firstActor)));
    pending.push(scheduler.submit(renameTransaction(documentId, 'B1', secondActor)));
    await Promise.all(pending);

    expect(new Set(starts.slice(0, 4).map((entry) => entry.lane))).toEqual(new Set([0, 1, 2, 3]));
    expect(starts.findIndex((entry) => entry.label === 'B1')).toBeLessThan(starts.findIndex((entry) => entry.label === 'A5'));
  });

  it('carries one ingress image-work context through animated playback into commit', async () => {
    const apply = vi.fn(async () => ({ status: 'committed' as const, revision: 1 }));
    const service = {
      apply,
      getDocumentIncarnation: vi.fn(() => 'test-incarnation'),
      updatePresence: vi.fn(),
      broadcastPlayback: vi.fn(),
    } as unknown as DocumentService;
    const scheduler = new PlaybackScheduler(service);
    const context = new TransactionImageWorkContext();
    await expect(scheduler.submit(renameTransaction('document', 'Context carrier', actor('agent-context')), { imageWorkContext: context })).resolves.toMatchObject({ status: 'committed' });
    expect(apply).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ imageWorkContext: context }));
  });

  it('rejects work beyond the global one-million-sample playback budget without allocating samples', async () => {
    const service = await serviceFixture();
    const scheduler = new PlaybackScheduler(service);
    const documentId = service.snapshot().activeDocument!.id;
    const oversized = renameTransaction(documentId, 'Oversized', actor('agent-large'));
    oversized.operations = [{
      kind: 'illustration.object.add',
      object: { type: 'vector-stroke', points: new Array(1_000_001) },
    } as CanvasOperation];
    await expect(scheduler.submit(oversized)).resolves.toMatchObject({ status: 'busy', message: expect.stringContaining('budget') });
  });

  it('estimates semantic pixel preparation before expansion and rejects aggregate over-budget intent', () => {
    expect(estimatePublicMutationSamples([{ kind: 'pixel.image.quantize', width: 32, height: 16 }])).toBe(512);
    expect(estimatePublicMutationSamples([{ kind: 'pixel.image.quantize' }])).toBe(1_000_000);
    expect(estimatePublicMutationSamples([
      { kind: 'pixel.flood-fill' },
      { kind: 'pixel.image.quantize', width: 1, height: 1 },
    ])).toBe(1_000_001);
    expect(estimatePublicMutationSamples([
      { kind: 'pixel.image-collection.tile.move' },
      { kind: 'document.rename', name: 'Malformed exclusive mixture' },
    ])).toBe(1_000_000);
    expect(estimatePublicMutationSamples([{ kind: 'pixel.cel.region', runs: [{ length: 400 }, { length: 100 }] }])).toBe(500);
  });

  it('reserves global, per-document, semantic, and image-retention capacity before public preparation', () => {
    const scheduler = new PlaybackScheduler({ getDocumentIncarnation: (documentId: string) => `incarnation:${documentId}` } as DocumentService);
    const reservations = Array.from({ length: MAX_PUBLIC_MUTATIONS }, (_, index) => scheduler.reservePublicMutation(
      'one-actor',
      `document-${index}`,
      [{ kind: 'document.rename', name: `Document ${index}` }],
    ));
    expect(reservations.every((entry) => entry.accepted)).toBe(true);
    expect(scheduler.publicMutationStatus()).toEqual({
      active: MAX_PUBLIC_MUTATIONS,
      reservedSamples: MAX_PUBLIC_MUTATIONS * 256,
      reservedImageBytes: MAX_PUBLIC_RETAINED_IMAGE_BYTES,
    });
    expect(scheduler.reservePublicMutation('other-actor', 'document-overflow', [{ kind: 'document.rename', name: 'Overflow' }])).toMatchObject({ accepted: false, response: { status: 'busy' } });
    if (reservations[0].accepted) reservations[0].reservation.release();
    const replacement = scheduler.reservePublicMutation('other-actor', 'document-overflow', [{ kind: 'document.rename', name: 'Replacement' }]);
    expect(replacement.accepted).toBe(true);
    expect(scheduler.reservePublicMutation('third-actor', 'document-overflow', [{ kind: 'document.rename', name: 'Same document' }])).toMatchObject({ accepted: false, response: { status: 'busy' } });
    for (const entry of [...reservations.slice(1), replacement]) if (entry.accepted) entry.reservation.release();
    expect(scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
  });

  it('admits semantic work against one shared sample pool before expansion', () => {
    const scheduler = new PlaybackScheduler({ getDocumentIncarnation: (documentId: string) => `incarnation:${documentId}` } as DocumentService);
    const exclusive = scheduler.reservePublicMutation('actor-a', 'document-a', [{ kind: 'pixel.flood-fill' }]);
    expect(exclusive).toMatchObject({ accepted: true });
    expect(scheduler.reservePublicMutation('actor-b', 'document-b', [{ kind: 'document.rename', name: 'Wait' }])).toMatchObject({
      accepted: false,
      response: { status: 'busy', message: expect.stringContaining('semantic-work capacity') },
    });
    if (exclusive.accepted) exclusive.reservation.release();
    expect(scheduler.reservePublicMutation('actor-c', 'document-c', [
      { kind: 'pixel.flood-fill' },
      { kind: 'pixel.image.quantize', width: 1, height: 1 },
    ])).toMatchObject({ accepted: false, response: { status: 'conflict', message: expect.stringContaining('one-million-sample') } });
    expect(scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
  });

  it('carries one public lease through instant dispatch and releases every capacity dimension', async () => {
    const apply = vi.fn(async () => ({ status: 'committed' as const, revision: 1 }));
    const scheduler = new PlaybackScheduler({ apply, getDocumentIncarnation: () => 'test-incarnation' } as unknown as DocumentService);
    const owner = actor('public-instant');
    const admission = scheduler.reservePublicMutation(owner.id, 'document', [{ kind: 'document.rename', name: 'Reserved' }]);
    if (!admission.accepted) throw new Error('Expected public admission');
    const request = renameTransaction('document', 'Reserved', owner);
    request.playback = { mode: 'instant', speed: 1 };
    await expect(scheduler.submitReserved(request, admission.reservation)).resolves.toMatchObject({ status: 'committed' });
    expect(apply).toHaveBeenCalledWith(request, expect.objectContaining({ signal: admission.reservation.signal }));
    admission.reservation.release();
    expect(scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
  });

  it('binds public preparation to the incarnation present at reservation instead of reacquiring at submit', async () => {
    let incarnation = 'predecessor-incarnation';
    const apply = vi.fn(async () => ({ status: 'committed' as const, revision: 1 }));
    const scheduler = new PlaybackScheduler({ apply, getDocumentIncarnation: () => incarnation } as unknown as DocumentService);
    const owner = actor('public-incarnation');
    const admission = scheduler.reservePublicMutation(owner.id, 'document', [{ kind: 'document.rename', name: 'Reserved' }]);
    if (!admission.accepted) throw new Error('Expected public admission');
    expect(admission.reservation.documentIncarnationId).toBe('predecessor-incarnation');

    incarnation = 'replacement-incarnation';
    expect(() => admission.reservation.assertActive()).toThrow(/incarnation changed.*old edit was not applied/i);
    const request = renameTransaction('document', 'Must not reach replacement', owner);
    request.playback = { mode: 'instant', speed: 1 };
    await expect(scheduler.submitReserved(request, admission.reservation)).resolves.toMatchObject({
      status: 'conflict',
      message: expect.stringMatching(/incarnation changed.*old edit was not applied/i),
    });
    expect(apply).not.toHaveBeenCalled();
    expect(scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
  });

  it('aborts an actor preparation on session retirement but retains accounting until its owner settles', () => {
    const scheduler = new PlaybackScheduler({ getDocumentIncarnation: (documentId: string) => `incarnation:${documentId}` } as DocumentService);
    const admission = scheduler.reservePublicMutation('retired-actor', 'retired-document', [{ kind: 'document.rename', name: 'Reserved' }]);
    if (!admission.accepted) throw new Error('Expected public admission');
    expect(scheduler.stopActor('retired-actor')).toBe(1);
    expect(admission.reservation.signal.aborted).toBe(true);
    expect(() => admission.reservation.assertActive()).toThrow('authenticated MCP session closed');
    expect(scheduler.publicMutationStatus()).toMatchObject({ active: 1 });
    admission.reservation.release();
    expect(scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
  });

  it('retains a cancelled visible pixel prefix as one actor-undoable transaction', async () => {
    const service = await serviceFixture();
    const scheduler = new PlaybackScheduler(service);
    const snapshot = service.create({ kind: 'sprite', name: 'Partial playback' });
    await service.compactRecovery();
    const document = snapshot.activeDocument!;
    if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const changes = Array.from({ length: sprite.width * sprite.height }, (_, index) => ({
      x: index % sprite.width,
      y: Math.floor(index / sprite.width),
      index: 4,
    }));
    const owner = actor('agent-partial');
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: owner,
      label: 'Long pixel fill', createdAt: nowIso(),
      operations: [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes, expectedRevision: cel.revision }],
      playback: { mode: 'animated', speed: 1 },
    };
    const pending = scheduler.submit(transaction);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(scheduler.stop(document.id)).toBe(1);
    expect(await pending).toMatchObject({ status: 'committed' });

    const partial = service.getDocument(document.id);
    if (!partial || partial.kind !== 'pixel') throw new Error('Expected pixel document');
    const partialSprite = partial.pixelAssets[sprite.id];
    if (partialSprite.type !== 'sprite') throw new Error('Expected sprite');
    const partialCel = partialSprite.cels[cel.id];
    const painted = changes.filter(({ x, y }) => readPixel(partialCel, x, y) === 4).length;
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(changes.length);
    expect(partial.activity.at(-1)?.status).toBe('partial');

    expect((await service.undo(document.id, owner)).status).toBe('committed');
    const undone = service.getDocument(document.id);
    if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
    const undoneSprite = undone.pixelAssets[sprite.id];
    if (undoneSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(changes.every(({ x, y }) => readPixel(undoneSprite.cels[cel.id], x, y) === 0)).toBe(true);
    expect((await service.redo(document.id, owner)).status).toBe('committed');
    const redone = service.getDocument(document.id);
    if (!redone || redone.kind !== 'pixel') throw new Error('Expected pixel document');
    const redoneSprite = redone.pixelAssets[sprite.id];
    if (redoneSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(changes.filter(({ x, y }) => readPixel(redoneSprite.cels[cel.id], x, y) === 4)).toHaveLength(painted);
  });

  it('keeps queued cancellation and lane progress authoritative when advisory observers throw', async () => {
    const service = await serviceFixture();
    const scheduler = new PlaybackScheduler(service);
    const document = service.snapshot().activeDocument!;
    const owner = actor('agent-advisory-isolation');
    let healthyDeliveries = 0;
    service.on('event', () => { throw new Error('Injected scheduler advisory observer failure.'); });
    service.on('event', () => { healthyDeliveries += 1; });

    const transactions = Array.from({ length: 5 }, (_, index) => renameTransaction(document.id, `Advisory ${index + 1}`, owner));
    const pending = transactions.map((entry) => scheduler.submit(entry));
    expect(scheduler.cancelTransaction(transactions[4].id)).toBe(true);
    await expect(pending[4]).resolves.toMatchObject({ status: 'cancelled', message: expect.stringContaining('before playback') });
    await expect(Promise.all(pending.slice(0, 4))).resolves.toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ status: 'committed' })));
    expect(service.getDocument(document.id)?.revision).toBe(document.revision + 4);
    expect(scheduler.publicMutationStatus()).toEqual({ active: 0, reservedSamples: 0, reservedImageBytes: 0 });
    expect(healthyDeliveries).toBeGreaterThan(0);
  });

  it('refuses a delayed full apply after the admitted document incarnation is replaced under the same ID', async () => {
    const service = await serviceFixture();
    const scheduler = new PlaybackScheduler(service);
    const predecessor = service.snapshot().activeDocument!;
    const admittedIncarnation = service.getDocumentIncarnation(predecessor.id);
    const pending = scheduler.submit(renameTransaction(predecessor.id, 'Must remain on predecessor', actor('agent-full-incarnation')));

    await expect(service.close(predecessor.id, true)).resolves.toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Same-ID replacement');
    replacement.id = predecessor.id;
    service.addDocument(replacement);
    expect(service.getDocumentIncarnation(predecessor.id)).not.toBe(admittedIncarnation);

    await expect(pending).resolves.toMatchObject({ status: 'conflict', message: expect.stringContaining('incarnation changed') });
    expect(service.getDocument(predecessor.id)).toMatchObject({ name: 'Same-ID replacement', revision: 0 });
  });

  it('refuses a delayed partial apply after cancellation races a same-ID replacement', async () => {
    const service = await serviceFixture();
    const scheduler = new PlaybackScheduler(service);
    const predecessor = service.snapshot().activeDocument!;
    if (predecessor.kind !== 'illustration') throw new Error('Expected illustration document.');
    const layer = Object.values(predecessor.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer.');
    const pending = scheduler.submit(vectorStrokeTransaction(predecessor.id, layer.id, actor('agent-partial-incarnation'), 2_000));
    await new Promise((resolve) => setTimeout(resolve, 60));

    await expect(service.close(predecessor.id, true)).resolves.toMatchObject({ closed: true });
    const replacement = createIllustrationDocument('Partial same-ID replacement');
    replacement.id = predecessor.id;
    service.addDocument(replacement);
    expect(scheduler.stop(predecessor.id)).toBe(1);

    await expect(pending).resolves.toMatchObject({ status: 'conflict', message: expect.stringContaining('incarnation changed') });
    expect(service.getDocument(predecessor.id)).toMatchObject({ name: 'Partial same-ID replacement', revision: 0, objects: {} });
  });

  it('detaches nested playback payloads per observer from canonical work and trace truth', async () => {
    const service = await serviceFixture(true);
    const scheduler = new PlaybackScheduler(service);
    const document = service.snapshot().activeDocument!;
    if (document.kind !== 'illustration') throw new Error('Expected illustration document.');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer.');
    const transaction = vectorStrokeTransaction(document.id, layer.id, actor('agent-detached-advisory'));
    const operation = transaction.operations[0];
    if (operation.kind !== 'illustration.object.add' || operation.object.type !== 'vector-stroke') throw new Error('Expected vector-stroke operation.');
    const canonicalObject = operation.object;
    let synchronouslyMutated = false;
    let asynchronouslyMutated = false;
    let healthyFirstPoint: number | undefined;
    service.on('event', (event) => {
      if (synchronouslyMutated || event.type !== 'playback' || event.status !== 'playing') return;
      const observed = event.operations[0];
      if (!observed || observed.kind !== 'illustration.object.add' || observed.object.type !== 'vector-stroke') return;
      observed.object.points[0].x = 777;
      observed.object.name = 'Observer overwrite';
      event.actor.name = 'Observer actor overwrite';
      synchronouslyMutated = true;
    });
    service.on('event', (event) => {
      if (healthyFirstPoint !== undefined || event.type !== 'playback' || event.status !== 'playing') return;
      const observed = event.operations[0];
      if (observed?.kind === 'illustration.object.add' && observed.object.type === 'vector-stroke') healthyFirstPoint = observed.object.points[0].x;
    });
    service.on('event', async (event) => {
      if (asynchronouslyMutated || event.type !== 'playback' || event.status !== 'playing') return;
      await Promise.resolve();
      const observed = event.operations[0];
      if (observed?.kind === 'illustration.object.add' && observed.object.type === 'vector-stroke') {
        observed.object.points[0].x = 999;
        asynchronouslyMutated = true;
      }
    });

    const requestFingerprint = 'a'.repeat(64);
    await expect(scheduler.submit(transaction, { requestFingerprint })).resolves.toMatchObject({ status: 'committed' });
    expect({ synchronouslyMutated, asynchronouslyMutated, healthyFirstPoint }).toEqual({ synchronouslyMutated: true, asynchronouslyMutated: true, healthyFirstPoint: 1 });
    const committed = service.getDocument(document.id);
    if (!committed || committed.kind !== 'illustration') throw new Error('Expected committed illustration document.');
    expect(committed.objects[canonicalObject.id]).toMatchObject({ name: canonicalObject.name, points: canonicalObject.points });
    await expect(service.findTrace(document.id, transaction.id)).resolves.toMatchObject({
      requestFingerprint,
      transaction: {
        id: transaction.id,
        clientOperationId: transaction.clientOperationId,
        actor: transaction.actor,
        operations: [{ kind: 'illustration.object.add', object: { id: canonicalObject.id, name: canonicalObject.name, points: canonicalObject.points } }],
      },
    });
  });
});
