import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('editor accessibility baseline', () => {
  it('retains keyboard, motion, contrast, and live-status affordances', async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('@media (prefers-contrast: more)');
    expect(styles).toContain('@media (forced-colors: active)');
    expect(styles).toMatch(/:focus-visible/);
    expect(app).toContain('role="tablist"');
    expect(app).toContain('aria-haspopup="menu"');
    expect(app).toContain('aria-haspopup="dialog"');
    expect(app).toContain('role="tabpanel"');
    expect(app).toContain('aria-selected={visiblePanel ===');
    expect(app).toContain('aria-label="Canvas zoom"');
    expect(app).toContain('aria-label="Stop all agents working on this document"');
    expect(app).toContain('aria-live="polite"');
    expect(app).toContain('aria-modal="true"');
    expect(app).toContain('aria-describedby={description ? descriptionId : undefined}');
    expect(app).toContain('previouslyFocused?.isConnected');
    expect(app).toContain('event.key !== "Tab"');
    expect(app).not.toMatch(/\bwindow\.(?:prompt|confirm|alert)\s*\(/);
  });

  it('keeps both drawing surfaces focusable and named', async () => {
    const [illustration, pixel] = await Promise.all([
      readFile(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/renderer/canvas/PixelCanvas.tsx', import.meta.url), 'utf8'),
    ]);
    for (const source of [illustration, pixel]) {
      expect(source).toContain('role="application"');
      expect(source).toContain('tabIndex={0}');
      expect(source).toMatch(/aria-label={`(?:Illustration|Pixel-art) canvas/);
    }
  });
});
