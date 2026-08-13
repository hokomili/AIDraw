import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('sprite viewport source wiring', () => {
  it('routes base, onion, and wrap frames through the bounded shared compositor', async () => {
    const source = await readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8');
    expect(source).toContain("import { drawPixelSpriteRegion, pixelSpriteRegionPlan } from '../../common/pixel-sprite-render'");
    expect(source).toContain('const baseRasterViewportRegion = sprite || tilemap ? coveringRasterViewportRegion');
    expect(source).toContain('const drawFrame = (targetFrame: string, alpha: number, tint?: string, source = baseRasterViewportRegion!)');
    expect(source).toContain("invalidChunk: 'skip'");
    expect(source).toContain('opacityMultiplier: alpha');
    expect(source).toContain('colorForIndex: (index) => tint ?? paletteColor(index)');
    expect(source).toContain('replayMasks.celPixels.get(cel.id)?.has(replayPointKey(x, y))');
    expect(source).toContain('const shiftedSource = { ...source, x: source.x - offsetX, y: source.y - offsetY }');
    expect(source).toContain('drawFrame(activeFrameId, 1, undefined, shiftedSource)');
    expect(source).not.toContain("recordValues<PixelCel['chunks'][string]>(cel.chunks)");
  });
});
