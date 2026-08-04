import type { BitmapFont, BitmapGlyph } from './model';

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
  const lines = text.split('\n'); const lineWidths = lines.map((line) => line.length ? line.split('').reduce((sum, character, index) => sum + resolveGlyph(font, character).advance * scale + (index ? spacing * scale : 0), 0) - scale : 0);
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
