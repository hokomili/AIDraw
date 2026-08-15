import type { BitmapFont, BitmapGlyph } from './model';

const MAX_BITMAP_GLYPH_AXIS = 64;
const MAX_BITMAP_GLYPH_CELLS = MAX_BITMAP_GLYPH_AXIS * MAX_BITMAP_GLYPH_AXIS;
const MAX_BITMAP_GLYPH_SHEET_CHARACTERS = 256;
const MAX_BITMAP_GLYPH_SHEET_CELLS = 65_536;

export interface BitmapGlyphCapture {
  glyph: BitmapGlyph;
  bounds: { x: number; y: number; width: number; height: number };
  selectedCellCount: number;
  inkCellCount: number;
}

export interface BitmapGlyphSheetMapping {
  font: BitmapFont;
  bounds: { x: number; y: number; width: number; height: number };
  characterCount: number;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  advance: number;
  lineHeight: number;
  selectedCellCount: number;
  inkCellCount: number;
  blankGlyphCount: number;
  newGlyphCount: number;
  replacedGlyphCount: number;
  mappings: Array<{ character: string; glyph: BitmapGlyph; inkCellCount: number; replaced: boolean }>;
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

/**
 * Map one exact indexed selection as a uniform row-major bitmap-glyph sheet.
 * Selected nonzero indices become ink; index 0 and unselected cells are clear.
 * The ordered character string and explicit column count are the only grid
 * interpretation inputs: no character order or trimming is inferred.
 */
export function mapBitmapFontGlyphSheet(
  font: BitmapFont,
  points: ReadonlyArray<{ x: number; y: number }>,
  readIndex: (x: number, y: number) => number,
  characters: string,
  columns: number,
  advance?: number,
  lineHeight?: number,
): BitmapGlyphSheetMapping {
  if (!points.length) throw new Error('Select at least one sprite cell to map a glyph sheet.');
  if (points.length > MAX_BITMAP_GLYPH_SHEET_CELLS) throw new Error(`Bitmap glyph sheets are limited to ${MAX_BITMAP_GLYPH_SHEET_CELLS.toLocaleString('en-US')} selected cells.`);
  const orderedCharacters = [...characters];
  if (!orderedCharacters.length) throw new Error('Enter at least one character in row-major sheet order.');
  if (orderedCharacters.length > MAX_BITMAP_GLYPH_SHEET_CHARACTERS) throw new Error(`Bitmap glyph sheets are limited to ${MAX_BITMAP_GLYPH_SHEET_CHARACTERS} characters.`);
  for (const character of orderedCharacters) {
    const characterError = bitmapFontCharacterError(character);
    if (characterError) throw new Error('Glyph-sheet order must contain individual Unicode characters without line breaks.');
  }
  if (new Set(orderedCharacters).size !== orderedCharacters.length) throw new Error('Glyph-sheet character order cannot contain duplicates.');
  if (!Number.isInteger(columns) || columns < 1 || columns > orderedCharacters.length) throw new Error(`Glyph-sheet columns must be a whole number from 1 through ${orderedCharacters.length}.`);

  const selected = new Map<string, { x: number; y: number }>();
  let minX = Number.POSITIVE_INFINITY; let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY; let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) throw new Error('Bitmap glyph-sheet selection coordinates must be safe integers.');
    const key = `${point.x},${point.y}`;
    if (selected.has(key)) continue;
    selected.set(key, { x: point.x, y: point.y });
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX + 1; const height = maxY - minY + 1;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new Error('Bitmap glyph-sheet bounds must use safe integer geometry.');
  if (width * height > MAX_BITMAP_GLYPH_SHEET_CELLS) throw new Error(`Bitmap glyph-sheet bounds are limited to ${MAX_BITMAP_GLYPH_SHEET_CELLS.toLocaleString('en-US')} cells.`);
  const rowCount = Math.ceil(orderedCharacters.length / columns);
  if (width % columns !== 0 || height % rowCount !== 0) throw new Error(`Selection bounds ${width} × ${height} must divide evenly into ${columns} columns and ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}.`);
  const cellWidth = width / columns; const cellHeight = height / rowCount;
  if (cellWidth < 1 || cellHeight < 1 || cellWidth > MAX_BITMAP_GLYPH_AXIS || cellHeight > MAX_BITMAP_GLYPH_AXIS) throw new Error(`Every glyph-sheet cell must be from 1 × 1 through ${MAX_BITMAP_GLYPH_AXIS} × ${MAX_BITMAP_GLYPH_AXIS} cells.`);
  const resolvedAdvance = advance ?? cellWidth;
  if (!Number.isInteger(resolvedAdvance) || resolvedAdvance < 1 || resolvedAdvance > 128) throw new Error('Bitmap glyph-sheet advance must be a whole number from 1 through 128.');
  const minimumLineHeight = Math.max(minimumBitmapFontLineHeight(font), cellHeight);
  const resolvedLineHeight = lineHeight ?? Math.max(font.lineHeight, cellHeight);
  if (!Number.isInteger(resolvedLineHeight) || resolvedLineHeight < minimumLineHeight || resolvedLineHeight > 128) throw new Error(`Bitmap glyph-sheet line height must be a whole number from ${minimumLineHeight} through 128.`);

  const selectedIndices = new Map<string, number>();
  let inkCellCount = 0;
  for (const point of selected.values()) {
    const index = readIndex(point.x, point.y);
    if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error('Bitmap glyph-sheet capture requires palette indices from 0 through 255.');
    selectedIndices.set(`${point.x},${point.y}`, index);
    if (index === 0) continue;
    inkCellCount += 1;
    const column = Math.floor((point.x - minX) / cellWidth); const row = Math.floor((point.y - minY) / cellHeight);
    if (row * columns + column >= orderedCharacters.length) throw new Error('Unused trailing glyph-sheet cells must contain no selected nonzero palette indices.');
  }
  if (!inkCellCount) throw new Error('The selected glyph sheet contains no nonzero palette indices.');

  let mappedFont = font;
  const mappings = orderedCharacters.map((character, characterIndex) => {
    const cellColumn = characterIndex % columns; const cellRow = Math.floor(characterIndex / columns);
    let glyphInkCellCount = 0;
    const rows = Array.from({ length: cellHeight }, (_, y) => Array.from({ length: cellWidth }, (_, x) => {
      const index = selectedIndices.get(`${minX + cellColumn * cellWidth + x},${minY + cellRow * cellHeight + y}`) ?? 0;
      if (index === 0) return '.';
      glyphInkCellCount += 1;
      return '#';
    }).join(''));
    const glyphValue = { width: cellWidth, advance: resolvedAdvance, rows };
    const replaced = Boolean(font.glyphs[character]);
    mappedFont = upsertBitmapFontGlyph(mappedFont, character, glyphValue, resolvedLineHeight);
    return { character, glyph: glyphValue, inkCellCount: glyphInkCellCount, replaced };
  });
  const replacedGlyphCount = mappings.filter((mapping) => mapping.replaced).length;
  return {
    font: mappedFont,
    bounds: { x: minX, y: minY, width, height },
    characterCount: orderedCharacters.length,
    columns,
    rows: rowCount,
    cellWidth,
    cellHeight,
    advance: resolvedAdvance,
    lineHeight: resolvedLineHeight,
    selectedCellCount: selected.size,
    inkCellCount,
    blankGlyphCount: mappings.filter((mapping) => mapping.inkCellCount === 0).length,
    newGlyphCount: mappings.length - replacedGlyphCount,
    replacedGlyphCount,
    mappings,
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
