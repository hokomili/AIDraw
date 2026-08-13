import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('map-object render source parity', () => {
  it('uses the same overlay renderer in interactive and headless map surfaces', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    expect(interactive).toContain("import { drawMapObjectOverlay } from '../../common/map-object-render'");
    expect(headless).toContain("import { drawMapObjectOverlay } from '../common/map-object-render'");
    expect(interactive).toContain('drawMapObjectOverlay(context, object, { selected, unitScale })');
    expect(headless).toContain('drawMapObjectOverlay(context, object, { unitScale })');
  });

  it('keeps headless object layers in the same flattened z-order as tile layers', async () => {
    const source = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    expect(source).toContain("if (layer.type === 'object')");
    expect(source).toContain('for (const entry of visibleLayers)');
    expect(source).toContain('context.globalAlpha = entry.opacity');
    expect(source).toContain('isometricObjectMatrix(map.height, map.tileWidth, map.tileHeight, map.tileWidth, map.tileHeight)');
  });
});
