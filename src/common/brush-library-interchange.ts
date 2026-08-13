import {
  BUILT_IN_RASTER_BRUSH_PRESETS,
  CanvasOperationSchema,
  createId,
  type CanvasOperation,
  type IllustrationDocument,
  type RasterBrushPreset,
} from '@aidraw/core';
import { z } from 'zod';

export const MAX_BRUSH_LIBRARY_BYTES = 1024 * 1024;

export interface BrushLibraryBundle {
  format: 'aidraw-brush-library';
  version: 1;
  presets: RasterBrushPreset[];
}

export type BrushLibraryImportMode = 'append' | 'replace';

export interface BrushLibraryImportPlan {
  mode: BrushLibraryImportMode;
  incomingCount: number;
  totalCount: number;
  importedIds: string[];
  operations: CanvasOperation[];
}

const EnvelopeSchema = z.object({
  format: z.literal('aidraw-brush-library'),
  version: z.literal(1),
  presets: z.unknown(),
}).strict();

const reservedIds = new Set(Object.keys(BUILT_IN_RASTER_BRUSH_PRESETS));

function firstIssue(result: { error: { issues: Array<{ message: string }> } }, fallback: string): Error {
  return new Error(result.error.issues[0]?.message ?? fallback);
}

function encodedBytes(text: string): number {
  if (text.length > MAX_BRUSH_LIBRARY_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

function assertSerializedBound(text: string): void {
  if (encodedBytes(text) > MAX_BRUSH_LIBRARY_BYTES) throw new Error('Brush library JSON is limited to 1 MiB.');
}

function validatePresets(value: unknown): RasterBrushPreset[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error('Brush libraries require at least one custom preset.');
  if (value.length > 256) throw new Error('Brush libraries are limited to 256 custom presets.');
  const result = CanvasOperationSchema.safeParse({ kind: 'illustration.brush-presets.replace', presets: value });
  if (!result.success) throw firstIssue(result, 'The brush library is invalid.');
  if (result.data.kind !== 'illustration.brush-presets.replace') throw new Error('The brush library is invalid.');
  for (const preset of result.data.presets) if (reservedIds.has(preset.id)) throw new Error(`Custom brush preset ID “${preset.id}” is reserved for a built-in brush.`);
  return structuredClone(result.data.presets);
}

export function parseBrushLibraryJson(text: string): BrushLibraryBundle {
  assertSerializedBound(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Brush library JSON is malformed.'); }
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) throw firstIssue(envelope, 'The brush library envelope is invalid.');
  return { ...envelope.data, presets: validatePresets(envelope.data.presets) };
}

export function serializeBrushLibrary(document: IllustrationDocument): string {
  const bundle: BrushLibraryBundle = { format: 'aidraw-brush-library', version: 1, presets: validatePresets(document.brushPresets) };
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  assertSerializedBound(text);
  return text;
}

function uniqueId(used: Set<string>, makeId: (prefix: string) => string): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const id = makeId('brush-preset');
    if (id && !used.has(id)) { used.add(id); return id; }
  }
  throw new Error('Could not allocate a unique imported brush preset ID.');
}

function uniqueName(name: string, used: Set<string>): string {
  const original = name.trim();
  if (!used.has(original.toLowerCase())) { used.add(original.toLowerCase()); return original; }
  for (let number = 2; number <= 1_024; number += 1) {
    const suffix = ` (import ${number})`;
    const candidate = `${original.slice(0, Math.max(1, 200 - suffix.length)).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
  }
  throw new Error(`Could not allocate a unique name for “${name}”.`);
}

export function prepareBrushLibraryImport(
  document: IllustrationDocument,
  bundle: BrushLibraryBundle,
  mode: BrushLibraryImportMode,
  options: { makeId?: (prefix: string) => string } = {},
): BrushLibraryImportPlan {
  if (mode !== 'append' && mode !== 'replace') throw new Error('Unknown brush library import behavior.');
  const imported = validatePresets(bundle.presets);
  let presets: RasterBrushPreset[];
  let importedIds: string[];
  if (mode === 'replace') {
    presets = imported;
    importedIds = imported.map((preset) => preset.id);
  } else {
    const usedIds = new Set([...reservedIds, ...document.brushPresets.map((preset) => preset.id)]);
    const usedNames = new Set(document.brushPresets.map((preset) => preset.name.toLowerCase()));
    const makeId = options.makeId ?? createId;
    const copies = imported.map((preset) => ({ ...structuredClone(preset), id: uniqueId(usedIds, makeId), name: uniqueName(preset.name, usedNames) }));
    presets = [...structuredClone(document.brushPresets), ...copies];
    importedIds = copies.map((preset) => preset.id);
  }
  if (presets.length > 256) throw new Error('Brush libraries are limited to 256 custom presets.');
  const operation = CanvasOperationSchema.safeParse({ kind: 'illustration.brush-presets.replace', presets });
  if (!operation.success) throw firstIssue(operation, 'The imported brush library is invalid.');
  if (operation.data.kind !== 'illustration.brush-presets.replace') throw new Error('The imported brush library is invalid.');
  return {
    mode,
    incomingCount: imported.length,
    totalCount: operation.data.presets.length,
    importedIds,
    operations: [structuredClone(operation.data)],
  };
}
