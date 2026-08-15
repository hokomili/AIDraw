import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createEmptyBitmapFont,
  createId,
  deleteBitmapFont,
  deleteBitmapFontGlyph,
  editBitmapFontGlyph,
  nowIso,
  readPixel,
  renameBitmapFont,
  type Actor,
  type CanvasOperation,
  type CanvasTransaction,
  type IllustrationDocument,
  type PixelDocument,
  type ShapeObject,
} from '@aidraw/core';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';

const AGENT: Actor = { id: 'history-agent', kind: 'agent', name: 'History agent', color: '#2fa7a0' };
const temporaryPaths: string[] = [];
const services: DocumentService[] = [];

afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Document-history fixture teardown failed.');
});

async function serviceFixture(): Promise<{ service: DocumentService; document: IllustrationDocument; first: ShapeObject; second: ShapeObject }> {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-history-'));
  temporaryPaths.push(root);
  const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
  services.push(service);
  service.initialize();
  const document = service.snapshot().activeDocument;
  if (!document || document.kind !== 'illustration') throw new Error('Expected illustration document');
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
  if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
  const shape = (id: string, x: number): ShapeObject => ({
    id,
    revision: 0,
    name: id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy: HUMAN_ACTOR.id,
    layerId: layer.id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x },
    type: 'shape',
    shape: 'rectangle',
    width: 12,
    height: 8,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  });
  const first = shape('history-shape-one', 0); const second = shape('history-shape-two', 24);
  const seeded = await service.apply(transaction(document.id, HUMAN_ACTOR, 'Seed history objects', [
    { kind: 'illustration.object.add', object: first },
    { kind: 'illustration.object.add', object: second },
  ]), { recordHistory: false });
  expect(seeded.status).toBe('committed');
  const current = service.getDocument(document.id);
  if (!current || current.kind !== 'illustration') throw new Error('Expected seeded illustration document');
  return { service, document: current, first: current.objects[first.id] as ShapeObject, second: current.objects[second.id] as ShapeObject };
}

function transaction(documentId: string, actor: Actor, label: string, operations: CanvasOperation[]): CanvasTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), documentId, actor, label, createdAt: nowIso(), operations };
}

function illustration(service: DocumentService, documentId: string): IllustrationDocument {
  const document = service.getDocument(documentId);
  if (!document || document.kind !== 'illustration') throw new Error('Expected illustration document');
  return document;
}

function pixel(service: DocumentService, documentId: string): PixelDocument {
  const document = service.getDocument(documentId);
  if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
  return document;
}

function replaceName(document: IllustrationDocument, objectId: string, name: string): CanvasOperation {
  const object = document.objects[objectId];
  return { kind: 'illustration.object.replace', object: { ...object, name }, expectedRevision: object.revision };
}

describe('per-actor document history lineage', () => {
  it('undoes font creation and deletion as exact whole-library changes without rewriting rasterized cels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-history-fonts-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const created = service.create({ kind: 'sprite', name: 'Font history', width: 8, height: 8 }).activeDocument;
    if (!created || created.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = created.pixelAssets[created.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Seed rasterized text pixel', [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 2, y: 3, index: 4 }], expectedRevision: cel.revision }]), { recordHistory: false })).status).toBe('committed');
    const baseline = pixel(service, created.id);
    const originalFonts = structuredClone(baseline.bitmapFonts);
    const originalAssets = structuredClone(baseline.pixelAssets);
    const originalPalette = structuredClone(baseline.palette);
    const creation = createEmptyBitmapFont(baseline.bitmapFonts, { id: 'bitmap-font-history-empty', name: 'History empty', lineHeight: 11 });

    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Create bitmap font', [{ kind: 'pixel.bitmap-fonts.replace', fonts: creation.fonts }]))).status).toBe('committed');
    let current = pixel(service, created.id);
    expect(current.bitmapFonts).toEqual(creation.fonts);
    expect(current.pixelAssets).toEqual(originalAssets);
    expect(current.palette).toEqual(originalPalette);
    const deletion = deleteBitmapFont(current.bitmapFonts, originalFonts[0].id);
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Delete bitmap font', [{ kind: 'pixel.bitmap-fonts.replace', fonts: deletion.fonts }]))).status).toBe('committed');
    current = pixel(service, created.id);
    expect(current.bitmapFonts).toEqual([creation.font]);
    expect(current.pixelAssets).toEqual(originalAssets);
    expect(readPixel((current.pixelAssets[sprite.id] as typeof sprite).cels[cel.id], 2, 3)).toBe(4);

    expect((await service.undo(created.id, HUMAN_ACTOR)).status).toBe('committed');
    current = pixel(service, created.id);
    expect(current.bitmapFonts).toEqual(creation.fonts);
    expect(current.pixelAssets).toEqual(originalAssets);
    expect((await service.undo(created.id, HUMAN_ACTOR)).status).toBe('committed');
    current = pixel(service, created.id);
    expect(current.bitmapFonts).toEqual(originalFonts);
    expect(current.pixelAssets).toEqual(originalAssets);
    expect(current.palette).toEqual(originalPalette);
  });

  it('undoes selected-font rename, glyph editing, and glyph deletion through exact library snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-history-font-edit-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const created = service.create({ kind: 'sprite', name: 'Font edit history', width: 8, height: 8 }).activeDocument;
    if (!created || created.kind !== 'pixel') throw new Error('Expected pixel document');
    const originalFonts = structuredClone(created.bitmapFonts);
    const originalAssets = structuredClone(created.pixelAssets);
    const originalPalette = structuredClone(created.palette);

    const renamed = renameBitmapFont(created.bitmapFonts, structuredClone(created.bitmapFonts[0]), 'Interface');
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Rename bitmap font', [{ kind: 'pixel.bitmap-fonts.replace', fonts: renamed.fonts }]))).status).toBe('committed');
    let current = pixel(service, created.id);
    const edited = editBitmapFontGlyph(current.bitmapFonts, structuredClone(current.bitmapFonts[0]), 'A', { width: 2, advance: 3, rows: ['#.', '##'] }, 8);
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Edit bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace', fonts: edited.fonts }]))).status).toBe('committed');
    current = pixel(service, created.id);
    const deleted = deleteBitmapFontGlyph(current.bitmapFonts, structuredClone(current.bitmapFonts[0]), '?');
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Delete bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace', fonts: deleted.fonts }]))).status).toBe('committed');
    current = pixel(service, created.id);
    expect(current.bitmapFonts[0].name).toBe('Interface');
    expect(current.bitmapFonts[0].glyphs.A).toEqual({ width: 2, advance: 3, rows: ['#.', '##'] });
    expect(current.bitmapFonts[0].glyphs['?']).toBeUndefined();
    expect(current.pixelAssets).toEqual(originalAssets);
    expect(current.palette).toEqual(originalPalette);

    expect((await service.undo(created.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(pixel(service, created.id).bitmapFonts[0].glyphs['?']).toEqual(originalFonts[0].glyphs['?']);
    expect((await service.undo(created.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(pixel(service, created.id).bitmapFonts[0]).toEqual(renamed.font);
    expect((await service.undo(created.id, HUMAN_ACTOR)).status).toBe('committed');
    current = pixel(service, created.id);
    expect(current.bitmapFonts).toEqual(originalFonts);
    expect(current.pixelAssets).toEqual(originalAssets);
    expect(current.palette).toEqual(originalPalette);
  });

  it('rebases consecutive same-actor revisions through complete undo and redo stacks', async () => {
    const { service, document, first } = await serviceFixture();
    const baselineRevision = document.revision;
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'First name', [replaceName(document, first.id, 'First name')]))).status).toBe('committed');
    const once = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Second name', [replaceName(once, first.id, 'Second name')]))).status).toBe('committed');

    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).objects[first.id].name).toBe('First name');
    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).objects[first.id].name).toBe(first.name);
    expect((await service.redo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).objects[first.id].name).toBe('First name');
    expect((await service.redo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).objects[first.id].name).toBe('Second name');

    const changes = service.getChanges(document.id, baselineRevision);
    expect(changes.map((entry) => entry.revision)).toEqual(Array.from({ length: 6 }, (_, index) => baselineRevision + index + 1));
    expect(changes.map((entry) => entry.transaction.actor.id)).toEqual(Array(6).fill(HUMAN_ACTOR.id));
  });

  it('allows disjoint actors to undo independently without overwriting each other', async () => {
    const { service, document, first, second } = await serviceFixture();
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Human first object', [replaceName(document, first.id, 'Human first object')]))).status).toBe('committed');
    const afterHuman = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, AGENT, 'Agent second object', [replaceName(afterHuman, second.id, 'Agent second object')]))).status).toBe('committed');

    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    let current = illustration(service, document.id);
    expect(current.objects[first.id].name).toBe(first.name);
    expect(current.objects[second.id].name).toBe('Agent second object');
    expect((await service.undo(document.id, AGENT)).status).toBe('committed');
    current = illustration(service, document.id);
    expect(current.objects[first.id].name).toBe(first.name);
    expect(current.objects[second.id].name).toBe(second.name);
  });

  it('allows a newer own edit to undo to foreign state but blocks crossing the foreign overlap', async () => {
    const { service, document, first } = await serviceFixture();
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Human before agent', [replaceName(document, first.id, 'Human before agent')]))).status).toBe('committed');
    const afterHuman = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, AGENT, 'Agent overlap', [replaceName(afterHuman, first.id, 'Agent overlap')]))).status).toBe('committed');
    const afterAgent = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Human after agent', [replaceName(afterAgent, first.id, 'Human after agent')]))).status).toBe('committed');

    expect(service.snapshot().canUndo).toBe(true);
    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).objects[first.id].name).toBe('Agent overlap');
    expect(service.snapshot().canUndo).toBe(false);
    expect(await service.undo(document.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(AGENT.name) });
    expect(illustration(service, document.id).objects[first.id].name).toBe('Agent overlap');
  });

  it('invalidates redo when another actor changes the same logical target', async () => {
    const { service, document, first } = await serviceFixture();
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Human reversible edit', [replaceName(document, first.id, 'Human reversible edit')]))).status).toBe('committed');
    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    const restored = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, AGENT, 'Agent after undo', [replaceName(restored, first.id, 'Agent after undo')]))).status).toBe('committed');

    expect(service.snapshot().canRedo).toBe(false);
    expect(await service.redo(document.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(AGENT.name) });
    expect(illustration(service, document.id).objects[first.id].name).toBe('Agent after undo');
  });

  it('protects unguarded document fields by logical target rather than revision accidents', async () => {
    const { service, document, first } = await serviceFixture();
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Human rename', [{ kind: 'document.rename', name: 'Human rename' }]))).status).toBe('committed');
    const afterRename = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, AGENT, 'Disjoint agent object', [replaceName(afterRename, first.id, 'Disjoint agent object')]))).status).toBe('committed');
    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id)).toMatchObject({ name: document.name, objects: { [first.id]: { name: 'Disjoint agent object' } } });

    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Human rename again', [{ kind: 'document.rename', name: 'Human rename again' }]))).status).toBe('committed');
    expect((await service.apply(transaction(document.id, AGENT, 'Agent rename overlap', [{ kind: 'document.rename', name: 'Agent rename overlap' }]))).status).toBe('committed');
    expect(service.snapshot().canUndo).toBe(false);
    expect(await service.undo(document.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(AGENT.name) });
    expect(illustration(service, document.id).name).toBe('Agent rename overlap');
  });

  it('treats an explicitly unrecorded same-actor mutation as an undo barrier', async () => {
    const { service, document, first } = await serviceFixture();
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Recorded edit', [replaceName(document, first.id, 'Recorded edit')]))).status).toBe('committed');
    const recorded = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Unrecorded edit', [replaceName(recorded, first.id, 'Unrecorded edit')]), { recordHistory: false })).status).toBe('committed');
    expect(service.snapshot().canUndo).toBe(false);
    expect(await service.undo(document.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(HUMAN_ACTOR.name) });
    expect(illustration(service, document.id).objects[first.id].name).toBe('Unrecorded edit');
  });

  it('blocks regrouping over a foreign child move after a group deletion', async () => {
    const { service, document, first } = await serviceFixture();
    const group = {
      id: 'history-group', revision: 0, name: 'History group', createdAt: nowIso(), updatedAt: nowIso(), createdBy: HUMAN_ACTOR.id,
      layerId: first.layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'group' as const, childIds: [first.id],
    };
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Seed group', [{ kind: 'illustration.object.add', object: group }]), { recordHistory: false })).status).toBe('committed');
    let current = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Delete group', [{ kind: 'illustration.object.delete', objectId: group.id, expectedRevision: current.objects[group.id].revision }]))).status).toBe('committed');
    current = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, AGENT, 'Move former child', [{ kind: 'illustration.object.move', objectId: first.id, layerId: first.layerId, index: 1, expectedRevision: current.objects[first.id].revision }]))).status).toBe('committed');

    expect(service.snapshot().canUndo).toBe(false);
    expect(await service.undo(document.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(AGENT.name) });
    expect(illustration(service, document.id).objects[group.id]).toBeUndefined();
  });

  it('treats a whole-sprite inverse as overlapping later nested pixel edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-history-pixel-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const created = service.create({ kind: 'sprite', name: 'History sprite', width: 8, height: 8 }).activeDocument;
    if (!created || created.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = created.pixelAssets[created.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const timestamp = nowIso(); const frameId = 'history-frame-two';
    const frame = { id: frameId, revision: 0, name: 'Frame 2', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 120 };
    const cels = sprite.layerIds.map((layerId, index) => ({ id: `history-frame-two-cel-${index}`, revision: 0, name: `Frame 2 cel ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} }));
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Seed second frame', [{ kind: 'pixel.frame.add', spriteId: sprite.id, frame, cels, expectedRevision: sprite.revision }]), { recordHistory: false })).status).toBe('committed');
    let current = service.getDocument(created.id);
    if (!current || current.kind !== 'pixel') throw new Error('Expected pixel document');
    let currentSprite = current.pixelAssets[sprite.id];
    if (currentSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect((await service.apply(transaction(created.id, HUMAN_ACTOR, 'Delete second frame', [{ kind: 'pixel.frame.delete', spriteId: sprite.id, frameId, expectedRevision: currentSprite.revision }]))).status).toBe('committed');
    current = service.getDocument(created.id);
    if (!current || current.kind !== 'pixel') throw new Error('Expected pixel document');
    currentSprite = current.pixelAssets[sprite.id];
    if (currentSprite.type !== 'sprite') throw new Error('Expected sprite');
    const firstCel = Object.values(currentSprite.cels)[0];
    expect((await service.apply(transaction(created.id, AGENT, 'Agent nested pixel', [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: firstCel.id, changes: [{ x: 1, y: 1, index: 4 }], expectedRevision: firstCel.revision }]))).status).toBe('committed');

    expect(service.snapshot().canUndo).toBe(false);
    expect(await service.undo(created.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(AGENT.name) });
    const preserved = service.getDocument(created.id);
    if (!preserved || preserved.kind !== 'pixel') throw new Error('Expected pixel document');
    const preservedSprite = preserved.pixelAssets[sprite.id];
    if (preservedSprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(preservedSprite.frames[frameId]).toBeUndefined();
    expect(readPixel(preservedSprite.cels[firstCel.id], 1, 1)).toBe(4);
  });

  it('rebases same-actor document revision guards but preserves their global foreign-edit barrier', async () => {
    const { service, document, second } = await serviceFixture();
    const firstGuides: CanvasOperation = { kind: 'illustration.guides.replace', guides: [{ id: 'guide-one', orientation: 'vertical', position: 10, color: '#ff0000', locked: false }], expectedRevision: document.revision };
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'First guides', [firstGuides]))).status).toBe('committed');
    const once = illustration(service, document.id);
    const secondGuides: CanvasOperation = { kind: 'illustration.guides.replace', guides: [{ id: 'guide-two', orientation: 'horizontal', position: 20, color: '#00ff00', locked: false }], expectedRevision: once.revision };
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Second guides', [secondGuides]))).status).toBe('committed');
    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).guides.map((guide) => guide.id)).toEqual(['guide-one']);
    expect((await service.undo(document.id, HUMAN_ACTOR)).status).toBe('committed');
    expect(illustration(service, document.id).guides).toEqual([]);

    const current = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, HUMAN_ACTOR, 'Guarded guides', [{ ...firstGuides, expectedRevision: current.revision }]))).status).toBe('committed');
    const guarded = illustration(service, document.id);
    expect((await service.apply(transaction(document.id, AGENT, 'Foreign disjoint object', [replaceName(guarded, second.id, 'Foreign disjoint object')]))).status).toBe('committed');
    expect(service.snapshot().canUndo).toBe(false);
    expect(await service.undo(document.id, HUMAN_ACTOR)).toMatchObject({ status: 'conflict', message: expect.stringContaining(AGENT.name) });
    expect(illustration(service, document.id).guides.map((guide) => guide.id)).toEqual(['guide-one']);
  });
});
