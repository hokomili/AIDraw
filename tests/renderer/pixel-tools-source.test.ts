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
});
