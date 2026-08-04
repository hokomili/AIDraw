import { describe, expect, it } from 'vitest';
import { createIllustrationDocument, createPixelDocument } from '@aidraw/core';
import { rebaseRestoredEntityRevisions } from '../../src/common/document-branch';

describe('document branch revision rebasing', () => {
  it('advances restored illustration entities beyond both branches', () => {
    const current = createIllustrationDocument(); const restored = structuredClone(current);
    const layerId = current.layerIds[0]; current.layers[layerId].revision = 8; restored.layers[layerId].revision = 2;
    rebaseRestoredEntityRevisions(current, restored, '2026-08-04T00:00:00.000Z');
    expect(restored.layers[layerId]).toMatchObject({ revision: 9, updatedAt: '2026-08-04T00:00:00.000Z' });
  });

  it('rebases nested pixel assets, layers, frames, and cels', () => {
    const current = createPixelDocument('sprite'); const restored = structuredClone(current); const asset = current.pixelAssets[current.activeAssetId]; const nextAsset = restored.pixelAssets[restored.activeAssetId];
    if (asset.type !== 'sprite' || nextAsset.type !== 'sprite') throw new Error('Expected sprite');
    asset.revision = 4; current.pixelAssets[asset.id] = asset; const layerId = asset.layerIds[0]; asset.layers[layerId].revision = 5; const frameId = asset.frameIds[0]; asset.frames[frameId].revision = 6; const cel = Object.values(asset.cels)[0]; cel.revision = 7;
    rebaseRestoredEntityRevisions(current, restored, '2026-08-04T00:00:00.000Z');
    expect(nextAsset.revision).toBe(5); expect(nextAsset.layers[layerId].revision).toBe(6); expect(nextAsset.frames[frameId].revision).toBe(7); expect(nextAsset.cels[cel.id].revision).toBe(8);
  });
});
