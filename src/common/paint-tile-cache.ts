import type { DocumentAsset, PaintLayer } from '@aidraw/core';

export interface PaintTileCacheEntry {
  asset: DocumentAsset;
  assetId: string;
  key: string;
  tileX: number;
  tileY: number;
}

export interface PaintTileCachePlan {
  entries: PaintTileCacheEntry[];
  strokeCount: number;
}

export function parsePaintTileKey(key: string): { tileX: number; tileY: number } | undefined {
  const match = /^(-?\d+),(-?\d+)$/.exec(key);
  if (!match) return undefined;
  const tileX = Number(match[1]);
  const tileY = Number(match[2]);
  if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY)) return undefined;
  return { tileX, tileY };
}

/**
 * Performs renderer-independent structural checks for a persisted paint cache.
 * The SHA-256 binding to the stroke prefix is verified by the main process when
 * a native document is opened.
 */
export function paintTileCachePlan(
  layer: PaintLayer,
  assets: Record<string, DocumentAsset>,
): PaintTileCachePlan | undefined {
  const cache = layer.tileCache;
  if (!cache || cache.version !== 1 || !Number.isInteger(cache.strokeCount) || cache.strokeCount < 0 || cache.strokeCount > layer.strokes.length || !/^[0-9a-f]{64}$/i.test(cache.strokesSha256)) return undefined;
  if (layer.tileSize !== 256 || Object.keys(layer.tileAssetIds).length > 16_384) return undefined;

  const entries: PaintTileCacheEntry[] = [];
  for (const [key, assetId] of Object.entries(layer.tileAssetIds)) {
    const coordinates = parsePaintTileKey(key);
    const asset = assets[assetId];
    if (!coordinates || !asset || asset.mimeType !== 'image/png' || typeof asset.data !== 'string') return undefined;
    entries.push({ asset, assetId, key, ...coordinates });
  }
  entries.sort((left, right) => left.tileY - right.tileY || left.tileX - right.tileX || left.key.localeCompare(right.key));
  return { entries, strokeCount: cache.strokeCount };
}
