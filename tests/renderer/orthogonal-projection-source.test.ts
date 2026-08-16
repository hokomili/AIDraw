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

  it('selects sparse per-tile image sprites for rendering and exact finite-orthogonal Current tile authoring', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    const interactive = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    const headless = await readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    for (const source of [interactive, headless]) {
      expect(source).toContain('tilesetTileSourceAssetId(');
      expect(source).toContain('isImageCollectionTileset(');
    }
    expect(headless).toContain('sourceAsset.width'); expect(headless).toContain('sourceAsset.height');
    expect(interactive).toContain('mapSourceAsset.width'); expect(interactive).toContain('mapSourceAsset.height');
    expect(interactive).toContain('const atlasMapTilesets = attachedMapTilesets.filter((entry) => Boolean(entry.spriteAssetId))');
    expect(interactive).toContain("const finiteOrthogonalCollectionTilesets = attachedMapTilesets.filter((entry) => isImageCollectionTileset(entry) && tilemap?.orientation === 'orthogonal' && !tilemap.infinite)");
    expect(interactive).toContain('const authorableMapTileTilesets = [...atlasMapTilesets, ...finiteOrthogonalCollectionTilesets]');
    expect(interactive).toContain("currentMapTileChoice?.documentId === document.id");
    expect(interactive).toContain("tool === 'terrain'\n      ? atlasMapTilesets[0]\n      : currentMapTileTileset");
    expect(interactive).toContain('<CurrentMapTileControl');
    expect(interactive).toContain('planMapTileAuthoringSelection(document, request)');
    expect(interactive).toContain('mapTileAuthoringPlansMatch(observed, current)');
    expect(interactive).toContain('selectCurrentMapTileset({ documentId: document.id, mapId: tilemap.id }, next, selectedTileId)');
    expect(interactive).toContain('selectScopedMapTileId({ documentId: document.id, mapId: tilemap.id, tilesetId: currentMapTileTileset.id }, currentMapTileTileset, value)');
    expect(interactive).toContain('selectScopedMapTileId({ documentId: document.id, mapId: tilemap.id, tilesetId: tileObjectTileset.id }, tileObjectTileset, event.target.value)');
    expect(interactive).toContain("applyGuarded('Place Current tile stamp', operations, pendingMapTilePlan.expectedDocumentRevision)");
    expect(interactive).toContain('await applyGuarded(label, operations, pendingMapTilePlan.expectedDocumentRevision)');
    expect(interactive).toContain("const activeTileStamp = activeTileStampId === 'builtin-tile'");
    expect(interactive).toContain('onChange={(event) => setActiveTileStampId(event.target.value)}');
    expect(interactive).toContain('tilesetTileSourceAssetId(resolved.tileset, visibleLocalId)');
    expect(headless).toContain('tilesetTileSourceAssetId(resolved.tileset, renderedLocalId)');
    expect(app).toContain('nextTilesetFirstGid(assets.filter((asset): asset is PixelTileset => asset.type === "tileset"))');
    expect(app).toContain('imageCollectionTilemapModeError(document, next)');
    expect(interactive).toContain('const tilemapModeError = tilemap ? imageCollectionTilemapModeError(document, tilemap) : undefined');
    expect(interactive).toContain('else if (tilemap && !tilemapModeError)');
    expect(interactive).toContain('<strong>Unsupported image-collection map mode</strong>');
    expect(interactive).toContain('<strong>Image collection tileset</strong>');
    expect(interactive).toContain('sparse PNG tile(s) · {asset.columns} display column(s). Per-tile artwork is read-only here; use this tileset from a finite orthogonal map.');
    expect(interactive.indexOf("asset.type === 'tileset' && isImageCollectionTileset(asset)")).toBeLessThan(interactive.indexOf("asset.type === 'tileset' && !sprite"));
    expect(headless).toContain('assertImageCollectionTilemapMode(document, map);');
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
