import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STYLE, HUMAN_ACTOR, IDENTITY_TRANSFORM, applyTextStyleRange, normalizeTextStyleRanges, replaceStyledText, textStyleAt, type TextObject } from '@aidraw/core';

function textObject(): TextObject {
  return {
    id: 'text', revision: 0, name: 'Text', createdAt: 'now', updatedAt: 'now', createdBy: HUMAN_ACTOR.id, layerId: 'layer',
    visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: IDENTITY_TRANSFORM, type: 'text', text: 'Gold train', width: 300, height: 120, align: 'left', lineHeight: 1.2,
    ranges: [{ start: 0, end: 10, ...DEFAULT_TEXT_STYLE }],
  };
}

describe('styled text ranges', () => {
  it('fills gaps and merges adjacent equivalent styles into a canonical range list', () => {
    const ranges = normalizeTextStyleRanges('abcd', [
      { start: 0, end: 1, ...DEFAULT_TEXT_STYLE, fontWeight: 700 },
      { start: 1, end: 2, ...DEFAULT_TEXT_STYLE, fontWeight: 700 },
    ]);
    expect(ranges).toEqual([
      { start: 0, end: 2, ...DEFAULT_TEXT_STYLE, fontWeight: 700 },
      { start: 2, end: 4, ...DEFAULT_TEXT_STYLE },
    ]);
  });

  it('splits only the selected characters and preserves surrounding typography', () => {
    const styled = applyTextStyleRange(textObject(), 5, 10, { fontWeight: 800, fontStyle: 'italic', color: '#d49c28', underline: true });
    expect(styled.ranges).toHaveLength(2);
    expect(styled.ranges[0]).toMatchObject({ start: 0, end: 5, fontWeight: 500 });
    expect(styled.ranges[1]).toMatchObject({ start: 5, end: 10, fontWeight: 800, fontStyle: 'italic', color: '#d49c28', underline: true });
    expect(textStyleAt(styled, 7)).toMatchObject({ fontWeight: 800, fontStyle: 'italic' });
    expect(() => applyTextStyleRange(styled, 2, 2, { underline: true })).toThrow(/Select/);
  });

  it('retains existing character styles and extends new text with the final style', () => {
    const source = applyTextStyleRange(textObject(), 5, 10, { fontWeight: 800 });
    const longer = replaceStyledText(source, 'Gold train now');
    expect(textStyleAt(longer, 1).fontWeight).toBe(500);
    expect(textStyleAt(longer, 12).fontWeight).toBe(800);
    const shorter = replaceStyledText(longer, 'Gold');
    expect(shorter.ranges).toEqual([{ start: 0, end: 4, ...DEFAULT_TEXT_STYLE }]);
  });
});
