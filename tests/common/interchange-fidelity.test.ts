import { describe, expect, it } from 'vitest';
import {
  MAX_INTERCHANGE_FIDELITY_ENTRIES,
  interchangeFidelityCodeLabel,
  isInterchangeFidelityEntry,
  normalizeInterchangeFidelityEntries,
  tryAppendInterchangeFidelityEntry,
} from '@common/interchange-fidelity';

describe('interchange fidelity reasons', () => {
  const valid = {
    code: 'raster-fallback' as const,
    subjectType: 'object' as const,
    subjectId: 'object-1',
    subjectName: 'Gradient title',
    detail: 'The gradient requires a raster fallback.',
  };

  it('accepts only the closed bounded reason shape', () => {
    expect(isInterchangeFidelityEntry(valid)).toBe(true);
    expect(isInterchangeFidelityEntry({ ...valid, code: 'adapter-made-this-up' })).toBe(false);
    expect(isInterchangeFidelityEntry({ ...valid, surprise: true })).toBe(false);
    expect(isInterchangeFidelityEntry({ ...valid, subjectId: '' })).toBe(false);
    expect(isInterchangeFidelityEntry({ ...valid, detail: 'x'.repeat(4_097) })).toBe(false);
    let getterReads = 0;
    const accessor = Object.defineProperty({ ...valid }, 'detail', { enumerable: true, get: () => { getterReads += 1; return 'trap'; } });
    expect(isInterchangeFidelityEntry(accessor)).toBe(false);
    expect(getterReads).toBe(0);
  });

  it('normalizes legacy and corrupt persisted values without retaining aliases', () => {
    const source = [{ ...valid }, { ...valid, code: 'unknown' }];
    const normalized = normalizeInterchangeFidelityEntries(source);
    expect(normalized).toEqual([valid]);
    expect(normalized[0]).not.toBe(source[0]);
    expect(normalizeInterchangeFidelityEntries(undefined)).toEqual([]);
    expect(interchangeFidelityCodeLabel(valid.code)).toBe('Raster fallback');
    expect(interchangeFidelityCodeLabel('blend-mode-substitution')).toBe('Blend mode substitution');
  });

  it('caps producer entries without replacing an already-recorded reason', () => {
    const entries = Array.from({ length: MAX_INTERCHANGE_FIDELITY_ENTRIES }, () => ({ ...valid }));
    expect(tryAppendInterchangeFidelityEntry(entries, { ...valid, subjectId: 'overflow' })).toBe(false);
    expect(entries).toHaveLength(MAX_INTERCHANGE_FIDELITY_ENTRIES);
    expect(entries.at(-1)?.subjectId).toBe(valid.subjectId);
  });
});
