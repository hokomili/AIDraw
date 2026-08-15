import type { BitmapFont, BitmapGlyph } from './model';

const MAX_BITMAP_GLYPH_AXIS = 64;
const MAX_BITMAP_GLYPH_CELLS = MAX_BITMAP_GLYPH_AXIS * MAX_BITMAP_GLYPH_AXIS;

export interface BitmapGlyphCapture {
  glyph: BitmapGlyph;
  bounds: { x: number; y: number; width: number; height: number };
  selectedCellCount: number;
  inkCellCount: number;
}

const PATTERNS: Record<string, string> = {
  ' ': '.../.../.../.../.../.../...', '!': '.#./.#./.#./.#./.#./.../.#.', '?': '.###./#...#/....#/...#./..#../...../..#..',
  '.': '.../.../.../.../.../.../.#.', ',': '.../.../.../.../.../.#./#..', ':': '.../.#./.../.../.#./.../...', '-': '...../...../...../.###./...../...../.....', '+': '...../..#../..#../#####/..#../..#../.....',
  '0': '.###./#...#/##..#/#.#.#/#..##/#...#/.###.', '1': '..#../.##../..#../..#../..#../..#../.###.', '2': '.###./#...#/....#/...#./..#../.#.../#####', '3': '####./....#/....#/.###./....#/....#/####.', '4': '...#./..##./.#.#./#..#./#####/...#./...#.', '5': '#####/#..../#..../####./....#/....#/####.', '6': '.###./#..../#..../####./#...#/#...#/.###.', '7': '#####/....#/...#./..#../.#.../.#.../.#...', '8': '.###./#...#/#...#/.###./#...#/#...#/.###.', '9': '.###./#...#/#...#/.####/....#/....#/.###.',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#', B: '####./#...#/#...#/####./#...#/#...#/####.', C: '.###./#...#/#..../#..../#..../#...#/.###.', D: '####./#...#/#...#/#...#/#...#/#...#/####.', E: '#####/#..../#..../####./#..../#..../#####', F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.', H: '#...#/#...#/#...#/#####/#...#/#...#/#...#', I: '.###./..#../..#../..#../..#../..#../.###.', J: '..###/...#./...#./...#./...#./#..#./.##..', K: '#...#/#..#./#.#../##.../#.#../#..#./#...#', L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#', N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#', O: '.###./#...#/#...#/#...#/#...#/#...#/.###.', P: '####./#...#/#...#/####./#..../#..../#....', Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#', R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.', T: '#####/..#../..#../..#../..#../..#../..#..', U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.', V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..', W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#', X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#', Y: '#...#/#...#/.#.#./..#../..#../..#../..#..', Z: '#####/....#/...#./..#../.#.../#..../#####',
};

function glyph(pattern: string): BitmapGlyph {
  const rows = pattern.split('/'); const width = rows[0].length;
  return { width, advance: width + 1, rows };
}

export function createDefaultBitmapFont(): BitmapFont {
  return { id: 'bitmap-font-tiny-5x7', name: 'Tiny 5×7', lineHeight: 8, glyphs: Object.fromEntries(Object.entries(PATTERNS).map(([character, pattern]) => [character, glyph(pattern)])) };
}

/**
 * Capture one bounded monochrome glyph from an exact sprite selection.
 * Selected nonzero palette indices become ink; index 0 and unselected cells
 * inside the selection bounds remain clear. Effective palette alpha is not
 * consulted, and source palette indices are never rewritten.
 */
export function captureBitmapGlyph(
  points: ReadonlyArray<{ x: number; y: number }>,
  readIndex: (x: number, y: number) => number,
  advance?: number,
): BitmapGlyphCapture {
  if (!points.length) throw new Error('Select at least one sprite cell to map a glyph.');
  if (points.length > MAX_BITMAP_GLYPH_CELLS) throw new Error(`Bitmap glyph selections are limited to ${MAX_BITMAP_GLYPH_CELLS.toLocaleString('en-US')} cells.`);
  const selected = new Map<string, { x: number; y: number }>();
  for (const point of points) {
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) throw new Error('Bitmap glyph selection coordinates must be safe integers.');
    selected.set(`${point.x},${point.y}`, { x: point.x, y: point.y });
  }
  const cells = [...selected.values()];
  const minX = Math.min(...cells.map((point) => point.x)); const maxX = Math.max(...cells.map((point) => point.x));
  const minY = Math.min(...cells.map((point) => point.y)); const maxY = Math.max(...cells.map((point) => point.y));
  const width = maxX - minX + 1; const height = maxY - minY + 1;
  if (width > MAX_BITMAP_GLYPH_AXIS || height > MAX_BITMAP_GLYPH_AXIS) throw new Error(`Bitmap glyph bounds are limited to ${MAX_BITMAP_GLYPH_AXIS} × ${MAX_BITMAP_GLYPH_AXIS} cells.`);
  const ink = new Set<string>();
  for (const point of cells) {
    const index = readIndex(point.x, point.y);
    if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error('Bitmap glyph capture requires palette indices from 0 through 255.');
    if (index !== 0) ink.add(`${point.x},${point.y}`);
  }
  if (!ink.size) throw new Error('The selected sprite cells contain no nonzero palette indices.');
  const resolvedAdvance = advance ?? width + 1;
  if (!Number.isInteger(resolvedAdvance) || resolvedAdvance < 1 || resolvedAdvance > 128) throw new Error('Bitmap glyph advance must be a whole number from 1 through 128.');
  const rows = Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, column) => ink.has(`${minX + column},${minY + row}`) ? '#' : '.').join(''));
  return {
    glyph: { width, advance: resolvedAdvance, rows },
    bounds: { x: minX, y: minY, width, height },
    selectedCellCount: cells.length,
    inkCellCount: ink.size,
  };
}

export function bitmapFontCharacterError(character: string): string | undefined {
  const codePoints = [...character];
  if (codePoints.length !== 1 || character === '\n' || character === '\r') return 'Enter exactly one character.';
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return 'Enter one valid Unicode character.';
  return undefined;
}

export function minimumBitmapFontLineHeight(font: BitmapFont, glyphValue?: BitmapGlyph): number {
  let minimum = Math.max(1, glyphValue?.rows.length ?? 0);
  for (const entry of Object.values(font.glyphs)) minimum = Math.max(minimum, entry.rows.length);
  return minimum;
}

/** Return an immutable font with one exact glyph mapping replaced or added. */
export function upsertBitmapFontGlyph(font: BitmapFont, character: string, glyphValue: BitmapGlyph, lineHeight = font.lineHeight): BitmapFont {
  const characterError = bitmapFontCharacterError(character);
  if (characterError) throw new Error(characterError);
  if (!Number.isInteger(glyphValue.width) || glyphValue.width < 1 || glyphValue.width > 64) throw new Error('Bitmap glyph width must be a whole number from 1 through 64.');
  if (!Number.isInteger(glyphValue.advance) || glyphValue.advance < 1 || glyphValue.advance > 128) throw new Error('Bitmap glyph advance must be a whole number from 1 through 128.');
  if (!glyphValue.rows.length || glyphValue.rows.length > 64 || glyphValue.rows.some((row) => row.length !== glyphValue.width || !/^[.#]+$/.test(row))) throw new Error('Every bitmap glyph row must match its width and contain only . or # cells.');
  const minimumLineHeight = minimumBitmapFontLineHeight(font, glyphValue);
  if (!Number.isInteger(lineHeight) || lineHeight < minimumLineHeight || lineHeight > 128) throw new Error(`Bitmap font line height must be a whole number from ${minimumLineHeight} through 128.`);
  return {
    ...font,
    lineHeight,
    glyphs: { ...font.glyphs, [character]: structuredClone(glyphValue) },
  };
}

export interface BitmapTextOptions {
  x?: number;
  y?: number;
  letterSpacing?: number;
  lineSpacing?: number;
  scale?: number;
  align?: 'left' | 'center' | 'right';
}

function resolveGlyph(font: BitmapFont, character: string): BitmapGlyph {
  return font.glyphs[character] ?? font.glyphs[character.toUpperCase()] ?? font.glyphs['?'] ?? { width: 1, advance: 2, rows: ['.'] };
}

export function measureBitmapText(font: BitmapFont, text: string, options: BitmapTextOptions = {}): { width: number; height: number; lineWidths: number[] } {
  const scale = Math.max(1, Math.min(16, Math.trunc(options.scale ?? 1))); const spacing = Math.max(0, Math.min(32, Math.trunc(options.letterSpacing ?? 0)));
  const lines = text.split('\n'); const lineWidths = lines.map((line) => { const characters = [...line]; return characters.length ? characters.reduce((sum, character, index) => sum + resolveGlyph(font, character).advance * scale + (index ? spacing * scale : 0), 0) - scale : 0; });
  const lineHeight = (font.lineHeight + Math.max(0, Math.min(64, Math.trunc(options.lineSpacing ?? 0)))) * scale;
  return { width: Math.max(0, ...lineWidths), height: Math.max(scale, lines.length * lineHeight - Math.max(0, Math.min(64, Math.trunc(options.lineSpacing ?? 0))) * scale), lineWidths };
}

export function bitmapTextCells(font: BitmapFont, text: string, options: BitmapTextOptions = {}): Array<{ x: number; y: number }> {
  const x = Math.trunc(options.x ?? 0); const y = Math.trunc(options.y ?? 0); const scale = Math.max(1, Math.min(16, Math.trunc(options.scale ?? 1))); const spacing = Math.max(0, Math.min(32, Math.trunc(options.letterSpacing ?? 0))); const lineSpacing = Math.max(0, Math.min(64, Math.trunc(options.lineSpacing ?? 0))); const align = options.align ?? 'left';
  const lines = text.split('\n'); const measured = measureBitmapText(font, text, options); const result: Array<{ x: number; y: number }> = [];
  lines.forEach((line, lineIndex) => {
    const width = measured.lineWidths[lineIndex]; let cursorX = align === 'center' ? x - Math.floor(width / 2) : align === 'right' ? x - width + 1 : x; const originY = y + lineIndex * (font.lineHeight + lineSpacing) * scale;
    for (const character of line) {
      const value = resolveGlyph(font, character);
      value.rows.forEach((row, rowIndex) => row.split('').forEach((pixel, column) => {
        if (pixel !== '#') return;
        for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) result.push({ x: cursorX + column * scale + dx, y: originY + rowIndex * scale + dy });
      }));
      cursorX += (value.advance + spacing) * scale;
    }
  });
  return [...new Map(result.map((point) => [`${point.x},${point.y}`, point])).values()];
}
