import { dirname, extname, join } from 'node:path';
import type { AIDrawDocument, PixelTileset } from '@aidraw/core';
import type { ExportFormat } from '../common/contracts';

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

  const tilesets = tiledTilesets(document);
  if (!tilesets) return undefined;
  const active = document.kind === 'pixel' ? document.pixelAssets[document.activeAssetId] : undefined;
  const json = format === 'tiled-json';
  return {
    primary: {
      mimeType: json ? 'application/json' : 'application/xml',
      extension: active?.type === 'tilemap' ? (json ? 'tmj' : 'tmx') : (json ? 'tsj' : 'tsx'),
    },
    companions: tilesets
      .filter((tileset) => document.kind === 'pixel' && document.pixelAssets[tileset.spriteAssetId]?.type === 'sprite')
      .map((tileset) => ({ name: safeTiledAssetName(tileset.name, 'png'), extension: 'png', mimeType: 'image/png' })),
  };
}

export function plannedExportCompanionPaths(document: AIDrawDocument, format: ExportFormat, target: string): string[] {
  if (format === 'sprite-sheet') return [`${target.slice(0, -extname(target).length)}.json`];
  const expected = expectedExportArtifactIdentity(document, format);
  return expected?.companions?.map((companion) => join(dirname(target), companion.name!)) ?? [];
}
