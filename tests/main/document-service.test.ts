import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, nowIso, type Actor, type CanvasTransaction, type ShapeObject } from '@aidraw/core';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';

const temporaryPaths: string[] = [];
const services: DocumentService[] = [];
afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Document-service fixture teardown failed.');
});

describe('document service collaboration semantics', () => {
  it('creates documents with mode-specific dialog settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();

    const illustration = service.create({ kind: 'illustration', name: 'Poster', width: 1080, height: 1920, background: null }).activeDocument;
    expect(illustration?.kind).toBe('illustration');
    if (!illustration || illustration.kind !== 'illustration') throw new Error('Illustration was not created.');
    expect(illustration.name).toBe('Poster');
    expect(illustration.artboard).toMatchObject({ width: 1080, height: 1920, background: null });

    const mapDocument = service.create({ kind: 'tilemap', name: 'Isometric world', width: 96, height: 48, orientation: 'isometric', infinite: true, tileWidth: 32, tileHeight: 16 }).activeDocument;
    expect(mapDocument?.kind).toBe('pixel');
    if (!mapDocument || mapDocument.kind !== 'pixel') throw new Error('Tilemap was not created.');
    const map = mapDocument.pixelAssets[mapDocument.activeAssetId];
    expect(map.type).toBe('tilemap');
    if (map.type !== 'tilemap') throw new Error('Active asset is not a tilemap.');
    expect(map).toMatchObject({ width: 96, height: 48, orientation: 'isometric', infinite: true, tileWidth: 32, tileHeight: 16 });
    await service.compactRecovery();
  });

  it('deduplicates client operation IDs and keeps human history separate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const document = service.snapshot().activeDocument!;
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: 'same-operation', documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Rename', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Named once' }],
    };
    expect((await service.apply(transaction)).status).toBe('committed');
    expect((await service.apply(transaction)).status).toBe('duplicate');
    expect(service.getDocument(document.id)?.revision).toBe(1);
    expect(service.snapshot().canUndo).toBe(true);
    await service.undo();
    expect(service.getDocument(document.id)?.name).toBe(document.name);
    await service.compactRecovery();
  });

  it('publishes live and unread background-agent tab activity until the document is viewed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const foreground = service.snapshot().activeDocument!;
    const background = service.create({ kind: 'illustration', name: 'Background board' }).activeDocument!;
    service.activate(foreground.id);
    const agent: Actor = { id: 'agent-background-tab', kind: 'agent', name: 'Background collaborator', color: '#5d67d8' };

    service.updatePresence({
      actor: agent,
      documentId: background.id,
      cursor: { x: 128, y: 96, tool: 'pen' },
      queueDepth: 0,
      status: 'working',
    });
    const liveSnapshot = service.snapshot();
    expect(liveSnapshot.activeDocumentId).toBe(foreground.id);
    expect(liveSnapshot.documents.find((document) => document.id === background.id)).toMatchObject({
      id: background.id,
      activityState: 'active',
      activityActor: { id: agent.id, name: agent.name, color: agent.color },
      activityCursor: { x: 128, y: 96, tool: 'pen' },
    });

    expect((await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: background.id, actor: agent,
      label: 'Background edit', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Background result' }],
    })).status).toBe('committed');
    service.updatePresence({ actor: agent, documentId: background.id, queueDepth: 0, status: 'idle' });
    expect(service.snapshot().documents.find((document) => document.id === background.id)).toMatchObject({
      activityState: 'complete',
      activityActor: { id: agent.id },
    });

    service.activate(background.id);
    expect(service.snapshot().documents.find((document) => document.id === background.id)).not.toHaveProperty('activityState');
    service.activate(foreground.id);
    expect(service.snapshot().documents.find((document) => document.id === background.id)).not.toHaveProperty('activityState');
    await service.compactRecovery();
  });

  it('restores a named editable checkpoint while preserving the abandoned branch automatically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const original = service.snapshot().activeDocument!;
    const checkpoint = service.createCheckpoint(original.id, 'Clean composition');
    expect(checkpoint).toMatchObject({ name: 'Clean composition', sourceRevision: 0, kind: 'manual', createdBy: { id: HUMAN_ACTOR.id } });
    expect((await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: original.id, actor: HUMAN_ACTOR, label: 'Risky branch', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Risky experiment' }] })).status).toBe('committed');

    const restored = await service.restoreCheckpoint(original.id, checkpoint.id);
    expect(restored).toMatchObject({ status: 'committed', revision: 2 });
    const current = service.getDocument(original.id)!;
    expect(current.name).toBe(original.name);
    expect(current.activity.at(-1)).toMatchObject({ label: 'Restore checkpoint · Clean composition', actor: { id: HUMAN_ACTOR.id } });
    const checkpoints = service.listCheckpoints(original.id);
    expect(checkpoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: checkpoint.id, kind: 'manual' }), expect.objectContaining({ kind: 'automatic', name: 'Before restore · Clean composition', sourceRevision: 1 })]));
    const safety = checkpoints.find((entry) => entry.kind === 'automatic')!;
    expect(service.getCheckpoint(original.id, safety.id)?.document.name).toBe('Risky experiment');
    expect(service.snapshot().canUndo).toBe(false);
  });

  it('does not recover an untitled document after it is explicitly discarded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const journal = new RecoveryJournal(root);
    const service = new DocumentService(journal, '1.0.0');
    services.push(service);
    service.initialize();
    const retainedId = service.snapshot().activeDocument!.id;
    const discarded = service.create({ kind: 'sprite', name: 'Discarded untitled sprite' }).activeDocument!;
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: discarded.id, actor: HUMAN_ACTOR,
      label: 'Make dirty', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Still discard me' }],
    };
    expect((await service.apply(transaction)).status).toBe('committed');

    expect(await service.close(discarded.id, true)).toEqual({ closed: true });
    await service.compactRecovery();

    const restarted = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(restarted);
    expect(await restarted.recover()).toBe(1);
    restarted.initialize();
    expect(restarted.getDocument(retainedId)).toBeDefined();
    expect(restarted.getDocument(discarded.id)).toBeUndefined();
    expect(restarted.snapshot().documents.map(({ id }) => id)).not.toContain(discarded.id);
  });

  it('gives a human-held object lock priority while allowing unrelated agent work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    await service.compactRecovery();
    const document = service.snapshot().activeDocument!;
    if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const timestamp = nowIso();
    const shape = (id: string, name: string): ShapeObject => ({
      id, revision: 0, name, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM },
      type: 'shape', shape: 'rectangle', width: 12, height: 12, fill: { kind: 'solid', color: '#ff6b7a' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    });
    const original = shape('locked-shape', 'Locked shape');
    expect((await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Add locked shape', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object: original }],
    })).status).toBe('committed');
    const lock = service.acquireLock({ documentId: document.id, objectIds: [original.id] });
    expect(lock.acquired).toBe(true);
    const agent: Actor = { id: 'agent-lock-test', kind: 'agent', name: 'Lock test agent', color: '#2fa7a0' };
    const agentTransaction = (operation: CanvasTransaction['operations'][number], label: string): CanvasTransaction => ({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: agent, label, createdAt: nowIso(), operations: [operation],
    });
    expect(await service.apply(agentTransaction({ kind: 'illustration.object.replace', object: { ...original, name: 'Agent overwrite' }, expectedRevision: 0 }, 'Conflicting replace'))).toMatchObject({ status: 'locked' });
    expect(await service.apply(agentTransaction({ kind: 'illustration.object.delete', objectId: original.id, expectedRevision: 0 }, 'Conflicting delete'))).toMatchObject({ status: 'locked' });
    expect((await service.apply(agentTransaction({ kind: 'illustration.object.add', object: shape('unrelated-shape', 'Unrelated shape') }, 'Unrelated add'))).status).toBe('committed');

    expect((await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Human keeps priority', createdAt: nowIso(),
      operations: [{ kind: 'illustration.object.replace', object: { ...original, name: 'Human edit' }, expectedRevision: 0 }],
    })).status).toBe('committed');
    const edited = service.getDocument(document.id);
    if (!edited || edited.kind !== 'illustration') throw new Error('Expected illustration');
    expect(edited.objects[original.id]?.name).toBe('Human edit');
    expect(service.snapshot().agentHistories.find((entry) => entry.actor.id === agent.id)).toMatchObject({ canUndo: true, canRedo: false });
    expect((await service.undoAgent(document.id, agent.id)).status).toBe('committed');
    const agentUndone = service.getDocument(document.id);
    if (!agentUndone || agentUndone.kind !== 'illustration') throw new Error('Expected illustration');
    expect(agentUndone.objects['unrelated-shape']).toBeUndefined();
    expect(agentUndone.objects[original.id]?.name).toBe('Human edit');
    expect(service.snapshot().agentHistories.find((entry) => entry.actor.id === agent.id)).toMatchObject({ canRedo: true });
    expect((await service.redoAgent(document.id, agent.id)).status).toBe('committed');
    expect(await service.undoAgent(document.id, HUMAN_ACTOR.id)).toMatchObject({ status: 'conflict' });
    if (lock.lockId) service.releaseLock(lock.lockId);
    await service.compactRecovery();
  });

  it('blocks only overlapping agent pixels inside a human-held region', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const snapshot = service.create({ kind: 'sprite', name: 'Region lock' });
    await service.compactRecovery();
    const document = snapshot.activeDocument!;
    if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const lock = service.acquireLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, x: 10, y: 10, width: 4, height: 4 } });
    const agent: Actor = { id: 'agent-region-test', kind: 'agent', name: 'Region test agent', color: '#8268dd' };
    const write = (x: number, y: number, owner: Actor, expectedRevision = 0): CanvasTransaction => ({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: owner,
      label: `Write ${x},${y}`, createdAt: nowIso(), operations: [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x, y, index: 4 }], expectedRevision }],
    });
    expect(await service.apply(write(12, 12, agent))).toMatchObject({ status: 'locked' });
    expect((await service.apply(write(0, 0, agent))).status).toBe('committed');
    expect((await service.apply(write(11, 11, HUMAN_ACTOR, 1))).status).toBe('committed');
    if (lock.lockId) service.releaseLock(lock.lockId);
    await service.compactRecovery();
  });

  it('protects a pixel asset replacement while its inspector gesture holds an asset lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-')); temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0'); services.push(service); service.initialize();
    const snapshot = service.create({ kind: 'sprite', name: 'Asset lock' }); const document = snapshot.activeDocument!; if (document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const lock = service.acquireLock({ documentId: document.id, objectIds: [sprite.id] }); expect(lock.acquired).toBe(true);
    const agent: Actor = { id: 'agent-asset-lock-test', kind: 'agent', name: 'Asset lock agent', color: '#8268dd' };
    const replacement = { ...structuredClone(sprite), name: 'Agent replacement' };
    expect(await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: agent, label: 'Replace held asset', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: replacement, expectedRevision: sprite.revision }] })).toMatchObject({ status: 'locked' });
    expect((await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Human replaces held asset', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: { ...replacement, name: 'Human replacement' }, expectedRevision: sprite.revision }] })).status).toBe('committed');
    if (lock.lockId) service.releaseLock(lock.lockId); await service.compactRecovery();
  });
});
