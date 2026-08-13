import { dirname, extname, join } from 'node:path';
import type { AIDrawDocument, PixelTileset } from '@aidraw/core';
import type { ExportFormat } from '../common/contracts';
import { MAX_EXPORT_UTILITY_MEMBERS } from './utility-resource-policy';

export interface ExportArtifactMemberIdentity {
  mimeType: string;
  extension: string;
  name?: string;
}

export interface ExpectedExportArtifactIdentity {
  primary: ExportArtifactMemberIdentity;
  companion?: ExportArtifactMemberIdentity;
  companions?: ExportArtifactMemberIdentity[];
}

export interface PlannedTiledCompanion extends ExportArtifactMemberIdentity {
  tilesetId: string;
  name: string;
}

/** The primary Tiled document consumes one member of the utility result envelope. */
export const MAX_TILED_EXPORT_COMPANIONS = MAX_EXPORT_UTILITY_MEMBERS - 1;

export function safeTiledAssetName(name: string, extension: string): string {
  return `${name.replace(/[<>:"/\\|?*]/g, '-').trim() || 'tileset'}.${extension}`;
}

function tiledTilesets(document: AIDrawDocument): PixelTileset[] | undefined {
  if (document.kind !== 'pixel') return undefined;
  const active = document.pixelAssets[document.activeAssetId];
  if (active?.type === 'tileset') return [active];
  if (active?.type !== 'tilemap') return undefined;
  return active.tilesetIds
    .map((id) => document.pixelAssets[id])
    .filter((asset): asset is PixelTileset => asset?.type === 'tileset');
}

function foldedTiledAssetKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Plan the exact Tiled PNG member set before any companion is rendered.
 * Canonical tileset order owns deterministic suffix allocation; the map/tileset
 * body records the resulting leaf names, so no source identity or pixels change.
 */
export function planTiledExportCompanions(document: AIDrawDocument): PlannedTiledCompanion[] | undefined {
  const tilesets = tiledTilesets(document);
  if (!tilesets) return undefined;
  const companions: PlannedTiledCompanion[] = [];
  const reserved = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (const tileset of tilesets) {
    if (document.kind !== 'pixel' || document.pixelAssets[tileset.spriteAssetId]?.type !== 'sprite') continue;
    if (companions.length >= MAX_TILED_EXPORT_COMPANIONS) {
      throw new RangeError(`Tiled export exceeds the ${MAX_TILED_EXPORT_COMPANIONS.toLocaleString('en-US')}-companion-image safety limit.`);
    }
    const extension = 'png';
    const baseName = safeTiledAssetName(tileset.name, extension);
    const baseKey = foldedTiledAssetKey(baseName);
    let name = baseName;
    let suffix = nextSuffix.get(baseKey) ?? 2;
    while (reserved.has(foldedTiledAssetKey(name))) {
      name = `${baseName.slice(0, -(extension.length + 1))} (${suffix}).${extension}`;
      suffix += 1;
    }
    nextSuffix.set(baseKey, suffix);
    reserved.add(foldedTiledAssetKey(name));
    companions.push({ tilesetId: tileset.id, name, extension, mimeType: 'image/png' });
  }
  return companions;
}

/** Exact format-derived member identities accepted from the utility worker. */
export function expectedExportArtifactIdentity(
  document: AIDrawDocument,
  format: ExportFormat,
): ExpectedExportArtifactIdentity | undefined {
  if (format === 'png') return { primary: { mimeType: 'image/png', extension: 'png' } };
  if (format === 'jpeg') return { primary: { mimeType: 'image/jpeg', extension: 'jpg' } };
  if (format === 'webp') return { primary: { mimeType: 'image/webp', extension: 'webp' } };
  if (format === 'svg') return { primary: { mimeType: 'image/svg+xml', extension: 'svg' } };
  if (format === 'pdf') return { primary: { mimeType: 'application/pdf', extension: 'pdf' } };
  if (format === 'psd') return { primary: { mimeType: 'image/vnd.adobe.photoshop', extension: 'psd' } };
  if (format === 'gif') return { primary: { mimeType: 'image/gif', extension: 'gif' } };
  if (format === 'apng') return { primary: { mimeType: 'image/apng', extension: 'apng' } };
  if (format === 'sprite-sheet') {
    return {
      primary: { mimeType: 'image/png', extension: 'png' },
      companion: { mimeType: 'application/json', extension: 'json' },
    };
  }

  const companions = planTiledExportCompanions(document);
  if (!companions) return undefined;
  const active = document.kind === 'pixel' ? document.pixelAssets[document.activeAssetId] : undefined;
  const json = format === 'tiled-json';
  return {
    primary: {
      mimeType: json ? 'application/json' : 'application/xml',
      extension: active?.type === 'tilemap' ? (json ? 'tmj' : 'tmx') : (json ? 'tsj' : 'tsx'),
    },
    companions: companions.map(({ name, extension, mimeType }) => ({ name, extension, mimeType })),
  };
}

export function plannedExportCompanionPaths(document: AIDrawDocument, format: ExportFormat, target: string): string[] {
  if (format === 'sprite-sheet') return [`${target.slice(0, -extname(target).length)}.json`];
  const expected = expectedExportArtifactIdentity(document, format);
  return expected?.companions?.map((companion) => join(dirname(target), companion.name!)) ?? [];
}
