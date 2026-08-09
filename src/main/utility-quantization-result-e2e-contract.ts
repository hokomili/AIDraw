import type { PaletteEntry } from '@aidraw/core';
import type { QuantizeImageOptions } from './quantize-image';

export type Fnd09QuantizationResultFault = 'over-budget' | 'contradictory';

export const FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZYxAUFPwPAAGdATO384aOAAAAAElFTkSuQmCC';
export const FND09_QUANTIZATION_RESULT_E2E_WIDTH = 1;
export const FND09_QUANTIZATION_RESULT_E2E_HEIGHT = 1;
export const FND09_QUANTIZATION_RESULT_E2E_HOLD_MS = 150;
export const FND09_QUANTIZATION_RESULT_E2E_PALETTE: PaletteEntry[] = [
  { id: 'transparent', name: 'Transparent', color: '#00000000' },
  { id: 'ink', name: 'Ink', color: '#111111ff' },
];
export const FND09_QUANTIZATION_RESULT_E2E_OPTIONS = {
  alphaThreshold: 0.5,
  dithering: 'none',
} satisfies QuantizeImageOptions;

export function isFnd09QuantizationResultE2eEnabled(input: { nodeEnv?: string; enabled?: string }): boolean {
  return input.nodeEnv === 'test' && input.enabled === '1';
}

export function isFnd09QuantizationResultFault(value: unknown): value is Fnd09QuantizationResultFault {
  return value === 'over-budget' || value === 'contradictory';
}

/** Fixed invalid responses used only after the real packaged worker quantizes its one-pixel fixture. */
export function createFnd09InvalidQuantizationResult(
  fault: Fnd09QuantizationResultFault,
): Array<{ x: number; y: number; index: number }> {
  return fault === 'over-budget'
    ? [{ x: 0, y: 0, index: 1 }, { x: 0, y: 0, index: 1 }]
    : [{ x: FND09_QUANTIZATION_RESULT_E2E_WIDTH, y: 0, index: 1 }];
}
