import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { createPixelDocument, type PixelCel, type PixelFrame, type PixelLayer, type PixelSprite } from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import { CelExposureGrid } from '../../src/renderer/components/CelExposureGrid';
import { flattenLayerTree } from '../../src/common/layer-tree';

function exposureFixture(layerCount: number, frameCount: number): PixelSprite {
  const document = createPixelDocument('sprite');
  const sprite = document.pixelAssets[document.activeAssetId];
  if (sprite.type !== 'sprite') throw new Error('Expected sprite');
  const firstLayer = Object.values(sprite.layers).find((layer) => layer.type === 'pixel'); const firstFrameId = sprite.frameIds[0];
  if (!firstLayer) throw new Error('Expected pixel layer');
  const firstLayerId = firstLayer.id; const firstFrame = sprite.frames[firstFrameId]; const firstCel = Object.values(sprite.cels).find((cel) => cel.layerId === firstLayerId)!;
  for (let layerIndex = 1; layerIndex < layerCount; layerIndex += 1) {
    const id = `exposure-layer-${layerIndex + 1}`; sprite.layers[id] = { ...structuredClone(firstLayer), id, name: `Layer ${layerIndex + 1}`, parentId: undefined } satisfies PixelLayer; sprite.layerIds.push(id);
    const celId = `cel-${id}-${firstFrameId}`; sprite.cels[celId] = { ...structuredClone(firstCel), id: celId, name: `${id} · ${firstFrameId}`, layerId: id } satisfies PixelCel;
  }
  for (let frameIndex = 1; frameIndex < frameCount; frameIndex += 1) {
    const id = `exposure-frame-${frameIndex + 1}`; sprite.frames[id] = { ...structuredClone(firstFrame), id, name: `Frame ${frameIndex + 1}` } satisfies PixelFrame; sprite.frameIds.push(id);
    for (const layerId of sprite.layerIds) {
      const celId = `cel-${layerId}-${id}`; sprite.cels[celId] = { ...structuredClone(firstCel), id: celId, name: `${layerId} · ${id}`, layerId, frameId: id, chunks: {} } satisfies PixelCel;
    }
  }
  return sprite;
}

function renderGrid(sprite: PixelSprite, activeFrameId: string, activeLayerId: string): string {
  return renderToStaticMarkup(createElement(CelExposureGrid, { sprite, activeFrameId, activeLayerId, onSelect: () => undefined, onToggleLink: () => undefined, onClose: () => undefined }));
}

describe('cel exposure grid', () => {
  it('bounds the initial grid page to twelve frames by six pixel layers', () => {
    const sprite = exposureFixture(8, 14);
    expect(Object.values(sprite.layers).filter((layer) => layer.type === 'pixel')).toHaveLength(8);
    expect(sprite.layerIds).toHaveLength(8);
    const orderedLayers = flattenLayerTree(sprite.layers, sprite.layerIds).filter(({ entry }) => entry.type === 'pixel').map(({ entry }) => entry.id);
    expect(orderedLayers).toHaveLength(8);
    const first = renderGrid(sprite, sprite.frameIds[0], orderedLayers[0]);
    expect(first.match(/role="gridcell"/g)).toHaveLength(72);
    expect(first).toContain('aria-label="Select frame 12"');
    expect(first).not.toContain('aria-label="Select frame 13"');
    expect(first).toContain('Layers 1–6');
    const last = renderGrid(sprite, sprite.frameIds[13], orderedLayers[7]);
    expect(last.match(/role="gridcell"/g)).toHaveLength(4);
    expect(last).toContain('aria-label="Select frame 13"');
    expect(last).toContain('aria-label="Select frame 14"');
    expect(last).toContain('Layers 7–8');
  });

  it('wires the grid to the selected editable layer and one revision-checked exposure replacement', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('editableSpriteLayer(sprite, selectedEntityId)');
    expect(source).not.toContain('editableSpriteLayer(sprite)?.id');
    expect(source).toContain('setPixelCelLinked(sprite, layerId, targetFrameId, !linked)');
    expect(source).toContain('<CelExposureGrid');
    expect(source).toContain('setSelectedEntity(layerId)');
    expect(source).toContain("kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision");
    expect(source).toContain('Open layer-by-frame cel exposure grid');
  });
});
