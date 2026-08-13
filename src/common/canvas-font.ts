export interface CanvasFontStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
}

export const BUNDLED_CANVAS_FALLBACK_FAMILY = 'AIDraw Liberation Sans';

/**
 * Browser canvas accepts variable numeric weights, but native Canvas backends
 * can interpret non-100 values such as 650 as a font size. Normalize the
 * cross-renderer subset so editor, snapshots, and exports remain identical.
 */
export function canvasFont(style: CanvasFontStyle): string {
  const weightValue = Number.isFinite(style.fontWeight) ? style.fontWeight : 400;
  const weight = Math.max(100, Math.min(900, Math.round(weightValue / 100) * 100));
  const size = Math.max(1, Number.isFinite(style.fontSize) ? style.fontSize : 16);
  const family = style.fontFamily.replace(/[\\"\r\n]/g, ' ').trim() || 'sans-serif';
  const families = family === BUNDLED_CANVAS_FALLBACK_FAMILY
    ? `"${family}"`
    : `"${family}", "${BUNDLED_CANVAS_FALLBACK_FAMILY}"`;
  return `${style.fontStyle} ${weight} ${size}px ${families}`;
}
