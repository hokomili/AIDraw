import { describe, expect, it } from 'vitest';
import { BUNDLED_CANVAS_FONT_FACES, BUNDLED_CANVAS_FONT_FAMILY } from '../../src/common/bundled-canvas-font';
import { loadBundledBrowserCanvasFonts } from '../../src/renderer/canvas-fonts';

describe('browser Canvas font registration', () => {
  it('loads every face before adding the complete family to the browser font set', async () => {
    const created: FakeFontFace[] = []; const added: FakeFontFace[] = [];
    class FakeFontFace {
      loaded = false;
      constructor(public family: string, public source: string, public descriptors?: FontFaceDescriptors) { created.push(this); }
      async load(): Promise<FakeFontFace> { this.loaded = true; return this; }
    }
    await loadBundledBrowserCanvasFonts(
      { add: (face) => { expect(created.every((entry) => entry.loaded)).toBe(true); added.push(face as unknown as FakeFontFace); } },
      FakeFontFace as unknown as typeof FontFace,
    );
    expect(created.map((face) => ({ family: face.family, style: face.descriptors?.style, weight: face.descriptors?.weight }))).toEqual(
      BUNDLED_CANVAS_FONT_FACES.map((face) => ({ family: BUNDLED_CANVAS_FONT_FAMILY, style: face.style, weight: String(face.weight) })),
    );
    expect(created.every((face) => face.source.startsWith('url("data:font/ttf;base64,'))).toBe(true);
    expect(added).toEqual(created);
  });
});
