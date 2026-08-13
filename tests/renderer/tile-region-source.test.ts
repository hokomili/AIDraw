import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('bounded placed-tile source wiring', () => {
  it('uses the shared crop planner and a byte-and-entry-bounded disposable cache in both map renderers', async () => {
    const [interactive, headless] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of [interactive, headless]) {
      expect(source).toContain('BoundedResourceCache');
      expect(source).toContain('pixelSpriteRegionPlan');
      expect(source).toContain('MAX_MAP_TILE_SOURCE_CACHE_BYTES = 64 * 1024 * 1024');
      expect(source).toContain('MAX_MAP_TILE_SOURCE_CACHE_ENTRIES = 1_024');
      expect(source).toContain('sourceRect.width},${sourceRect.height}');
      expect(source).toContain('.clear()');
    }
    expect(interactive).toContain('spriteRegionBitmap');
    expect(interactive).not.toContain('spriteBitmap');
    expect(headless).toContain('renderSpriteRegion(document, sourceAsset, sourceRect, frameId)');
    const mapRenderer = headless.slice(headless.indexOf('export function renderTilemap'), headless.indexOf('export function renderPixelAsset'));
    expect(mapRenderer).not.toContain('renderSprite(document, sourceAsset)');
  });
});
