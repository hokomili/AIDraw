import type { TextObject, TextStyleRange } from './model';

export type TextStyle = Omit<TextStyleRange, 'start' | 'end'>;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Segoe UI',
  fontSize: 48,
  fontWeight: 500,
  fontStyle: 'normal',
  color: '#27213c',
  letterSpacing: 0,
  underline: false,
};

function styleOf(range: TextStyleRange | TextStyle): TextStyle {
  const { fontFamily, fontSize, fontWeight, fontStyle, color, letterSpacing, underline } = range;
  return { fontFamily, fontSize, fontWeight, fontStyle, color, letterSpacing, underline: Boolean(underline) };
}

function sameStyle(left: TextStyle, right: TextStyle): boolean {
  return left.fontFamily === right.fontFamily && left.fontSize === right.fontSize && left.fontWeight === right.fontWeight && left.fontStyle === right.fontStyle && left.color === right.color && left.letterSpacing === right.letterSpacing && Boolean(left.underline) === Boolean(right.underline);
}

function stylesByCharacter(text: string, ranges: TextStyleRange[], fallback: TextStyle): TextStyle[] {
  const styles = Array.from({ length: text.length }, () => ({ ...fallback }));
  for (const range of ranges) {
    const start = Math.max(0, Math.min(text.length, Math.floor(range.start))); const end = Math.max(start, Math.min(text.length, Math.floor(range.end)));
    const style = styleOf(range); for (let index = start; index < end; index += 1) styles[index] = { ...style };
  }
  return styles;
}

function rangesFromStyles(styles: TextStyle[]): TextStyleRange[] {
  if (!styles.length) return [];
  const ranges: TextStyleRange[] = []; let start = 0; let current = styles[0];
  for (let index = 1; index <= styles.length; index += 1) {
    const next = styles[index];
    if (next && sameStyle(current, next)) continue;
    ranges.push({ start, end: index, ...current }); start = index; current = next;
  }
  return ranges;
}

export function normalizeTextStyleRanges(text: string, ranges: TextStyleRange[], fallback: TextStyle = DEFAULT_TEXT_STYLE): TextStyleRange[] {
  return rangesFromStyles(stylesByCharacter(text, ranges, fallback));
}

export function textStyleAt(object: TextObject, index: number): TextStyle {
  const position = Math.max(0, Math.min(Math.max(0, object.text.length - 1), Math.floor(index)));
  const range = object.ranges.find((entry) => entry.start <= position && entry.end > position);
  return range ? styleOf(range) : { ...DEFAULT_TEXT_STYLE };
}

export function applyTextStyleRange(object: TextObject, start: number, end: number, patch: Partial<TextStyle>): TextObject {
  const from = Math.max(0, Math.min(object.text.length, Math.floor(start))); const to = Math.max(from, Math.min(object.text.length, Math.floor(end)));
  if (from === to) throw new Error('Select at least one text character to style.');
  const styles = stylesByCharacter(object.text, object.ranges, textStyleAt(object, from));
  for (let index = from; index < to; index += 1) styles[index] = { ...styles[index], ...patch };
  return { ...structuredClone(object), ranges: rangesFromStyles(styles) };
}

export function replaceStyledText(object: TextObject, text: string): TextObject {
  const prior = stylesByCharacter(object.text, object.ranges, DEFAULT_TEXT_STYLE);
  const extension = prior.at(-1) ?? textStyleAt(object, 0);
  const styles = Array.from({ length: text.length }, (_, index) => ({ ...(prior[index] ?? extension) }));
  return { ...structuredClone(object), text, ranges: rangesFromStyles(styles) };
}
