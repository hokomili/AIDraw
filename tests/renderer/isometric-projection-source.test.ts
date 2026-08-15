import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('isometric projection source parity', () => {
  it('uses the shared extent and cell rectangle in both render surfaces', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    for (const source of [interactive, headless]) {
      expect(source).toContain('isometricProjectionExtent');
      expect(source).toContain('isometricCellRect');
    }
    expect(interactive).toContain('isometricObjectMatrix');
    expect(interactive).toContain('fillGridCell(point)');
    expect(interactive).toContain('strokeGridCell(point)');
  });

  it('routes pointer and parallax inversion through the shared projection kernel', async () => {
    const canvas = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const coordinates = await readFile(new URL('../../src/renderer/canvas/pixel-coordinates.ts', import.meta.url), 'utf8');
    expect(coordinates).toContain('isometricCoordinateFromScreen(screenX, screenY, mapHeight, view.scale, cellHeight)');
    expect(canvas).toContain('clientPointToIsometricTile(event.clientX, event.clientY, bounds, size, layerView, tilemap.height');
    expect(canvas).toContain('isometricCoordinateDeltaFromScreen(translation.x, translation.y');
  });

  it('shares native sprite placement and exact overhang admission without changing nominal fallback geometry', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    for (const source of [interactive, headless]) {
      expect(source).toContain('isometricMapTileArtworkEnvelope');
      expect(source).toContain('isometricTileArtworkPlacement');
      expect(source).toContain('isometricTileArtworkIntersects');
      expect(source).toContain('sourceIsRenderable');
      expect(source).toContain('resolved.tileset.tileOffset');
      expect(source).toContain('isometricArtworkEnvelope,');
    }
    expect(interactive).toContain('traceIsometricCell(context, rect); context.fill();');
    expect(headless).toContain('context.fillRect(rect.x, rect.y, rect.width, rect.height);');
  });
});
