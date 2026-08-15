import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('orthogonal projection source parity', () => {
  it('shares authored-aspect extent and cell geometry across render surfaces', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    expect(interactive).toContain("import { orthogonalCellRect, orthogonalCoordinateDeltaFromScreen, orthogonalObjectMatrix, orthogonalProjectionExtent } from '../../common/orthogonal-projection'");
    expect(headless).toContain("import { orthogonalCellRect, orthogonalObjectMatrix, orthogonalProjectionExtent } from '../common/orthogonal-projection'");
    expect(interactive).toContain("import { orthogonalMapTileArtworkEnvelope, orthogonalTileArtworkIntersects, orthogonalTileArtworkPlacement, type OrthogonalTileArtworkPlacement } from '../../common/orthogonal-tile-artwork'");
    expect(headless).toContain("import { orthogonalMapTileArtworkEnvelope, orthogonalTileArtworkIntersects, orthogonalTileArtworkPlacement } from '../common/orthogonal-tile-artwork'");
    expect(interactive).toContain('orthogonalProjectionExtent(tilemap.width, tilemap.height, 1, tilemap.tileHeight / tilemap.tileWidth)');
    expect(interactive).toContain('orthogonalCellRect(point.x, point.y, view.scale, orthogonalCellHeight)');
    expect(headless).toContain('orthogonalProjectionExtent(map.width, map.height, map.tileWidth, map.tileHeight)');
    expect(headless).toContain('orthogonalCellRect(tileX, tileY, map.tileWidth, map.tileHeight)');
  });

  it('shares native artwork placement and matches fallback admission to the visual source', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    for (const source of [interactive, headless]) {
      expect(source).toContain('orthogonalMapTileArtworkEnvelope(document,');
      expect(source).toContain('orthogonalArtworkEnvelope,');
      expect(source).toContain('orthogonalTileArtworkPlacement(');
      expect(source).toContain('orthogonalTileArtworkIntersects(');
      expect(source).toContain('sourceIsRenderable ? decoded : {}');
    }
    expect(headless).toContain("const sourceIsRenderable = sourceAsset?.type === 'sprite'");
    expect(headless).toContain('sourceIsRenderable ? { width: resolved.tileset.tileWidth, height: resolved.tileset.tileHeight } : { width: map.tileWidth, height: map.tileHeight }');
    expect(interactive).toContain("const sourceIsRenderable = mapSourceAsset?.type === 'sprite'");
    expect(interactive).toContain('sourceIsRenderable ? { width: resolved.tileset.tileWidth, height: resolved.tileset.tileHeight } : { width: tilemap.tileWidth, height: tilemap.tileHeight }');
    expect(interactive.indexOf('const mapSourceAsset =')).toBeLessThan(interactive.indexOf('const canonicalPlacement ='));
    expect(interactive.indexOf('if (canonicalPlacement && !orthogonalTileArtworkIntersects')).toBeLessThan(interactive.indexOf('const sourcePlan ='));
    expect(interactive).toContain('const placement = resolved && sourceIsRenderable ? orthogonalTileArtworkPlacement(');
    expect(interactive).toContain("const gridCellRect = (point: PixelPoint): IsometricCellRect => tilemap?.orientation === 'isometric'");
    expect(interactive).toContain('orthogonalCellRect(point.x, point.y, view.scale, orthogonalCellHeight)');
  });

  it('uses the rectangular cell for objects, pointers, parallax, and grid rows', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('clientPointToOrthogonalTile(event.clientX, event.clientY, bounds, size, view, view.scale * tilemap.tileHeight / tilemap.tileWidth)');
    expect(source).toContain('clientPointToOrthogonalCoordinate(event.clientX, event.clientY, bounds, size, view, view.scale * tilemap.tileHeight / tilemap.tileWidth)');
    expect(source).toContain('orthogonalCoordinateDeltaFromScreen(pan.x * (layer.parallaxX - 1), pan.y * (layer.parallaxY - 1), view.scale, view.scale * tilemap.tileHeight / tilemap.tileWidth)');
    expect(source).toContain('orthogonalObjectMatrix(tilemap.tileWidth, tilemap.tileHeight, view.scale, orthogonalCellHeight)');
    expect(source).toContain("const rowHeight = tilemap?.orientation === 'orthogonal' ? orthogonalCellHeight : view.scale");
    expect(source.match(/tilemap\.orientation === 'orthogonal' \? view\.scale \/ tilemap\.tileWidth : view\.scale \/ Math\.max\(tilemap\.tileWidth, tilemap\.tileHeight\)/g)).toHaveLength(3);
  });
});
