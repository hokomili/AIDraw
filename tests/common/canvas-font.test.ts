import { describe, expect, it } from 'vitest';
import { BUNDLED_CANVAS_FALLBACK_FAMILY, canvasFont } from '../../src/common/canvas-font';

describe('canvasFont', () => {
  it('normalizes variable weights for browser and native canvas parity', () => {
    expect(canvasFont({ fontFamily: 'Segoe UI', fontSize: 42, fontWeight: 650, fontStyle: 'normal' }))
      .toBe(`normal 700 42px "Segoe UI", "${BUNDLED_CANVAS_FALLBACK_FAMILY}"`);
    expect(canvasFont({ fontFamily: 'Segoe UI', fontSize: 15, fontWeight: 450, fontStyle: 'italic' }))
      .toBe(`italic 500 15px "Segoe UI", "${BUNDLED_CANVAS_FALLBACK_FAMILY}"`);
  });

  it('sanitizes a family before embedding it in the canvas font shorthand', () => {
    expect(canvasFont({ fontFamily: 'Bad"\nFamily', fontSize: 12, fontWeight: 400, fontStyle: 'normal' }))
      .toBe(`normal 400 12px "Bad  Family", "${BUNDLED_CANVAS_FALLBACK_FAMILY}"`);
  });

  it('does not duplicate the bundled fallback when it is the authored family', () => {
    expect(canvasFont({ fontFamily: BUNDLED_CANVAS_FALLBACK_FAMILY, fontSize: 16, fontWeight: 400, fontStyle: 'normal' }))
      .toBe(`normal 400 16px "${BUNDLED_CANVAS_FALLBACK_FAMILY}"`);
  });
});
