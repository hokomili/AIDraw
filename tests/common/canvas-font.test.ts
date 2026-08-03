import { describe, expect, it } from 'vitest';
import { canvasFont } from '../../src/common/canvas-font';

describe('canvasFont', () => {
  it('normalizes variable weights for browser and native canvas parity', () => {
    expect(canvasFont({ fontFamily: 'Segoe UI', fontSize: 42, fontWeight: 650, fontStyle: 'normal' }))
      .toBe('normal 700 42px "Segoe UI"');
    expect(canvasFont({ fontFamily: 'Segoe UI', fontSize: 15, fontWeight: 450, fontStyle: 'italic' }))
      .toBe('italic 500 15px "Segoe UI"');
  });

  it('sanitizes a family before embedding it in the canvas font shorthand', () => {
    expect(canvasFont({ fontFamily: 'Bad"\nFamily', fontSize: 12, fontWeight: 400, fontStyle: 'normal' }))
      .toBe('normal 400 12px "Bad  Family"');
  });
});
