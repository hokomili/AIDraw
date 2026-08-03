import { describe, expect, it } from 'vitest';
import { createIllustrationDocument, createPixelDocument, migrateDocument, readPixel } from '@aidraw/core';

describe('document migrations', () => {
  it('upgrades an unversioned greenfield document and rejects future schemas', () => {
    const legacy = createIllustrationDocument('Legacy') as unknown as Record<string, unknown>; delete legacy.schemaVersion; delete legacy.provenance;
    const migrated = migrateDocument(legacy); expect(migrated.schemaVersion).toBe(1); expect(migrated.provenance).toEqual([]);
    expect(() => migrateDocument({ ...legacy, schemaVersion: 99 })).toThrow(/newer/);
  });

  it('repairs incomplete agent-authored sprite frames and cels during recovery', () => {
    const source = createPixelDocument('sprite', 'Malformed recovery');
    const asset = source.pixelAssets[source.activeAssetId];
    if (asset.type !== 'sprite') throw new Error('Expected sprite');
    const frameId = 'frame-agent-minimal';
    const celId = 'cel-agent-minimal';
    asset.frameIds.push(frameId);
    (asset.frames as Record<string, unknown>)[frameId] = { id: frameId, name: 'Frame 2', durationMs: 140 };
    (asset.cels as Record<string, unknown>)[celId] = { id: celId, frameId, layerId: asset.layerIds[0] };
    (asset.cels as Record<string, unknown>)['not-a-cel'] = { id: 'not-a-cel', name: 'Misplaced tag' };

    const migrated = migrateDocument(source);
    if (migrated.kind !== 'pixel') throw new Error('Expected pixel document');
    const repaired = migrated.pixelAssets[migrated.activeAssetId];
    if (repaired.type !== 'sprite') throw new Error('Expected sprite');
    expect(repaired.frames[frameId]).toMatchObject({ revision: 0, name: 'Frame 2', durationMs: 140 });
    expect(repaired.cels[celId]).toMatchObject({ revision: 0, frameId, layerId: asset.layerIds[0], chunks: {} });
    expect(repaired.cels['not-a-cel']).toBeUndefined();
    expect(readPixel(repaired.cels[celId], 0, 0)).toBe(0);
  });
});
