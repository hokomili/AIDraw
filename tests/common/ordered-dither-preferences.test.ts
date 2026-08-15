import { describe, expect, it } from 'vitest';
import {
  commitOrderedDitherPhaseDraft,
  createOrderedDitherPhaseDraft,
  DEFAULT_ORDERED_DITHER_PREFERENCES,
  MAX_ORDERED_DITHER_PRESETS,
  normalizeOrderedDitherConfiguration,
  parseOrderedDitherPreferences,
  reconcileOrderedDitherPhaseDraft,
  withAppliedOrderedDitherPreset,
  withOrderedDitherConfiguration,
  withOrderedDitherPhaseDraftText,
  withSavedOrderedDitherPreset,
  withoutOrderedDitherPreset,
  type OrderedDitherPreferences,
} from '../../src/common/ordered-dither-preferences';

function defaults(): OrderedDitherPreferences {
  return { current: { ...DEFAULT_ORDERED_DITHER_PREFERENCES.current }, presets: [], activePresetId: null };
}

describe('human-local ordered dither preferences', () => {
  it('normalizes signed phase in matrix-local coordinates and visibly renormalizes on matrix changes', () => {
    expect(normalizeOrderedDitherConfiguration({ matrixSize: 4, coverage: 0.5, phaseX: -1, phaseY: 9 })).toEqual({ matrixSize: 4, coverage: 0.5, phaseX: 3, phaseY: 1 });
    const eight = withOrderedDitherConfiguration(defaults(), { matrixSize: 8, phaseX: 7, phaseY: 6 });
    expect(eight.current).toEqual({ matrixSize: 8, coverage: 0.5, phaseX: 7, phaseY: 6 });
    expect(withOrderedDitherConfiguration(eight, { matrixSize: 4 }).current).toEqual({ matrixSize: 4, coverage: 0.5, phaseX: 3, phaseY: 2 });
    expect(() => normalizeOrderedDitherConfiguration({ matrixSize: 4, coverage: 0.5, phaseX: 8_193, phaseY: 0 })).toThrow('whole-cell integer');
  });

  it('keeps intermediate signed and multi-digit keyboard drafts local until an explicit normalized commit', () => {
    const initial = defaults();
    let negative = createOrderedDitherPhaseDraft(initial.current.phaseX, initial.current.matrixSize);
    for (const text of ['', '-', '-1', '-13']) {
      negative = withOrderedDitherPhaseDraftText(negative, text);
      expect(negative.text).toBe(text);
      expect(initial.current).toEqual(DEFAULT_ORDERED_DITHER_PREFERENCES.current);
    }
    const committedNegative = commitOrderedDitherPhaseDraft(initial, 'phaseX', negative);
    expect(committedNegative).toMatchObject({
      status: 'committed',
      draft: { matrixSize: 4, authoritativeValue: 3, text: '3' },
      preferences: { current: { matrixSize: 4, coverage: 0.5, phaseX: 3, phaseY: 0 } },
    });

    let multiDigit = createOrderedDitherPhaseDraft(initial.current.phaseY, initial.current.matrixSize);
    multiDigit = withOrderedDitherPhaseDraftText(multiDigit, '1');
    expect(multiDigit.text).toBe('1');
    multiDigit = withOrderedDitherPhaseDraftText(multiDigit, '12');
    expect(multiDigit.text).toBe('12');
    expect(commitOrderedDitherPhaseDraft(initial, 'phaseY', multiDigit)).toMatchObject({
      status: 'committed',
      draft: { authoritativeValue: 0, text: '0' },
      preferences: { current: { phaseY: 0 } },
    });
  });

  it('cancels intermediate drafts, rejects invalid drafts, and discards stale drafts on a matrix change', () => {
    const initial = defaults();
    const signOnly = withOrderedDitherPhaseDraftText(
      createOrderedDitherPhaseDraft(initial.current.phaseX, initial.current.matrixSize),
      '-',
    );
    const cancelled = commitOrderedDitherPhaseDraft(initial, 'phaseX', signOnly);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.preferences).toBe(initial);
    expect(cancelled.draft.text).toBe('0');

    const fractional = commitOrderedDitherPhaseDraft(initial, 'phaseX', withOrderedDitherPhaseDraftText(signOnly, '1.5'));
    expect(fractional.status).toBe('invalid');
    expect(fractional.preferences).toBe(initial);
    expect(fractional).toMatchObject({ message: expect.stringContaining('whole-cell integer') });
    const overflow = commitOrderedDitherPhaseDraft(initial, 'phaseX', withOrderedDitherPhaseDraftText(signOnly, '8193'));
    expect(overflow.status).toBe('invalid');
    expect(overflow.preferences).toBe(initial);

    const inProgress = withOrderedDitherPhaseDraftText(signOnly, '-5');
    const eight = withOrderedDitherConfiguration(initial, { matrixSize: 8 });
    expect(reconcileOrderedDitherPhaseDraft(inProgress, eight.current.phaseX, eight.current.matrixSize)).toEqual({
      matrixSize: 8,
      authoritativeValue: 0,
      text: '0',
    });
    const staleCommit = commitOrderedDitherPhaseDraft(eight, 'phaseX', inProgress);
    expect(staleCommit.status).toBe('cancelled');
    expect(staleCommit.preferences).toBe(eight);
  });

  it('strictly admits complete normalized presets without palette identity or partial durable state', () => {
    const valid: OrderedDitherPreferences = {
      current: { matrixSize: 8, coverage: 0.375, phaseX: 7, phaseY: 2 },
      presets: [{ id: 'preset-a', name: 'Fine shade', matrixSize: 8, coverage: 0.375, phaseX: 7, phaseY: 2 }],
      activePresetId: 'preset-a',
    };
    expect(parseOrderedDitherPreferences(valid)).toEqual(valid);
    expect(JSON.stringify(valid)).not.toMatch(/palette|baseIndex|mixIndex|color/i);
    expect(() => parseOrderedDitherPreferences({ ...valid, current: { ...valid.current, phaseX: -1 } })).toThrow('Invalid ordered dither preferences.');
    expect(() => parseOrderedDitherPreferences({ ...valid, current: { ...valid.current, mixIndex: 4 } })).toThrow('Invalid ordered dither preferences.');
    expect(() => parseOrderedDitherPreferences({ ...valid, presets: [{ ...valid.presets[0], baseIndex: 2 }] })).toThrow('Invalid ordered dither preferences.');
    expect(() => parseOrderedDitherPreferences({ ...valid, activePresetId: null, surprise: true })).toThrow('Invalid ordered dither preferences.');
    expect(() => parseOrderedDitherPreferences({ ...valid, current: { ...valid.current, coverage: 0.5 } })).toThrow('Invalid ordered dither preferences.');
  });

  it('saves, applies, diverges from, and deletes bounded named presets without palette choices', () => {
    const configured = withOrderedDitherConfiguration(defaults(), { matrixSize: 8, coverage: 0.25, phaseX: -1, phaseY: 10 });
    const saved = withSavedOrderedDitherPreset(configured, { id: 'preset-one', name: ' Edge shade ' });
    expect(saved).toEqual({
      current: { matrixSize: 8, coverage: 0.25, phaseX: 7, phaseY: 2 },
      presets: [{ id: 'preset-one', name: 'Edge shade', matrixSize: 8, coverage: 0.25, phaseX: 7, phaseY: 2 }],
      activePresetId: 'preset-one',
    });
    const custom = withOrderedDitherConfiguration(saved, { coverage: 0.5 });
    expect(custom.activePresetId).toBeNull();
    expect(withAppliedOrderedDitherPreset(custom, 'preset-one')).toEqual(saved);
    expect(withoutOrderedDitherPreset(saved, 'preset-one')).toEqual({ current: saved.current, presets: [], activePresetId: null });
    expect(() => withSavedOrderedDitherPreset(saved, { id: 'preset-two', name: 'Edge shade' })).toThrow('already exists');
  });

  it('enforces the preset capacity before changing live configuration', () => {
    const full: OrderedDitherPreferences = {
      ...defaults(),
      presets: Array.from({ length: MAX_ORDERED_DITHER_PRESETS }, (_, index) => ({
        id: `preset-${index}`,
        name: `Preset ${index}`,
        matrixSize: 4 as const,
        coverage: index / MAX_ORDERED_DITHER_PRESETS,
        phaseX: index % 4,
        phaseY: Math.floor(index / 4) % 4,
      })),
    };
    expect(() => withSavedOrderedDitherPreset(full, { id: 'overflow', name: 'Overflow' })).toThrow(`limited to ${MAX_ORDERED_DITHER_PRESETS}`);
    expect(full.current).toEqual(DEFAULT_ORDERED_DITHER_PREFERENCES.current);
  });
});
