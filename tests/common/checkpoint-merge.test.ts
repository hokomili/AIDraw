import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, createIllustrationDocument, createPixelDocument, createPixelSprite, createPixelTileset, createId, nowIso, applyTransaction } from '@aidraw/core';
import { checkpointMergeCandidates, checkpointMergeOperations } from '../../src/common/checkpoint-merge';

describe('checkpoint selective merge', () => {
  it('duplicates a selected illustration layer with objects into the current branch', () => {
    const source = createIllustrationDocument('Source'); const target = createIllustrationDocument('Target'); const layer = source.layers[source.layerIds[0]]; if (layer.type !== 'vector') throw new Error('Expected vector layer'); const timestamp = nowIso(); const objectId = createId('shape');
    source.objects[objectId] = { id: objectId, revision: 0, name: 'Checkpoint star', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { x: 8, y: 8, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 }, type: 'shape', shape: 'star', width: 32, height: 32, sides: 5, innerRadius: 0.5, fill: { kind: 'solid', color: '#ffcc33' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    const groupId = createId('group'); source.objects[groupId] = { id: groupId, revision: 0, name: 'Checkpoint group', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 }, type: 'group', childIds: [objectId] }; layer.objectIds.push(groupId, objectId);
    const operations = checkpointMergeOperations(target, source, [layer.id]); const merged = applyTransaction(target, { id: 'tx', clientOperationId: 'merge', documentId: target.id, actor: HUMAN_ACTOR, label: 'Merge checkpoint layer', createdAt: timestamp, operations }).document;
    if (merged.kind !== 'illustration') throw new Error('Expected illustration'); expect(merged.layerIds).toHaveLength(target.layerIds.length + 1); expect(Object.values(merged.objects).some((object) => object.name === 'Checkpoint star')).toBe(true); expect(Object.values(merged.objects).find((object) => object.name === 'Checkpoint group')).toMatchObject({ type: 'group', childIds: [expect.any(String)] }); expect(checkpointMergeCandidates(source)[0]).toMatchObject({ id: layer.id, type: 'illustration-layer' });
  });

  it('duplicates a selected pixel asset with its dependency closure', () => {
    const source = createPixelDocument('project', 'Source'); const target = createPixelDocument('project', 'Target'); const sprite = source.pixelAssets[source.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const tileset = createPixelTileset('Terrain', sprite.id, 16, 16, 2, 2); source.pixelAssets[tileset.id] = tileset; source.assetIds.push(tileset.id);
    const operations = checkpointMergeOperations(target, source, [tileset.id]); const merged = applyTransaction(target, { id: 'tx', clientOperationId: 'merge-pixel', documentId: target.id, actor: HUMAN_ACTOR, label: 'Merge checkpoint asset', createdAt: nowIso(), operations }).document;
    if (merged.kind !== 'pixel') throw new Error('Expected pixel'); const copies = Object.values(merged.pixelAssets); const copiedTileset = copies.find((asset) => asset.type === 'tileset'); expect(copiedTileset?.type).toBe('tileset'); if (copiedTileset?.type === 'tileset') { if (!copiedTileset.spriteAssetId) throw new Error('Expected atlas tileset'); expect(merged.pixelAssets[copiedTileset.spriteAssetId]?.type).toBe('sprite'); }
  });

  it('duplicates every sparse image-collection sprite dependency with exact remapped local IDs', () => {
    const source = createPixelDocument('project', 'Collection source'); const target = createPixelDocument('project', 'Collection target');
    const tileZero = source.pixelAssets[source.activeAssetId]; if (tileZero.type !== 'sprite') throw new Error('Expected first collection sprite');
    const tileThree = createPixelSprite('Sparse tile 3', 3, 2); const collection = createPixelTileset('Sparse collection', tileZero.id, 2, 2, 1, 1); delete collection.spriteAssetId; collection.columns = 2; collection.rows = 0;
    collection.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: tileZero.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: tileThree.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    source.pixelAssets[tileThree.id] = tileThree; source.pixelAssets[collection.id] = collection; source.assetIds.push(tileThree.id, collection.id);

    const operations = checkpointMergeOperations(target, source, [collection.id]);
    expect(operations.filter((operation) => operation.kind === 'pixel.asset.add')).toHaveLength(3);
    const merged = applyTransaction(target, { id: 'collection-merge-tx', clientOperationId: 'collection-merge', documentId: target.id, actor: HUMAN_ACTOR, label: 'Merge image collection', createdAt: nowIso(), operations }).document;
    if (merged.kind !== 'pixel') throw new Error('Expected pixel document');
    const copiedCollection = Object.values(merged.pixelAssets).find((asset) => asset.type === 'tileset');
    if (copiedCollection?.type !== 'tileset') throw new Error('Expected copied collection');
    const remappedSources = [copiedCollection.tiles[0].imageAssetId, copiedCollection.tiles[3].imageAssetId];
    expect(copiedCollection).toMatchObject({ columns: 2, rows: 0 });
    expect(copiedCollection.spriteAssetId).toBeUndefined();
    expect(Object.keys(copiedCollection.tiles)).toEqual(['0', '3']);
    expect(new Set(remappedSources).size).toBe(2);
    expect(remappedSources).not.toContain(tileZero.id);
    expect(remappedSources).not.toContain(tileThree.id);
    for (const sourceId of remappedSources) {
      expect(sourceId).toBeDefined();
      expect(merged.pixelAssets[sourceId!]?.type).toBe('sprite');
    }
  });
});
