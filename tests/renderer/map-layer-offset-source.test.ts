import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('MAP-09 layer offset production wiring', () => {
  it('authors bounded signed map-pixel offsets through the existing asset replacement path', async () => {
    const source = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('MAX_TILEMAP_LAYER_OFFSET');
    expect(source).toContain('aria-label="Layer drawing offset X"');
    expect(source).toContain('aria-label="Layer drawing offset Y"');
    expect(source).toContain('Group offsets add to their descendants.');
    expect(source).toContain('if (nextX === layer.offsetX && nextY === layer.offsetY)');
    expect(source).toContain('updateLayer(selectedLayer, { offsetX, offsetY }, "Change layer drawing offset")');
    expect(source).toContain('kind: "pixel.asset.replace"');
    expect(source).toContain('offsetX: 0');
    expect(source).toContain('offsetY: 0');
  });

  it('shares composed group offsets across interactive and headless rendering', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    for (const source of [interactive, headless]) expect(source).toContain('composedVisibleTilemapLayers');
    expect(interactive).toContain('tilemapLayerScreenTranslation');
    expect(interactive).toContain('context.translate(layerOffsetX, layerOffsetY)');
    expect(interactive).toContain('const layerViewportRegion = rasterViewportRegionForLayer(entry)');
    expect(interactive).toContain('offsetX: view.offsetX + translation.x');
    expect(interactive).toContain('offsetY: view.offsetY + translation.y');
    expect(interactive).toContain('activeTileLayerEntry?.layer');
    expect(headless).toContain('context.save(); context.translate(entry.offsetX, entry.offsetY)');
    expect(headless).toContain('x: region.x - entry.offsetX');
    expect(headless).toContain('mapObjectsIntersectingRasterRegion([object], matrix, layerRegion, { unitScale })');
  });

  it('keeps layer offsets distinct from tileset artwork offsets and parallax', async () => {
    const composition = await readFile(new URL('../../src/common/tilemap-layer-composition.ts', import.meta.url), 'utf8');
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(composition).toContain('offsetX: inherited.offsetX + layer.offsetX');
    expect(composition).toContain('parallaxX: inherited.parallaxX * layer.parallaxX');
    expect(composition).toContain('pan.x * (layer.parallaxX - 1) + layer.offsetX * projectionScale');
    expect(interactive).toContain('resolved.tileset.tileOffset');
  });
});
