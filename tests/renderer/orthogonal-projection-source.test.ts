import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('orthogonal projection source parity', () => {
  it('shares authored-aspect extent and cell geometry across render surfaces', async () => {
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    expect(interactive).toContain("import { orthogonalCellRect, orthogonalObjectMatrix, orthogonalProjectionExtent } from '../../common/orthogonal-projection'");
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
      expect(source).toContain('resolved && sourceIsRenderable');
      expect(source).toContain('{ width: resolved.tileset.tileWidth, height: resolved.tileset.tileHeight }');
      expect(source).toContain('resolved.tileset.tileOffset');
    }
    expect(headless).toContain("const sourceIsRenderable = sourceAsset?.type === 'sprite'");
    expect(headless).toContain(': rect.x + rect.width > layerRegion.x && rect.y + rect.height > layerRegion.y');
    expect(interactive).toContain("const sourceIsRenderable = mapSourceAsset?.type === 'sprite'");
    expect(interactive).toContain(': canonicalRect.x + canonicalRect.width > layerViewportRegion.x');
    expect(interactive.indexOf('const mapSourceAsset =')).toBeLessThan(interactive.indexOf('const canonicalPlacement ='));
    const canonicalIntersectsIndex = interactive.indexOf('const canonicalIntersects = canonicalPlacement');
    expect(canonicalIntersectsIndex).toBeGreaterThan(-1);
    expect(canonicalIntersectsIndex).toBeLessThan(interactive.indexOf('const sourcePlan = mapSourceAsset', canonicalIntersectsIndex));
    expect(interactive).toContain('const placement = resolved && sourceIsRenderable ? orthogonalTileArtworkPlacement(');
    expect(interactive).toContain('decoded, resolved.tileset.tileOffset)');
    expect(interactive).toContain("const gridCellRect = (point: PixelPoint): IsometricCellRect => tilemap?.orientation === 'isometric'");
    expect(interactive).toContain('orthogonalCellRect(point.x, point.y, view.scale, orthogonalCellHeight)');
  });

  it('uses the rectangular cell for objects, pointers, parallax, and grid rows', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const coordinates = await readFile(new URL('../../src/renderer/canvas/pixel-coordinates.ts', import.meta.url), 'utf8');
    expect(source).toContain('clientPointToOrthogonalTile(event.clientX, event.clientY, bounds, size, layerView, view.scale * tilemap.tileHeight / tilemap.tileWidth)');
    expect(source).toContain('clientPointToTilemapObjectAnchor(event.clientX, event.clientY, bounds, size, view, {');
    expect(source).toContain('layerTranslation: translation');
    expect(coordinates).toContain("geometry.orientation === 'isometric'");
    expect(coordinates).toContain(': clientPointToOrthogonalCoordinate(clientX, clientY, bounds, logicalSize, layerView, cellHeight)');
    expect(source).toContain('orthogonalObjectMatrix(tilemap.tileWidth, tilemap.tileHeight, view.scale, orthogonalCellHeight)');
    expect(source).toContain("const rowHeight = tilemap?.orientation === 'orthogonal' ? orthogonalCellHeight : view.scale");
    expect(source.match(/tilemap\.orientation === 'orthogonal' \? view\.scale \/ tilemap\.tileWidth : view\.scale \/ Math\.max\(tilemap\.tileWidth, tilemap\.tileHeight\)/g)).toHaveLength(3);
  });
});
