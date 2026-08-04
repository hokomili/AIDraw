import type { PaletteEntry } from '@aidraw/core';

export const MAX_PALETTE_FILE_BYTES = 1024 * 1024;
export const MAX_PALETTE_ENTRIES = 256;

export type PaletteFileFormat = 'json' | 'gpl';
export type PaletteImportMode = 'replace-slots' | 'append-unique';

export interface PortablePaletteEntry {
  name: string;
  color: string;
}

export interface ParsedPaletteFile {
  format: PaletteFileFormat;
  name: string;
  entries: PortablePaletteEntry[];
  warnings: string[];
}

export interface AppliedPaletteImport {
  palette: PaletteEntry[];
  added: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((part) => part.repeat(2)).join('')}`.toLowerCase();
  if (/^#[0-9a-f]{4}$/i.test(color)) return `#${[...color.slice(1)].map((part) => part.repeat(2)).join('')}`.toLowerCase();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return color.toLowerCase();
  return undefined;
}

function alphaOf(color: string): number {
  return color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255;
}

function opaque(color: string): string {
  return color.slice(0, 7);
}

function normalizeEntries(entries: PortablePaletteEntry[], sourceHasAlpha: boolean): { entries: PortablePaletteEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const firstTransparent = entries.findIndex((entry) => alphaOf(entry.color) === 0);
  let normalized = entries;
  if (firstTransparent === 0) {
    normalized = [{ ...entries[0], color: `${opaque(entries[0].color)}00` }, ...entries.slice(1)];
  } else {
    if (firstTransparent > 0) warnings.push(`Moved transparent color ${firstTransparent} to required palette index 0.`);
    const transparent = firstTransparent > 0 ? entries[firstTransparent] : { name: 'Transparent', color: '#00000000' };
    normalized = [
      { ...transparent, color: `${opaque(transparent.color)}00` },
      ...entries.filter((_entry, index) => index !== firstTransparent),
    ];
    if (!sourceHasAlpha) warnings.push('Inserted AIDraw transparent index 0; GPL stores RGB colors only.');
    else if (firstTransparent < 0) warnings.push('Inserted required transparent palette index 0.');
  }
  if (normalized.length > MAX_PALETTE_ENTRIES) throw new Error(`Palette contains ${normalized.length} entries after reserving transparent index 0; AIDraw supports at most ${MAX_PALETTE_ENTRIES}.`);
  return { entries: normalized, warnings };
}

function portableEntry(value: unknown, index: number): PortablePaletteEntry {
  const object = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  const rawColor = typeof value === 'string' ? value : object?.color ?? object?.hex;
  const color = normalizeHexColor(rawColor);
  if (!color) throw new Error(`Palette entry ${index} must contain a #RGB, #RGBA, #RRGGBB, or #RRGGBBAA color.`);
  const rawName = object?.name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 120) : `Color ${index}`;
  return { name, color };
}

function parseJsonPalette(text: string): ParsedPaletteFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Palette JSON is malformed.'); }
  const object = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (object?.format !== undefined && object.format !== 'aidraw-palette') throw new Error('Palette JSON declares an unsupported format.');
  if (object?.version !== undefined && object.version !== 1) throw new Error(`Unsupported AIDraw palette version: ${String(object.version)}.`);
  const values = Array.isArray(value) ? value : Array.isArray(object?.entries) ? object.entries : Array.isArray(object?.palette) ? object.palette : Array.isArray(object?.colors) ? object.colors : undefined;
  if (!values?.length) throw new Error('Palette JSON must contain a non-empty entries, palette, or colors array.');
  if (values.length > MAX_PALETTE_ENTRIES) throw new Error(`Palette declares ${values.length} entries; AIDraw supports at most ${MAX_PALETTE_ENTRIES}.`);
  const entries = values.map(portableEntry);
  const normalized = normalizeEntries(entries, true);
  return {
    format: 'json',
    name: typeof object?.name === 'string' && object.name.trim() ? object.name.trim().slice(0, 120) : 'Imported palette',
    entries: normalized.entries,
    warnings: normalized.warnings,
  };
}

function parseGplPalette(text: string): ParsedPaletteFile {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== 'GIMP Palette') throw new Error('GPL palette must start with “GIMP Palette”.');
  let name = 'Imported GPL palette';
  const entries: PortablePaletteEntry[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (/^name\s*:/i.test(line)) { name = line.slice(line.indexOf(':') + 1).trim().slice(0, 120) || name; continue; }
    if (/^columns\s*:/i.test(line)) continue;
    const match = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s+(.*))?$/);
    if (!match) throw new Error(`Malformed GPL color on line ${index + 1}.`);
    const channels = match.slice(1, 4).map(Number);
    if (channels.some((channel) => channel < 0 || channel > 255)) throw new Error(`GPL RGB value is outside 0–255 on line ${index + 1}.`);
    const color = `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    entries.push({ name: match[4]?.trim().slice(0, 120) || `Color ${entries.length + 1}`, color });
    if (entries.length >= MAX_PALETTE_ENTRIES) throw new Error(`GPL palette leaves no room for AIDraw's transparent index 0; use at most ${MAX_PALETTE_ENTRIES - 1} RGB colors.`);
  }
  if (!entries.length) throw new Error('GPL palette contains no colors.');
  const normalized = normalizeEntries(entries, false);
  return { format: 'gpl', name, entries: normalized.entries, warnings: normalized.warnings };
}

export function parsePaletteFile(bytes: Uint8Array, extension?: string): ParsedPaletteFile {
  if (!bytes.byteLength) throw new Error('Palette file is empty.');
  if (bytes.byteLength > MAX_PALETTE_FILE_BYTES) throw new Error(`Palette file exceeds the ${MAX_PALETTE_FILE_BYTES / 1024} KiB safety limit.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const normalizedExtension = extension?.toLowerCase().replace(/^\./, '');
  if (normalizedExtension === 'gpl' || text.replace(/^\uFEFF/, '').startsWith('GIMP Palette')) return parseGplPalette(text);
  return parseJsonPalette(text);
}

export function serializePaletteFile(name: string, palette: PaletteEntry[], format: PaletteFileFormat): string {
  if (!palette.length || palette.length > MAX_PALETTE_ENTRIES) throw new Error('Palette must contain from 1 to 256 entries.');
  if (format === 'json') return `${JSON.stringify({ format: 'aidraw-palette', version: 1, name, entries: palette.map(({ name: entryName, color }) => ({ name: entryName, color })) }, null, 2)}\n`;
  const safeName = name.replace(/[\r\n]+/g, ' ').trim() || 'AIDraw palette';
  const lines = ['GIMP Palette', `Name: ${safeName}`, 'Columns: 8', '# AIDraw transparent index 0 omitted; GPL has no alpha channel.'];
  for (const entry of palette.slice(1)) {
    const color = normalizeHexColor(entry.color);
    if (!color) throw new Error(`Palette entry ${entry.name} has an invalid color.`);
    const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    lines.push(`${channels.map((channel) => String(channel).padStart(3, ' ')).join(' ')}\t${entry.name.replace(/[\r\n\t]+/g, ' ').trim() || 'Color'}`);
  }
  return `${lines.join('\n')}\n`;
}

export function applyPortablePalette(current: PaletteEntry[], imported: PortablePaletteEntry[], mode: PaletteImportMode, createEntryId: () => string): AppliedPaletteImport {
  if (!current.length || current.length > MAX_PALETTE_ENTRIES) throw new Error('Current palette must contain from 1 to 256 entries.');
  const normalized = normalizeEntries(imported.map((entry, index) => portableEntry(entry, index)), true);
  const warnings = [...normalized.warnings];
  if (mode === 'append-unique') {
    const palette = structuredClone(current); const known = new Set(palette.map((entry) => entry.color.toLowerCase())); let added = 0; let skipped = 0;
    for (const entry of normalized.entries.slice(1)) {
      if (known.has(entry.color.toLowerCase())) { skipped += 1; continue; }
      if (palette.length >= MAX_PALETTE_ENTRIES) { skipped += 1; continue; }
      palette.push({ id: createEntryId(), ...entry }); known.add(entry.color.toLowerCase()); added += 1;
    }
    if (skipped) warnings.push(`Skipped ${skipped} duplicate or overflow color${skipped === 1 ? '' : 's'}.`);
    return { palette, added, updated: 0, skipped, warnings };
  }
  const palette = structuredClone(current); let added = 0; let updated = 0;
  normalized.entries.forEach((entry, index) => {
    const value = index === 0 ? { ...entry, color: `${opaque(entry.color)}00` } : entry;
    if (index < palette.length) { palette[index] = { ...palette[index], ...value }; updated += 1; }
    else { palette.push({ id: createEntryId(), ...value }); added += 1; }
  });
  if (normalized.entries.length < current.length) warnings.push(`Kept ${current.length - normalized.entries.length} trailing slot${current.length - normalized.entries.length === 1 ? '' : 's'} so importing colors never deletes indexed artwork.`);
  return { palette, added, updated, skipped: 0, warnings };
}
