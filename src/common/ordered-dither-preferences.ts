import { normalizeOrderedDitherPhase, type OrderedDitherMatrixSize } from '@aidraw/core';

export const MAX_ORDERED_DITHER_PRESETS = 32;
export const MAX_ORDERED_DITHER_PRESET_ID_LENGTH = 128;
export const MAX_ORDERED_DITHER_PRESET_NAME_LENGTH = 64;
export const MAX_ORDERED_DITHER_PHASE_INPUT = 8_192;

export interface OrderedDitherConfiguration {
  matrixSize: OrderedDitherMatrixSize;
  coverage: number;
  /** Normalized matrix-local X phase in the range 0 through matrixSize - 1. */
  phaseX: number;
  /** Normalized matrix-local Y phase in the range 0 through matrixSize - 1. */
  phaseY: number;
}

export interface OrderedDitherPreset extends OrderedDitherConfiguration {
  id: string;
  name: string;
}

export interface OrderedDitherPreferences {
  current: OrderedDitherConfiguration;
  presets: OrderedDitherPreset[];
  activePresetId: string | null;
}

export interface OrderedDitherPhaseDraft {
  /** Matrix size against which the authoritative value was last observed. */
  matrixSize: OrderedDitherMatrixSize;
  /** Last normalized value admitted by the human-local preference authority. */
  authoritativeValue: number;
  /** Exact keyboard draft. Intermediate and invalid text stays local until commit. */
  text: string;
}

export type OrderedDitherPhaseDraftCommit =
  | { status: 'committed'; draft: OrderedDitherPhaseDraft; preferences: OrderedDitherPreferences }
  | { status: 'cancelled'; draft: OrderedDitherPhaseDraft; preferences: OrderedDitherPreferences }
  | { status: 'invalid'; draft: OrderedDitherPhaseDraft; preferences: OrderedDitherPreferences; message: string };

export const DEFAULT_ORDERED_DITHER_PREFERENCES: Readonly<OrderedDitherPreferences> = Object.freeze({
  current: Object.freeze({ matrixSize: 4, coverage: 0.5, phaseX: 0, phaseY: 0 }),
  presets: Object.freeze([]) as unknown as OrderedDitherPreset[],
  activePresetId: null,
});

const PREFERENCE_KEYS = new Set(['current', 'presets', 'activePresetId']);
const CONFIGURATION_KEYS = new Set(['matrixSize', 'coverage', 'phaseX', 'phaseY']);
const PRESET_KEYS = new Set(['id', 'name', ...CONFIGURATION_KEYS]);

function isMatrixSize(value: unknown): value is OrderedDitherMatrixSize {
  return value === 2 || value === 4 || value === 8;
}

function exactKeys(source: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(source);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function validCoverage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validPresetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ORDERED_DITHER_PRESET_ID_LENGTH;
}

function parseConfiguration(value: unknown): OrderedDitherConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ordered dither preferences.');
  const source = value as Record<string, unknown>;
  if (!exactKeys(source, CONFIGURATION_KEYS) || !isMatrixSize(source.matrixSize) || !validCoverage(source.coverage)
    || !Number.isSafeInteger(source.phaseX) || Number(source.phaseX) < 0 || Number(source.phaseX) >= source.matrixSize
    || !Number.isSafeInteger(source.phaseY) || Number(source.phaseY) < 0 || Number(source.phaseY) >= source.matrixSize) {
    throw new Error('Invalid ordered dither preferences.');
  }
  return {
    matrixSize: source.matrixSize,
    coverage: source.coverage,
    phaseX: Object.is(source.phaseX, -0) ? 0 : Number(source.phaseX),
    phaseY: Object.is(source.phaseY, -0) ? 0 : Number(source.phaseY),
  };
}

function parsePreset(value: unknown): OrderedDitherPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ordered dither preferences.');
  const source = value as Record<string, unknown>;
  if (!exactKeys(source, PRESET_KEYS) || !validPresetId(source.id)
    || typeof source.name !== 'string' || source.name.length < 1 || source.name.length > MAX_ORDERED_DITHER_PRESET_NAME_LENGTH
    || source.name.trim() !== source.name) throw new Error('Invalid ordered dither preferences.');
  return { id: source.id, name: source.name, ...parseConfiguration({
    matrixSize: source.matrixSize,
    coverage: source.coverage,
    phaseX: source.phaseX,
    phaseY: source.phaseY,
  }) };
}

export function orderedDitherConfigurationsEqual(a: OrderedDitherConfiguration, b: OrderedDitherConfiguration): boolean {
  return a.matrixSize === b.matrixSize && a.coverage === b.coverage && a.phaseX === b.phaseX && a.phaseY === b.phaseY;
}

export function createOrderedDitherPhaseDraft(
  authoritativeValue: number,
  matrixSize: OrderedDitherMatrixSize,
): OrderedDitherPhaseDraft {
  if (!isMatrixSize(matrixSize) || !Number.isSafeInteger(authoritativeValue)
    || authoritativeValue < 0 || authoritativeValue >= matrixSize) {
    throw new Error('The authoritative ordered dither phase is invalid.');
  }
  return { matrixSize, authoritativeValue, text: String(authoritativeValue) };
}

/** Preserve a keyboard draft only while it still belongs to the observed matrix-local authority. */
export function reconcileOrderedDitherPhaseDraft(
  draft: OrderedDitherPhaseDraft,
  authoritativeValue: number,
  matrixSize: OrderedDitherMatrixSize,
): OrderedDitherPhaseDraft {
  return draft.matrixSize === matrixSize && draft.authoritativeValue === authoritativeValue
    ? draft
    : createOrderedDitherPhaseDraft(authoritativeValue, matrixSize);
}

export function withOrderedDitherPhaseDraftText(
  draft: OrderedDitherPhaseDraft,
  text: string,
): OrderedDitherPhaseDraft {
  return { ...draft, text };
}

/**
 * Commit one local keyboard draft. Blank/sign-only drafts cancel; malformed or
 * out-of-policy text is rejected; admitted signed integers normalize through
 * the same complete preference transition used by every other dither control.
 */
export function commitOrderedDitherPhaseDraft(
  preferences: OrderedDitherPreferences,
  axis: 'phaseX' | 'phaseY',
  draft: OrderedDitherPhaseDraft,
): OrderedDitherPhaseDraftCommit {
  const admitted = parseOrderedDitherPreferences(preferences);
  const authoritativeDraft = reconcileOrderedDitherPhaseDraft(
    draft,
    admitted.current[axis],
    admitted.current.matrixSize,
  );
  if (authoritativeDraft !== draft) {
    return { status: 'cancelled', draft: authoritativeDraft, preferences };
  }

  const text = draft.text.trim();
  if (text === '' || text === '-' || text === '+') {
    return {
      status: 'cancelled',
      draft: createOrderedDitherPhaseDraft(admitted.current[axis], admitted.current.matrixSize),
      preferences,
    };
  }
  if (!/^[+-]?\d+$/.test(text)) {
    return {
      status: 'invalid',
      draft: createOrderedDitherPhaseDraft(admitted.current[axis], admitted.current.matrixSize),
      preferences,
      message: `Ordered dither phase must be a whole-cell integer from -${MAX_ORDERED_DITHER_PHASE_INPUT} through ${MAX_ORDERED_DITHER_PHASE_INPUT}.`,
    };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_ORDERED_DITHER_PHASE_INPUT) {
    return {
      status: 'invalid',
      draft: createOrderedDitherPhaseDraft(admitted.current[axis], admitted.current.matrixSize),
      preferences,
      message: `Ordered dither phase must be a whole-cell integer from -${MAX_ORDERED_DITHER_PHASE_INPUT} through ${MAX_ORDERED_DITHER_PHASE_INPUT}.`,
    };
  }
  const next = withOrderedDitherConfiguration(admitted, { [axis]: value });
  return {
    status: 'committed',
    draft: createOrderedDitherPhaseDraft(next.current[axis], next.current.matrixSize),
    preferences: next,
  };
}

/** Strictly admit one complete renderer-independent human-local dither preference value. */
export function parseOrderedDitherPreferences(value: unknown): OrderedDitherPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ordered dither preferences.');
  const source = value as Record<string, unknown>;
  if (!exactKeys(source, PREFERENCE_KEYS) || !Array.isArray(source.presets) || source.presets.length > MAX_ORDERED_DITHER_PRESETS
    || !(source.activePresetId === null || validPresetId(source.activePresetId))) {
    throw new Error('Invalid ordered dither preferences.');
  }
  const current = parseConfiguration(source.current);
  const presets = source.presets.map(parsePreset);
  for (let index = 0; index < presets.length; index += 1) {
    const preset = presets[index];
    if (presets.slice(0, index).some((candidate) => candidate.id === preset.id || candidate.name === preset.name)) {
      throw new Error('Invalid ordered dither preferences.');
    }
  }
  const activePresetId = source.activePresetId as string | null;
  const activePreset = activePresetId === null ? undefined : presets.find((preset) => preset.id === activePresetId);
  if (activePresetId !== null && (!activePreset || !orderedDitherConfigurationsEqual(current, activePreset))) {
    throw new Error('Invalid ordered dither preferences.');
  }
  return { current, presets, activePresetId };
}

/** Admit a bounded signed whole-cell input and return its deterministic matrix-local configuration. */
export function normalizeOrderedDitherConfiguration(value: OrderedDitherConfiguration): OrderedDitherConfiguration {
  if (!isMatrixSize(value.matrixSize) || !validCoverage(value.coverage)
    || !Number.isSafeInteger(value.phaseX) || Math.abs(value.phaseX) > MAX_ORDERED_DITHER_PHASE_INPUT
    || !Number.isSafeInteger(value.phaseY) || Math.abs(value.phaseY) > MAX_ORDERED_DITHER_PHASE_INPUT) {
    throw new Error(`Ordered dither phase must be a whole-cell integer from -${MAX_ORDERED_DITHER_PHASE_INPUT} through ${MAX_ORDERED_DITHER_PHASE_INPUT}.`);
  }
  return {
    matrixSize: value.matrixSize,
    coverage: value.coverage,
    phaseX: normalizeOrderedDitherPhase(value.phaseX, value.matrixSize),
    phaseY: normalizeOrderedDitherPhase(value.phaseY, value.matrixSize),
  };
}

export function withOrderedDitherConfiguration(
  preferences: OrderedDitherPreferences,
  update: Partial<OrderedDitherConfiguration>,
): OrderedDitherPreferences {
  const admitted = parseOrderedDitherPreferences(preferences);
  const current = normalizeOrderedDitherConfiguration({ ...admitted.current, ...update });
  const activePreset = admitted.activePresetId === null ? undefined : admitted.presets.find((preset) => preset.id === admitted.activePresetId);
  return {
    current,
    presets: admitted.presets,
    activePresetId: activePreset && orderedDitherConfigurationsEqual(current, activePreset) ? activePreset.id : null,
  };
}

export function orderedDitherPresetNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return 'Enter a preset name.';
  if (name.length > MAX_ORDERED_DITHER_PRESET_NAME_LENGTH) return `Preset names must be at most ${MAX_ORDERED_DITHER_PRESET_NAME_LENGTH} characters.`;
  return undefined;
}

export function withSavedOrderedDitherPreset(
  preferences: OrderedDitherPreferences,
  identity: { id: string; name: string },
): OrderedDitherPreferences {
  const admitted = parseOrderedDitherPreferences(preferences);
  const name = identity.name.trim();
  const nameError = orderedDitherPresetNameError(name);
  if (nameError) throw new Error(nameError);
  if (!validPresetId(identity.id)) throw new Error('The dither preset identity is invalid.');
  if (admitted.presets.length >= MAX_ORDERED_DITHER_PRESETS) throw new Error(`Dither presets are limited to ${MAX_ORDERED_DITHER_PRESETS}. Delete one before saving another.`);
  if (admitted.presets.some((preset) => preset.id === identity.id || preset.name === name)) throw new Error('A dither preset with this name or identity already exists.');
  const preset: OrderedDitherPreset = { id: identity.id, name, ...admitted.current };
  return { current: admitted.current, presets: [...admitted.presets, preset], activePresetId: preset.id };
}

export function withAppliedOrderedDitherPreset(preferences: OrderedDitherPreferences, presetId: string): OrderedDitherPreferences {
  const admitted = parseOrderedDitherPreferences(preferences);
  const preset = admitted.presets.find((entry) => entry.id === presetId);
  if (!preset) throw new Error('The selected dither preset no longer exists.');
  return {
    current: { matrixSize: preset.matrixSize, coverage: preset.coverage, phaseX: preset.phaseX, phaseY: preset.phaseY },
    presets: admitted.presets,
    activePresetId: preset.id,
  };
}

export function withoutOrderedDitherPreset(preferences: OrderedDitherPreferences, presetId: string): OrderedDitherPreferences {
  const admitted = parseOrderedDitherPreferences(preferences);
  if (!admitted.presets.some((preset) => preset.id === presetId)) throw new Error('The selected dither preset no longer exists.');
  return {
    current: admitted.current,
    presets: admitted.presets.filter((preset) => preset.id !== presetId),
    activePresetId: admitted.activePresetId === presetId ? null : admitted.activePresetId,
  };
}
