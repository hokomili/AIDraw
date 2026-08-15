import type { PaletteEntry } from './model';

export type OrderedDitherMatrixSize = 2 | 4 | 8;

const BAYER_2 = [
  [0, 2],
  [3, 1],
] as const;

function expandBayer(source: readonly (readonly number[])[]): number[][] {
  const size = source.length;
  const offsets = [[0, 2], [3, 1]];
  return Array.from({ length: size * 2 }, (_, y) => Array.from({ length: size * 2 }, (_, x) => source[y % size][x % size] * 4 + offsets[Math.floor(y / size)][Math.floor(x / size)]));
}

const BAYER_MATRICES: Record<OrderedDitherMatrixSize, readonly (readonly number[])[]> = {
  2: BAYER_2,
  4: expandBayer(BAYER_2),
  8: expandBayer(expandBayer(BAYER_2)),
};

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Normalize a whole-cell phase into the selected Bayer matrix's local coordinates. */
export function normalizeOrderedDitherPhase(value: number, matrixSize: OrderedDitherMatrixSize): number {
  if (!Number.isSafeInteger(value)) throw new Error('Ordered dither phase must be a whole-cell integer.');
  return positiveModulo(value, matrixSize);
}

export function orderedDitherUsesMix(x: number, y: number, coverage: number, matrixSize: OrderedDitherMatrixSize = 4, phaseX = 0, phaseY = 0): boolean {
  const size = matrixSize; const matrix = BAYER_MATRICES[size]; const clamped = Math.max(0, Math.min(1, coverage));
  return matrix[positiveModulo(y - phaseY, size)][positiveModulo(x - phaseX, size)] < clamped * size * size;
}

export function orderedDitherIndex(x: number, y: number, baseIndex: number, mixIndex: number, coverage: number, matrixSize: OrderedDitherMatrixSize = 4, phaseX = 0, phaseY = 0): number {
  return orderedDitherUsesMix(x, y, coverage, matrixSize, phaseX, phaseY) ? mixIndex : baseIndex;
}

export function paletteRelativeLuminance(color: string): number {
  const value = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color) ? color : '#000000';
  const channel = (start: number) => { const encoded = Number.parseInt(value.slice(start, start + 2), 16) / 255; return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function stepPaletteByLuminance(palette: readonly PaletteEntry[], currentIndex: number, direction: 'lighter' | 'darker'): number {
  if (currentIndex <= 0 || currentIndex >= palette.length) return currentIndex;
  const current = paletteRelativeLuminance(palette[currentIndex].color); let best = currentIndex; let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < palette.length; index += 1) {
    if (index === currentIndex) continue;
    const luminance = paletteRelativeLuminance(palette[index].color); const distance = direction === 'lighter' ? luminance - current : current - luminance;
    if (distance > 1e-9 && (distance < bestDistance || (distance === bestDistance && index < best))) { best = index; bestDistance = distance; }
  }
  return best;
}
