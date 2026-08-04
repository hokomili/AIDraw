import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { HUMAN_ACTOR, createId, createIllustrationDocument, nowIso, type CanvasTransaction } from '@aidraw/core';
import { readNativeDocument, writeNativeDocument } from '@main/persistence';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('.aidraw persistence', () => {
  it('validates a temporary ZIP and round-trips its versioned document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-'));
    temporaryPaths.push(root);
    const document = createIllustrationDocument('Round trip');
    const paint = Object.values(document.layers).find((layer) => layer.type === 'paint'); if (!paint || paint.type !== 'paint') throw new Error('Paint layer missing'); paint.strokes.push({ id: createId('stroke'), actorId: HUMAN_ACTOR.id, points: [{ x: 8, y: 8, pressure: 0.5 }, { x: 270, y: 8, pressure: 0.8 }], color: '#ff5d8f', size: 12, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    document.filePath = 'C:\\private\\machine-only\\drawing.aidraw';
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Persistent trace', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: document.name }] };
    const trace = [{ version: 1 as const, documentId: document.id, revision: 1, recordedAt: nowIso(), outcome: 'committed' as const, transaction }];
    const path = await writeNativeDocument(join(root, 'drawing'), document, '1.0.0', undefined, trace);
    expect(path.endsWith('.aidraw')).toBe(true);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    expect(Object.keys(archive)).toEqual(expect.arrayContaining(['manifest.json', 'document.json', 'activity.json', 'trace/transactions.jsonl', 'preview.png']));
    expect(JSON.parse(Buffer.from(archive['document.json']).toString('utf8')).filePath).toBeUndefined();
    expect(JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8')).schemaVersion).toBe(2);
    const persisted = JSON.parse(Buffer.from(archive['document.json']).toString('utf8')) as typeof document; const persistedPaint = Object.values(persisted.layers).find((layer) => layer.type === 'paint'); expect(persistedPaint?.type === 'paint' ? Object.keys(persistedPaint.tileAssetIds).length : 0).toBeGreaterThan(1); expect(persistedPaint?.type === 'paint' ? persistedPaint.tileCache : undefined).toMatchObject({ version: 1, strokeCount: 1, strokesSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }); expect(Object.keys(archive).some((entry) => entry.startsWith('assets/'))).toBe(true);
    const loaded = await readNativeDocument(path);
    expect(loaded.document.id).toBe(document.id);
    expect(loaded.document.name).toBe('Round trip');
    expect(loaded.document.dirty).toBe(false);
    expect(loaded.trace).toEqual(trace);
    const loadedPaint = loaded.document.kind === 'illustration' ? Object.values(loaded.document.layers).find((layer) => layer.type === 'paint') : undefined;
    expect(loadedPaint?.type === 'paint' ? loadedPaint.tileCache?.strokeCount : undefined).toBe(1);
  });

  it('drops a stale paint cache while preserving its editable strokes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Stale cache');
    document.artboard = { ...document.artboard, width: 64, height: 64, background: null };
    const paint = Object.values(document.layers).find((layer) => layer.type === 'paint');
    if (!paint || paint.type !== 'paint') throw new Error('Paint layer missing');
    paint.strokes.push({ id: 'original-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 8, y: 8, pressure: 0.5 }, { x: 56, y: 56, pressure: 0.5 }], color: '#ff0000', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const sourcePath = await writeNativeDocument(join(root, 'stale.aidraw'), document, '1.0.0');
    const files = unzipSync(new Uint8Array(await readFile(sourcePath)));
    const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document;
    const persistedPaint = Object.values(persisted.layers).find((layer) => layer.type === 'paint');
    if (!persistedPaint || persistedPaint.type !== 'paint') throw new Error('Persisted paint layer missing');
    persistedPaint.strokes[0].color = '#0000ff';
    files['document.json'] = strToU8(JSON.stringify(persisted));
    const stalePath = join(root, 'stale-mutated.aidraw'); await writeFile(stalePath, zipSync(files));

    const loaded = await readNativeDocument(stalePath);
    const loadedPaint = loaded.document.kind === 'illustration' ? Object.values(loaded.document.layers).find((layer) => layer.type === 'paint') : undefined;
    expect(loadedPaint?.type === 'paint' ? loadedPaint.strokes[0].color : undefined).toBe('#0000ff');
    expect(loadedPaint?.type === 'paint' ? loadedPaint.tileCache : undefined).toBeUndefined();
    expect(loadedPaint?.type === 'paint' ? loadedPaint.tileAssetIds : undefined).toEqual({});
    expect(loaded.warnings).toContainEqual(expect.stringMatching(/editable stroke digest does not match/));
  });

  it('stores editable checkpoints in the native container without duplicating asset payload files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-'));
    temporaryPaths.push(root);
    const document = createIllustrationDocument('Current branch');
    const checkpointDocument = structuredClone(document);
    checkpointDocument.name = 'Saved branch';
    const checkpoint = { id: 'checkpoint-native', documentId: document.id, name: 'Saved branch', createdAt: nowIso(), createdBy: HUMAN_ACTOR, sourceRevision: 0, kind: 'manual' as const, document: checkpointDocument };
    const path = await writeNativeDocument(join(root, 'checkpointed.aidraw'), document, '1.0.0', undefined, [], [checkpoint]);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    expect(Object.keys(archive)).toEqual(expect.arrayContaining(['checkpoints/index.json', 'checkpoints/checkpoint-native.json']));
    const loaded = await readNativeDocument(path);
    expect(loaded.checkpoints).toHaveLength(1);
    expect(loaded.checkpoints[0]).toMatchObject({ id: checkpoint.id, name: 'Saved branch', document: { id: document.id, name: 'Saved branch' } });
  });

  it('opens a schema-1 native container and migrates its document to schema 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-')); temporaryPaths.push(root);
    const sourcePath = await writeNativeDocument(join(root, 'source.aidraw'), createIllustrationDocument('Legacy archive'), '0.1.0');
    const files = unzipSync(new Uint8Array(await readFile(sourcePath))); const manifest = JSON.parse(strFromU8(files['manifest.json'])); const document = JSON.parse(strFromU8(files['document.json']));
    manifest.schemaVersion = 1; document.schemaVersion = 1; delete document.animation; files['manifest.json'] = strToU8(JSON.stringify(manifest)); files['document.json'] = strToU8(JSON.stringify(document));
    const legacyPath = join(root, 'legacy.aidraw'); await writeFile(legacyPath, zipSync(files));
    const loaded = await readNativeDocument(legacyPath); expect(loaded.manifest.schemaVersion).toBe(1); expect(loaded.document.schemaVersion).toBe(2);
    if (loaded.document.kind !== 'illustration') throw new Error('Expected illustration'); expect(loaded.document.animation.keyframeIds).toEqual([]);
  });

  it('rejects unsafe ZIP paths and oversized metadata before native extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-')); temporaryPaths.push(root);
    const unsafePath = join(root, 'unsafe.aidraw'); await writeFile(unsafePath, zipSync({ '../escape.json': strToU8('{}'), 'manifest.json': strToU8('{}'), 'document.json': strToU8('{}') }));
    await expect(readNativeDocument(unsafePath)).rejects.toThrow(/unsafe entry path/);
    const oversizedPath = join(root, 'oversized.aidraw'); await writeFile(oversizedPath, zipSync({ 'manifest.json': new Uint8Array(1024 * 1024 + 1), 'document.json': strToU8('{}') }, { level: 9 }));
    await expect(readNativeDocument(oversizedPath)).rejects.toThrow(/expanded-size limit/);
  });
});
