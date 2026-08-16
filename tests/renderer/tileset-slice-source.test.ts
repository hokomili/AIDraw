import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('tileset slice editor source wiring', () => {
  it('previews controlled slice drafts and requires explicit metadata remap application', async () => {
    const source = await readFile(new URL('../../src/renderer/components/TilesetSliceEditor.tsx', import.meta.url), 'utf8');
    expect(source).toContain("planTilesetReslice(tileset");
    expect(source).toContain('<TilesetSliceReview');
    expect(source).toContain('Follow source positions');
    expect(source).toContain('Keep tile IDs');
    expect(source).toContain('onRemapChange={(nextRemap) => { setRemap(nextRemap); setAcknowledged(false); }}');
    expect(source).toContain('I reviewed how this re-slice moves or drops metadata.');
    expect(source).toContain('onReset={() => { setDraft(draftFor(tileset)); setAcknowledged(false); }}');
    expect(source).toContain('Apply re-slice');
    expect(source).toContain('onApply={apply}');
    expect(source).toContain('plan.impact.reframedMetadataTiles > 0 || plan.impact.remappedMetadataTileIds > 0 || totalLoss(plan.impact) > 0');
    expect(source).toContain('if (!plan || !layoutChanged || (requiresAcknowledgement && !acknowledged)) return;');
    expect(source).toContain('onCommit(plan.tileset, nextSelected, plan.impact);');
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
    expect(styles).toContain('/* Source-sheet re-slicing keeps every review decision legible before the existing explicit commit. */');
  });

  it('authors bounded signed tileset drawing offsets and settles semantically equal no-op drafts', async () => {
    const app = await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('Tileset drawing offset ${axis.toUpperCase()}');
    expect(app).toContain('right" : "down"} positive');
    expect(app).toContain('drawingOffsetDraft?.tilesetId === tileset.id && drawingOffsetDraft.revision === tileset.revision');
    expect(app).toContain('const parsedDrawingOffset = { x: Number(currentDrawingOffsetDraft.x), y: Number(currentDrawingOffsetDraft.y) };');
    expect(app).toContain('Math.abs(value) <= MAX_TILESET_DRAWING_OFFSET');
    for (const equivalentZero of ['0.0', '00', '-0']) expect(Number(equivalentZero) === 0).toBe(true);
    expect(app).toContain('const drawingOffsetDraftMatchesTileset = drawingOffsetDraftIsValid');
    expect(app).toContain('disabled={drawingOffsetDraftMatchesTileset}');
    expect(app).toMatch(/if \(drawingOffsetDraftMatchesTileset\) \{\s*setDrawingOffsetDraft\(undefined\);\s*return;/u);
    expect(app).toContain('replace({ ...tileset, tileOffset: { x, y } }, "Change tileset drawing offset")');
    expect(app).toContain('Apply drawing offset');
    expect(app).toContain('Moves this tileset’s tile-layer sprite artwork without moving map cells, grid geometry, or collision data.');
  });
});
