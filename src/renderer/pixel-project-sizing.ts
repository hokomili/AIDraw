import type { PixelSprite } from '@aidraw/core';

export const MIN_PIXEL_DIMENSION = 1;
export const MAX_PIXEL_DIMENSION = 8_192;

export function pixelDimension(value: string | number, fallback = 64): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(MIN_PIXEL_DIMENSION, Math.min(MAX_PIXEL_DIMENSION, Math.round(parsed)))
    : fallback;
}

export type PixelCanvasAxisChange = 'unchanged' | 'shrink' | 'expand';
export type PixelCanvasSizeChange = PixelCanvasAxisChange | 'mixed';

export interface PixelCanvasSizeReview {
  currentWidth: number;
  currentHeight: number;
  draftWidth: number;
  draftHeight: number;
  widthChange: PixelCanvasAxisChange;
  heightChange: PixelCanvasAxisChange;
  change: PixelCanvasSizeChange;
  normalized: boolean;
}

function axisChange(current: number, draft: number): PixelCanvasAxisChange {
  if (draft < current) return 'shrink';
  if (draft > current) return 'expand';
  return 'unchanged';
}

function inputWasNormalized(value: string | number, normalized: number): boolean {
  const parsed = typeof value === 'number' ? value : Number(value);
  return !Number.isFinite(parsed) || parsed !== normalized;
}

export function reviewPixelCanvasSize(
  sprite: Pick<PixelSprite, 'width' | 'height'>,
  width: string | number,
  height: string | number,
): PixelCanvasSizeReview {
  const draftWidth = pixelDimension(width, sprite.width);
  const draftHeight = pixelDimension(height, sprite.height);
  const widthChange = axisChange(sprite.width, draftWidth);
  const heightChange = axisChange(sprite.height, draftHeight);
  const changes = new Set([widthChange, heightChange]);
  const change: PixelCanvasSizeChange = changes.has('shrink') && changes.has('expand')
    ? 'mixed'
    : changes.has('shrink')
      ? 'shrink'
      : changes.has('expand')
        ? 'expand'
        : 'unchanged';
  return {
    currentWidth: sprite.width,
    currentHeight: sprite.height,
    draftWidth,
    draftHeight,
    widthChange,
    heightChange,
    change,
    normalized: inputWasNormalized(width, draftWidth) || inputWasNormalized(height, draftHeight),
  };
}

export function pixelCanvasSizeEditorKey(sprite: Pick<PixelSprite, 'id' | 'width' | 'height'>): string {
  return `${sprite.id}:${sprite.width}:${sprite.height}`;
}
