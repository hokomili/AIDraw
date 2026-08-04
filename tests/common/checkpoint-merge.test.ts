import { describe, expect, it } from 'vitest';
import { HUMAN_ACTOR, createIllustrationDocument, createPixelDocument, createPixelTileset, createId, nowIso, applyTransaction } from '@aidraw/core';
import { checkpointMergeCandidates, checkpointMergeOperations } from '../../src/common/checkpoint-merge';

describe('checkpoint selective merge', () => {
  it('duplicates a selected illustration layer with objects into the current branch', () => {
    const source = createIllustrationDocument('Source'); const target = createIllustrationDocument('Target'); const layer = source.layers[source.layerIds[0]]; if (layer.type !== 'vector') throw new Error('Expected vector layer'); const timestamp = nowIso(); const objectId = createId('shape');
    source.objects[objectId] = { id: objectId, revision: 0, name: 'Checkpoint star', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { x: 8, y: 8, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0 }, type: 'shape', shape: 'star', width: 32, height: 32, sides: 5, innerRadius: 0.5, fill: { kind: 'solid', color: '#ffcc33' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } }; layer.objectIds.push(objectId);
    const operations = checkpointMergeOperations(target, source, [layer.id]); const merged = applyTransaction(target, { id: 'tx', clientOperationId: 'merge', documentId: target.id, actor: HUMAN_ACTOR, label: 'Merge checkpoint layer', createdAt: timestamp, operations }).document;
    if (merged.kind !== 'illustration') throw new Error('Expected illustration'); expect(merged.layerIds).toHaveLength(target.layerIds.length + 1); expect(Object.values(merged.objects).some((object) => object.name === 'Checkpoint star')).toBe(true); expect(checkpointMergeCandidates(source)[0]).toMatchObject({ id: layer.id, type: 'illustration-layer' });
  });

  it('duplicates a selected pixel asset with its dependency closure', () => {
    const source = createPixelDocument('project', 'Source'); const target = createPixelDocument('project', 'Target'); const sprite = source.pixelAssets[source.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); const tileset = createPixelTileset('Terrain', sprite.id, 16, 16, 2, 2); source.pixelAssets[tileset.id] = tileset; source.assetIds.push(tileset.id);
    const operations = checkpointMergeOperations(target, source, [tileset.id]); const merged = applyTransaction(target, { id: 'tx', clientOperationId: 'merge-pixel', documentId: target.id, actor: HUMAN_ACTOR, label: 'Merge checkpoint asset', createdAt: nowIso(), operations }).document;
    if (merged.kind !== 'pixel') throw new Error('Expected pixel'); const copies = Object.values(merged.pixelAssets); const copiedTileset = copies.find((asset) => asset.type === 'tileset'); expect(copiedTileset?.type).toBe('tileset'); if (copiedTileset?.type === 'tileset') expect(merged.pixelAssets[copiedTileset.spriteAssetId]?.type).toBe('sprite');
  });
});
