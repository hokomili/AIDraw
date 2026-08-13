import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUNDLED_CANVAS_FONT_FACES, BUNDLED_CANVAS_FONT_FAMILY } from '../../src/common/bundled-canvas-font';

describe('bundled Canvas font assets', () => {
  it('pins the four licensed Liberation Sans faces by content hash', () => {
    expect(BUNDLED_CANVAS_FONT_FAMILY).toBe('AIDraw Liberation Sans');
    expect(BUNDLED_CANVAS_FONT_FACES.map(({ fileName, style, weight }) => ({ fileName, style, weight }))).toEqual([
      { fileName: 'LiberationSans-Regular.ttf', style: 'normal', weight: 400 },
      { fileName: 'LiberationSans-Bold.ttf', style: 'normal', weight: 700 },
      { fileName: 'LiberationSans-Italic.ttf', style: 'italic', weight: 400 },
      { fileName: 'LiberationSans-BoldItalic.ttf', style: 'italic', weight: 700 },
    ]);
    for (const face of BUNDLED_CANVAS_FONT_FACES) {
      expect(face.source).toMatch(/^data:font\/ttf;base64,/u);
      const bytes = Buffer.from(face.source.slice(face.source.indexOf(',') + 1), 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(face.sha256);
    }
  });
});
