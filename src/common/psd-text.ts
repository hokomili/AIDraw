import type { Transform } from '@aidraw/core';

export const AIDRAW_PSD_EDITABLE_TEXT_SUFFIX = ' · editable text';

export type AffineMatrix = readonly [number, number, number, number, number, number];

const MAX_TEXT_DIMENSION = 1_000_000;
const MAX_TRANSLATION = 1_000_000;
const MAX_SCALE = 10_000;
const MAX_SKEW = 89.999;
const MATRIX_EPSILON = 1e-12;

function finiteNumbers(values: unknown[]): values is number[] {
  return values.every((value) => typeof value === 'number' && Number.isFinite(value));
}

export function illustrationTransformMatrix(transform: Transform): AffineMatrix {
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const skewX = Math.tan(transform.skewX * Math.PI / 180);
  const skewY = Math.tan(transform.skewY * Math.PI / 180);
  return [
    cosine * transform.scaleX - sine * skewY,
    sine * transform.scaleX + cosine * skewY,
    cosine * skewX - sine * transform.scaleY,
    sine * skewX + cosine * transform.scaleY,
    transform.x,
    transform.y,
  ];
}

/**
 * AIDraw's PSD companion uses the first text run's baseline as the PSD text
 * origin. Keeping that offset inside the affine matrix preserves the complete
 * object transform while remaining compatible with older translation-only
 * AIDraw companions.
 */
export function aidrawPsdTextMatrix(transform: Transform, firstFontSize: number): AffineMatrix {
  const [a, b, c, d, e, f] = illustrationTransformMatrix(transform);
  return [a, b, c, d, e + c * firstFontSize, f + d * firstFontSize];
}

function transformFromMatrix(matrix: AffineMatrix): Transform | undefined {
  const [a, b, c, d, x, y] = matrix;
  const scaleX = Math.hypot(a, b);
  let rotation: number;
  let scaleY: number;
  let skewX: number;

  if (scaleX > MATRIX_EPSILON) {
    rotation = Math.atan2(b, a) * 180 / Math.PI;
    scaleY = (a * d - b * c) / scaleX;
    skewX = Math.atan((a * c + b * d) / scaleX) * 180 / Math.PI;
  } else {
    scaleY = Math.hypot(c, d);
    rotation = scaleY > MATRIX_EPSILON ? Math.atan2(-c, d) * 180 / Math.PI : 0;
    skewX = 0;
  }

  const transform: Transform = { x, y, scaleX, scaleY, rotation, skewX, skewY: 0 };
  if (!Object.values(transform).every(Number.isFinite)
    || Math.abs(x) > MAX_TRANSLATION
    || Math.abs(y) > MAX_TRANSLATION
    || Math.abs(scaleX) > MAX_SCALE
    || Math.abs(scaleY) > MAX_SCALE
    || Math.abs(skewX) > MAX_SKEW) return undefined;
  return transform;
}

export interface AidrawPsdTextGeometry {
  transform: Transform;
  width: number;
  height: number;
}

/**
 * Recovers only the private geometry convention written by AIDraw. General
 * Photoshop text-box interpretation remains with the established PSD adapter.
 */
export function aidrawPsdTextGeometry(
  layerName: unknown,
  transformValue: unknown,
  boxBoundsValue: unknown,
  firstFontSize: number,
): AidrawPsdTextGeometry | undefined {
  if (typeof layerName !== 'string' || !layerName.endsWith(AIDRAW_PSD_EDITABLE_TEXT_SUFFIX)
    || !Array.isArray(transformValue) || transformValue.length < 6
    || !Array.isArray(boxBoundsValue) || boxBoundsValue.length < 4
    || !Number.isFinite(firstFontSize) || firstFontSize < 1 || firstFontSize > 500) return undefined;

  const matrix = transformValue.slice(0, 6);
  const bounds = boxBoundsValue.slice(0, 4);
  if (!finiteNumbers(matrix) || !finiteNumbers(bounds) || bounds[0] !== 0 || bounds[1] !== 0) return undefined;
  const width = bounds[2];
  const height = bounds[3];
  if (!(width > 0 && width <= MAX_TEXT_DIMENSION && height > 0 && height <= MAX_TEXT_DIMENSION)) return undefined;

  const [a, b, c, d, baselineX, baselineY] = matrix as unknown as AffineMatrix;
  const transform = transformFromMatrix([a, b, c, d, baselineX - c * firstFontSize, baselineY - d * firstFontSize]);
  return transform ? { transform, width, height } : undefined;
}
