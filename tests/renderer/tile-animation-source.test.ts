import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('tile animation editor wiring', () => {
  it('provides drag and keyboard ordering through the shared immutable kernel', async () => {
    const source = await readFile(new URL('../../src/renderer/components/TileAnimationEditor.tsx', import.meta.url), 'utf8');
    expect(source).toContain('moveTileAnimationFrame');
    expect(source).toContain('draggable');
    expect(source).toContain('onDrop=');
    expect(source).toContain('Move animation frame up');
    expect(source).toContain('Move animation frame down');
    expect(source).toContain("'Reorder animated tile frames'");
  });

  it('renders a duration-aware, pausable tileset preview with reduced-motion protection', async () => {
    const source = await readFile(new URL('../../src/renderer/components/TileAnimationEditor.tsx', import.meta.url), 'utf8');
    expect(source).toContain('drawSpriteRegionThumbnail');
    expect(source).toContain('resolveTilesetTileSource');
    expect(source).toContain('<canvas');
    expect(source).toContain('frame.durationMs');
    expect(source).toContain('Pause animation preview');
    expect(source).toContain('Play animation preview');
    expect(source).toContain('prefers-reduced-motion: reduce');
  });

  it('uses an exact sparse-ID chooser for image-collection animation frames', async () => {
    const source = await readFile(new URL('../../src/renderer/components/TileAnimationEditor.tsx', import.meta.url), 'utf8');
    expect(source).toContain('availableTileIds ? <select');
    expect(source).toContain('Existing collection tile ID');
    expect(source).toContain('availableTileIds.map((tileId)');
  });

  it('samples placed animations through one clock and one shared source-rectangle contract', async () => {
    const [renderer, headless] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of [renderer, headless]) {
      expect(source).toContain('tileAnimationFrameAt');
      expect(source).toContain('tilesetTileSourceRect');
      expect(source).toContain('animatedLocalId');
    }
    expect(renderer).toContain('artworkPlacement.transform.a');
    expect(headless).toContain('placement.transform.a');
    expect(renderer).toContain('tileAnimationTimeMs');
    expect(renderer).toContain('MIN_TILE_ANIMATION_TICK_MS');
    expect(renderer).toContain("matchMedia?.('(prefers-reduced-motion: reduce)')");
    expect(headless).toContain('tileAnimationTimeMs = 0');
  });

  it('renders a bounded weighted-variant strip that navigates exact tile IDs', async () => {
    const source = await readFile(new URL('../../src/renderer/components/TileVariantPreview.tsx', import.meta.url), 'utf8');
    expect(source).toContain('MAX_VISIBLE_VARIANTS = 12');
    expect(source).toContain('MAX_VARIANT_THUMBNAIL_SIDE = 32');
    expect(source).toContain('drawSpriteRegionThumbnail');
    expect(source).toContain('weight ${tile.probability}');
    expect(source).toContain('onSelect(tile.id)');
  });
});
