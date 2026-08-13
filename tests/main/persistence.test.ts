import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, createIllustrationDocument, createPixelDocument, duplicatePixelFrame, nowIso, readPixel, readTileAt, resolvePixelCel, writePixels, writeTiles, type CanvasTransaction, type GroupObject, type IllustrationLayer, type PixelLayer, type TilemapLayer } from '@aidraw/core';
import type { TransactionTraceEntry } from '@common/contracts';
import { MAX_TRANSACTION_SERIALIZED_BYTES } from '@common/transaction-limits';
import { nativeSaveFileSystem, readNativeDocument, writeNativeDocument, type NativeSaveFileSystem } from '@main/persistence';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function replaceStoredCrc(bytes: Buffer, entryName: string): Buffer {
  const result = Buffer.from(bytes);
  let end = result.length - 22;
  while (end >= 0 && result.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('Test ZIP has no central directory.');
  const entries = result.readUInt16LE(end + 10);
  let cursor = result.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (result.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Test ZIP central directory is invalid.');
    const nameLength = result.readUInt16LE(cursor + 28); const extraLength = result.readUInt16LE(cursor + 30); const commentLength = result.readUInt16LE(cursor + 32);
    const name = strFromU8(result.subarray(cursor + 46, cursor + 46 + nameLength), !(result.readUInt16LE(cursor + 8) & 0x0800));
    if (name === entryName) {
      const wrongCrc = (result.readUInt32LE(cursor + 16) ^ 0xffffffff) >>> 0;
      result.writeUInt32LE(wrongCrc, cursor + 16);
      const localOffset = result.readUInt32LE(cursor + 42);
      if (result.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Test ZIP local entry is invalid.');
      result.writeUInt32LE(wrongCrc, localOffset + 14);
      return result;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Test ZIP has no ${entryName} entry.`);
}

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
    expect(paint.tileCache).toMatchObject({ version: 1, strokeCount: 1, strokesSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.keys(paint.tileAssetIds).length).toBeGreaterThan(1);
    expect(Object.values(paint.tileAssetIds).every((assetId) => typeof document.assets[assetId]?.data === 'string')).toBe(true);
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

  it('opens an acyclic native illustration hierarchy and rejects the equivalent two-group child cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-cycle-')); temporaryPaths.push(root); const document = createIllustrationDocument('Layer cycle fixture'); const timestamp = nowIso(); const outerId = createId('layer'); const innerId = createId('layer');
    const outer: IllustrationLayer = { id: outerId, revision: 0, name: 'Outer group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'group', childIds: [innerId] };
    const inner: IllustrationLayer = { id: innerId, revision: 0, name: 'Inner group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, parentId: outerId, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'group', childIds: [] };
    document.layers[outer.id] = outer; document.layers[inner.id] = inner; document.layerIds.unshift(outer.id);
    const acyclicPath = await writeNativeDocument(join(root, 'acyclic'), document, '1.0.0'); const acyclic = await readNativeDocument(acyclicPath); if (acyclic.document.kind !== 'illustration') throw new Error('Expected illustration document');
    expect(acyclic.document.layers[outer.id]).toMatchObject({ type: 'group', childIds: [inner.id] }); expect(acyclic.document.layers[inner.id]).toMatchObject({ type: 'group', parentId: outer.id, childIds: [] });

    const files = unzipSync(new Uint8Array(await readFile(acyclicPath))); const manifest = strFromU8(files['manifest.json']); const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document; const persistedInner = persisted.layers[inner.id]; if (persistedInner.type !== 'group') throw new Error('Expected persisted inner group'); persistedInner.childIds = [outer.id]; files['document.json'] = strToU8(JSON.stringify(persisted));
    const cyclicPath = join(root, 'cyclic.aidraw'); await writeFile(cyclicPath, zipSync(files, { level: 6 })); const cyclicArchive = unzipSync(new Uint8Array(await readFile(cyclicPath)));
    expect(strFromU8(cyclicArchive['manifest.json'])).toBe(manifest); expect((JSON.parse(strFromU8(cyclicArchive['document.json'])) as typeof document).layers[inner.id]).toMatchObject({ childIds: [outer.id] });
    await expect(readNativeDocument(cyclicPath)).rejects.toThrow('Illustration layer hierarchy contains a cycle.');
  });

  it('opens acyclic native illustration object groups and rejects the equivalent two-group child cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-object-cycle-')); temporaryPaths.push(root); const document = createIllustrationDocument('Object cycle fixture'); const timestamp = nowIso(); const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Vector layer missing');
    const outer: GroupObject = { id: createId('object'), revision: 0, name: 'Outer object group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'group', childIds: [] };
    const inner: GroupObject = { id: createId('object'), revision: 0, name: 'Inner object group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'group', childIds: [] }; outer.childIds = [inner.id]; document.objects[outer.id] = outer; document.objects[inner.id] = inner; vector.objectIds.push(outer.id, inner.id);
    const acyclicPath = await writeNativeDocument(join(root, 'acyclic'), document, '1.0.0'); const acyclic = await readNativeDocument(acyclicPath); if (acyclic.document.kind !== 'illustration') throw new Error('Expected illustration document'); const acyclicVector = acyclic.document.layers[vector.id];
    expect(acyclicVector).toMatchObject({ type: 'vector', objectIds: [outer.id, inner.id] }); expect(acyclic.document.objects[outer.id]).toMatchObject({ type: 'group', layerId: vector.id, childIds: [inner.id] }); expect(acyclic.document.objects[inner.id]).toMatchObject({ type: 'group', layerId: vector.id, childIds: [] });

    const files = unzipSync(new Uint8Array(await readFile(acyclicPath))); const manifest = strFromU8(files['manifest.json']); const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document; const persistedInner = persisted.objects[inner.id]; if (persistedInner.type !== 'group') throw new Error('Expected persisted inner object group'); persistedInner.childIds = [outer.id]; files['document.json'] = strToU8(JSON.stringify(persisted));
    const cyclicPath = join(root, 'cyclic.aidraw'); await writeFile(cyclicPath, zipSync(files, { level: 6 })); const cyclicArchive = unzipSync(new Uint8Array(await readFile(cyclicPath)));
    expect(strFromU8(cyclicArchive['manifest.json'])).toBe(manifest); expect((JSON.parse(strFromU8(cyclicArchive['document.json'])) as typeof document).objects[inner.id]).toMatchObject({ childIds: [outer.id] });
    await expect(readNativeDocument(cyclicPath)).rejects.toThrow('Illustration object hierarchy contains a cycle.');
  });

  it('opens acyclic native sprite layer groups and rejects the equivalent two-group child cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-sprite-cycle-')); temporaryPaths.push(root); const document = createPixelDocument('sprite', 'Sprite layer cycle fixture'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const timestamp = nowIso(); const originalRootIds = [...sprite.layerIds]; const originalFrameIds = [...sprite.frameIds]; const originalCelLinks = Object.values(sprite.cels).map((cel) => ({ id: cel.id, layerId: cel.layerId, frameId: cel.frameId, linkedToCelId: cel.linkedToCelId })).sort((left, right) => left.id.localeCompare(right.id));
    const outer: PixelLayer = { id: createId('pixel-layer'), revision: 0, name: 'Outer sprite group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'group', childIds: [] };
    const inner: PixelLayer = { id: createId('pixel-layer'), revision: 0, name: 'Inner sprite group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, parentId: outer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'group', childIds: [] }; outer.childIds = [inner.id]; sprite.layers[outer.id] = outer; sprite.layers[inner.id] = inner; sprite.layerIds.unshift(outer.id);
    const acyclicPath = await writeNativeDocument(join(root, 'acyclic'), document, '1.0.0'); const acyclic = await readNativeDocument(acyclicPath); if (acyclic.document.kind !== 'pixel') throw new Error('Expected pixel document'); const loadedSprite = acyclic.document.pixelAssets[sprite.id]; if (loadedSprite.type !== 'sprite') throw new Error('Expected loaded sprite');
    expect(loadedSprite.layerIds).toEqual([outer.id, ...originalRootIds]); expect(loadedSprite.layers[outer.id]).toMatchObject({ type: 'group', childIds: [inner.id] }); expect(loadedSprite.layers[inner.id]).toMatchObject({ type: 'group', parentId: outer.id, childIds: [] }); expect(loadedSprite.frameIds).toEqual(originalFrameIds); expect(Object.values(loadedSprite.cels).map((cel) => ({ id: cel.id, layerId: cel.layerId, frameId: cel.frameId, linkedToCelId: cel.linkedToCelId })).sort((left, right) => left.id.localeCompare(right.id))).toEqual(originalCelLinks);

    const files = unzipSync(new Uint8Array(await readFile(acyclicPath))); const manifest = strFromU8(files['manifest.json']); const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document; const persistedSprite = persisted.pixelAssets[sprite.id]; if (persistedSprite.type !== 'sprite') throw new Error('Expected persisted sprite'); const persistedInner = persistedSprite.layers[inner.id]; if (persistedInner.type !== 'group') throw new Error('Expected persisted inner sprite group'); persistedInner.childIds = [outer.id]; files['document.json'] = strToU8(JSON.stringify(persisted));
    const cyclicPath = join(root, 'cyclic.aidraw'); await writeFile(cyclicPath, zipSync(files, { level: 6 })); const cyclicArchive = unzipSync(new Uint8Array(await readFile(cyclicPath)));
    expect(strFromU8(cyclicArchive['manifest.json'])).toBe(manifest); const cyclicDocument = JSON.parse(strFromU8(cyclicArchive['document.json'])) as typeof document; const cyclicSprite = cyclicDocument.pixelAssets[sprite.id]; expect(cyclicSprite.type === 'sprite' ? cyclicSprite.layers[inner.id] : undefined).toMatchObject({ childIds: [outer.id] });
    await expect(readNativeDocument(cyclicPath)).rejects.toThrow('Pixel sprite layer hierarchy contains a cycle.');
  });

  it('opens acyclic native tilemap layer groups and rejects the equivalent two-group child cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-tilemap-cycle-')); temporaryPaths.push(root); const document = createPixelDocument('tilemap', 'Tilemap layer cycle fixture'); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap' || map.orientation !== 'orthogonal') throw new Error('Expected orthogonal tilemap'); const tile = map.layers[map.layerIds[0]]; if (tile.type !== 'tile' || !tile.chunks) throw new Error('Expected tile layer'); writeTiles(tile.chunks, [{ x: 1, y: 2, gid: 7 }]); const timestamp = nowIso();
    const outer: TilemapLayer = { id: createId('map-layer'), revision: 0, name: 'Outer map group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, parallaxX: 1, parallaxY: 1, type: 'group', childIds: [] };
    const inner: TilemapLayer = { id: createId('map-layer'), revision: 0, name: 'Inner map group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, parentId: outer.id, visible: true, locked: false, opacity: 1, parallaxX: 1, parallaxY: 1, type: 'group', childIds: [] };
    const objects: TilemapLayer = { id: createId('map-layer'), revision: 0, name: 'Objects', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, parentId: inner.id, visible: true, locked: false, opacity: 1, parallaxX: 1, parallaxY: 1, type: 'object', objects: [{ id: 'qa08-object', type: 'rectangle', x: 3, y: 4, width: 5, height: 6, properties: { role: 'spawn' } }] }; outer.childIds = [inner.id]; inner.childIds = [tile.id, objects.id]; tile.parentId = inner.id; map.layers[outer.id] = outer; map.layers[inner.id] = inner; map.layers[objects.id] = objects; map.layerIds = [outer.id];
    const acyclicPath = await writeNativeDocument(join(root, 'acyclic'), document, '1.0.0'); const acyclic = await readNativeDocument(acyclicPath); if (acyclic.document.kind !== 'pixel') throw new Error('Expected pixel document'); const loadedMap = acyclic.document.pixelAssets[map.id]; if (loadedMap.type !== 'tilemap') throw new Error('Expected loaded tilemap');
    expect(loadedMap).toMatchObject({ orientation: 'orthogonal', layerIds: [outer.id] }); expect(loadedMap.layers[outer.id]).toMatchObject({ type: 'group', childIds: [inner.id] }); expect(loadedMap.layers[inner.id]).toMatchObject({ type: 'group', parentId: outer.id, childIds: [tile.id, objects.id] }); expect(loadedMap.layers[tile.id]).toMatchObject({ type: 'tile', parentId: inner.id }); expect(readTileAt(loadedMap.layers[tile.id].chunks ?? {}, 1, 2)).toBe(7); expect(loadedMap.layers[objects.id]).toMatchObject({ type: 'object', parentId: inner.id, objects: [{ id: 'qa08-object', type: 'rectangle', x: 3, y: 4, width: 5, height: 6, properties: { role: 'spawn' } }] });

    const files = unzipSync(new Uint8Array(await readFile(acyclicPath))); const manifest = strFromU8(files['manifest.json']); const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document; const persistedMap = persisted.pixelAssets[map.id]; if (persistedMap.type !== 'tilemap') throw new Error('Expected persisted tilemap'); const persistedInner = persistedMap.layers[inner.id]; if (persistedInner.type !== 'group' || !persistedInner.childIds) throw new Error('Expected persisted inner map group'); persistedInner.childIds.push(outer.id); files['document.json'] = strToU8(JSON.stringify(persisted));
    const cyclicPath = join(root, 'cyclic.aidraw'); await writeFile(cyclicPath, zipSync(files, { level: 6 })); const cyclicArchive = unzipSync(new Uint8Array(await readFile(cyclicPath)));
    expect(strFromU8(cyclicArchive['manifest.json'])).toBe(manifest); const cyclicDocument = JSON.parse(strFromU8(cyclicArchive['document.json'])) as typeof document; const cyclicMap = cyclicDocument.pixelAssets[map.id]; expect(cyclicMap.type === 'tilemap' ? cyclicMap.layers[inner.id] : undefined).toMatchObject({ childIds: [tile.id, objects.id, outer.id] });
    await expect(readNativeDocument(cyclicPath)).rejects.toThrow('Pixel tilemap layer hierarchy contains a cycle.');
  });

  it('opens an acyclic native two-cel link and rejects the equivalent back-edge cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-cel-cycle-')); temporaryPaths.push(root); const document = createPixelDocument('sprite', 'Cel link cycle fixture'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0]; writePixels(firstCel, [{ x: 4, y: 5, index: 7 }]); const timestamp = nowIso();
    const duplicate = duplicatePixelFrame(sprite, firstFrameId, { actorId: HUMAN_ACTOR.id, timestamp, createId }); const secondCel = duplicate.cels[0]; if (!secondCel) throw new Error('Expected duplicate cel'); secondCel.chunks = {}; secondCel.linkedToCelId = firstCel.id; sprite.frameIds.splice(duplicate.index, 0, duplicate.frame.id); sprite.frames[duplicate.frame.id] = duplicate.frame; sprite.cels[secondCel.id] = secondCel;
    const acyclicPath = await writeNativeDocument(join(root, 'acyclic'), document, '1.0.0'); const acyclic = await readNativeDocument(acyclicPath); if (acyclic.document.kind !== 'pixel') throw new Error('Expected pixel document'); const loadedSprite = acyclic.document.pixelAssets[sprite.id]; if (loadedSprite.type !== 'sprite') throw new Error('Expected loaded sprite'); const loadedFirst = loadedSprite.cels[firstCel.id]; const loadedSecond = loadedSprite.cels[secondCel.id];
    expect(loadedSprite.layerIds).toEqual([layerId]); expect(loadedSprite.frameIds).toEqual([firstFrameId, duplicate.frame.id]); expect(loadedFirst).toMatchObject({ layerId, frameId: firstFrameId, chunks: firstCel.chunks }); expect(loadedFirst.linkedToCelId).toBeUndefined(); expect(readPixel(loadedFirst, 4, 5)).toBe(7); expect(loadedSecond).toMatchObject({ layerId, frameId: duplicate.frame.id, linkedToCelId: firstCel.id, chunks: {} }); expect(resolvePixelCel(loadedSprite, loadedSecond.id)?.id).toBe(loadedFirst.id);

    const files = unzipSync(new Uint8Array(await readFile(acyclicPath))); const manifest = strFromU8(files['manifest.json']); const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document; const persistedSprite = persisted.pixelAssets[sprite.id]; if (persistedSprite.type !== 'sprite') throw new Error('Expected persisted sprite'); persistedSprite.cels[firstCel.id].linkedToCelId = secondCel.id; files['document.json'] = strToU8(JSON.stringify(persisted));
    const cyclicPath = join(root, 'cyclic.aidraw'); await writeFile(cyclicPath, zipSync(files, { level: 6 })); const cyclicArchive = unzipSync(new Uint8Array(await readFile(cyclicPath)));
    expect(strFromU8(cyclicArchive['manifest.json'])).toBe(manifest); const cyclicDocument = JSON.parse(strFromU8(cyclicArchive['document.json'])) as typeof document; const cyclicSprite = cyclicDocument.pixelAssets[sprite.id]; if (cyclicSprite.type !== 'sprite') throw new Error('Expected cyclic sprite'); expect(cyclicSprite.cels[firstCel.id]).toMatchObject({ linkedToCelId: secondCel.id }); expect(cyclicSprite.cels[secondCel.id]).toMatchObject({ linkedToCelId: firstCel.id });
    await expect(readNativeDocument(cyclicPath)).rejects.toThrow('Pixel sprite cel links contain a cycle.');
  });

  it('isolates a cyclic cel-link checkpoint while opening the exact acyclic main sprite document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-checkpoint-cel-cycle-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'Checkpoint cel-link isolation fixture'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0]; writePixels(firstCel, [{ x: 6, y: 7, index: 11 }]);
    const duplicate = duplicatePixelFrame(sprite, firstFrameId, { actorId: HUMAN_ACTOR.id, timestamp: nowIso(), createId }); const secondCel = duplicate.cels[0]; if (!secondCel) throw new Error('Expected duplicate cel'); secondCel.chunks = {}; secondCel.linkedToCelId = firstCel.id; sprite.frameIds.splice(duplicate.index, 0, duplicate.frame.id); sprite.frames[duplicate.frame.id] = duplicate.frame; sprite.cels[secondCel.id] = secondCel;
    const checkpointDocument = structuredClone(document); checkpointDocument.name = 'Valid cel-link checkpoint';
    const checkpoint = { id: 'checkpoint-cel-link-cycle', documentId: document.id, name: checkpointDocument.name, createdAt: nowIso(), createdBy: HUMAN_ACTOR, sourceRevision: document.revision, kind: 'manual' as const, document: checkpointDocument };

    const validPath = await writeNativeDocument(join(root, 'valid'), document, '1.0.0', undefined, [], [checkpoint]);
    const valid = await readNativeDocument(validPath); if (valid.document.kind !== 'pixel') throw new Error('Expected pixel document'); const validMainSprite = valid.document.pixelAssets[sprite.id]; if (validMainSprite.type !== 'sprite') throw new Error('Expected main sprite');
    expect(valid.warnings).toEqual([]); expect(valid.checkpoints).toHaveLength(1); expect(valid.checkpoints[0]).toMatchObject({ id: checkpoint.id, documentId: document.id, name: checkpoint.name, createdBy: HUMAN_ACTOR, sourceRevision: document.revision, kind: 'manual', document: { id: document.id, name: checkpointDocument.name } });
    const validCheckpointDocument = valid.checkpoints[0].document; if (validCheckpointDocument.kind !== 'pixel') throw new Error('Expected checkpoint pixel document'); const validCheckpointSprite = validCheckpointDocument.pixelAssets[sprite.id]; if (validCheckpointSprite.type !== 'sprite') throw new Error('Expected checkpoint sprite');
    expect(validCheckpointSprite.cels[firstCel.id].linkedToCelId).toBeUndefined(); expect(validCheckpointSprite.cels[secondCel.id]).toMatchObject({ layerId, frameId: duplicate.frame.id, linkedToCelId: firstCel.id, chunks: {} }); expect(resolvePixelCel(validCheckpointSprite, secondCel.id)?.id).toBe(firstCel.id);

    const originalArchive = unzipSync(new Uint8Array(await readFile(validPath))); const checkpointEntry = `checkpoints/${checkpoint.id}.json`; const originalCheckpoint = JSON.parse(strFromU8(originalArchive[checkpointEntry])) as typeof checkpoint; const originalIndex = JSON.parse(strFromU8(originalArchive['checkpoints/index.json']));
    expect(originalIndex).toEqual([{ id: checkpoint.id, documentId: document.id, name: checkpoint.name, createdAt: checkpoint.createdAt, createdBy: HUMAN_ACTOR, sourceRevision: document.revision, kind: 'manual' }]);
    const twinArchive: Record<string, Uint8Array> = Object.fromEntries(Object.entries(originalArchive).map(([name, bytes]) => [name, Uint8Array.from(bytes)])); const cyclicCheckpoint = structuredClone(originalCheckpoint); const cyclicCheckpointDocument = cyclicCheckpoint.document; if (cyclicCheckpointDocument.kind !== 'pixel') throw new Error('Expected persisted checkpoint pixel document'); const cyclicCheckpointSprite = cyclicCheckpointDocument.pixelAssets[sprite.id]; if (cyclicCheckpointSprite.type !== 'sprite') throw new Error('Expected persisted checkpoint sprite'); cyclicCheckpointSprite.cels[firstCel.id].linkedToCelId = secondCel.id; twinArchive[checkpointEntry] = strToU8(JSON.stringify(cyclicCheckpoint));
    const cyclicPath = join(root, 'cyclic-checkpoint.aidraw'); await writeFile(cyclicPath, zipSync(twinArchive, { level: 6 })); const cyclicArchive = unzipSync(new Uint8Array(await readFile(cyclicPath)));
    expect(Object.keys(cyclicArchive).sort()).toEqual(Object.keys(originalArchive).sort()); for (const [name, bytes] of Object.entries(originalArchive)) { if (name !== checkpointEntry) expect(Buffer.from(cyclicArchive[name])).toEqual(Buffer.from(bytes)); }
    expect(JSON.parse(strFromU8(cyclicArchive[checkpointEntry]))).toEqual(cyclicCheckpoint); expect(JSON.parse(strFromU8(cyclicArchive['checkpoints/index.json']))).toEqual(originalIndex);

    const isolated = await readNativeDocument(cyclicPath); if (isolated.document.kind !== 'pixel') throw new Error('Expected isolated pixel document'); const isolatedMainSprite = isolated.document.pixelAssets[sprite.id]; if (isolatedMainSprite.type !== 'sprite') throw new Error('Expected isolated main sprite');
    const validMain = structuredClone(valid.document); delete validMain.filePath; const isolatedMain = structuredClone(isolated.document); delete isolatedMain.filePath;
    expect(isolatedMain).toEqual(validMain); expect(isolated.document.filePath).toBe(cyclicPath); expect(isolated.checkpoints).toEqual([]); expect(isolated.warnings).toEqual([`Checkpoint “${checkpoint.id}” is corrupt and was ignored.`]);
    expect(isolatedMainSprite.layerIds).toEqual([layerId]); expect(isolatedMainSprite.frameIds).toEqual([firstFrameId, duplicate.frame.id]); expect(readPixel(isolatedMainSprite.cels[firstCel.id], 6, 7)).toBe(11); expect(resolvePixelCel(isolatedMainSprite, secondCel.id)?.id).toBe(firstCel.id);
  });

  it('bounds native checkpoint loading to the newest 32 indexed entries without disturbing the main document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-checkpoint-budget-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'Checkpoint budget fixture'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const mainCel = Object.values(sprite.cels)[0]; writePixels(mainCel, [{ x: 3, y: 4, index: 5 }]);
    const checkpoints = Array.from({ length: 32 }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, '0'); const checkpointDocument = structuredClone(document); checkpointDocument.name = `Checkpoint document ${ordinal}`; checkpointDocument.revision = index + 1;
      return { id: `checkpoint-budget-${ordinal}`, documentId: document.id, name: `Checkpoint ${ordinal}`, createdAt: `2026-08-05T00:${String(index).padStart(2, '0')}:00.000Z`, createdBy: HUMAN_ACTOR, sourceRevision: index + 1, kind: index % 2 === 0 ? 'manual' as const : 'automatic' as const, document: checkpointDocument };
    });
    const summarize = (checkpoint: Omit<(typeof checkpoints)[number], 'document'>) => ({ id: checkpoint.id, documentId: checkpoint.documentId, name: checkpoint.name, createdAt: checkpoint.createdAt, createdBy: checkpoint.createdBy, sourceRevision: checkpoint.sourceRevision, kind: checkpoint.kind }); const expectedSummaries = checkpoints.map(summarize);

    const validPath = await writeNativeDocument(join(root, 'valid'), document, '1.0.0', undefined, [], checkpoints); const validArchive = unzipSync(new Uint8Array(await readFile(validPath))); const persistedIndex = JSON.parse(strFromU8(validArchive['checkpoints/index.json']));
    expect(persistedIndex).toEqual(expectedSummaries); expect(Object.keys(validArchive).filter((name) => /^checkpoints\/checkpoint-budget-\d{2}\.json$/.test(name))).toHaveLength(32);
    const valid = await readNativeDocument(validPath); expect(valid.warnings).toEqual([]); expect(valid.checkpoints).toHaveLength(32); expect(valid.checkpoints.map(summarize)).toEqual(expectedSummaries); expect(valid.checkpoints.map((checkpoint) => ({ name: checkpoint.document.name, revision: checkpoint.document.revision }))).toEqual(checkpoints.map((checkpoint) => ({ name: checkpoint.document.name, revision: checkpoint.document.revision })));
    const persistedMain = JSON.parse(strFromU8(validArchive['document.json'])); const validMain = structuredClone(valid.document); delete validMain.filePath; expect(validMain).toEqual(persistedMain);

    const olderSummaries = [
      { id: 'checkpoint-budget-older-parse', documentId: document.id, name: 'Older parse trap', createdAt: '2026-08-04T23:58:00.000Z', createdBy: HUMAN_ACTOR, sourceRevision: 0, kind: 'automatic' as const },
      { id: 'checkpoint-budget-older-migrate', documentId: document.id, name: 'Older migration trap', createdAt: '2026-08-04T23:59:00.000Z', createdBy: HUMAN_ACTOR, sourceRevision: 0, kind: 'automatic' as const },
    ];
    const twinArchive: Record<string, Uint8Array> = Object.fromEntries(Object.entries(validArchive).map(([name, bytes]) => [name, Uint8Array.from(bytes)])); twinArchive['checkpoints/index.json'] = strToU8(JSON.stringify([...olderSummaries, ...persistedIndex])); twinArchive[`checkpoints/${olderSummaries[0].id}.json`] = strToU8('{');
    const migrationTrap = structuredClone(JSON.parse(strFromU8(validArchive[`checkpoints/${checkpoints[0].id}.json`]))); migrationTrap.id = olderSummaries[1].id; migrationTrap.name = olderSummaries[1].name; migrationTrap.createdAt = olderSummaries[1].createdAt; migrationTrap.sourceRevision = 0; migrationTrap.document.schemaVersion = 999; twinArchive[`checkpoints/${olderSummaries[1].id}.json`] = strToU8(JSON.stringify(migrationTrap));
    const twinPath = join(root, 'surplus-index.aidraw'); await writeFile(twinPath, zipSync(twinArchive, { level: 6 })); const persistedTwin = unzipSync(new Uint8Array(await readFile(twinPath)));
    expect(JSON.parse(strFromU8(persistedTwin['checkpoints/index.json']))).toEqual([...olderSummaries, ...expectedSummaries]); expect(strFromU8(persistedTwin['document.json'])).toBe(strFromU8(validArchive['document.json'])); for (const checkpoint of checkpoints) expect(Buffer.from(persistedTwin[`checkpoints/${checkpoint.id}.json`])).toEqual(Buffer.from(validArchive[`checkpoints/${checkpoint.id}.json`]));

    const bounded = await readNativeDocument(twinPath); expect(bounded.warnings).toEqual([]); expect(bounded.checkpoints).toHaveLength(32); expect(bounded.checkpoints.map(summarize)).toEqual(expectedSummaries); expect(bounded.checkpoints.map((checkpoint) => checkpoint.id)).not.toContain(olderSummaries[0].id); expect(bounded.checkpoints.map((checkpoint) => checkpoint.id)).not.toContain(olderSummaries[1].id);
    const boundedMain = structuredClone(bounded.document); delete boundedMain.filePath; expect(boundedMain).toEqual(validMain); expect(bounded.document.filePath).toBe(twinPath); if (bounded.document.kind !== 'pixel') throw new Error('Expected bounded pixel document'); const boundedSprite = bounded.document.pixelAssets[sprite.id]; if (boundedSprite.type !== 'sprite') throw new Error('Expected bounded sprite'); expect(readPixel(Object.values(boundedSprite.cels)[0], 3, 4)).toBe(5);
  });

  it('isolates invalid and non-array checkpoint indexes before checkpoint payload processing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-checkpoint-index-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'Checkpoint index isolation fixture'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); writePixels(Object.values(sprite.cels)[0], [{ x: 7, y: 8, index: 13 }]);
    const checkpointDocument = structuredClone(document); checkpointDocument.name = 'Valid indexed checkpoint'; checkpointDocument.revision = 7; const checkpoint = { id: 'checkpoint-index-valid', documentId: document.id, name: checkpointDocument.name, createdAt: '2026-08-05T01:00:00.000Z', createdBy: HUMAN_ACTOR, sourceRevision: 7, kind: 'manual' as const, document: checkpointDocument };
    const validPath = await writeNativeDocument(join(root, 'valid'), document, '1.0.0', undefined, [], [checkpoint]); const validArchive = unzipSync(new Uint8Array(await readFile(validPath))); const checkpointEntry = `checkpoints/${checkpoint.id}.json`; const persistedCheckpoint = JSON.parse(strFromU8(validArchive[checkpointEntry]));
    const valid = await readNativeDocument(validPath); expect(valid.warnings).toEqual([]); expect(valid.checkpoints).toHaveLength(1); expect(valid.checkpoints[0]).toMatchObject({ id: checkpoint.id, documentId: document.id, name: checkpoint.name, createdAt: checkpoint.createdAt, createdBy: HUMAN_ACTOR, sourceRevision: 7, kind: 'manual', document: { id: document.id, name: checkpointDocument.name, revision: 7 } }); const validMain = structuredClone(valid.document); delete validMain.filePath;

    const mutations = [
      { name: 'invalid-json', bytes: strToU8('{') },
      { name: 'non-array', bytes: strToU8(JSON.stringify({ checkpoints: [checkpoint.id] })) },
    ];
    for (const mutation of mutations) {
      const twinArchive: Record<string, Uint8Array> = Object.fromEntries(Object.entries(validArchive).map(([name, bytes]) => [name, Uint8Array.from(bytes)])); twinArchive['checkpoints/index.json'] = mutation.bytes;
      const twinPath = join(root, `${mutation.name}.aidraw`); await writeFile(twinPath, zipSync(twinArchive, { level: 6 })); const persistedTwin = unzipSync(new Uint8Array(await readFile(twinPath)));
      expect(Object.keys(persistedTwin).sort()).toEqual(Object.keys(validArchive).sort()); for (const [name, bytes] of Object.entries(validArchive)) { if (name !== 'checkpoints/index.json') expect(Buffer.from(persistedTwin[name])).toEqual(Buffer.from(bytes)); }
      expect(Buffer.from(persistedTwin['checkpoints/index.json'])).toEqual(Buffer.from(mutation.bytes)); expect(JSON.parse(strFromU8(persistedTwin[checkpointEntry]))).toEqual(persistedCheckpoint);

      const isolated = await readNativeDocument(twinPath); const isolatedMain = structuredClone(isolated.document); delete isolatedMain.filePath;
      expect(isolatedMain).toEqual(validMain); expect(isolated.document.filePath).toBe(twinPath); expect(isolated.checkpoints).toEqual([]); expect(isolated.warnings).toEqual(['The checkpoint index is corrupt and was ignored.']);
      if (isolated.document.kind !== 'pixel') throw new Error('Expected isolated pixel document'); const isolatedSprite = isolated.document.pixelAssets[sprite.id]; if (isolatedSprite.type !== 'sprite') throw new Error('Expected isolated sprite'); expect(readPixel(Object.values(isolatedSprite.cels)[0], 7, 8)).toBe(13);
    }
  });

  it('isolates one checkpoint payload document-identity mismatch while preserving its ordered sibling and main document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-checkpoint-metadata-')); temporaryPaths.push(root);
    const document = createPixelDocument('sprite', 'Checkpoint metadata isolation fixture'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); writePixels(Object.values(sprite.cels)[0], [{ x: 9, y: 10, index: 17 }]);
    const checkpoints = ['First valid checkpoint', 'Second selected checkpoint'].map((name, index) => { const checkpointDocument = structuredClone(document); checkpointDocument.name = `${name} document`; checkpointDocument.revision = index + 4; return { id: `checkpoint-metadata-${index + 1}`, documentId: document.id, name, createdAt: `2026-08-05T02:0${index}:00.000Z`, createdBy: HUMAN_ACTOR, sourceRevision: index + 4, kind: index === 0 ? 'manual' as const : 'automatic' as const, document: checkpointDocument }; });
    const validPath = await writeNativeDocument(join(root, 'valid'), document, '1.0.0', undefined, [], checkpoints); const validArchive = unzipSync(new Uint8Array(await readFile(validPath))); const persistedIndex = strFromU8(validArchive['checkpoints/index.json']); const selectedEntry = `checkpoints/${checkpoints[1].id}.json`; const originalSelected = JSON.parse(strFromU8(validArchive[selectedEntry]));
    const valid = await readNativeDocument(validPath); expect(valid.warnings).toEqual([]); expect(valid.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(checkpoints.map((checkpoint) => checkpoint.id)); expect(valid.checkpoints).toHaveLength(2); const retainedCheckpoint = structuredClone(valid.checkpoints[0]); const validMain = structuredClone(valid.document); delete validMain.filePath;

    const twinArchive: Record<string, Uint8Array> = Object.fromEntries(Object.entries(validArchive).map(([name, bytes]) => [name, Uint8Array.from(bytes)])); const mismatchedSelected = structuredClone(originalSelected); mismatchedSelected.documentId = createId('document'); expect(mismatchedSelected.documentId).not.toBe(document.id); twinArchive[selectedEntry] = strToU8(JSON.stringify(mismatchedSelected));
    const twinPath = join(root, 'document-id-mismatch.aidraw'); await writeFile(twinPath, zipSync(twinArchive, { level: 6 })); const persistedTwin = unzipSync(new Uint8Array(await readFile(twinPath)));
    expect(Object.keys(persistedTwin).sort()).toEqual(Object.keys(validArchive).sort()); for (const [name, bytes] of Object.entries(validArchive)) { if (name !== selectedEntry) expect(Buffer.from(persistedTwin[name])).toEqual(Buffer.from(bytes)); }
    expect(strFromU8(persistedTwin['checkpoints/index.json'])).toBe(persistedIndex); expect(JSON.parse(strFromU8(persistedTwin[selectedEntry]))).toEqual(mismatchedSelected); expect(mismatchedSelected).toEqual({ ...originalSelected, documentId: mismatchedSelected.documentId });

    const isolated = await readNativeDocument(twinPath); const isolatedMain = structuredClone(isolated.document); delete isolatedMain.filePath;
    expect(isolatedMain).toEqual(validMain); expect(isolated.document.filePath).toBe(twinPath); expect(isolated.checkpoints).toEqual([retainedCheckpoint]); expect(isolated.checkpoints[0]).toEqual(valid.checkpoints[0]); expect(isolated.warnings).toEqual([`Checkpoint “${checkpoints[1].id}” is corrupt and was ignored.`]);
    if (isolated.document.kind !== 'pixel') throw new Error('Expected isolated pixel document'); const isolatedSprite = isolated.document.pixelAssets[sprite.id]; if (isolatedSprite.type !== 'sprite') throw new Error('Expected isolated sprite'); expect(readPixel(Object.values(isolatedSprite.cels)[0], 9, 10)).toBe(17);
  });

  it('reconciles checkpoint index metadata with each payload and its captured document revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-checkpoint-reconciliation-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Checkpoint reconciliation fixture');
    const checkpoints = ['Retained checkpoint', 'Selected checkpoint'].map((name, index) => {
      const checkpointDocument = structuredClone(document); checkpointDocument.name = `${name} document`; checkpointDocument.revision = index + 3;
      return {
        id: `checkpoint-reconciliation-${index + 1}`, documentId: document.id, name,
        createdAt: `2026-08-12T04:0${index}:00.000Z`, createdBy: HUMAN_ACTOR,
        sourceRevision: checkpointDocument.revision, kind: 'manual' as const, document: checkpointDocument,
      };
    });
    const validPath = await writeNativeDocument(join(root, 'valid'), document, '1.0.0', undefined, [], checkpoints);
    const validArchive = unzipSync(new Uint8Array(await readFile(validPath)));
    const valid = await readNativeDocument(validPath); expect(valid.warnings).toEqual([]); expect(valid.checkpoints).toHaveLength(2);
    const validMain = structuredClone(valid.document); delete validMain.filePath;
    const retainedCheckpoint = structuredClone(valid.checkpoints[0]);
    const selectedEntry = `checkpoints/${checkpoints[1].id}.json`;
    type CheckpointJson = Record<string, unknown> & { document: Record<string, unknown> };
    type ReconciliationMutation = {
      name: string;
      warning: string;
      mutate(index: Array<Record<string, unknown>>, payload: CheckpointJson): void;
    };
    const corruptWarning = `Checkpoint “${checkpoints[1].id}” is corrupt and was ignored.`;
    const mutations: ReconciliationMutation[] = [
      { name: 'index-name-mismatch', warning: corruptWarning, mutate: (index) => { index[1].name = 'Different indexed name'; } },
      { name: 'payload-created-at-mismatch', warning: corruptWarning, mutate: (_index, payload) => { payload.createdAt = '2026-08-12T05:00:00.000Z'; } },
      { name: 'payload-actor-mismatch', warning: corruptWarning, mutate: (_index, payload) => { payload.createdBy = { ...HUMAN_ACTOR, id: 'human-other' }; } },
      { name: 'payload-kind-mismatch', warning: corruptWarning, mutate: (_index, payload) => { payload.kind = 'automatic'; } },
      { name: 'payload-invalid-timestamp', warning: corruptWarning, mutate: (_index, payload) => { payload.createdAt = '2026-08-12T04:01:00Z'; } },
      { name: 'payload-expanded-envelope', warning: corruptWarning, mutate: (_index, payload) => { payload.untrusted = true; } },
      { name: 'document-revision-mismatch', warning: corruptWarning, mutate: (_index, payload) => { payload.document.revision = checkpoints[1].sourceRevision + 1; } },
      { name: 'invalid-index-actor', warning: 'An invalid checkpoint entry was ignored.', mutate: (index) => { index[1].createdBy = { ...HUMAN_ACTOR, color: 'pink' }; } },
    ];

    for (const mutation of mutations) {
      const twinArchive: Record<string, Uint8Array> = Object.fromEntries(Object.entries(validArchive).map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
      const index = JSON.parse(strFromU8(twinArchive['checkpoints/index.json'])) as Array<Record<string, unknown>>;
      const payload = JSON.parse(strFromU8(twinArchive[selectedEntry])) as CheckpointJson;
      mutation.mutate(index, payload);
      twinArchive['checkpoints/index.json'] = strToU8(JSON.stringify(index));
      twinArchive[selectedEntry] = strToU8(JSON.stringify(payload));
      const twinPath = join(root, `${mutation.name}.aidraw`); await writeFile(twinPath, zipSync(twinArchive, { level: 6 }));

      const isolated = await readNativeDocument(twinPath); const isolatedMain = structuredClone(isolated.document); delete isolatedMain.filePath;
      expect(isolatedMain).toEqual(validMain); expect(isolated.document.filePath).toBe(twinPath);
      expect(isolated.checkpoints).toEqual([retainedCheckpoint]); expect(isolated.warnings).toEqual([mutation.warning]);
    }

    const duplicateArchive: Record<string, Uint8Array> = Object.fromEntries(Object.entries(validArchive).map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
    const duplicateIndex = JSON.parse(strFromU8(duplicateArchive['checkpoints/index.json'])) as Array<Record<string, unknown>>;
    duplicateIndex.push(structuredClone(duplicateIndex[1])); duplicateArchive['checkpoints/index.json'] = strToU8(JSON.stringify(duplicateIndex));
    const duplicatePath = join(root, 'duplicate-index-id.aidraw'); await writeFile(duplicatePath, zipSync(duplicateArchive, { level: 6 }));
    const duplicate = await readNativeDocument(duplicatePath);
    expect(duplicate.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(checkpoints.map((checkpoint) => checkpoint.id));
    expect(duplicate.warnings).toEqual(['An invalid checkpoint entry was ignored.']);
  });

  it('rejects inconsistent or duplicate checkpoints before replacing an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-checkpoint-save-policy-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Checkpoint save policy fixture');
    const destination = await writeNativeDocument(join(root, 'drawing'), document, '1.0.0');
    const destinationBytes = await readFile(destination);
    const checkpointDocument = structuredClone(document);
    const checkpoint = {
      id: 'checkpoint-save-policy', documentId: document.id, name: 'Save policy checkpoint',
      createdAt: '2026-08-12T05:00:00.000Z', createdBy: HUMAN_ACTOR,
      sourceRevision: checkpointDocument.revision, kind: 'manual' as const, document: checkpointDocument,
    };
    const inconsistent = structuredClone(checkpoint); inconsistent.sourceRevision += 1;
    await expect(writeNativeDocument(destination, document, '1.0.1', undefined, [], [inconsistent]))
      .rejects.toThrow('AIDraw checkpoint contains invalid or inconsistent metadata.');
    await expect(writeNativeDocument(destination, document, '1.0.1', undefined, [], [checkpoint, structuredClone(checkpoint)]))
      .rejects.toThrow('AIDraw checkpoint contains invalid or inconsistent metadata.');
    expect(await readFile(destination)).toEqual(destinationBytes);
    expect((await readNativeDocument(destination)).document.name).toBe(document.name);
    expect(await readdir(root)).toEqual(['drawing.aidraw']);
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

  it('drops an incomplete paint tile index instead of trusting partial stroke coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Incomplete cache index');
    document.artboard = { ...document.artboard, width: 520, height: 80, background: null };
    const paint = Object.values(document.layers).find((layer) => layer.type === 'paint');
    if (!paint || paint.type !== 'paint') throw new Error('Paint layer missing');
    paint.strokes.push({ id: 'cross-tile', actorId: HUMAN_ACTOR.id, points: [{ x: 8, y: 24, pressure: 0.5 }, { x: 512, y: 24, pressure: 0.5 }], color: '#d94a67', size: 12, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const sourcePath = await writeNativeDocument(join(root, 'incomplete.aidraw'), document, '1.0.0');
    const files = unzipSync(new Uint8Array(await readFile(sourcePath)));
    const persisted = JSON.parse(strFromU8(files['document.json'])) as typeof document;
    const persistedPaint = Object.values(persisted.layers).find((layer) => layer.type === 'paint');
    if (!persistedPaint || persistedPaint.type !== 'paint') throw new Error('Persisted paint layer missing');
    expect(Object.keys(persistedPaint.tileAssetIds)).toHaveLength(3);
    delete persistedPaint.tileAssetIds['1,0'];
    files['document.json'] = strToU8(JSON.stringify(persisted));
    const incompletePath = join(root, 'incomplete-mutated.aidraw'); await writeFile(incompletePath, zipSync(files));

    const loaded = await readNativeDocument(incompletePath);
    const loadedPaint = loaded.document.kind === 'illustration' ? Object.values(loaded.document.layers).find((layer) => layer.type === 'paint') : undefined;
    expect(loadedPaint?.type === 'paint' ? loadedPaint.strokes : undefined).toEqual(paint.strokes);
    expect(loadedPaint?.type === 'paint' ? loadedPaint.tileCache : undefined).toBeUndefined();
    expect(loadedPaint?.type === 'paint' ? loadedPaint.tileAssetIds : undefined).toEqual({});
    expect(loaded.warnings).toContainEqual(expect.stringMatching(/tile index does not match editable stroke coverage/));
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

  it('rejects malformed manifests and manifest/document contradictions before returning native content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-manifest-')); temporaryPaths.push(root);
    const sourcePath = await writeNativeDocument(join(root, 'source.aidraw'), createIllustrationDocument('Manifest fixture'), '1.0.0');
    const files = unzipSync(new Uint8Array(await readFile(sourcePath)));
    const validManifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>;

    const contradictions: Array<[string, unknown]> = [
      ['schemaVersion', 1],
      ['documentId', 'document-other'],
      ['documentKind', 'pixel'],
      ['name', 'Contradictory name'],
      ['revision', 1],
      ['createdAt', '2000-01-01T00:00:00.000Z'],
      ['updatedAt', '2000-01-02T00:00:00.000Z'],
      ['assetCount', 1],
    ];
    for (const [field, value] of contradictions) {
      const manifest = { ...validManifest, [field]: value };
      const path = join(root, `contradictory-${field}.aidraw`);
      await writeFile(path, zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) }));
      await expect(readNativeDocument(path)).rejects.toThrow(`AIDraw manifest is inconsistent with document.json: ${field}.`);
    }

    const malformed: Array<[string, unknown, string]> = [
      ['not-an-object', null, 'AIDraw manifest is malformed.'],
      ['wrong-format', { ...validManifest, format: 'Other' }, 'This file is not a valid AIDraw container.'],
      ['future-schema', { ...validManifest, schemaVersion: 3 }, 'Unsupported AIDraw schema version: 3'],
      ['unsafe-revision', { ...validManifest, revision: Number.MAX_SAFE_INTEGER + 1 }, 'AIDraw manifest is malformed.'],
      ['negative-asset-count', { ...validManifest, assetCount: -1 }, 'AIDraw manifest is malformed.'],
      ['missing-saver', { ...validManifest, savedBy: undefined }, 'AIDraw manifest is malformed.'],
      ['wrong-saver', { ...validManifest, savedBy: { application: 'Other', version: '1.0.0' } }, 'AIDraw manifest is malformed.'],
    ];
    for (const [name, manifest, error] of malformed) {
      const path = join(root, `malformed-${name}.aidraw`);
      await writeFile(path, zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) }));
      await expect(readNativeDocument(path)).rejects.toThrow(error);
    }
    const invalidJsonPath = join(root, 'malformed-invalid-json.aidraw');
    await writeFile(invalidJsonPath, zipSync({ ...files, 'manifest.json': strToU8('{"format":') }));
    await expect(readNativeDocument(invalidJsonPath)).rejects.toThrow('AIDraw manifest is malformed.');
  });

  it('hydrates only hash- and length-matched native asset entries and never trusts inline document bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-assets-')); temporaryPaths.push(root);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const document = createIllustrationDocument('Asset integrity fixture');
    document.assets['asset-integrity'] = {
      id: 'asset-integrity', name: 'Integrity asset', mimeType: 'image/png', byteLength: bytes.byteLength,
      sha256, source: 'imported', data: bytes.toString('base64'),
    };
    const sourcePath = await writeNativeDocument(join(root, 'source.aidraw'), document, '1.0.0');
    const valid = await readNativeDocument(sourcePath);
    expect(valid.document.assets['asset-integrity'].data).toBe(bytes.toString('base64'));
    expect(valid.warnings).toEqual([]);

    const sourceArchiveBytes = await readFile(sourcePath);
    const invalidSave = structuredClone(document);
    const invalidSaveBytes = Buffer.from(bytes); invalidSaveBytes[0] ^= 0xff;
    invalidSave.assets['asset-integrity'].data = invalidSaveBytes.toString('base64');
    await expect(writeNativeDocument(sourcePath, invalidSave, '1.0.1')).rejects.toThrow('AIDraw asset data does not match its content metadata.');
    expect(await readFile(sourcePath)).toEqual(sourceArchiveBytes);

    const sourceFiles = unzipSync(new Uint8Array(sourceArchiveBytes));
    const corruptBytes = Uint8Array.from(sourceFiles[`assets/${sha256}`]); corruptBytes[0] ^= 0xff;
    const corruptPath = join(root, 'corrupt-hash.aidraw');
    await writeFile(corruptPath, zipSync({ ...sourceFiles, [`assets/${sha256}`]: corruptBytes }));
    const corrupt = await readNativeDocument(corruptPath);
    expect(corrupt.document.assets['asset-integrity'].data).toBeUndefined();
    expect(corrupt.warnings).toContain('Embedded data for asset “Integrity asset” is corrupt and was ignored.');

    const wrongLengthFiles = { ...sourceFiles };
    const wrongLengthDocument = JSON.parse(strFromU8(wrongLengthFiles['document.json'])) as typeof document;
    wrongLengthDocument.assets['asset-integrity'].byteLength += 1;
    wrongLengthFiles['document.json'] = strToU8(JSON.stringify(wrongLengthDocument));
    const wrongLengthPath = join(root, 'wrong-length.aidraw');
    await writeFile(wrongLengthPath, zipSync(wrongLengthFiles));
    const wrongLength = await readNativeDocument(wrongLengthPath);
    expect(wrongLength.document.assets['asset-integrity'].data).toBeUndefined();
    expect(wrongLength.warnings).toContain('Embedded data for asset “Integrity asset” is corrupt and was ignored.');

    const inlineFiles = { ...sourceFiles };
    delete inlineFiles[`assets/${sha256}`];
    const inlineDocument = JSON.parse(strFromU8(inlineFiles['document.json'])) as typeof document;
    inlineDocument.assets['asset-integrity'].data = bytes.toString('base64');
    inlineFiles['document.json'] = strToU8(JSON.stringify(inlineDocument));
    const inlinePath = join(root, 'inline-bypass.aidraw');
    await writeFile(inlinePath, zipSync(inlineFiles));
    const inline = await readNativeDocument(inlinePath);
    expect(inline.document.assets['asset-integrity'].data).toBeUndefined();
    expect(inline.warnings).toContain('Embedded data for asset “Integrity asset” is missing.');

    const invalidMetadataFiles = { ...sourceFiles };
    const invalidMetadataDocument = JSON.parse(strFromU8(invalidMetadataFiles['document.json'])) as typeof document;
    invalidMetadataDocument.assets['asset-integrity'].sha256 = 'not-a-content-hash';
    invalidMetadataFiles['document.json'] = strToU8(JSON.stringify(invalidMetadataDocument));
    const invalidMetadataPath = join(root, 'invalid-asset-metadata.aidraw');
    await writeFile(invalidMetadataPath, zipSync(invalidMetadataFiles));
    await expect(readNativeDocument(invalidMetadataPath)).rejects.toThrow('AIDraw document contains invalid asset metadata.');
  });

  it('isolates malformed native trace records and rejects an invalid trace before save replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-trace-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Trace integrity fixture');
    const transaction: CanvasTransaction = {
      id: 'trace-valid', clientOperationId: 'trace-valid-operation', documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Valid durable trace', createdAt: nowIso(), operations: [{ kind: 'document.rename', name: document.name }],
    };
    const validTrace: TransactionTraceEntry = {
      version: 1, documentId: document.id, revision: 1, recordedAt: nowIso(), outcome: 'committed', transaction,
    };
    const sourcePath = await writeNativeDocument(join(root, 'source.aidraw'), document, '1.0.0', undefined, [validTrace]);
    const sourceBytes = await readFile(sourcePath);
    const files = unzipSync(new Uint8Array(sourceBytes));
    const exactTransaction = {
      ...transaction, id: 'trace-exact-limit', clientOperationId: 'trace-exact-limit-operation',
      operations: [{ kind: 'document.rename', name: document.name, padding: '' }],
    } as unknown as CanvasTransaction;
    const paddingLength = MAX_TRANSACTION_SERIALIZED_BYTES - Buffer.byteLength(JSON.stringify(exactTransaction), 'utf8');
    (exactTransaction.operations[0] as unknown as { padding: string }).padding = 'x'.repeat(paddingLength);
    expect(Buffer.byteLength(JSON.stringify(exactTransaction), 'utf8')).toBe(MAX_TRANSACTION_SERIALIZED_BYTES);
    const exactTrace: TransactionTraceEntry = { ...validTrace, revision: 2, transaction: exactTransaction };
    const oversizedTrace = structuredClone(exactTrace) as TransactionTraceEntry;
    (oversizedTrace.transaction.operations[0] as unknown as { padding: string }).padding += 'x';
    const malformed = [
      { ...validTrace, extra: 'not-writer-authored' },
      { ...validTrace, transaction: { ...transaction, documentId: 'another-document' } },
      { ...validTrace, transaction: { ...transaction, operations: [{ kind: 'document.rename', name: '' }] } },
      oversizedTrace,
    ];
    files['trace/transactions.jsonl'] = strToU8([
      JSON.stringify(validTrace),
      JSON.stringify(exactTrace),
      ...Array.from({ length: 10_000 }, () => '{}'),
      ...malformed.map((entry) => JSON.stringify(entry)),
      '',
    ].join('\n'));
    const hostilePath = join(root, 'hostile-trace.aidraw');
    await writeFile(hostilePath, zipSync(files));

    const loaded = await readNativeDocument(hostilePath);
    expect(loaded.trace).toEqual([validTrace, exactTrace]);
    expect(loaded.warnings).toEqual(['10,004 malformed transaction trace entries were ignored.']);
    expect(loaded.document.id).toBe(document.id);

    const invalidSaveTrace = malformed[2] as unknown as TransactionTraceEntry;
    await expect(writeNativeDocument(sourcePath, document, '1.0.1', undefined, [invalidSaveTrace])).rejects.toThrow('AIDraw transaction trace contains an invalid entry.');
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
  });

  it('rejects unsafe ZIP paths and oversized metadata before native extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-')); temporaryPaths.push(root);
    const unsafePath = join(root, 'unsafe.aidraw'); await writeFile(unsafePath, zipSync({ '../escape.json': strToU8('{}'), 'manifest.json': strToU8('{}'), 'document.json': strToU8('{}') }));
    await expect(readNativeDocument(unsafePath)).rejects.toThrow(/unsafe entry path/);
    const oversizedPath = join(root, 'oversized.aidraw'); await writeFile(oversizedPath, zipSync({ 'manifest.json': new Uint8Array(1024 * 1024 + 1), 'document.json': strToU8('{}') }, { level: 9 }));
    await expect(readNativeDocument(oversizedPath)).rejects.toThrow(/expanded-size limit/);
  });

  it('rejects a native container whose stored entry CRC does not match its intact payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-crc-')); temporaryPaths.push(root);
    const sourcePath = await writeNativeDocument(join(root, 'source'), createIllustrationDocument('CRC fixture'), '1.0.0');
    const corruptedPath = join(root, 'wrong-crc.aidraw');
    const corrupted = replaceStoredCrc(await readFile(sourcePath), 'document.json');
    expect(JSON.parse(strFromU8(unzipSync(corrupted)['document.json'])).name).toBe('CRC fixture');
    await writeFile(corruptedPath, corrupted);
    await expect(readNativeDocument(corruptedPath)).rejects.toThrow('AIDraw container CRC-32 mismatch for document.json.');
  });

  it('preserves an existing destination across write, flush, and replace failures and then saves normally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-atomic-')); temporaryPaths.push(root);
    const destination = await writeNativeDocument(join(root, 'drawing'), createIllustrationDocument('Original destination'), '1.0.0');
    const originalBytes = await readFile(destination);
    const replacement = createIllustrationDocument('Replacement document');

    for (const stage of ['write', 'flush', 'replace'] as const) {
      const opened: string[] = []; const removed: string[] = []; const replacements: Array<[string, string]> = [];
      const fileSystem: NativeSaveFileSystem = {
        openExclusive: async (filePath) => {
          opened.push(filePath);
          const handle = await nativeSaveFileSystem.openExclusive(filePath);
          return {
            writeFile: stage === 'write' ? async (data) => { await handle.writeFile(data.subarray(0, 64)); throw new Error('Injected write failure.'); } : handle.writeFile,
            sync: stage === 'flush' ? async () => { await handle.sync(); throw new Error('Injected flush failure.'); } : handle.sync,
            close: handle.close,
          };
        },
        replace: async (source, target) => {
          replacements.push([source, target]);
          if (stage === 'replace') throw new Error('Injected replace failure.');
          await nativeSaveFileSystem.replace(source, target);
        },
        remove: async (filePath) => { removed.push(filePath); await nativeSaveFileSystem.remove(filePath); },
      };

      await expect(writeNativeDocument(destination, replacement, '1.0.1', undefined, [], [], fileSystem)).rejects.toThrow(`Injected ${stage} failure.`);
      expect(opened).toHaveLength(1);
      expect(opened[0].startsWith(`${destination}.`)).toBe(true);
      expect(opened[0].endsWith('.tmp')).toBe(true);
      expect(removed).toEqual(opened);
      expect(replacements).toEqual(stage === 'replace' ? [[opened[0], destination]] : []);
      expect(Buffer.compare(await readFile(destination), originalBytes)).toBe(0);
      expect((await readNativeDocument(destination)).document.name).toBe('Original destination');
      expect(await readdir(root)).toEqual(['drawing.aidraw']);
    }

    await writeNativeDocument(destination, replacement, '1.0.1');
    expect(Buffer.compare(await readFile(destination), originalBytes)).not.toBe(0);
    expect((await readNativeDocument(destination)).document.name).toBe('Replacement document');
    expect(await readdir(root)).toEqual(['drawing.aidraw']);
  });

  it('adopts a materialized paint cache only after the atomic replacement succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-persistence-cache-adoption-')); temporaryPaths.push(root);
    const document = createIllustrationDocument('Cache adoption');
    document.artboard = { ...document.artboard, width: 520, height: 80, background: null };
    const paint = Object.values(document.layers).find((layer) => layer.type === 'paint');
    if (!paint || paint.type !== 'paint') throw new Error('Paint layer missing');
    paint.strokes.push({ id: 'initial-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 24, y: 24, pressure: 0.5 }, { x: 96, y: 48, pressure: 0.5 }], color: '#d94a67', size: 12, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });
    const destination = await writeNativeDocument(join(root, 'drawing'), document, '1.0.0');
    expect(paint.tileCache?.strokeCount).toBe(1);
    const cacheBefore = structuredClone(paint.tileCache);
    const tileAssetIdsBefore = structuredClone(paint.tileAssetIds);
    const assetsBefore = structuredClone(document.assets);
    const destinationBefore = await readFile(destination);
    paint.strokes.push({ id: 'appended-stroke', actorId: HUMAN_ACTOR.id, points: [{ x: 128, y: 40, pressure: 0.5 }, { x: 192, y: 56, pressure: 0.5 }], color: '#3344cc', size: 8, opacity: 1, hardness: 1, flow: 1, mode: 'paint', preset: 'hard-round' });

    const fileSystem: NativeSaveFileSystem = {
      ...nativeSaveFileSystem,
      replace: async () => { throw new Error('Injected replace failure.'); },
    };
    await expect(writeNativeDocument(destination, document, '1.0.1', undefined, [], [], fileSystem)).rejects.toThrow('Injected replace failure.');
    expect(paint.tileCache).toEqual(cacheBefore);
    expect(paint.tileAssetIds).toEqual(tileAssetIdsBefore);
    expect(document.assets).toEqual(assetsBefore);
    expect(await readFile(destination)).toEqual(destinationBefore);
    expect(await readdir(root)).toEqual(['drawing.aidraw']);
  });
});
