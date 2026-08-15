import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('pixel tool renderer wiring', () => {
  it('uses shared bounded kernels and compact region commits', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('floodPixelRegion');
    expect(source).toContain('replacePixelRegion');
    expect(source).toContain('pixelPerfectStrokePoints');
    expect(source).toContain("kind: 'pixel.cel.region'");
    expect(source).toContain('bulkPreview');
    expect(source).not.toContain('function floodFill(');
    expect(source).not.toContain('function floodSelect(');
    expect(source).not.toContain('function pixelPerfect(');
  });

  it('cancels captured gestures on pointer cancellation or Escape without committing them', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onPointerCancel={() => void cancelGesture()}');
    expect(source).not.toContain('onPointerCancel={() => void finish()}');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("else if (tool === 'fill' || tool === 'replace') { setCursor(point); return; }");
    expect(source).toContain('cancelPixelGesture(() =>');
    expect(source).toContain('gestureEpochRef.current += 1');
    expect(source).toContain('gestureEpoch !== gestureEpochRef.current');
  });

  it('exposes both exact quarter-turn directions for selections and reusable pixel or tile stamps', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain("transformSelection('rotate-clockwise')");
    expect(source).toContain("transformSelection('rotate-counterclockwise')");
    expect(source).toContain("transformActiveStamp('rotate-clockwise')");
    expect(source).toContain("transformActiveStamp('rotate-counterclockwise')");
    expect(source).toContain('RotateCcw');
  });

  it('persists a deterministic new seed between weighted-variant strokes without rewriting painted cells', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('nextTileVariantSeed(variantSeed)');
    expect(source).toContain('Start new tile-variant stroke seed');
    expect(source).toContain('existing painted tiles do not change');
    expect(source).toContain("kind: 'pixel.asset.replace', asset: map, expectedRevision: tilemap.revision");
  });

  it('turns repeated sprite copies into exact wrapped edits through the ordinary cel transaction', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('wrapPixelPoint');
    expect(source).toContain('wrapPixelPoints(preview, sprite.width, sprite.height)');
    expect(source).toContain('wrapPixelPoints(stampPreview, sprite.width, sprite.height)');
    expect(source).toContain("tool !== 'select' && tool !== 'lasso'");
    expect(source).toContain('placePixelStamp(placementStamp, entry.x, entry.y, wrapEditing ? undefined');
    expect(source).toContain('const spritePoint = sprite && wrapEditing ? wrapPixelPoint(point, sprite.width, sprite.height) : point');
    expect(source).toContain('pixelAt(sprite, activeFrameId, spritePoint.x, spritePoint.y)');
    expect(source).toContain('start: spritePoint, read: compositePixelReader(sprite, activeFrameId)');
    expect(source).toContain('wrapPixelPoints(authoredPoints, sprite.width, sprite.height)');
    expect(source).toContain('wrap={wrapEditing}');
    expect(source).toContain('orderedDitherIndex(sample.x, sample.y');
    expect(source).toContain('Preview and edit through repeated copies across opposite sprite edges');
    expect(source).toContain('aria-pressed={wrapEditing}');
    expect(source).toContain("kind: 'pixel.cel.set'");
    expect(source).toContain("region: { kind: bounds.kind, assetId: sprite.id, x: 0, y: 0, width: bounds.width, height: bounds.height }");
  });

  it('maps a bounded indexed sprite selection into the document bitmap-font transaction', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain('captureBitmapGlyph(selection, compositePixelReader(sprite, activeFrameId))');
    expect(source).toContain('Map selected nonzero indexed cells to a reusable bitmap-font character');
    expect(source).toContain('<CaseUpper size={EDITOR_DENSITY.secondaryIcon} /> Glyph');
    expect(source).toContain('<BitmapGlyphMapperDialog');
    expect(source).toContain('upsertBitmapFontGlyph(font, character, { ...capture.glyph, advance }, lineHeight)');
    expect(source).toContain("apply('Map bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace'");
    expect(source).toContain('Use the Text tool to paint it as editable indexed pixels.');
    expect(source).not.toContain("kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: capture");
  });
});
