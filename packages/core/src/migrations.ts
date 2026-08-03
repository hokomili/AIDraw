import { nowIso } from './ids';
import { validateDocument } from './schemas';
import type { AIDrawDocument } from './model';
import { normalizePixelDocument } from './normalize';

export const CURRENT_SCHEMA_VERSION = 1 as const;

export function migrateDocument(value: unknown): AIDrawDocument {
  if (!value || typeof value !== 'object') throw new Error('Document payload must be an object.');
  const source = structuredClone(value) as Record<string, unknown>; const version = Number(source.schemaVersion ?? 0);
  if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Document schema ${version} is newer than this AIDraw build.`);
  if (version === 0) {
    const timestamp = nowIso(); source.schemaVersion = 1; source.revision ??= 0; source.createdAt ??= timestamp; source.updatedAt ??= timestamp; source.dirty ??= false; source.assets ??= {}; source.activity ??= []; source.provenance ??= [];
  }
  let document = validateDocument(source);
  if (document.kind === 'pixel') document = normalizePixelDocument(document);
  if (document.kind === 'pixel') for (const asset of Object.values(document.pixelAssets)) if (asset.type === 'tileset' && !Number.isFinite(asset.firstGid)) asset.firstGid = 1;
  return document;
}
