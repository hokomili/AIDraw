import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('isometric depth-order source wiring', () => {
  it('uses the same sparse-cell order in interactive and headless renderers', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    expect(interactive).toContain("import { isometricTileRenderCells } from '../../common/tile-render-order'");
    expect(interactive).toContain("tilemap.orientation === 'isometric'");
    expect(interactive).toContain('isometricTileRenderCells(Object.values(layer.chunks), safeDecodeTilemapChunk)');
    expect(headless).toContain("import { isometricTileRenderCells } from '../common/tile-render-order'");
    expect(headless).toContain("import { tilemapChunksIntersectingRegion } from '../common/tilemap-region'");
    expect(headless).toContain('const candidateChunks = tilemapChunksIntersectingRegion(Object.values(layer.chunks)');
    expect(headless).toContain('isometricTileRenderCells(candidateChunks, (chunk) => decodeTilemapChunk(chunk))');
  });
});
