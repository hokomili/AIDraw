import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
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
    const persisted = JSON.parse(Buffer.from(archive['document.json']).toString('utf8')) as typeof document; const persistedPaint = Object.values(persisted.layers).find((layer) => layer.type === 'paint'); expect(persistedPaint?.type === 'paint' ? Object.keys(persistedPaint.tileAssetIds).length : 0).toBeGreaterThan(1); expect(Object.keys(archive).some((entry) => entry.startsWith('assets/'))).toBe(true);
    const loaded = await readNativeDocument(path);
    expect(loaded.document.id).toBe(document.id);
    expect(loaded.document.name).toBe('Round trip');
    expect(loaded.document.dirty).toBe(false);
    expect(loaded.trace).toEqual(trace);
  });
});
