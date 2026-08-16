import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, applyTransaction, createId, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTilemap, createPixelTileset, encodeTiledGid, nowIso, readTileAt, type Actor, type CanvasTransaction, type ShapeObject } from '@aidraw/core';
import type { TransactionTraceEntry } from '@common/contracts';
import { appendImageCollectionSource, createImageCollectionTileset, imageCollectionSourceDependencyGuards, removeUnusedImageCollectionSource, replaceImageCollectionSource, replaceImageCollectionTileMetadata } from '@common/image-collection-authoring';
import { planTileObjectCreation } from '@common/tile-object-authoring';
import { planMapTileAuthoringSelection } from '@common/map-tile-authoring';
import { parseStampLibraryJson, prepareStampLibraryImport, serializePortableTileStampKit } from '@common/stamp-library-interchange';
import { DocumentService, type NativeDocumentPreviewRenderer } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { writeNativeDocument } from '@main/persistence';
import { TransactionTraceStore } from '@main/trace-store';
import { createCanvas } from '@napi-rs/canvas';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const temporaryPaths: string[] = [];
const services: DocumentService[] = [];

function pngAsset(id: string) {
  const bytes = createCanvas(1, 1).toBuffer('image/png');
  return {
    id,
    name: 'Serialized image asset',
    mimeType: 'image/png' as const,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: 'embedded' as const,
    data: bytes.toString('base64'),
  };
}

afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Document-service fixture teardown failed.');
});

describe('document service collaboration semantics', () => {
  it('archives the exact admitted preview while isolating renderer mutations from the saved document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-supervised-preview-'));
    temporaryPaths.push(root);
    const canvas = createCanvas(3, 2);
    const context = canvas.getContext('2d'); context.fillStyle = '#ff6b7a'; context.fillRect(0, 0, 3, 2);
    const preview = canvas.toBuffer('image/png');
    const previewRenderer = vi.fn<NativeDocumentPreviewRenderer>(async (snapshot) => {
      snapshot.name = 'Renderer mutation must stay isolated';
      return preview;
    });
    const service = new DocumentService(
      new RecoveryJournal(join(root, 'recovery')),
      '1.0.0',
      undefined,
      undefined,
      previewRenderer,
    );
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Saved preview source', width: 3, height: 2 }).activeDocument!;

    const destination = await service.save(document.id, join(root, 'supervised-preview.aidraw'));
    const files = unzipSync(new Uint8Array(await readFile(destination)));
    expect(Buffer.from(files['preview.png'])).toEqual(preview);
    expect(JSON.parse(strFromU8(files['document.json']))).toMatchObject({ id: document.id, name: 'Saved preview source' });
    expect(service.getDocument(document.id)).toMatchObject({ name: 'Saved preview source', filePath: destination, dirty: false });
    expect(previewRenderer).toHaveBeenCalledOnce();
  });

  it('keeps edits committed during save out of that revision-bound archive and dirty in recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-save-snapshot-'));
    temporaryPaths.push(root);
    const recoveryRoot = join(root, 'recovery');
    let markTraceRead!: () => void;
    let releaseTraceRead!: () => void;
    const traceReadStarted = new Promise<void>((resolve) => { markTraceRead = resolve; });
    const traceReadRelease = new Promise<void>((resolve) => { releaseTraceRead = resolve; });
    class DelayedTraceStore extends TransactionTraceStore {
      override async list(documentId: string, limit = Number.POSITIVE_INFINITY) {
        markTraceRead();
        await traceReadRelease;
        return super.list(documentId, limit);
      }
    }
    const canvas = createCanvas(3, 2);
    const preview = canvas.toBuffer('image/png');
    const previewNames: string[] = [];
    const previewRenderer = vi.fn<NativeDocumentPreviewRenderer>(async (snapshot) => {
      previewNames.push(snapshot.name);
      return preview;
    });
    const service = new DocumentService(
      new RecoveryJournal(recoveryRoot),
      '1.0.0',
      new DelayedTraceStore(join(root, 'trace')),
      undefined,
      previewRenderer,
    );
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Revision zero', width: 3, height: 2 }).activeDocument!;
    const savedRevision = document.revision;
    const destinationPath = join(root, 'revision-bound.aidraw');
    const save = service.save(document.id, destinationPath);
    await traceReadStarted;

    const committed = await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Edit during save', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Unsaved revision one' }],
    });
    expect(committed).toMatchObject({ status: 'committed', revision: savedRevision + 1 });
    releaseTraceRead();
    const destination = await save;

    const archive = unzipSync(new Uint8Array(await readFile(destination)));
    expect(JSON.parse(strFromU8(archive['document.json']))).toMatchObject({ name: 'Revision zero', revision: savedRevision });
    expect(strFromU8(archive['trace/transactions.jsonl'])).toBe('');
    expect(previewNames).toEqual(['Revision zero']);
    expect(service.getDocument(document.id)).toMatchObject({
      name: 'Unsaved revision one', revision: savedRevision + 1, filePath: destination, dirty: true,
    });

    await service.flushRecovery();
    const recovered = (await new RecoveryJournal(recoveryRoot).recover()).find(({ id }) => id === document.id);
    expect(recovered).toMatchObject({
      name: 'Unsaved revision one', revision: savedRevision + 1, filePath: destination, dirty: true,
    });
  });

  it('serializes saves in invocation order and continues after an earlier preview failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-save-queue-'));
    temporaryPaths.push(root);
    const canvas = createCanvas(3, 2);
    const preview = canvas.toBuffer('image/png');
    let previewCount = 0;
    let markFirstPreview!: () => void;
    let releaseFirstPreview!: () => void;
    const firstPreviewStarted = new Promise<void>((resolve) => { markFirstPreview = resolve; });
    const firstPreviewRelease = new Promise<void>((resolve) => { releaseFirstPreview = resolve; });
    const previewRenderer = vi.fn<NativeDocumentPreviewRenderer>(async () => {
      previewCount += 1;
      if (previewCount === 1) {
        markFirstPreview();
        await firstPreviewRelease;
        throw new Error('Injected first-save preview failure.');
      }
      return preview;
    });
    const service = new DocumentService(new RecoveryJournal(join(root, 'recovery')), '1.0.0', undefined, undefined, previewRenderer);
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Serialized saves', width: 3, height: 2 }).activeDocument!;
    const failedPath = join(root, 'failed.aidraw');
    const successfulPath = join(root, 'successful.aidraw');

    const firstSave = service.save(document.id, failedPath);
    await firstPreviewStarted;
    const secondSave = service.save(document.id, successfulPath);
    await Promise.resolve();
    expect(previewCount).toBe(1);
    releaseFirstPreview();
    await expect(firstSave).rejects.toThrow('Injected first-save preview failure.');
    const destination = await secondSave;

    expect(previewCount).toBe(2);
    await expect(readFile(failedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(destination)))['document.json']))).toMatchObject({ name: 'Serialized saves' });
    expect(service.getDocument(document.id)).toMatchObject({ filePath: successfulPath, dirty: false });
  });

  it('does not let a stale save completion mutate or recover a replacement document incarnation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-save-incarnation-'));
    temporaryPaths.push(root);
    const recoveryRoot = join(root, 'recovery');
    const canvas = createCanvas(3, 2);
    const preview = canvas.toBuffer('image/png');
    let markPreview!: () => void;
    let releasePreview!: () => void;
    const previewStarted = new Promise<void>((resolve) => { markPreview = resolve; });
    const previewRelease = new Promise<void>((resolve) => { releasePreview = resolve; });
    const previewRenderer = vi.fn<NativeDocumentPreviewRenderer>(async () => {
      markPreview();
      await previewRelease;
      return preview;
    });
    const service = new DocumentService(new RecoveryJournal(recoveryRoot), '1.0.0', undefined, undefined, previewRenderer);
    services.push(service);
    const original = service.create({ kind: 'illustration', name: 'Closing save source', width: 3, height: 2 }).activeDocument!;
    const destinationPath = join(root, 'closed-source.aidraw');
    const save = service.save(original.id, destinationPath);
    await previewStarted;
    await service.close(original.id, true);
    const replacement = structuredClone(original);
    replacement.name = 'Replacement incarnation';
    replacement.filePath = join(root, 'replacement.aidraw');
    replacement.dirty = true;
    service.addDocument(replacement);
    releasePreview();
    await save;

    expect(service.getDocument(original.id)).toMatchObject({
      name: 'Replacement incarnation', filePath: replacement.filePath, dirty: true,
    });
    expect(JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(destinationPath)))['document.json']))).toMatchObject({ name: 'Closing save source' });
    await service.flushRecovery();
    const recovered = (await new RecoveryJournal(recoveryRoot).recover()).find(({ id }) => id === original.id);
    expect(recovered).toMatchObject({ name: 'Replacement incarnation', filePath: replacement.filePath, dirty: true });
  });

  it('rejects invalid or contradictory preview output before replacing an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-preview-admission-'));
    temporaryPaths.push(root);
    const wrongCanvas = createCanvas(1, 1);
    const previewRenderer = vi.fn<NativeDocumentPreviewRenderer>()
      .mockResolvedValueOnce(Buffer.from('not a PNG'))
      .mockResolvedValueOnce(wrongCanvas.toBuffer('image/png'));
    const service = new DocumentService(
      new RecoveryJournal(join(root, 'recovery')),
      '1.0.0',
      undefined,
      undefined,
      previewRenderer,
    );
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Preview admission', width: 3, height: 2 }).activeDocument!;
    const destination = join(root, 'existing.aidraw');
    const original = Buffer.from('existing destination bytes');
    await writeFile(destination, original);

    await expect(service.save(document.id, destination)).rejects.toThrow('Native document preview renderer returned an invalid PNG.');
    expect(await readFile(destination)).toEqual(original);
    await expect(service.save(document.id, destination)).rejects.toThrow('Native document preview renderer returned contradictory PNG dimensions.');
    expect(await readFile(destination)).toEqual(original);
    expect(service.getDocument(document.id)?.filePath).toBeUndefined();
    expect(service.getDocument(document.id)?.dirty).toBe(false);
    expect(previewRenderer).toHaveBeenCalledTimes(2);
  });

  it('saves an oversized nominal tilemap with the established transparent preview fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-bounded-preview-'));
    temporaryPaths.push(root);
    const previewRenderer = vi.fn<NativeDocumentPreviewRenderer>(async () => { throw new Error('Oversized preview must be skipped.'); });
    const service = new DocumentService(new RecoveryJournal(join(root, 'recovery')), '1.0.0', undefined, undefined, previewRenderer);
    services.push(service);
    service.initialize();
    const document = service.create({ kind: 'tilemap', name: 'Oversized saved map', width: 32, height: 1, tileWidth: 16, tileHeight: 16 }).activeDocument;
    if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document');
    const map = document.pixelAssets[document.activeAssetId];
    if (map.type !== 'tilemap') throw new Error('Expected tilemap');
    map.width = 1_000_000;
    expect((await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Expand nominal map bounds', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.replace', asset: map, expectedRevision: map.revision }],
    })).status).toBe('committed');

    const destination = await service.save(document.id, join(root, 'oversized-map.aidraw'));
    const files = unzipSync(new Uint8Array(await readFile(destination)));
    const preview = Buffer.from(files['preview.png']);
    expect({ width: preview.readUInt32BE(16), height: preview.readUInt32BE(20) }).toEqual({ width: 1, height: 1 });
    expect(previewRenderer).not.toHaveBeenCalled();
  });

  it('wires production native previews to the supervised PNG export lane', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/engine-runtime.ts'), 'utf8');
    expect(source).toContain("async (document) => (await this.rasterUtilities.exportDocument(document, 'png')).data");
    expect(source.indexOf('this.rasterUtilities = new RasterUtilitySupervisor()')).toBeLessThan(source.indexOf('this.service = new DocumentService('));
  });

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

  it('restores eight documents in tab order with the exact active, dirty, and saved-path state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-workspace-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(join(root, 'recovery')), '1.0.0');
    services.push(service);
    service.initialize();
    const original = service.snapshot().activeDocument!;
    const saved = service.create({ kind: 'illustration', name: 'Saved clean illustration' }).activeDocument!;
    expect((await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: saved.id, actor: HUMAN_ACTOR, label: 'Prepare saved document', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Saved clean illustration' }] })).status).toBe('committed');
    const savedPath = await service.save(saved.id, join(root, 'saved-clean.aidraw'));
    const cleanSprite = service.create({ kind: 'sprite', name: 'Clean sprite' }).activeDocument!;
    const dirtySprite = service.create({ kind: 'sprite', name: 'Dirty sprite' }).activeDocument!;
    expect((await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: dirtySprite.id, actor: HUMAN_ACTOR, label: 'Dirty sprite', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Dirty sprite edited' }] })).status).toBe('committed');
    const cleanTilemap = service.create({ kind: 'tilemap', name: 'Clean tilemap' }).activeDocument!;
    const dirtyTilemap = service.create({ kind: 'tilemap', name: 'Dirty tilemap' }).activeDocument!;
    expect((await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: dirtyTilemap.id, actor: HUMAN_ACTOR, label: 'Dirty tilemap', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Dirty tilemap edited' }] })).status).toBe('committed');
    const cleanProject = service.create({ kind: 'project', name: 'Clean project' }).activeDocument!;
    const dirtyIllustration = service.create({ kind: 'illustration', name: 'Dirty illustration' }).activeDocument!;
    expect((await service.apply({ id: createId('tx'), clientOperationId: createId('op'), documentId: dirtyIllustration.id, actor: HUMAN_ACTOR, label: 'Dirty illustration', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Dirty illustration edited' }] })).status).toBe('committed');
    const expectedOrder = [original.id, saved.id, cleanSprite.id, dirtySprite.id, cleanTilemap.id, dirtyTilemap.id, cleanProject.id, dirtyIllustration.id];
    service.activate(cleanSprite.id);
    await service.compactRecovery();

    const restarted = new DocumentService(new RecoveryJournal(join(root, 'recovery')), '1.0.0');
    services.push(restarted);
    expect(await restarted.recover()).toBe(8);
    restarted.initialize();
    const snapshot = restarted.snapshot();
    expect(snapshot.documents.map((document) => document.id)).toEqual(expectedOrder);
    expect(snapshot.activeDocumentId).toBe(cleanSprite.id);
    expect(snapshot.documents.map(({ id, dirty, filePath }) => ({ id, dirty, filePath }))).toEqual([
      { id: original.id, dirty: false, filePath: undefined },
      { id: saved.id, dirty: false, filePath: savedPath },
      { id: cleanSprite.id, dirty: false, filePath: undefined },
      { id: dirtySprite.id, dirty: true, filePath: undefined },
      { id: cleanTilemap.id, dirty: false, filePath: undefined },
      { id: dirtyTilemap.id, dirty: true, filePath: undefined },
      { id: cleanProject.id, dirty: false, filePath: undefined },
      { id: dirtyIllustration.id, dirty: true, filePath: undefined },
    ]);
  });

  it('preserves recovered documents and asset metadata while omitting invalid embedded image payloads with one warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-image-recovery-'));
    temporaryPaths.push(root);
    const journal = new RecoveryJournal(root);
    const document = createIllustrationDocument('Recovered image payloads');
    const bytes = createCanvas(2, 3).toBuffer('image/png');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    document.assets['decoder-rejected'] = {
      id: 'decoder-rejected', name: 'Decoder-rejected image', mimeType: 'image/png', byteLength: bytes.byteLength,
      sha256, source: 'embedded', data: bytes.toString('base64'),
    };
    document.assets['hash-rejected'] = {
      id: 'hash-rejected', name: 'Hash-rejected image', mimeType: 'image/png', byteLength: bytes.byteLength,
      sha256: '0'.repeat(64), source: 'embedded', data: bytes.toString('base64'),
    };
    await journal.compact(document);
    await journal.compactWorkspace([document.id], document.id);
    const decoder = vi.fn(async () => { throw new Error('fixture decoder rejection'); });
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0', undefined, decoder);
    services.push(service);

    expect(await service.recover()).toBe(1);
    const recovered = service.getDocument(document.id)!;
    expect(recovered.assets['decoder-rejected']).toMatchObject({
      id: 'decoder-rejected', name: 'Decoder-rejected image', mimeType: 'image/png', byteLength: bytes.byteLength, sha256, source: 'embedded',
    });
    expect(recovered.assets['hash-rejected']).toMatchObject({
      id: 'hash-rejected', name: 'Hash-rejected image', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: '0'.repeat(64), source: 'embedded',
    });
    expect(recovered.assets['decoder-rejected'].data).toBeUndefined();
    expect(recovered.assets['hash-rejected'].data).toBeUndefined();
    expect(recovered.dirty).toBe(document.dirty);
    expect(decoder).toHaveBeenCalledOnce();
    expect(decoder).toHaveBeenCalledWith(bytes, { mimeType: 'image/png', width: 2, height: 3 });
    expect(service.snapshot().recoveryWarnings).toEqual([
      'Recovery omitted 2 invalid embedded image payloads across 1 recovered document; the recovered document state and asset metadata were preserved.',
    ]);
  });

  it('seeds recovery before an immediately edited native document can be returned to the caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-open-recovery-')); temporaryPaths.push(root);
    const source = createIllustrationDocument('Opened native source'); const sourcePath = await writeNativeDocument(join(root, 'source'), source, '1.0.0');
    const recoveryRoot = join(root, 'recovery'); const service = new DocumentService(new RecoveryJournal(recoveryRoot), '1.0.0'); services.push(service);
    await expect(service.open([sourcePath])).resolves.toEqual({ opened: [sourcePath], warnings: [] });
    expect(await service.apply({
      id: 'immediate-open-recovery-transaction', clientOperationId: 'immediate-open-recovery-operation', documentId: source.id,
      actor: HUMAN_ACTOR, label: 'Immediate edit after open', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Recovered immediate edit' }],
    })).toMatchObject({ status: 'committed', revision: 1 });
    await service.flushRecovery();

    const restarted = new DocumentService(new RecoveryJournal(recoveryRoot), '1.0.0'); services.push(restarted);
    expect(await restarted.recover()).toBe(1);
    expect(restarted.snapshot()).toMatchObject({ activeDocumentId: source.id, activeDocument: { id: source.id, name: 'Recovered immediate edit', revision: 1, dirty: true, filePath: sourcePath } });
  });

  it('opens and recovers native artwork when advisory trace-history import fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-open-trace-failure-'));
    temporaryPaths.push(root);
    const source = createIllustrationDocument('Trace-backed native source');
    const archivedTransaction: CanvasTransaction = {
      id: 'archived-trace-transaction', clientOperationId: 'archived-trace-operation', documentId: source.id,
      actor: HUMAN_ACTOR, label: 'Archived trace entry', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Archived trace rename' }],
    };
    const archivedTrace: TransactionTraceEntry = {
      version: 1, documentId: source.id, revision: 1, recordedAt: nowIso(), outcome: 'committed', transaction: archivedTransaction,
    };
    const archivedSource = applyTransaction(source, archivedTransaction).document;
    const sourcePath = await writeNativeDocument(join(root, 'trace-source'), archivedSource, '1.0.0', undefined, [archivedTrace]);
    const archive = unzipSync(new Uint8Array(await readFile(sourcePath)));
    archive['trace/transactions.jsonl'] = strToU8(`${strFromU8(archive['trace/transactions.jsonl'])}{}\n`);
    await writeFile(sourcePath, zipSync(archive, { level: 6 }));
    class FailingTraceStore extends TransactionTraceStore {
      readonly imports: Array<{ documentId: string; entries: TransactionTraceEntry[] }> = [];

      override async import(documentId: string, entries: TransactionTraceEntry[]): Promise<number> {
        this.imports.push({ documentId, entries: structuredClone(entries) });
        throw new Error('Injected trace import failure.');
      }
    }
    const recoveryRoot = join(root, 'recovery');
    const traces = new FailingTraceStore(join(root, 'traces'));
    const service = new DocumentService(new RecoveryJournal(recoveryRoot), '1.0.0', traces);
    services.push(service);
    const traceErrors: unknown[] = [];
    service.on('trace-error', (error) => traceErrors.push(error));

    await expect(service.open([sourcePath])).resolves.toEqual({
      opened: [sourcePath],
      warnings: [
        'A malformed transaction trace entry was ignored.',
        `${sourcePath}: Transaction trace history could not be imported: Injected trace import failure.`,
      ],
    });
    expect(traces.imports).toEqual([{ documentId: source.id, entries: [archivedTrace] }]);
    expect(traceErrors).toHaveLength(1);
    expect(traceErrors[0]).toMatchObject({ message: 'Injected trace import failure.' });
    expect(service.snapshot()).toMatchObject({
      activeDocumentId: source.id,
      activeDocument: { id: source.id, name: 'Archived trace rename', revision: 1, dirty: false, filePath: sourcePath },
    });

    await expect(service.apply({
      id: 'post-trace-failure-transaction', clientOperationId: 'post-trace-failure-operation', documentId: source.id,
      actor: HUMAN_ACTOR, label: 'Edit after trace failure', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Recoverable after trace failure' }],
    })).resolves.toMatchObject({ status: 'committed', revision: 2 });
    await service.flushRecovery();
    const restarted = new DocumentService(new RecoveryJournal(recoveryRoot), '1.0.0');
    services.push(restarted);
    expect(await restarted.recover()).toBe(1);
    expect(restarted.snapshot()).toMatchObject({
      activeDocumentId: source.id,
      activeDocument: { id: source.id, name: 'Recoverable after trace failure', revision: 2, dirty: true, filePath: sourcePath },
    });
  });

  it('refuses a different native file with an open document ID without replacing dirty work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-open-identity-'));
    temporaryPaths.push(root);
    const source = createIllustrationDocument('Canonical source');
    const sourcePath = await writeNativeDocument(join(root, 'source'), source, '1.0.0');
    const copied = structuredClone(source);
    copied.name = 'Different copied file';
    const copiedPath = await writeNativeDocument(join(root, 'copy'), copied, '1.0.0');
    const sibling = createIllustrationDocument('Independent sibling');
    const siblingPath = await writeNativeDocument(join(root, 'sibling'), sibling, '1.0.0');
    const recoveryRoot = join(root, 'recovery');
    const service = new DocumentService(new RecoveryJournal(recoveryRoot), '1.0.0');
    services.push(service);

    await expect(service.open([sourcePath])).resolves.toEqual({ opened: [sourcePath], warnings: [] });
    await expect(service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: source.id, actor: HUMAN_ACTOR,
      label: 'Unsaved canonical edit', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Dirty canonical work' }],
    })).resolves.toMatchObject({ status: 'committed', revision: 1 });
    await expect(service.open([sourcePath])).resolves.toEqual({ opened: [], warnings: [] });
    expect(service.getDocument(source.id)).toMatchObject({ name: 'Dirty canonical work', revision: 1, dirty: true, filePath: sourcePath });

    await expect(service.open([copiedPath, siblingPath])).resolves.toEqual({
      opened: [siblingPath],
      warnings: [`${copiedPath}: Document ID “${source.id}” is already in use by an open document; refusing to replace existing work.`],
    });
    expect(service.snapshot()).toMatchObject({
      activeDocumentId: sibling.id,
      documents: [
        { id: source.id, name: 'Dirty canonical work', revision: 1, dirty: true, filePath: sourcePath },
        { id: sibling.id, name: 'Independent sibling', revision: 0, dirty: false, filePath: siblingPath },
      ],
    });
    expect(service.getDocument(source.id)).toMatchObject({ name: 'Dirty canonical work', revision: 1, dirty: true, filePath: sourcePath });
    await service.flushRecovery();
    expect((await new RecoveryJournal(recoveryRoot).recover()).find(({ id }) => id === source.id)).toMatchObject({
      name: 'Dirty canonical work', revision: 1, dirty: true, filePath: sourcePath,
    });
  });

  it('rejects an imported document set atomically before cloning, publishing, or recovery replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-add-identity-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const existing = service.create({ kind: 'illustration', name: 'Existing imported work' }).activeDocument!;
    const incoming = structuredClone(existing);
    incoming.name = 'Colliding import';
    incoming.revision = 12;
    incoming.dirty = true;
    const independent = createIllustrationDocument('Would otherwise be imported first');
    const workspaceRevision = service.snapshot().workspaceRevision;

    expect(() => service.addDocuments([independent, structuredClone(independent)])).toThrow(
      `Document ID “${independent.id}” appears more than once in the incoming document set; no documents were added.`,
    );
    expect(() => service.addDocuments([independent, incoming])).toThrow(
      `Document ID “${existing.id}” is already in use by an open document; refusing to replace existing work.`,
    );
    expect(service.snapshot()).toMatchObject({
      workspaceRevision,
      activeDocumentId: existing.id,
      documents: [{ id: existing.id, name: 'Existing imported work', revision: 0 }],
      activeDocument: { id: existing.id, name: 'Existing imported work', revision: 0 },
    });
    await service.flushRecovery();
    const recovered = await new RecoveryJournal(root).recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: existing.id, name: 'Existing imported work', revision: 0 });
  });

  it('serializes delayed apply, undo, and redo requests in invocation order for one document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-mutation-queue-'));
    temporaryPaths.push(root);
    let markValidationStarted!: () => void;
    let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validationRelease = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const decoder = vi.fn(async () => {
      markValidationStarted();
      await validationRelease;
    });
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0', undefined, decoder);
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Serialized source' }).activeDocument!;
    const independent = service.create({ kind: 'illustration', name: 'Independent source' }).activeDocument!;
    const asset = pngAsset('serialized-inline-asset');

    let settled = 0;
    const observe = <T>(promise: Promise<T>) => promise.then((value) => { settled += 1; return value; });
    const add = observe(service.apply({
      id: 'serialized-add-transaction', clientOperationId: 'serialized-add-operation', documentId: document.id,
      actor: HUMAN_ACTOR, label: 'Add validated asset', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    }));
    await validationStarted;
    const rename = observe(service.apply({
      id: 'serialized-rename-transaction', clientOperationId: 'serialized-rename-operation', documentId: document.id,
      actor: HUMAN_ACTOR, label: 'Rename after validated asset', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Serialized result' }],
    }));
    const undo = observe(service.undo(document.id));
    const redo = observe(service.redo(document.id));
    await expect(service.apply({
      id: 'independent-rename-transaction', clientOperationId: 'independent-rename-operation', documentId: independent.id,
      actor: HUMAN_ACTOR, label: 'Rename independent document', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: 'Independent result' }],
    })).resolves.toMatchObject({ status: 'committed', revision: independent.revision + 1 });
    expect(settled).toBe(0);
    expect(decoder).toHaveBeenCalledOnce();
    expect(service.getDocument(independent.id)).toMatchObject({ name: 'Independent result', revision: independent.revision + 1 });

    releaseValidation();
    const responses = await Promise.all([add, rename, undo, redo]);
    expect(responses.map(({ status, revision }) => ({ status, revision }))).toEqual([
      { status: 'committed', revision: document.revision + 1 },
      { status: 'committed', revision: document.revision + 2 },
      { status: 'committed', revision: document.revision + 3 },
      { status: 'committed', revision: document.revision + 4 },
    ]);
    expect(service.getDocument(document.id)).toMatchObject({
      name: 'Serialized result', revision: document.revision + 4, assets: { [asset.id]: asset }, dirty: true,
    });
    expect(service.getChanges(document.id, document.revision).map(({ revision }) => revision)).toEqual([
      document.revision + 1, document.revision + 2, document.revision + 3, document.revision + 4,
    ]);

    await service.flushRecovery();
    expect((await new RecoveryJournal(root).recover()).find(({ id }) => id === document.id)).toMatchObject({
      name: 'Serialized result', revision: document.revision + 4, assets: { [asset.id]: asset }, dirty: true,
    });
  });

  it('atomically refuses queued collection metadata after an earlier source-sprite change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-collection-source-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const document = createPixelDocument('project', 'Queued collection source guard');
    const source0 = createPixelSprite('Tile zero', 8, 12);
    const source3 = createPixelSprite('Tile three', 17, 6);
    const tileset = createPixelTileset('Collection', source0.id, 8, 12, 1, 1);
    tileset.spriteAssetId = undefined; tileset.columns = 2; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.5, animation: [], collisions: [], properties: {} },
    };
    document.assetIds = [source0.id, source3.id, tileset.id]; document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset }; document.activeAssetId = tileset.id;
    service.addDocument(document);

    const resizedSource = structuredClone(source3); resizedSource.width += 1;
    const editedTileset = replaceImageCollectionTileMetadata(tileset, 3, { probability: 0.8 });
    const sourceWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Resize collection source first', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: resizedSource, expectedRevision: source3.revision }],
    });
    const metadataWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Edit stale collection metadata', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: editedTileset, expectedRevision: tileset.revision, expectedSpriteDependencies: imageCollectionSourceDependencyGuards(document, tileset) }],
    });
    const [sourceResponse, metadataResponse] = await Promise.all([sourceWrite, metadataWrite]);

    expect(sourceResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(metadataResponse).toMatchObject({ status: 'conflict', message: 'A referenced source sprite changed before the asset replacement', conflict: { entityId: source3.id, expectedRevision: source3.revision, actualRevision: source3.revision + 1, retryable: true } });
    const current = service.getDocument(document.id); if (current?.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(current.revision).toBe(document.revision + 1);
    expect(current.activity.map(({ label }) => label)).toEqual(['Resize collection source first']);
    expect(current.pixelAssets[source3.id]).toMatchObject({ type: 'sprite', width: source3.width + 1, revision: source3.revision + 1 });
    expect(current.pixelAssets[tileset.id]).toMatchObject({ type: 'tileset', revision: tileset.revision, tiles: { 3: { probability: 0.5 } } });
  });

  it('atomically refuses stale collection paint after queued document, tileset, or source drift and admits a fresh undoable retry', async () => {
    for (const driftKind of ['document', 'tileset', 'source'] as const) {
      const root = await mkdtemp(join(tmpdir(), `aidraw-service-collection-current-tile-${driftKind}-`));
      temporaryPaths.push(root);
      const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
      services.push(service);
      const document = createPixelDocument('project', `Queued collection ${driftKind} guard`);
      document.assetIds = []; document.pixelAssets = {};
      const source0 = createPixelSprite('Tile zero', 8, 12);
      const source3 = createPixelSprite('Tile three', 17, 6);
      const tileset = createPixelTileset('Collection', source0.id, 17, 12, 1, 1);
      tileset.spriteAssetId = undefined; tileset.firstGid = 20; tileset.columns = 0; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
      tileset.tiles = {
        0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
        3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 1, animation: [], collisions: [], properties: {} },
      };
      const map = createPixelTilemap('Collection paint map'); map.tilesetIds = [tileset.id];
      const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
      document.assetIds = [source0.id, source3.id, tileset.id, map.id];
      document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset, [map.id]: map };
      document.activeAssetId = map.id;
      service.addDocument(document);

      const stalePlan = planMapTileAuthoringSelection(document, {
        mapId: map.id,
        tilesetId: tileset.id,
        tileId: 3,
        transforms: { hFlip: true, vFlip: false, diagonal: true },
      });
      if (stalePlan.expectedDocumentRevision === undefined) throw new Error('Expected collection document guard');
      const driftOperation: CanvasTransaction['operations'][number] = driftKind === 'document'
        ? { kind: 'document.rename', name: 'Document changed first' }
        : driftKind === 'tileset'
          ? { kind: 'pixel.asset.replace', asset: { ...structuredClone(tileset), transformations: { hFlip: false, vFlip: false, rotate: false } }, expectedRevision: tileset.revision }
          : { kind: 'pixel.asset.replace', asset: { ...structuredClone(source3), width: source3.width + 1 }, expectedRevision: source3.revision };
      const driftLabel = `Change ${driftKind} before collection paint`;
      const drift = service.apply({
        id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
        label: driftLabel, createdAt: nowIso(), operations: [driftOperation],
      });
      const stalePaint = service.apply({
        id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id,
        expectedDocumentRevision: stalePlan.expectedDocumentRevision, actor: HUMAN_ACTOR,
        label: 'Paint stale collection tile', createdAt: nowIso(),
        operations: [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: [{ x: 2, y: 4, gid: stalePlan.rawGid }], expectedRevision: layer.revision }],
      });
      const [driftResponse, staleResponse] = await Promise.all([drift, stalePaint]);
      expect(driftResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
      expect(staleResponse).toMatchObject({
        status: 'conflict',
        conflict: { entityId: document.id, expectedRevision: document.revision, actualRevision: document.revision + 1, retryable: true },
      });
      const afterConflict = service.getDocument(document.id); if (!afterConflict || afterConflict.kind !== 'pixel') throw new Error('Expected pixel document');
      const afterConflictMap = afterConflict.pixelAssets[map.id]; if (afterConflictMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const afterConflictLayer = afterConflictMap.layers[layer.id]; if (afterConflictLayer.type !== 'tile' || !afterConflictLayer.chunks) throw new Error('Expected tile layer');
      expect(readTileAt(afterConflictLayer.chunks, 2, 4)).toBe(0);
      expect(afterConflict.activity.map(({ label }) => label)).toEqual([driftLabel]);
      expect(service.getChanges(document.id, document.revision)).toHaveLength(1);

      const freshPlan = planMapTileAuthoringSelection(afterConflict, {
        mapId: map.id,
        tilesetId: tileset.id,
        tileId: 3,
        transforms: { hFlip: false, vFlip: false, diagonal: false },
      });
      if (freshPlan.expectedDocumentRevision === undefined) throw new Error('Expected collection document guard');
      expect(await service.apply({
        id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id,
        expectedDocumentRevision: freshPlan.expectedDocumentRevision, actor: HUMAN_ACTOR,
        label: 'Paint current collection tile', createdAt: nowIso(),
        operations: [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: [{ x: 2, y: 4, gid: freshPlan.rawGid }], expectedRevision: afterConflictLayer.revision }],
      })).toMatchObject({ status: 'committed', revision: document.revision + 2 });
      const painted = service.getDocument(document.id); if (!painted || painted.kind !== 'pixel') throw new Error('Expected pixel document');
      const paintedMap = painted.pixelAssets[map.id]; if (paintedMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const paintedLayer = paintedMap.layers[layer.id]; if (paintedLayer.type !== 'tile' || !paintedLayer.chunks) throw new Error('Expected tile layer');
      expect(readTileAt(paintedLayer.chunks, 2, 4)).toBe(freshPlan.rawGid);
      expect(await service.undo(document.id)).toMatchObject({ status: 'committed', revision: document.revision + 3 });
      const undone = service.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
      const undoneMap = undone.pixelAssets[map.id]; if (undoneMap.type !== 'tilemap') throw new Error('Expected tilemap');
      const undoneLayer = undoneMap.layers[layer.id]; if (undoneLayer.type !== 'tile' || !undoneLayer.chunks) throw new Error('Expected tile layer');
      expect(readTileAt(undoneLayer.chunks, 2, 4)).toBe(0);
    }
  });

  it('atomically refuses a queued portable tile-kit plan after an earlier palette change, then admits a fresh import and undo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-portable-stamp-kit-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);

    const source = createPixelDocument('project', 'Portable kit source');
    source.assetIds = []; source.pixelAssets = {};
    const sourceSprite = createPixelSprite('Portable source pixels', 16, 16);
    const sourceTileset = createPixelTileset('Portable terrain', sourceSprite.id, 16, 16, 1, 1); sourceTileset.firstGid = 21;
    const sourceMap = createPixelTilemap('Portable source map'); sourceMap.tilesetIds = [sourceTileset.id];
    source.pixelAssets = { [sourceSprite.id]: sourceSprite, [sourceTileset.id]: sourceTileset, [sourceMap.id]: sourceMap };
    source.assetIds = [sourceSprite.id, sourceTileset.id, sourceMap.id]; source.activeAssetId = sourceMap.id;
    source.tileStamps = [{ id: 'portable-stamp', name: 'Portable stamp', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: encodeTiledGid(21, { hFlip: true }) }] }];
    const bundle = parseStampLibraryJson(serializePortableTileStampKit(source, sourceMap));

    const document = createPixelDocument('project', 'Portable kit destination');
    document.assetIds = []; document.pixelAssets = {};
    const targetMap = createPixelTilemap('Portable target map');
    document.assetIds = [targetMap.id]; document.pixelAssets = { [targetMap.id]: targetMap }; document.activeAssetId = targetMap.id;
    service.addDocument(document);
    let sequence = 0;
    const makeId = (prefix: string) => `${prefix}-queued-${++sequence}`;
    const stalePlan = prepareStampLibraryImport(document, bundle, 'append', { map: targetMap, makeId });
    const palette = [...document.palette, { id: 'queued-palette-entry', name: 'Queued color', color: '#123456' }];
    const paletteWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: document.revision, actor: HUMAN_ACTOR,
      label: 'Change palette before portable import', createdAt: nowIso(), operations: [{ kind: 'pixel.palette.replace', palette }],
    });
    const staleImport = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: stalePlan.expectedDocumentId,
      expectedDocumentRevision: stalePlan.expectedDocumentRevision, actor: HUMAN_ACTOR,
      label: 'Import stale portable tile kit', createdAt: nowIso(), operations: stalePlan.operations,
    });
    const [paletteResponse, staleResponse] = await Promise.all([paletteWrite, staleImport]);
    expect(paletteResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(staleResponse).toMatchObject({ status: 'conflict', conflict: { entityId: document.id, expectedRevision: document.revision, actualRevision: document.revision + 1, retryable: true } });
    const afterConflict = service.getDocument(document.id); if (!afterConflict || afterConflict.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(afterConflict.assetIds).toEqual([targetMap.id]);
    expect((afterConflict.pixelAssets[targetMap.id] as ReturnType<typeof createPixelTilemap>).tilesetIds).toEqual([]);
    expect(afterConflict.tileStamps).toEqual([]);
    expect(afterConflict.activity.map(({ label }) => label)).toEqual(['Change palette before portable import']);
    expect(service.getChanges(document.id, document.revision)).toHaveLength(1);

    const freshMap = afterConflict.pixelAssets[targetMap.id]; if (freshMap.type !== 'tilemap') throw new Error('Expected target map');
    const freshPlan = prepareStampLibraryImport(afterConflict, bundle, 'append', { map: freshMap, makeId });
    expect(await service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: freshPlan.expectedDocumentId,
      expectedDocumentRevision: freshPlan.expectedDocumentRevision, actor: HUMAN_ACTOR,
      label: 'Import current portable tile kit', createdAt: nowIso(), operations: freshPlan.operations,
    })).toMatchObject({ status: 'committed', revision: document.revision + 2 });
    const imported = service.getDocument(document.id); if (!imported || imported.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(imported.tileStamps).toHaveLength(1);
    expect(imported.assetIds.length).toBeGreaterThan(afterConflict.assetIds.length);
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed', revision: document.revision + 3 });
    const undone = service.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(undone.assetIds).toEqual(afterConflict.assetIds);
    expect((undone.pixelAssets[targetMap.id] as ReturnType<typeof createPixelTilemap>).tilesetIds).toEqual([]);
    expect(undone.tileStamps).toEqual([]);
    expect(undone.palette).toEqual(afterConflict.palette);
  });

  it('atomically refuses queued collection tile-object placement after an earlier source-sprite change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-collection-object-source-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const document = createPixelDocument('project', 'Queued collection object source guard');
    const source0 = createPixelSprite('Tile zero', 8, 12);
    const source3 = createPixelSprite('Tile three', 17, 6);
    const tileset = createPixelTileset('Collection', source0.id, 17, 12, 1, 1);
    tileset.spriteAssetId = undefined; tileset.firstGid = 20; tileset.columns = 0; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    const map = createPixelTilemap('Collection object map'); map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [];
    document.assetIds = [source0.id, source3.id, tileset.id, map.id];
    document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset, [map.id]: map };
    document.activeAssetId = map.id;
    service.addDocument(document);

    const plan = planTileObjectCreation(document, {
      mapId: map.id, layerId: layer.id, tilesetId: tileset.id, tileId: 3,
      objectId: 'queued-collection-object', point: { x: 4, y: 9 },
      transforms: { hFlip: false, vFlip: false, diagonal: false },
    });
    const resizedSource = structuredClone(source3); resizedSource.width += 1;
    const sourceWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Resize collection object source first', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: resizedSource, expectedRevision: source3.revision }],
    });
    const stalePlacement = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Place stale collection object', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: plan.asset, expectedRevision: plan.expectedRevision, expectedSpriteDependencies: plan.expectedSpriteDependencies }],
    });
    const [sourceResponse, placementResponse] = await Promise.all([sourceWrite, stalePlacement]);

    expect(sourceResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(placementResponse).toMatchObject({ status: 'conflict', message: 'A referenced source sprite changed before the asset replacement', conflict: { entityId: source3.id, expectedRevision: source3.revision, actualRevision: source3.revision + 1, retryable: true } });
    const current = service.getDocument(document.id); if (current?.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(current.revision).toBe(document.revision + 1);
    expect(current.activity.map(({ label }) => label)).toEqual(['Resize collection object source first']);
    const currentMap = current.pixelAssets[map.id]; if (currentMap.type !== 'tilemap') throw new Error('Expected tilemap');
    const currentLayer = currentMap.layers[layer.id]; if (currentLayer.type !== 'object') throw new Error('Expected object layer');
    expect(currentLayer.objects).toEqual([]);
    expect(currentMap.revision).toBe(map.revision);
  });

  it('atomically refuses queued collection tile-object placement after an earlier tileset-only removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-collection-object-document-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const document = createPixelDocument('project', 'Queued collection object document guard');
    const source0 = createPixelSprite('Tile zero', 8, 12);
    const source3 = createPixelSprite('Tile three', 17, 6);
    const tileset = createPixelTileset('Collection', source0.id, 17, 12, 1, 1);
    tileset.spriteAssetId = undefined; tileset.firstGid = 20; tileset.columns = 0; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    const map = createPixelTilemap('Collection object map'); map.tilesetIds = [tileset.id];
    const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [];
    document.assetIds = [source0.id, source3.id, tileset.id, map.id];
    document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset, [map.id]: map };
    document.activeAssetId = map.id;
    service.addDocument(document);

    const placement = planTileObjectCreation(document, {
      mapId: map.id, layerId: layer.id, tilesetId: tileset.id, tileId: 3,
      objectId: 'queued-stale-collection-object', point: { x: 4, y: 9 },
      transforms: { hFlip: false, vFlip: false, diagonal: false },
    });
    if (placement.expectedDocumentRevision === undefined) throw new Error('Expected collection document guard');
    const removal = removeUnusedImageCollectionSource(document, tileset.id, 3);
    const removeFirst = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: document.revision, actor: HUMAN_ACTOR,
      label: 'Remove selected collection source first', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: removal.tileset, expectedRevision: tileset.revision, expectedSpriteDependencies: removal.expectedSpriteDependencies }],
    });
    const stalePlacement = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: placement.expectedDocumentRevision, actor: HUMAN_ACTOR,
      label: 'Place stale collection object', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: placement.asset, expectedRevision: placement.expectedRevision, expectedSpriteDependencies: placement.expectedSpriteDependencies }],
    });
    const [removalResponse, placementResponse] = await Promise.all([removeFirst, stalePlacement]);

    expect(removalResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(placementResponse).toMatchObject({ status: 'conflict', conflict: { entityId: document.id, expectedRevision: document.revision, actualRevision: document.revision + 1, retryable: true } });
    const current = service.getDocument(document.id); if (current?.kind !== 'pixel') throw new Error('Expected pixel document');
    const currentTileset = current.pixelAssets[tileset.id]; const currentMap = current.pixelAssets[map.id];
    if (currentTileset.type !== 'tileset' || currentMap.type !== 'tilemap') throw new Error('Expected tileset and map');
    const currentLayer = currentMap.layers[layer.id]; if (currentLayer.type !== 'object') throw new Error('Expected object layer');
    expect(currentTileset.tiles).not.toHaveProperty('3');
    expect(currentLayer.objects).toEqual([]);
    expect(currentMap.revision).toBe(map.revision);
    expect(current.activity.map(({ label }) => label)).toEqual(['Remove selected collection source first']);
    expect(service.getChanges(document.id, document.revision)).toHaveLength(1);
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed', revision: document.revision + 2 });
    const undone = service.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
    const undoneTileset = undone.pixelAssets[tileset.id]; const undoneMap = undone.pixelAssets[map.id];
    if (undoneTileset.type !== 'tileset' || undoneMap.type !== 'tilemap') throw new Error('Expected tileset and map');
    expect(undoneTileset.tiles[3].imageAssetId).toBe(source3.id);
    expect(undoneMap.layers[layer.id].objects).toEqual([]);
  });

  it('refuses a queued lifecycle append planned before a source change, then admits a fresh retry and exact undo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-collection-append-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const document = createPixelDocument('project', 'Queued collection append guard');
    const first = document.pixelAssets[document.activeAssetId]; if (first.type !== 'sprite') throw new Error('Expected sprite');
    const appendedSource = createPixelSprite('Queued append source', 12, 7);
    document.assetIds.push(appendedSource.id); document.pixelAssets[appendedSource.id] = appendedSource;
    const collection = createImageCollectionTileset(document, 'Queued collection', [first.id], { id: 'queued-collection' });
    document.assetIds.push(collection.id); document.pixelAssets[collection.id] = collection; document.activeAssetId = collection.id;
    service.addDocument(document);

    const stalePlan = appendImageCollectionSource(document, collection.id, appendedSource.id);
    const resizedSource = structuredClone(appendedSource); resizedSource.width += 3;
    const sourceWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Resize append source first', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: resizedSource, expectedRevision: appendedSource.revision }],
    });
    const staleAppend = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: document.revision, actor: HUMAN_ACTOR,
      label: 'Append stale collection source', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: stalePlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: stalePlan.expectedSpriteDependencies }],
    });
    const [sourceResponse, staleResponse] = await Promise.all([sourceWrite, staleAppend]);
    expect(sourceResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(staleResponse).toMatchObject({ status: 'conflict', conflict: { entityId: document.id, expectedRevision: document.revision, actualRevision: document.revision + 1, retryable: true } });
    const afterConflict = service.getDocument(document.id); if (!afterConflict || afterConflict.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(afterConflict.activity.map(({ label }) => label)).toEqual(['Resize append source first']);
    expect(afterConflict.pixelAssets[collection.id]).toEqual(collection);

    const retryPlan = appendImageCollectionSource(afterConflict, collection.id, appendedSource.id);
    expect(await service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: afterConflict.revision, actor: HUMAN_ACTOR,
      label: 'Append current collection source', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: retryPlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: retryPlan.expectedSpriteDependencies }],
    })).toMatchObject({ status: 'committed', revision: document.revision + 2 });
    const afterAppend = service.getDocument(document.id); if (!afterAppend || afterAppend.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(afterAppend.pixelAssets[collection.id]).toMatchObject({ type: 'tileset', tileWidth: Math.max(first.width, appendedSource.width + 3), tiles: { 1: { imageAssetId: appendedSource.id } } });
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed', revision: document.revision + 3 });
    const undone = service.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(undone.pixelAssets[collection.id]).toMatchObject({ type: 'tileset', revision: collection.revision + 1, tiles: { 0: { imageAssetId: first.id } } });
    expect(undone.pixelAssets[collection.id]).not.toHaveProperty('tiles.1');
  });

  it('atomically refuses queued exact-ID source replacement after its new source changes, then admits a fresh retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-collection-replacement-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const document = createPixelDocument('project', 'Queued collection replacement guard');
    const original = document.pixelAssets[document.activeAssetId]; if (original.type !== 'sprite') throw new Error('Expected sprite');
    const replacement = createPixelSprite('Queued replacement source', 12, 7);
    document.assetIds.push(replacement.id); document.pixelAssets[replacement.id] = replacement;
    const collection = createImageCollectionTileset(document, 'Queued collection', [original.id], { id: 'queued-replacement-collection' });
    collection.tiles[0].properties = { preserved: true };
    document.assetIds.push(collection.id); document.pixelAssets[collection.id] = collection; document.activeAssetId = collection.id;
    service.addDocument(document);

    const stalePlan = replaceImageCollectionSource(document, collection.id, 0, replacement.id);
    const resizedReplacement = structuredClone(replacement); resizedReplacement.width += 3;
    const sourceWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Resize replacement source first', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: resizedReplacement, expectedRevision: replacement.revision }],
    });
    const staleReplacement = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Replace with stale source', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: stalePlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: stalePlan.expectedSpriteDependencies }],
    });
    const [sourceResponse, staleResponse] = await Promise.all([sourceWrite, staleReplacement]);
    expect(sourceResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(staleResponse).toMatchObject({ status: 'conflict', conflict: { entityId: replacement.id, expectedRevision: replacement.revision, actualRevision: replacement.revision + 1, retryable: true } });
    const afterConflict = service.getDocument(document.id); if (!afterConflict || afterConflict.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(afterConflict.activity.map(({ label }) => label)).toEqual(['Resize replacement source first']);
    expect(afterConflict.pixelAssets[collection.id]).toEqual(collection);

    const retryPlan = replaceImageCollectionSource(afterConflict, collection.id, 0, replacement.id);
    expect(await service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Replace with current source', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: retryPlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: retryPlan.expectedSpriteDependencies }],
    })).toMatchObject({ status: 'committed', revision: document.revision + 2 });
    const afterReplacement = service.getDocument(document.id); if (!afterReplacement || afterReplacement.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(afterReplacement.pixelAssets[collection.id]).toMatchObject({ type: 'tileset', tileWidth: replacement.width + 3, tiles: { 0: { id: 0, imageAssetId: replacement.id, properties: { preserved: true } } } });
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed', revision: document.revision + 3 });
    const undone = service.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(undone.pixelAssets[collection.id]).toMatchObject({ type: 'tileset', tiles: { 0: { imageAssetId: original.id, properties: { preserved: true } } } });
  });

  it('atomically refuses queued unused-source removal when an earlier map edit creates a transformed reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-collection-removal-guard-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    const document = createPixelDocument('project', 'Queued collection removal guard');
    const retained = document.pixelAssets[document.activeAssetId]; if (retained.type !== 'sprite') throw new Error('Expected sprite');
    const removable = createPixelSprite('Removable source', 12, 7);
    document.assetIds.push(removable.id); document.pixelAssets[removable.id] = removable;
    const collection = createImageCollectionTileset(document, 'Queued collection', [retained.id, removable.id], { id: 'queued-removal-collection' });
    const map = createPixelTilemap('Queued reference map'); map.tilesetIds = [collection.id]; map.width = 1; map.height = 1;
    const layer = map.layers[map.layerIds[0]]; if (layer.type !== 'tile' || !layer.chunks) throw new Error('Expected tile layer');
    document.assetIds.push(collection.id, map.id); document.pixelAssets[collection.id] = collection; document.pixelAssets[map.id] = map; document.activeAssetId = collection.id;
    service.addDocument(document);

    const stalePlan = removeUnusedImageCollectionSource(document, collection.id, 1);
    const rawTarget = encodeTiledGid(collection.firstGid + 1, { hFlip: true, diagonal: true });
    const referenceWrite = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Reference collection tile first', createdAt: nowIso(), operations: [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: [{ x: 0, y: 0, gid: rawTarget }], expectedRevision: layer.revision }],
    });
    const staleRemoval = service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: document.revision, actor: HUMAN_ACTOR,
      label: 'Remove stale unused source', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: stalePlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: stalePlan.expectedSpriteDependencies }],
    });
    const [referenceResponse, staleResponse] = await Promise.all([referenceWrite, staleRemoval]);
    expect(referenceResponse).toMatchObject({ status: 'committed', revision: document.revision + 1 });
    expect(staleResponse).toMatchObject({ status: 'conflict', conflict: { entityId: document.id, expectedRevision: document.revision, actualRevision: document.revision + 1, retryable: true } });
    const afterConflict = service.getDocument(document.id); if (!afterConflict || afterConflict.kind !== 'pixel') throw new Error('Expected pixel document');
    const referencedMap = afterConflict.pixelAssets[map.id]; if (referencedMap.type !== 'tilemap') throw new Error('Expected map');
    const referencedLayer = referencedMap.layers[layer.id]; if (referencedLayer.type !== 'tile' || !referencedLayer.chunks) throw new Error('Expected tile layer');
    expect(readTileAt(referencedLayer.chunks, 0, 0)).toBe(rawTarget);
    expect(afterConflict.pixelAssets[collection.id]).toEqual(collection);
    expect(afterConflict.activity.map(({ label }) => label)).toEqual(['Reference collection tile first']);
    expect(() => removeUnusedImageCollectionSource(afterConflict, collection.id, 1)).toThrow(/still references image-collection tile 1/);

    expect(await service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Clear collection tile reference', createdAt: nowIso(), operations: [{ kind: 'pixel.tilemap.set', mapId: map.id, layerId: layer.id, changes: [{ x: 0, y: 0, gid: 0 }], expectedRevision: referencedLayer.revision }],
    })).toMatchObject({ status: 'committed', revision: document.revision + 2 });
    const cleared = service.getDocument(document.id); if (!cleared || cleared.kind !== 'pixel') throw new Error('Expected pixel document');
    const retryPlan = removeUnusedImageCollectionSource(cleared, collection.id, 1);
    expect(await service.apply({
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: cleared.revision, actor: HUMAN_ACTOR,
      label: 'Remove current unused source', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: retryPlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: retryPlan.expectedSpriteDependencies }],
    })).toMatchObject({ status: 'committed', revision: document.revision + 3 });
    const removed = service.getDocument(document.id); if (!removed || removed.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(removed.pixelAssets[collection.id]).toMatchObject({ type: 'tileset', tiles: { 0: { imageAssetId: retained.id } } });
    expect(removed.pixelAssets[collection.id]).not.toHaveProperty('tiles.1');
    expect(removed.pixelAssets[removable.id]).toEqual(removable);
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed', revision: document.revision + 4 });
    const undone = service.getDocument(document.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(undone.pixelAssets[collection.id]).toMatchObject({ type: 'tileset', tiles: { 1: { imageAssetId: removable.id } } });
  });

  it('orders checkpoint restore behind a pending commit and preserves that committed branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-restore-queue-'));
    temporaryPaths.push(root);
    let markValidationStarted!: () => void;
    let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validationRelease = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const decoder = vi.fn(async () => {
      markValidationStarted();
      await validationRelease;
    });
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0', undefined, decoder);
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Restore queue source' }).activeDocument!;
    const checkpoint = service.createCheckpoint(document.id, 'Before delayed commit');
    const asset = pngAsset('restore-queue-inline-asset');
    const add = service.apply({
      id: 'restore-queue-add-transaction', clientOperationId: 'restore-queue-add-operation', documentId: document.id,
      actor: HUMAN_ACTOR, label: 'Add before queued restore', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    });
    await validationStarted;
    let restoreSettled = false;
    const restore = service.restoreCheckpoint(document.id, checkpoint.id).then((value) => { restoreSettled = true; return value; });
    await Promise.resolve();
    expect(restoreSettled).toBe(false);

    releaseValidation();
    await expect(add).resolves.toMatchObject({ status: 'committed', revision: document.revision + 1 });
    await expect(restore).resolves.toMatchObject({ status: 'committed', revision: document.revision + 2 });
    const restoredDocument = service.getDocument(document.id);
    expect(restoredDocument).toMatchObject({
      name: 'Restore queue source', revision: document.revision + 2, assets: {}, dirty: true,
    });
    expect(restoredDocument?.assets[asset.id]).toBeUndefined();
    const automatic = service.listCheckpoints(document.id).find(({ kind }) => kind === 'automatic');
    expect(automatic).toMatchObject({ sourceRevision: document.revision + 1, name: 'Before restore · Before delayed commit' });
    expect(service.getCheckpoint(document.id, automatic!.id)?.document).toMatchObject({
      revision: document.revision + 1, assets: { [asset.id]: asset }, dirty: true,
    });

    await service.flushRecovery();
    const recovered = (await new RecoveryJournal(root).recover()).find(({ id }) => id === document.id);
    expect(recovered).toMatchObject({
      name: 'Restore queue source', revision: document.revision + 2, assets: {}, dirty: true,
    });
    expect(recovered?.assets[asset.id]).toBeUndefined();
  });

  it('refuses a delayed transaction after close and same-ID replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-mutation-incarnation-'));
    temporaryPaths.push(root);
    let markValidationStarted!: () => void;
    let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validationRelease = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const decoder = vi.fn(async () => {
      markValidationStarted();
      await validationRelease;
    });
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0', undefined, decoder);
    services.push(service);
    const original = service.create({ kind: 'illustration', name: 'Closing mutation source' }).activeDocument!;
    const asset = pngAsset('stale-inline-asset');
    const delayed = service.apply({
      id: 'stale-add-transaction', clientOperationId: 'stale-add-operation', documentId: original.id,
      actor: HUMAN_ACTOR, label: 'Stale validated asset', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    });
    await validationStarted;

    await expect(service.close(original.id, true)).resolves.toEqual({ closed: true });
    const replacement = structuredClone(original);
    replacement.name = 'Replacement incarnation';
    replacement.dirty = true;
    service.addDocument(replacement);
    releaseValidation();

    await expect(delayed).resolves.toEqual({ status: 'conflict', message: 'Document is no longer open.' });
    const liveReplacement = service.getDocument(original.id);
    expect(liveReplacement).toMatchObject({
      name: 'Replacement incarnation', revision: original.revision, dirty: true, assets: {},
    });
    expect(liveReplacement?.assets[asset.id]).toBeUndefined();
    expect(service.getChanges(original.id, -1)).toEqual([]);
    await service.flushRecovery();
    const recoveredReplacement = (await new RecoveryJournal(root).recover()).find(({ id }) => id === original.id);
    expect(recoveredReplacement).toMatchObject({
      name: 'Replacement incarnation', revision: original.revision, dirty: true, assets: {},
    });
    expect(recoveredReplacement?.assets[asset.id]).toBeUndefined();
  });

  it('keeps the attached editor advisory on the canonical active document and rejects stale tab updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-advisory-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const first = service.snapshot().activeDocument!;
    const second = service.create({ kind: 'illustration', name: 'Second tab' }).activeDocument!;
    service.setEditorAttached(true);
    service.activate(first.id);
    service.updateEditorAdvisory({ documentId: first.id, tool: 'bezier', selectedEntityIds: ['first-preview'], zoom: 2 });
    expect(service.getEditorAdvisory()).toMatchObject({ attached: true, documentId: first.id, tool: 'bezier', selectedEntityIds: ['first-preview'] });

    service.activate(second.id);
    expect(service.getEditorAdvisory()).toMatchObject({ attached: true, documentId: second.id, selectedEntityIds: [] });
    service.updateEditorAdvisory({ documentId: first.id, tool: 'pencil', selectedEntityIds: ['stale-first-preview'], zoom: 4 });
    expect(service.getEditorAdvisory()).toMatchObject({ attached: true, documentId: second.id, selectedEntityIds: [] });
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

  it('rejects a schema-shaped but non-JSON transaction without changing canonical state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-serialization-')); temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0'); services.push(service); service.initialize();
    const document = service.snapshot().activeDocument!;
    const transaction = {
      id: createId('tx'), clientOperationId: 'non-json-operation', documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Reject non-JSON transaction', createdAt: nowIso(),
      operations: [{ kind: 'document.rename', name: 'Must not commit', nonJson: 1n }],
    } as unknown as CanvasTransaction;
    await expect(service.apply(transaction)).resolves.toEqual({ status: 'conflict', message: 'Transaction must be JSON-serializable.' });
    expect(service.getDocument(document.id)).toMatchObject({ name: document.name, revision: document.revision, dirty: document.dirty });
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

  it('releases transient human locks when the sole editor detaches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-detached-locks-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const snapshot = service.create({ kind: 'sprite', name: 'Detached lock recovery' });
    const document = snapshot.activeDocument!;
    if (document.kind !== 'pixel') throw new Error('Expected pixel document');
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const cel = Object.values(sprite.cels)[0];
    const agent: Actor = { id: 'agent-detached-lock-test', kind: 'agent', name: 'Detached lock agent', color: '#8268dd' };
    const write = (): CanvasTransaction => ({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: agent,
      label: 'Write after editor detach', createdAt: nowIso(),
      operations: [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: [{ x: 2, y: 3, index: 4 }], expectedRevision: 0 }],
    });

    service.setEditorAttached(true);
    expect(service.acquireLock({
      documentId: document.id,
      region: { kind: 'pixel', assetId: sprite.id, x: 0, y: 0, width: 8, height: 8 },
    }).acquired).toBe(true);
    expect(service.getHumanOccupancy(document.id)).toMatchObject({ active: true, locks: [{ region: { assetId: sprite.id } }] });
    expect(await service.apply(write())).toMatchObject({ status: 'locked', conflict: { retryable: true } });

    service.setEditorAttached(false);
    expect(service.getEditorAdvisory()).toMatchObject({ attached: false });
    expect(service.getHumanOccupancy(document.id)).toMatchObject({ active: false, locks: [] });
    expect(await service.apply(write())).toMatchObject({ status: 'committed', revision: 1 });
  });

  it('preserves a canonical human transaction already admitted before editor detach', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-service-detached-pending-human-'));
    temporaryPaths.push(root);
    let markValidationStarted!: () => void;
    let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validationRelease = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const decoder = vi.fn(async () => {
      markValidationStarted();
      await validationRelease;
    });
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0', undefined, decoder);
    services.push(service);
    const document = service.create({ kind: 'illustration', name: 'Pending human detach' }).activeDocument!;
    const asset = pngAsset('pending-human-detach-asset');
    service.setEditorAttached(true);
    expect(service.acquireLock({ documentId: document.id, objectIds: [asset.id] }).acquired).toBe(true);

    const pending = service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Admitted before renderer detach', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    });
    await validationStarted;
    service.setEditorAttached(false);
    expect(service.getHumanOccupancy(document.id)).toMatchObject({ active: false, locks: [] });
    expect(service.getDocument(document.id)).toMatchObject({ revision: 0, assets: {} });

    releaseValidation();
    await expect(pending).resolves.toMatchObject({ status: 'committed', revision: 1 });
    expect(service.getDocument(document.id)).toMatchObject({ revision: 1, assets: { [asset.id]: asset } });
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
