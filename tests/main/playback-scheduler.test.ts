import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUMAN_ACTOR,
  createId,
  nowIso,
  readPixel,
  type Actor,
  type CanvasOperation,
  type CanvasTransaction,
} from '@aidraw/core';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { operationSamples, PlaybackScheduler, transactionSamples, visibleOperations } from '@main/playback-scheduler';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function serviceFixture(): Promise<DocumentService> {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-scheduler-'));
  temporaryPaths.push(root);
  const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
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
});
