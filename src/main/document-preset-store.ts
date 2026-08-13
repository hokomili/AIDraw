import { readFile } from 'node:fs/promises';
import { NewDocumentOptionsSchema, createId, nowIso } from '@aidraw/core';
import type { DocumentPreset, DocumentPresetInput } from '../common/contracts';
import { replacePrivateJsonFile, type PrivateJsonFileReplacer } from './private-json-file';

interface PersistedDocumentPresets {
  version: 1;
  presets: DocumentPreset[];
}

const MAX_PRESETS = 64;

export interface DocumentPresetStoreOptions {
  /** Narrow deterministic seam for replacement failure/concurrency coverage. */
  replaceFile?: PrivateJsonFileReplacer;
}

function normalizePreset(value: unknown): DocumentPreset | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<DocumentPreset>;
  if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(source.id)) return undefined;
  if (typeof source.name !== 'string' || !source.name.trim() || source.name.trim().length > 80) return undefined;
  const parsed = NewDocumentOptionsSchema.safeParse(source.options);
  if (!parsed.success || parsed.data.name !== undefined || source.kind !== parsed.data.kind) return undefined;
  if (typeof source.createdAt !== 'string' || typeof source.updatedAt !== 'string') return undefined;
  return {
    id: source.id,
    name: source.name.trim(),
    kind: parsed.data.kind,
    options: parsed.data,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

/** Application-owned, atomic persistence for reusable document configurations. */
export class DocumentPresetStore {
  private presets = new Map<string, DocumentPreset>();
  private loaded = false;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly options: DocumentPresetStoreOptions = {}) {}

  async list(): Promise<DocumentPreset[]> {
    return this.exclusive(async () => {
      await this.load();
      return [...this.presets.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((preset) => structuredClone(preset));
    });
  }

  async save(input: DocumentPresetInput): Promise<DocumentPreset> {
    return this.exclusive(async () => {
      await this.load();
      const name = input.name.trim();
      if (!name || name.length > 80) throw new Error('Preset name must contain 1 to 80 characters.');
      const parsed = NewDocumentOptionsSchema.parse(input.options);
      if (parsed.name !== undefined) throw new Error('Document presets cannot store a document name.');
      const existing = input.id ? this.presets.get(input.id) : undefined;
      if (input.id && !existing) throw new Error('Document preset not found.');
      if (!existing && this.presets.size >= MAX_PRESETS) throw new Error(`AIDraw supports up to ${MAX_PRESETS} custom document presets.`);
      const timestamp = nowIso();
      const preset: DocumentPreset = {
        id: existing?.id ?? createId('document-preset'),
        name,
        kind: parsed.kind,
        options: parsed,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const nextPresets = new Map(this.presets);
      nextPresets.set(preset.id, preset);
      await this.persist(nextPresets);
      this.presets = nextPresets;
      return structuredClone(preset);
    });
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return this.exclusive(async () => {
      await this.load();
      if (!this.presets.has(id)) return { deleted: false };
      const nextPresets = new Map(this.presets);
      nextPresets.delete(id);
      await this.persist(nextPresets);
      this.presets = nextPresets;
      return { deleted: true };
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedDocumentPresets>;
      if (parsed.version !== 1 || !Array.isArray(parsed.presets)) return;
      for (const value of parsed.presets.slice(0, MAX_PRESETS)) {
        const preset = normalizePreset(value);
        if (preset) this.presets.set(preset.id, preset);
      }
    } catch {
      // A missing or corrupt preference file must not prevent the editor from starting.
    }
  }

  private async persist(presets: ReadonlyMap<string, DocumentPreset>): Promise<void> {
    const value: PersistedDocumentPresets = { version: 1, presets: [...presets.values()] };
    await replacePrivateJsonFile(this.filePath, value, this.options.replaceFile);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
