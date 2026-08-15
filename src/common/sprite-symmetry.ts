export const SPRITE_SYMMETRY_MODES = ['none', 'horizontal', 'vertical', 'both'] as const;
export type SpriteSymmetryMode = (typeof SPRITE_SYMMETRY_MODES)[number];

export const MAX_SPRITE_SYMMETRY_BINDINGS = 128;
export const MAX_SPRITE_SYMMETRY_ID_LENGTH = 256;

export interface SpriteSymmetryAxisBinding {
  documentId: string;
  spriteId: string;
  width: number;
  height: number;
  /** Pixel-center X coordinate on the half-pixel grid. */
  horizontalAxis: number;
  /** Pixel-center Y coordinate on the half-pixel grid. */
  verticalAxis: number;
}

export interface SpriteSymmetryPreferences {
  mode: SpriteSymmetryMode;
  bindings: SpriteSymmetryAxisBinding[];
}

export interface EffectiveSpriteSymmetry {
  mode: SpriteSymmetryMode;
  horizontalAxis: number;
  verticalAxis: number;
  source: 'saved' | 'centered-default';
}

export const DEFAULT_SPRITE_SYMMETRY_PREFERENCES: Readonly<SpriteSymmetryPreferences> = Object.freeze({
  mode: 'none',
  bindings: Object.freeze([]) as unknown as SpriteSymmetryAxisBinding[],
});

const PREFERENCE_KEYS = new Set(['mode', 'bindings']);
const BINDING_KEYS = new Set(['documentId', 'spriteId', 'width', 'height', 'horizontalAxis', 'verticalAxis']);

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SPRITE_SYMMETRY_ID_LENGTH;
}

function validDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 8_192;
}

export function isHalfPixelAxis(value: unknown, dimension: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isSafeInteger(value * 2)
    && value >= 0
    && value <= dimension - 1;
}

function parseBinding(value: unknown): SpriteSymmetryAxisBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sprite symmetry preferences.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== BINDING_KEYS.size || keys.some((key) => !BINDING_KEYS.has(key))
    || !validId(source.documentId) || !validId(source.spriteId)
    || !validDimension(source.width) || !validDimension(source.height)
    || !isHalfPixelAxis(source.horizontalAxis, source.width)
    || !isHalfPixelAxis(source.verticalAxis, source.height)) {
    throw new Error('Invalid sprite symmetry preferences.');
  }
  return {
    documentId: source.documentId,
    spriteId: source.spriteId,
    width: source.width,
    height: source.height,
    horizontalAxis: Object.is(source.horizontalAxis, -0) ? 0 : source.horizontalAxis,
    verticalAxis: Object.is(source.verticalAxis, -0) ? 0 : source.verticalAxis,
  };
}

/** Strictly admit one complete renderer-independent human-local symmetry preference value. */
export function parseSpriteSymmetryPreferences(value: unknown): SpriteSymmetryPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sprite symmetry preferences.');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== PREFERENCE_KEYS.size || keys.some((key) => !PREFERENCE_KEYS.has(key))
    || !SPRITE_SYMMETRY_MODES.includes(source.mode as SpriteSymmetryMode)
    || !Array.isArray(source.bindings) || source.bindings.length > MAX_SPRITE_SYMMETRY_BINDINGS) {
    throw new Error('Invalid sprite symmetry preferences.');
  }
  const bindings = source.bindings.map(parseBinding);
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const duplicate = bindings.slice(0, index).some((candidate) => candidate.documentId === binding.documentId
      && candidate.spriteId === binding.spriteId
      && candidate.width === binding.width
      && candidate.height === binding.height);
    if (duplicate) throw new Error('Invalid sprite symmetry preferences.');
  }
  return { mode: source.mode as SpriteSymmetryMode, bindings };
}

export function centeredSpriteSymmetryAxes(width: number, height: number): Pick<EffectiveSpriteSymmetry, 'horizontalAxis' | 'verticalAxis'> {
  if (!validDimension(width) || !validDimension(height)) throw new Error('Sprite symmetry dimensions must be positive integers.');
  return { horizontalAxis: (width - 1) / 2, verticalAxis: (height - 1) / 2 };
}

export function effectiveSpriteSymmetry(
  preferences: SpriteSymmetryPreferences,
  target: Pick<SpriteSymmetryAxisBinding, 'documentId' | 'spriteId' | 'width' | 'height'>,
): EffectiveSpriteSymmetry {
  const admitted = parseSpriteSymmetryPreferences(preferences);
  if (!validDimension(target.width) || !validDimension(target.height)) {
    throw new Error('Invalid sprite symmetry target.');
  }
  const binding = validId(target.documentId) && validId(target.spriteId) ? admitted.bindings.find((entry) => entry.documentId === target.documentId
    && entry.spriteId === target.spriteId && entry.width === target.width && entry.height === target.height) : undefined;
  return binding
    ? { mode: admitted.mode, horizontalAxis: binding.horizontalAxis, verticalAxis: binding.verticalAxis, source: 'saved' }
    : { mode: admitted.mode, ...centeredSpriteSymmetryAxes(target.width, target.height), source: 'centered-default' };
}

export function withSpriteSymmetryMode(preferences: SpriteSymmetryPreferences, mode: SpriteSymmetryMode): SpriteSymmetryPreferences {
  return parseSpriteSymmetryPreferences({ ...preferences, mode });
}

export function withSpriteSymmetryAxes(
  preferences: SpriteSymmetryPreferences,
  binding: SpriteSymmetryAxisBinding,
): SpriteSymmetryPreferences {
  const admitted = parseSpriteSymmetryPreferences(preferences);
  const nextBinding = parseBinding(binding);
  const bindings = admitted.bindings.filter((entry) => !(entry.documentId === nextBinding.documentId
    && entry.spriteId === nextBinding.spriteId && entry.width === nextBinding.width && entry.height === nextBinding.height));
  bindings.push(nextBinding);
  if (bindings.length > MAX_SPRITE_SYMMETRY_BINDINGS) bindings.splice(0, bindings.length - MAX_SPRITE_SYMMETRY_BINDINGS);
  return { mode: admitted.mode, bindings };
}

/** Expand in input/variant order, then deterministically retain the last value for each addressed cell. */
export function expandSpriteSymmetry<T extends { x: number; y: number }>(
  points: readonly T[],
  symmetry: Pick<EffectiveSpriteSymmetry, 'mode' | 'horizontalAxis' | 'verticalAxis'>,
): T[] {
  if (symmetry.mode === 'none') return points.map((point) => ({ ...point }));
  const expanded: T[] = [];
  for (const point of points) {
    expanded.push({ ...point });
    if (symmetry.mode === 'horizontal' || symmetry.mode === 'both') expanded.push({ ...point, x: 2 * symmetry.horizontalAxis - point.x });
    if (symmetry.mode === 'vertical' || symmetry.mode === 'both') expanded.push({ ...point, y: 2 * symmetry.verticalAxis - point.y });
    if (symmetry.mode === 'both') expanded.push({ ...point, x: 2 * symmetry.horizontalAxis - point.x, y: 2 * symmetry.verticalAxis - point.y });
  }
  const unique = new Map<string, T>();
  for (const point of expanded) {
    const key = `${point.x},${point.y}`;
    if (unique.has(key)) unique.delete(key);
    unique.set(key, point);
  }
  return [...unique.values()];
}
