import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('tileset slice editor source wiring', () => {
  it('previews controlled slice drafts and requires explicit metadata remap application', async () => {
    const source = await readFile(new URL('../../src/renderer/components/TilesetSliceEditor.tsx', import.meta.url), 'utf8');
    expect(source).toContain("planTilesetReslice(tileset");
    expect(source).toContain('Follow source positions');
    expect(source).toContain('Keep tile IDs');
    expect(source).toContain('I reviewed how this re-slice moves or drops metadata.');
    expect(source).toContain('Apply re-slice');
    expect(source).toContain('drawSpriteThumbnail');
    expect(source).not.toContain('onBlur=');
  });

  it('binds one revision-checked asset replacement and source-sheet overlay into the tileset panel', async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(app).toContain('palette={document.palette} tileset={tileset}');
    expect(app).toContain('replace(next, "Re-slice tileset")');
    expect(app).not.toContain('removed by the new slice');
    expect(styles).toContain('.tileset-sheet-preview');
    expect(styles).toContain('.draft-slice-cell');
    expect(styles).toContain('.tileset-reslice-ack');
  });
});
