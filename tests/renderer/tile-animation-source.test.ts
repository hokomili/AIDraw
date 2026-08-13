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
    expect(source).toContain('tilesetTileSourceRect');
    expect(source).toContain('<canvas');
    expect(source).toContain('frame.durationMs');
    expect(source).toContain('Pause animation preview');
    expect(source).toContain('Play animation preview');
    expect(source).toContain('prefers-reduced-motion: reduce');
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
