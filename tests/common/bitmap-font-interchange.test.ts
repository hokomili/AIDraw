import { describe, expect, it } from 'vitest';
import { createDefaultBitmapFont } from '@aidraw/core';
import { parseBitmapFontJson } from '@common/bitmap-font-interchange';

describe('bitmap font interchange', () => {
  it('accepts wrapped portable fonts and replaces colliding IDs', () => {
    const font = createDefaultBitmapFont();
    const parsed = parseBitmapFontJson(JSON.stringify({ version: 1, font }), [font.id]);
    expect(parsed).toMatchObject({ name: font.name, glyphs: font.glyphs });
    expect(parsed.id).not.toBe(font.id);
  });

  it('reports malformed, oversized, and structurally invalid JSON', () => {
    expect(() => parseBitmapFontJson('{')).toThrow(/malformed/);
    expect(() => parseBitmapFontJson(JSON.stringify({ font: { id: 'bad' } }))).toThrow();
    expect(() => parseBitmapFontJson(`{"font":"${'x'.repeat(1024 * 1024)}"}`)).toThrow(/1 MiB/);
  });
});
