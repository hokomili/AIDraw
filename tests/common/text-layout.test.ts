import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_TEXT_STYLE, HUMAN_ACTOR, IDENTITY_TRANSFORM, type TextObject } from '@aidraw/core';
import { layoutStyledText, renderStyledText } from '../../src/common/text-layout';

function object(text = 'ABCD'): TextObject {
  return {
    id: 'text', revision: 0, name: 'Text', createdAt: 'now', updatedAt: 'now', createdBy: HUMAN_ACTOR.id, layerId: 'layer', visible: true, locked: false,
    opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'text', text, width: 25, height: 80, align: 'left', lineHeight: 1.5,
    ranges: [{ start: 0, end: text.length, ...DEFAULT_TEXT_STYLE, fontSize: 10 }],
  };
}

describe('shared styled text layout', () => {
  it('wraps to the text box, respects explicit newlines, and advances by line height', () => {
    const layout = layoutStyledText(object('ABC\nD'), () => 10);
    expect(layout.map((glyph) => [glyph.character, glyph.x, glyph.y])).toEqual([
      ['A', 0, 0], ['B', 10, 0], ['C', 0, 15], ['D', 0, 30],
    ]);
  });

  it('aligns each wrapped line independently', () => {
    const centered = { ...object('ABC'), align: 'center' as const };
    const layout = layoutStyledText(centered, () => 10);
    expect(layout[0].x).toBe(2.5);
    expect(layout[2].x).toBe(7.5);
    expect(layout[2].y).toBe(15);
  });

  it('renders multiline styled glyphs through the native shared path', () => {
    const canvas = createCanvas(80, 80); const context = canvas.getContext('2d'); const source = { ...object('A\nB'), width: 80, height: 80 };
    renderStyledText(context, source);
    const pixels = context.getImageData(0, 0, 80, 80).data;
    const firstRowInk = Array.from(pixels.slice(0, 80 * 20 * 4)).some((value, index) => index % 4 === 3 && value > 0);
    const secondRowInk = Array.from(pixels.slice(80 * 20 * 4)).some((value, index) => index % 4 === 3 && value > 0);
    expect(firstRowInk).toBe(true); expect(secondRowInk).toBe(true);
  });
});
