import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const canvas = readFileSync(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
const headless = readFileSync(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../../src/renderer/store.ts', import.meta.url), 'utf8');

describe('tile-object production source wiring', () => {
  it('shares placement, culling, raw-GID resolution, animation sampling, and sprite fallback across renderers', () => {
    for (const source of [canvas, headless]) {
      expect(source).toContain('tileObjectArtworkPlacement');
      expect(source).toContain('tileObjectArtworkIntersects');
      expect(source).toContain('tileObjectFallbackColor');
      expect(source).toContain('resolveTilesetForGid');
      expect(source).toContain('tilesetTileSourceRect');
      expect(source).toContain('animatedLocalId');
    }
    expect(canvas).toContain('spriteRegionBitmap(sourceAsset, frameId, document.palette, sourceRect)');
    expect(headless).toContain('renderSpriteRegion(document, sourceAsset, sourceRect, frameId)');
  });

  it('uses the shared transformed artwork for selection hits and resize handles without point editing', () => {
    expect(canvas).toContain('tileObjectArtworkContainsPoint(placement, rasterPoint, 9)');
    expect(canvas).toContain('hit.tilePlacement.resizeHandle');
    expect(canvas).toContain("hit.object.type !== 'tile'");
    expect(canvas).toContain("Tile objects do not expose polygon-point editing.");
  });

  it('keeps tile identity fixed in the human inspector and replacement transaction path', () => {
    expect(app).toContain('Fixed tile object GID ${object.gid}');
    expect(app).toContain('entry.id === object.id && entry.type !== "tile"');
    expect(app).toContain('<TileMapObjectInspector');
    expect(app).toContain('Change tileset object alignment');
    expect(canvas).toContain("kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision");
    expect(canvas).toContain('objectIds: [tilemap.id]');
  });

  it('admits one exact selected-layer tile object through the shared planner and layer-aware pointer contract', () => {
    expect(app).toContain('{ id: "tile-object", label: "Tile object", icon: Layers3 }');
    expect(canvas).toContain("tool === 'tile-object'");
    expect(canvas).toContain('planTileObjectCreation(liveDocument');
    expect(canvas).toContain('layerId: liveEntry.layer.id');
    expect(canvas).toContain('tilesetId: tileObjectTilesetId');
    expect(canvas).toContain('tileId: tileObjectPlacementTileId');
    expect(canvas).toContain("tileObjectTileDraftValue.trim() ? Number(tileObjectTileDraftValue) : Number.NaN");
    expect(canvas).toContain('value.trim() && Number.isSafeInteger(parsed) && parsed >= 0');
    expect(canvas).toContain('transforms: activeTileTransforms');
    expect(canvas).toContain('clientPointToTilemapObjectAnchor');
    expect(canvas).toContain("apply('Place tile object', [{ kind: 'pixel.asset.replace'");
    expect(canvas).toContain("setSelectedEntity(plan.object.id); setRightPanel('layers'); setTool('select')");
    expect(canvas).not.toContain('Select one visible, unlocked object layer before placing a tile object. Choosing');
  });

  it('binds placement to the rendered tileset revision and the originally observed document across the lock wait', () => {
    const firstTilesetCheck = canvas.indexOf('requireTileObjectPlacementTileset(liveDocument, liveMap, tileObjectTilesetId, tileObjectTileset.revision)');
    const lock = canvas.indexOf('objectIds: [liveMap.id, liveTileset.id]');
    const documentRecheck = canvas.indexOf("lockedDocument.id !== liveDocument.id");
    const secondTilesetCheck = canvas.indexOf('requireTileObjectPlacementTileset(lockedDocument, lockedMap, liveTileset.id, liveTileset.revision)');
    const submit = canvas.indexOf("apply('Place tile object'");
    expect(firstTilesetCheck).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(firstTilesetCheck);
    expect(documentRecheck).toBeGreaterThan(lock);
    expect(secondTilesetCheck).toBeGreaterThan(documentRecheck);
    expect(submit).toBeGreaterThan(secondTilesetCheck);
    expect(canvas).toContain('applyToActiveDocument(label, operations, document.id)');
    expect(store).toContain('(expectedDocumentId && document.id !== expectedDocumentId)');
  });

  it('enforces writable tile-object ancestry on delete and canvas move/resize without changing vector-object paths', () => {
    expect(app).toContain('requireWritableTileObject(asset, selectedLayer.id, object.id)');
    expect(app).toContain('disabled={object.type === "tile" && Boolean(tileObjectLayerError)}');
    expect(canvas).toContain('requireWritableTileObject(tilemap, hit.layer.id, hit.object.id)');
    expect(canvas).toContain('requireWritableTileObject(liveMap, gesture.layerId, gesture.objectId)');
    expect(canvas).toContain("if (hit.object.type !== 'tile'");
    expect(canvas).toContain("if (gesture.original.type === 'tile')");
  });
});
