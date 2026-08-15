import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const canvas = readFileSync(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
const headless = readFileSync(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');

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

  it('keeps imported tile objects distinct in the existing object inspector and replacement transaction path', () => {
    expect(app).toContain('object.type === "tile" ? <span title={`Tile object GID ${object.gid}`}>Tile</span>');
    expect(app).toContain('entry.id === object.id && entry.type !== "tile"');
    expect(canvas).toContain("kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision");
    expect(canvas).toContain('objectIds: [tilemap.id]');
  });
});
