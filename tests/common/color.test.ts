import { describe, expect, it } from 'vitest';
import { colorWithOpacity, splitColorAlpha } from '../../src/common/color';

describe('color opacity helpers', () => {
  it('combines embedded alpha and authored stop opacity', () => {
    expect(splitColorAlpha('#ff880080')).toEqual({ color: '#ff8800', opacity: 128 / 255 });
    expect(colorWithOpacity('#ff880080', 0.5)).toBe(`rgba(255, 136, 0, ${64 / 255})`);
  });
});
