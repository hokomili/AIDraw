export const MAX_ONION_SKIN_FRAMES_PER_SIDE = 4;

export interface OnionSkinSettings {
  previousFrames: number;
  nextFrames: number;
  previousOpacity: number;
  nextOpacity: number;
  previousTint: string;
  nextTint: string;
}

export interface OnionSkinPreferences extends OnionSkinSettings {
  enabled: boolean;
}

export const DEFAULT_ONION_SKIN_SETTINGS: Readonly<OnionSkinSettings> = Object.freeze({
  previousFrames: 1,
  nextFrames: 1,
  previousOpacity: 0.22,
  nextOpacity: 0.18,
  previousTint: '#51bfc0',
  nextTint: '#ef7297',
});

export const DEFAULT_ONION_SKIN_PREFERENCES: Readonly<OnionSkinPreferences> = Object.freeze({
  enabled: true,
  ...DEFAULT_ONION_SKIN_SETTINGS,
});

export interface OnionSkinLayer {
  frameId: string;
  side: 'previous' | 'next';
  distance: number;
  opacity: number;
  tint: string;
}

export function validateOnionSkinSettings(settings: OnionSkinSettings): void {
  for (const [label, value] of [['Previous onion frame count', settings.previousFrames], ['Next onion frame count', settings.nextFrames]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_ONION_SKIN_FRAMES_PER_SIDE) throw new Error(`${label} must be an integer from 0 through ${MAX_ONION_SKIN_FRAMES_PER_SIDE}.`);
  }
  for (const [label, value] of [['Previous onion opacity', settings.previousOpacity], ['Next onion opacity', settings.nextOpacity]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`);
  }
  for (const [label, value] of [['Previous onion tint', settings.previousTint], ['Next onion tint', settings.nextTint]] as const) {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${label} must be a six-digit hex color.`);
  }
}

const ONION_SKIN_PREFERENCE_KEYS = new Set([
  'enabled',
  'previousFrames',
  'nextFrames',
  'previousOpacity',
  'nextOpacity',
  'previousTint',
  'nextTint',
]);

/** Strictly admit one complete renderer-independent onion preference value. */
export function parseOnionSkinPreferences(value: unknown): OnionSkinPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid onion skin preferences.');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== ONION_SKIN_PREFERENCE_KEYS.size
    || Object.keys(source).some((key) => !ONION_SKIN_PREFERENCE_KEYS.has(key))
    || typeof source.enabled !== 'boolean') throw new Error('Invalid onion skin preferences.');
  const settings: OnionSkinSettings = {
    previousFrames: source.previousFrames as number,
    nextFrames: source.nextFrames as number,
    previousOpacity: source.previousOpacity as number,
    nextOpacity: source.nextOpacity as number,
    previousTint: source.previousTint as string,
    nextTint: source.nextTint as string,
  };
  try { validateOnionSkinSettings(settings); }
  catch { throw new Error('Invalid onion skin preferences.'); }
  return { enabled: source.enabled, ...settings };
}

export function onionSkinLayers(frameIds: readonly string[], activeFrameId: string, settings: OnionSkinSettings): OnionSkinLayer[] {
  validateOnionSkinSettings(settings);
  const activeIndex = frameIds.indexOf(activeFrameId);
  if (activeIndex < 0) return [];
  const result: OnionSkinLayer[] = [];
  const previousCount = Math.min(settings.previousFrames, activeIndex);
  const nextCount = Math.min(settings.nextFrames, frameIds.length - activeIndex - 1);
  for (let distance = Math.max(previousCount, nextCount); distance >= 1; distance -= 1) {
    if (distance <= previousCount) result.push({ frameId: frameIds[activeIndex - distance], side: 'previous', distance, opacity: settings.previousOpacity / distance, tint: settings.previousTint });
    if (distance <= nextCount) result.push({ frameId: frameIds[activeIndex + distance], side: 'next', distance, opacity: settings.nextOpacity / distance, tint: settings.nextTint });
  }
  return result;
}
