import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SpriteSymmetrySettingsPanel } from '../../src/renderer/components/SpriteSymmetrySettingsPanel';

describe('sprite symmetry settings', () => {
  it('renders deliberate modes, bounded half-pixel axes, binding truth, and accessible controls', () => {
    const markup = renderToStaticMarkup(createElement(SpriteSymmetrySettingsPanel, {
      mode: 'both', horizontalAxis: 3.5, verticalAxis: 2, width: 8, height: 6, source: 'saved',
      onModeChange: () => undefined, onAxesChange: () => undefined, onClose: () => undefined,
    }));
    expect(markup).toContain('aria-label="Sprite symmetry settings"');
    expect(markup).toContain('aria-label="Sprite symmetry mode"');
    expect(markup).toContain('aria-label="Horizontal symmetry axis X"');
    expect(markup).toContain('aria-label="Vertical symmetry axis Y"');
    expect(markup).toContain('step="0.5"');
    expect(markup).toContain('None'); expect(markup).toContain('Horizontal'); expect(markup).toContain('Vertical'); expect(markup).toContain('Both');
    expect(markup).toContain('Custom axes for this 8 × 6 sprite.');
    expect(markup).toContain('Axes use pixel-center coordinates and do not change artwork; a warning reports any save failure.');
  });

  it('wires one effective contract through freehand, shapes, stamps, text, wrap, guides, and bootstrap-owned state', async () => {
    const [canvas, store, app, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/store.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(canvas).toContain('effectiveSpriteSymmetry(symmetryPreferences');
    expect(canvas).toContain('expandSpriteSymmetry(points, symmetry)');
    expect(canvas).toContain('withSymmetry(frameChanges(tool, from, point))');
    expect(canvas).toContain('withSymmetry(line.flatMap((entry) => placePixelStamp');
    expect(canvas).toContain('withSymmetry(bitmapTextCells(font, request.text');
    expect(canvas).toContain('(symmetry.horizontalAxis + 0.5) * view.scale');
    expect(canvas).toContain('(symmetry.verticalAxis + 0.5) * view.scale');
    expect(canvas).toContain('wrapPixelPoints(preview, sprite.width, sprite.height)');
    expect(store).toContain('symmetryPreferences: structuredClone(snapshot.symmetryPreferences)');
    expect(store).toContain('setSpriteSymmetryPreferences: (value) =>');
    expect(app).toContain('if (loading || !document) return <LoadingScreen />;');
    expect(styles).toMatch(/\.sprite-symmetry-settings select, \.sprite-symmetry-settings input \{[^}]*height: var\(--ui-hit-secondary\)/);
    expect(styles).toMatch(/\.sprite-symmetry-settings > header strong \{[^}]*font-size: var\(--ui-type-label\)/);
    expect(styles).toMatch(/\.sprite-symmetry-settings > header small, \.sprite-symmetry-settings > p \{[^}]*font-size: var\(--ui-type-caption\)/);
    expect(canvas).not.toContain("useState<'none' | 'horizontal' | 'vertical' | 'both'>");
  });
});
