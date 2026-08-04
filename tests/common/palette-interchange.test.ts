import { describe, expect, it } from 'vitest';
import type { PaletteEntry } from '@aidraw/core';
import { applyPortablePalette, parsePaletteFile, serializePaletteFile } from '../../src/common/palette-interchange';

const current: PaletteEntry[] = [
  { id: 'transparent', name: 'Transparent', color: '#00000000' },
  { id: 'one', name: 'Ink', color: '#111111' },
  { id: 'two', name: 'Paper', color: '#eeeeee' },
];

describe('palette interchange', () => {
  it('round-trips portable JSON without exporting internal IDs', () => {
    const encoded = serializePaletteFile('Pocket', current, 'json');
    expect(encoded).not.toContain('"id"');
    expect(parsePaletteFile(Buffer.from(encoded), '.json')).toMatchObject({
      format: 'json', name: 'Pocket', entries: current.map(({ name, color }) => ({ name, color })), warnings: [],
    });
  });

  it('round-trips GPL order while reserving transparent index zero', () => {
    const parsed = parsePaletteFile(Buffer.from(serializePaletteFile('Pocket', current, 'gpl')), 'gpl');
    expect(parsed.name).toBe('Pocket');
    expect(parsed.entries).toEqual([
      { name: 'Transparent', color: '#00000000' },
      { name: 'Ink', color: '#111111' },
      { name: 'Paper', color: '#eeeeee' },
    ]);
    expect(parsed.warnings).toContain('Inserted AIDraw transparent index 0; GPL stores RGB colors only.');
  });

  it('replaces colors by index without changing IDs or deleting trailing slots', () => {
    const applied = applyPortablePalette(current, [
      { name: 'Clear', color: '#ffffff00' },
      { name: 'Red', color: '#ff0000' },
    ], 'replace-slots', () => 'new');
    expect(applied.palette).toEqual([
      { id: 'transparent', name: 'Clear', color: '#ffffff00' },
      { id: 'one', name: 'Red', color: '#ff0000' },
      current[2],
    ]);
    expect(applied.warnings[0]).toContain('trailing slot');
  });

  it('appends unique colors within the indexed limit', () => {
    let next = 0;
    const applied = applyPortablePalette(current, [
      { name: 'Transparent', color: '#00000000' },
      { name: 'Ink duplicate', color: '#111111' },
      { name: 'Mint', color: '#22cc99' },
    ], 'append-unique', () => `new-${next++}`);
    expect(applied.palette.at(-1)).toEqual({ id: 'new-0', name: 'Mint', color: '#22cc99' });
    expect(applied).toMatchObject({ added: 1, skipped: 1 });
  });

  it('rejects malformed, oversized, and over-capacity inputs', () => {
    expect(() => parsePaletteFile(Buffer.from('{'), 'json')).toThrow('malformed');
    expect(() => parsePaletteFile(Buffer.alloc(1024 * 1024 + 1), 'json')).toThrow('safety limit');
    const entries = Array.from({ length: 257 }, () => '#000000');
    expect(() => parsePaletteFile(Buffer.from(JSON.stringify(entries)), 'json')).toThrow('at most 256');
    expect(() => parsePaletteFile(Buffer.from('GIMP Palette\n999 0 0 Nope\n'), 'gpl')).toThrow('outside 0–255');
  });
});
