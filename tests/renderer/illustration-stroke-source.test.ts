import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('illustration stroke renderer wiring', () => {
  it('routes shapes and paths in both Canvas renderers through the shared complete style', () => {
    const interactive = readFileSync(new URL('../../src/renderer/canvas/IllustrationCanvas.tsx', import.meta.url), 'utf8');
    const headless = readFileSync(new URL('../../src/main/render-document.ts', import.meta.url), 'utf8');
    const hitTest = readFileSync(new URL('../../src/renderer/canvas/illustration-hit-test.ts', import.meta.url), 'utf8');
    expect(interactive).toContain("import { applyCanvasStrokeStyle } from '../../common/canvas-stroke'");
    expect(headless).toContain("import { applyCanvasStrokeStyle } from '../common/canvas-stroke'");
    for (const source of [interactive, headless]) {
      expect(source.match(/applyCanvasStrokeStyle\(context, object\.stroke\)/g)).toHaveLength(2);
      expect(source).toContain('stroke && object.stroke.width > 0');
    }
    expect(hitTest).toContain('CANVAS_STROKE_MITER_LIMIT');
    expect(hitTest).toContain('context.miterLimit = CANVAS_STROKE_MITER_LIMIT');
  });
});
