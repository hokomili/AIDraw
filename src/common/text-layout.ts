import { normalizeTextStyleRanges, type TextObject, type TextStyleRange } from '@aidraw/core';
import { canvasFont } from './canvas-font';

export interface TextGlyphLayout {
  character: string;
  index: number;
  style: TextStyleRange;
  x: number;
  y: number;
  width: number;
}

type DraftGlyph = Omit<TextGlyphLayout, 'x' | 'y'>;
interface DraftLine { glyphs: DraftGlyph[]; width: number; height: number; paragraphEnd: boolean }

function styleAt(ranges: TextStyleRange[], index: number): TextStyleRange {
  return ranges.find((range) => range.start <= index && range.end > index) ?? ranges[0];
}

export function layoutStyledText(object: TextObject, measure: (character: string, style: TextStyleRange) => number): TextGlyphLayout[] {
  if (!object.text.length) return [];
  const ranges = normalizeTextStyleRanges(object.text, object.ranges);
  const lines: DraftLine[] = []; let glyphs: DraftGlyph[] = []; let width = 0; let height = 0;
  const finish = (paragraphEnd: boolean) => { lines.push({ glyphs, width: Math.max(0, width), height: Math.max(1, height || ranges[0].fontSize) * object.lineHeight, paragraphEnd }); glyphs = []; width = 0; height = 0; };
  for (let index = 0; index < object.text.length; index += 1) {
    const character = object.text[index]; const style = styleAt(ranges, index);
    if (character === '\n') { finish(true); continue; }
    const measured = Math.max(0, measure(character, style)); const advance = measured + style.letterSpacing;
    if (glyphs.length && width + advance > object.width) finish(false);
    if (!glyphs.length && /\s/.test(character)) continue;
    glyphs.push({ character, index, style, width: measured }); width += advance; height = Math.max(height, style.fontSize);
  }
  finish(true);
  const result: TextGlyphLayout[] = []; let y = 0;
  for (const line of lines) {
    if (y >= object.height) break;
    const spaces = line.glyphs.filter((glyph) => glyph.character === ' ').length;
    const justify = object.align === 'justify' && !line.paragraphEnd && spaces > 0;
    const extraSpace = justify ? Math.max(0, object.width - line.width) / spaces : 0;
    let x = object.align === 'center' ? (object.width - line.width) / 2 : object.align === 'right' ? object.width - line.width : 0;
    for (const glyph of line.glyphs) { result.push({ ...glyph, x, y }); x += glyph.width + glyph.style.letterSpacing + (glyph.character === ' ' ? extraSpace : 0); }
    y += line.height;
  }
  return result;
}

export interface StyledTextContext {
  font: string;
  fillStyle: unknown;
  textBaseline: string;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
}

export function renderStyledText(context: StyledTextContext, object: TextObject): void {
  context.textBaseline = 'top';
  const glyphs = layoutStyledText(object, (character, style) => { context.font = canvasFont(style); return context.measureText(character).width; });
  for (const glyph of glyphs) {
    context.font = canvasFont(glyph.style); context.fillStyle = glyph.style.color; context.fillText(glyph.character, glyph.x, glyph.y);
    if (glyph.style.underline) context.fillRect(glyph.x, glyph.y + glyph.style.fontSize * 1.05, glyph.width, Math.max(1, glyph.style.fontSize / 18));
  }
}
