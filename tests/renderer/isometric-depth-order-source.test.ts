import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('tilemap traversal source wiring', () => {
  it('preserves sparse-cell order while bounding editor and headless payload decode', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    expect(interactive).toContain("import { isometricTileRenderCells } from '../../common/tile-render-order'");
    expect(interactive).toContain("import { coveringRasterViewportRegion, createGridRasterRegionFilter, tilemapChunksIntersectingRegion, tilemapGridLineRange } from '../../common/tilemap-region'");
    expect(interactive).toContain("tilemap.orientation === 'isometric'");
    expect(interactive).toContain('const candidateChunks = tilemapChunksIntersectingRegion(Object.values(layer.chunks)');
    expect(interactive).toContain("const isometricArtworkEnvelope = tilemap.orientation === 'isometric' ? isometricMapTileArtworkEnvelope(document, tilemap) : undefined;");
    expect(interactive).toContain('const layerViewportRegion = layerOffsetX === 0 && layerOffsetY === 0 ? baseRasterViewportRegion!');
    expect(interactive).toContain('layerOffsetX,');
    expect(interactive).toContain('layerOffsetY,');
    expect(interactive).toContain('projectionScale: view.scale / tilemap.tileWidth');
    expect(interactive).toContain('isometricTileRenderCells(candidateChunks, safeDecodeTilemapChunk)');
    expect(interactive).toContain('else for (const chunk of candidateChunks)');
    expect(interactive).toContain('tilemapGridLineRange(baseRasterViewportRegion');
    expect(interactive).toContain('for (let x = gridRange.columnStart; x <= gridRange.columnEnd; x += 1)');
    expect(interactive).toContain('for (let y = gridRange.rowStart; y <= gridRange.rowEnd; y += 1)');
    expect(interactive).toContain('const overlayRegionFilter = overlayGeometry && baseRasterViewportRegion');
    expect(interactive).toContain('const selectionRegionFilter = overlayGeometry && baseRasterViewportRegion');
    expect(interactive).toContain('overlayRegionFilter?.runOffsets(run.x, run.y, run.length)');
    expect(interactive).toContain('overlayRegionFilter.cellIntersects(change.x, change.y)');
    expect(interactive).toContain('selectionRegionFilter.cellIntersects(selected.x, selected.y)');
    expect(headless).toContain("import { isometricTileRenderCells } from '../common/tile-render-order'");
    expect(headless).toContain("import { tilemapChunksIntersectingRegion } from '../common/tilemap-region'");
    expect(headless).toContain('const candidateChunks = tilemapChunksIntersectingRegion(Object.values(layer.chunks)');
    expect(headless).toContain('const isometricArtworkEnvelope = isometric ? isometricMapTileArtworkEnvelope(document, map) : undefined;');
    expect(headless).toContain('isometricTileRenderCells(candidateChunks, (chunk) => decodeTilemapChunk(chunk))');
  });
});
