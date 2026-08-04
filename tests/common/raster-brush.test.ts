import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { BUILT_IN_RASTER_BRUSH_PRESETS, HUMAN_ACTOR, rasterBrushDynamics, type RasterStroke } from '@aidraw/core';
import { renderRasterStroke } from '../../src/common/raster-brush';

function stroke(presetId: 'hard-round' | 'watercolor', mode: RasterStroke['mode'] = 'paint'): RasterStroke {
  const preset = BUILT_IN_RASTER_BRUSH_PRESETS[presetId];
  return {
    id: `${presetId}-${mode}`, actorId: HUMAN_ACTOR.id, points: [{ x: 12, y: 24, pressure: 0.5 }, { x: 52, y: 24, pressure: 0.75 }],
    color: '#3c6fb5', size: presetId === 'watercolor' ? 20 : 12, opacity: preset.opacity, hardness: preset.hardness, flow: preset.flow,
    mode, preset: presetId, brushPresetId: preset.id, dynamics: rasterBrushDynamics(preset, 91),
  };
}

function render(source: RasterStroke): Uint8ClampedArray {
  const canvas = createCanvas(64, 48); const context = canvas.getContext('2d'); renderRasterStroke(context, source);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

describe('shared raster brush renderer', () => {
  it('renders deterministic watercolor accumulation with varied translucent coverage', () => {
    const first = render(stroke('watercolor')); const second = render(stroke('watercolor'));
    expect(first).toEqual(second);
    const alphas = new Set(Array.from(first.filter((_, index) => index % 4 === 3)).filter((alpha) => alpha > 0));
    expect(alphas.size).toBeGreaterThan(8);
    expect(first[(24 * 64 + 32) * 4 + 3]).toBeGreaterThan(0);
  });

  it('uses the same dab engine for destructive erasing', () => {
    const canvas = createCanvas(64, 48); const context = canvas.getContext('2d');
    renderRasterStroke(context, stroke('hard-round'));
    const painted = context.getImageData(32, 24, 1, 1).data[3];
    renderRasterStroke(context, stroke('hard-round', 'erase'));
    const erased = context.getImageData(32, 24, 1, 1).data[3];
    expect(painted).toBeGreaterThan(0);
    expect(erased).toBeLessThan(painted);
  });
});
