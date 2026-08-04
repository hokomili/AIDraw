import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NewDocumentOptionsSchema, createId, nowIso } from '@aidraw/core';
import type { DocumentPreset, DocumentPresetInput } from '../common/contracts';

interface PersistedDocumentPresets {
  version: 1;
  presets: DocumentPreset[];
}

const MAX_PRESETS = 64;

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

  constructor(private readonly filePath: string) {}

  async list(): Promise<DocumentPreset[]> {
    await this.load();
    return [...this.presets.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((preset) => structuredClone(preset));
  }

  async save(input: DocumentPresetInput): Promise<DocumentPreset> {
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
    this.presets.set(preset.id, preset);
    await this.persist();
    return structuredClone(preset);
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    await this.load();
    const deleted = this.presets.delete(id);
    if (deleted) await this.persist();
    return { deleted };
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

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const value: PersistedDocumentPresets = { version: 1, presets: [...this.presets.values()] };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
