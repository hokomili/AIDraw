import { GlobalFonts } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { BUNDLED_CANVAS_FONT_FAMILY } from '../../src/common/bundled-canvas-font';
import { ensureBundledNativeCanvasFonts, registerBundledNativeCanvasFonts } from '../../src/main/canvas-fonts';

describe('native Canvas font registration', () => {
  it('rejects a registry that cannot retain every bundled face', () => {
    expect(() => registerBundledNativeCanvasFonts({ register: () => null })).toThrow('Could not register bundled Canvas font LiberationSans-Regular.ttf.');
  });

  it('registers regular, bold, italic, and bold-italic faces under one private family', () => {
    ensureBundledNativeCanvasFonts();
    expect(GlobalFonts.has(BUNDLED_CANVAS_FONT_FAMILY)).toBe(true);
    expect(GlobalFonts.families.find((family) => family.family === BUNDLED_CANVAS_FONT_FAMILY)?.styles).toEqual([
      { weight: 400, width: 'normal', style: 'normal' },
      { weight: 700, width: 'normal', style: 'normal' },
      { weight: 400, width: 'normal', style: 'italic' },
      { weight: 700, width: 'normal', style: 'italic' },
    ]);
    expect(() => ensureBundledNativeCanvasFonts()).not.toThrow();
  });
});
