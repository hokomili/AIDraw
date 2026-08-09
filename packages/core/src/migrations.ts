import { defaultIllustrationAnimation } from './animation';
import { nowIso } from './ids';
import { validateDocument } from './schemas';
import type { AIDrawDocument } from './model';
import { normalizePixelDocument } from './normalize';
import { assertAcyclicReferences } from './reference-graph';

export const CURRENT_SCHEMA_VERSION = 2 as const;

function migrateUnversionedToV1(source: Record<string, unknown>): void {
  const timestamp = nowIso();
  source.schemaVersion = 1;
  source.revision ??= 0;
  source.createdAt ??= timestamp;
  source.updatedAt ??= timestamp;
  source.dirty ??= false;
  source.assets ??= {};
  source.activity ??= [];
  source.provenance ??= [];
}

function migrateV1ToV2(source: Record<string, unknown>): void {
  if (source.kind === 'illustration' && (!source.animation || typeof source.animation !== 'object')) source.animation = defaultIllustrationAnimation();
  source.schemaVersion = 2;
}

export function migrateDocument(value: unknown): AIDrawDocument {
  if (!value || typeof value !== 'object') throw new Error('Document payload must be an object.');
  const source = structuredClone(value) as Record<string, unknown>; let version = Number(source.schemaVersion ?? 0);
  if (!Number.isInteger(version) || version < 0) throw new Error(`Invalid AIDraw schema version: ${String(source.schemaVersion)}`);
  if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Document schema ${version} is newer than this AIDraw build.`);
  if (version === 0) { migrateUnversionedToV1(source); version = 1; }
  if (version === 1) { migrateV1ToV2(source); version = 2; }
  if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`No migration path exists from AIDraw schema ${version}.`);
  let document = validateDocument(source);
  if (document.kind === 'pixel') {
    document = normalizePixelDocument(document);
    for (const asset of Object.values(document.pixelAssets)) if (asset.type === 'sprite') {
      assertAcyclicReferences(asset.cels, (cel) => cel.linkedToCelId ? [cel.linkedToCelId] : [], 'Pixel sprite cel links contain a cycle.');
    }
  }
  if (document.kind === 'pixel') for (const asset of Object.values(document.pixelAssets)) if (asset.type === 'tileset' && !Number.isFinite(asset.firstGid)) asset.firstGid = 1;
  return document;
}
