import type {
  AnimationTag,
  BlendMode,
  EntityBase,
  PixelAsset,
  PixelCel,
  PixelDocument,
  PixelFrame,
  PixelLayer,
  PixelSprite,
  PixelTilemap,
  PixelTileset,
  TilemapLayer,
} from './model';
import { createDefaultBitmapFont } from './bitmap-font';

const BLEND_MODES = new Set<BlendMode>([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function assertUniqueNormalizedEntityIds(
  source: Record<string, unknown>,
  label: string,
  include: (candidate: Record<string, unknown>) => boolean = () => true,
): void {
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    if (!isRecord(value) || !include(value)) continue;
    const id = typeof value.id === 'string' && value.id.trim() ? value.id : key;
    if (ids.has(id)) throw new Error(`Duplicate persisted pixel ${label} ID: ${id}.`);
    ids.add(id);
  }
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = finite(value, fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function entityBase(
  value: Record<string, unknown>,
  fallbackId: string,
  fallbackName: string,
  current: EntityBase | undefined,
  timestamp: string,
  actorId: string,
): EntityBase {
  const id = text(value.id, fallbackId);
  return {
    id,
    revision: Math.max(0, Math.floor(finite(value.revision, current?.revision ?? 0))),
    name: text(value.name, current?.name ?? fallbackName),
    createdAt: text(value.createdAt, current?.createdAt ?? timestamp),
    updatedAt: text(value.updatedAt, current?.updatedAt ?? timestamp),
    createdBy: text(value.createdBy, current?.createdBy ?? actorId),
  };
}

function orderedIds(value: unknown, available: Record<string, unknown>): string[] {
  const listed = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id in available) : [];
  return [...new Set([...listed, ...Object.keys(available)])];
}

function rootLayerIds<T extends { type: string; childIds?: string[] }>(orderedLayerIds: string[], layers: Record<string, T>): string[] {
  const nestedLayerIds = new Set(Object.values(layers).flatMap((layer) => layer.type === 'group' ? layer.childIds ?? [] : []).filter((id) => Boolean(layers[id])));
  return orderedLayerIds.filter((id) => !nestedLayerIds.has(id));
}

function normalizeSprite(value: Record<string, unknown>, current: PixelSprite | undefined, timestamp: string, actorId: string): PixelSprite {
  const assetBase = entityBase(value, text(value.id, 'recovered-sprite'), 'Recovered sprite', current, timestamp, actorId);
  const layerSource = record(value.layers);
  assertUniqueNormalizedEntityIds(layerSource, 'sprite layer', (candidate) => candidate.type === 'pixel' || candidate.type === 'group');
  const layers: Record<string, PixelLayer> = {};
  for (const [key, candidate] of Object.entries(layerSource)) {
    if (!isRecord(candidate) || (candidate.type !== 'pixel' && candidate.type !== 'group')) continue;
    const base = entityBase(candidate, key, candidate.type === 'group' ? 'Recovered group' : 'Recovered pixels', current?.layers[key], timestamp, actorId);
    const blendMode = BLEND_MODES.has(candidate.blendMode as BlendMode) ? candidate.blendMode as BlendMode : current?.layers[key]?.blendMode ?? 'normal';
    layers[base.id] = {
      ...base,
      type: candidate.type,
      visible: typeof candidate.visible === 'boolean' ? candidate.visible : current?.layers[key]?.visible ?? true,
      locked: typeof candidate.locked === 'boolean' ? candidate.locked : current?.layers[key]?.locked ?? false,
      opacity: Math.max(0, Math.min(1, finite(candidate.opacity, current?.layers[key]?.opacity ?? 1))),
      blendMode,
      ...(typeof candidate.parentId === 'string' ? { parentId: candidate.parentId } : {}),
      ...(candidate.type === 'group' ? { childIds: Array.isArray(candidate.childIds) ? candidate.childIds.filter((id): id is string => typeof id === 'string') : [] } : {}),
    };
  }
  if (Object.keys(layers).length === 0) {
    const id = `${assetBase.id}:layer:recovered`;
    layers[id] = { ...entityBase({}, id, 'Recovered pixels', undefined, timestamp, actorId), type: 'pixel', visible: true, locked: false, opacity: 1, blendMode: 'normal' };
  }
  const orderedLayerIds = orderedIds(value.layerIds, layers);
  const layerIds = rootLayerIds(orderedLayerIds, layers);

  const frameSource = record(value.frames);
  assertUniqueNormalizedEntityIds(frameSource, 'sprite frame');
  const frames: Record<string, PixelFrame> = {};
  for (const [key, candidate] of Object.entries(frameSource)) {
    if (!isRecord(candidate)) continue;
    const base = entityBase(candidate, key, 'Recovered frame', current?.frames[key], timestamp, actorId);
    frames[base.id] = { ...base, durationMs: Math.max(1, Math.round(finite(candidate.durationMs, current?.frames[key]?.durationMs ?? 100))) };
  }
  if (Object.keys(frames).length === 0) {
    const id = `${assetBase.id}:frame:recovered`;
    frames[id] = { ...entityBase({}, id, 'Recovered frame', undefined, timestamp, actorId), durationMs: 100 };
  }
  const frameIds = orderedIds(value.frameIds, frames);

  const celSource = record(value.cels);
  assertUniqueNormalizedEntityIds(celSource, 'sprite cel', (candidate) => typeof candidate.layerId === 'string' && typeof candidate.frameId === 'string');
  const cels: Record<string, PixelCel> = {};
  for (const [key, candidate] of Object.entries(celSource)) {
    if (!isRecord(candidate) || typeof candidate.layerId !== 'string' || typeof candidate.frameId !== 'string') continue;
    if (!layers[candidate.layerId] || !frames[candidate.frameId]) continue;
    const currentCel = current?.cels[key];
    const layer = layers[candidate.layerId];
    const frame = frames[candidate.frameId];
    const base = entityBase(candidate, key, `${layer.name} · ${frame.name}`, currentCel, timestamp, actorId);
    cels[base.id] = {
      ...base,
      layerId: candidate.layerId,
      frameId: candidate.frameId,
      chunks: structuredClone(isRecord(candidate.chunks) ? candidate.chunks : currentCel?.chunks ?? {}) as PixelCel['chunks'],
      ...(typeof candidate.linkedToCelId === 'string' ? { linkedToCelId: candidate.linkedToCelId } : {}),
    };
  }
  for (const layerId of orderedLayerIds) {
    if (layers[layerId].type !== 'pixel') continue;
    for (const frameId of frameIds) {
      if (Object.values(cels).some((cel) => cel.layerId === layerId && cel.frameId === frameId)) continue;
      const id = `${assetBase.id}:cel:${layerId}:${frameId}`;
      cels[id] = {
        ...entityBase({}, id, `${layers[layerId].name} · ${frames[frameId].name}`, undefined, timestamp, actorId),
        layerId,
        frameId,
        chunks: {},
      };
    }
  }

  const tags = Array.isArray(value.tags) ? value.tags.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return [];
    if (typeof candidate.fromFrameId !== 'string' || typeof candidate.toFrameId !== 'string' || !frames[candidate.fromFrameId] || !frames[candidate.toFrameId]) return [];
    const direction: AnimationTag['direction'] = candidate.direction === 'reverse' || candidate.direction === 'ping-pong' ? candidate.direction : 'forward';
    return [{ id: candidate.id, name: candidate.name, fromFrameId: candidate.fromFrameId, toFrameId: candidate.toFrameId, direction, color: text(candidate.color, '#31a6a0') }];
  }) : [];
  const overrideSource = record(value.paletteOverrides);
  const paletteOverrides = Object.fromEntries(Object.entries(overrideSource).filter(([, entries]) => Array.isArray(entries))) as PixelSprite['paletteOverrides'];

  return {
    ...assetBase,
    type: 'sprite',
    width: positiveInteger(value.width, current?.width ?? 64),
    height: positiveInteger(value.height, current?.height ?? 64),
    layerIds,
    layers,
    frameIds,
    frames,
    cels,
    tags,
    paletteOverrides,
  };
}

function normalizeTileset(value: Record<string, unknown>, current: PixelTileset | undefined, timestamp: string, actorId: string): PixelTileset {
  const base = entityBase(value, text(value.id, 'recovered-tileset'), 'Recovered tileset', current, timestamp, actorId);
  const transformations = record(value.transformations);
  const tileOffset = record(value.tileOffset);
  return {
    ...base,
    type: 'tileset',
    firstGid: positiveInteger(value.firstGid, current?.firstGid ?? 1),
    tileWidth: positiveInteger(value.tileWidth, current?.tileWidth ?? 16),
    tileHeight: positiveInteger(value.tileHeight, current?.tileHeight ?? 16),
    margin: Math.max(0, Math.round(finite(value.margin, current?.margin ?? 0))),
    spacing: Math.max(0, Math.round(finite(value.spacing, current?.spacing ?? 0))),
    tileOffset: {
      x: finite(tileOffset.x, current?.tileOffset?.x ?? 0),
      y: finite(tileOffset.y, current?.tileOffset?.y ?? 0),
    },
    objectAlignment: value.objectAlignment === undefined
      ? current?.objectAlignment ?? 'unspecified'
      : value.objectAlignment as PixelTileset['objectAlignment'],
    columns: positiveInteger(value.columns, current?.columns ?? 1),
    rows: positiveInteger(value.rows, current?.rows ?? 1),
    spriteAssetId: text(value.spriteAssetId, current?.spriteAssetId ?? ''),
    tiles: structuredClone(record(value.tiles)) as PixelTileset['tiles'],
    wangSets: Array.isArray(value.wangSets) ? structuredClone(value.wangSets) as PixelTileset['wangSets'] : [],
    transformations: {
      hFlip: typeof transformations.hFlip === 'boolean' ? transformations.hFlip : false,
      vFlip: typeof transformations.vFlip === 'boolean' ? transformations.vFlip : false,
      rotate: typeof transformations.rotate === 'boolean' ? transformations.rotate : false,
    },
  };
}

function normalizeTilemap(value: Record<string, unknown>, current: PixelTilemap | undefined, timestamp: string, actorId: string): PixelTilemap {
  const base = entityBase(value, text(value.id, 'recovered-tilemap'), 'Recovered tilemap', current, timestamp, actorId);
  const source = record(value.layers);
  assertUniqueNormalizedEntityIds(source, 'tilemap layer', (candidate) => ['tile', 'object', 'group'].includes(String(candidate.type)));
  const layers: Record<string, TilemapLayer> = {};
  for (const [key, candidate] of Object.entries(source)) {
    if (!isRecord(candidate) || !['tile', 'object', 'group'].includes(String(candidate.type))) continue;
    const type = candidate.type as TilemapLayer['type'];
    const layerBase = entityBase(candidate, key, `Recovered ${type} layer`, current?.layers[key], timestamp, actorId);
    layers[layerBase.id] = {
      ...layerBase,
      type,
      visible: typeof candidate.visible === 'boolean' ? candidate.visible : true,
      locked: typeof candidate.locked === 'boolean' ? candidate.locked : false,
      opacity: Math.max(0, Math.min(1, finite(candidate.opacity, 1))),
      offsetX: finite(candidate.offsetX, current?.layers[key]?.offsetX ?? 0),
      offsetY: finite(candidate.offsetY, current?.layers[key]?.offsetY ?? 0),
      parallaxX: finite(candidate.parallaxX, 1),
      parallaxY: finite(candidate.parallaxY, 1),
      ...(typeof candidate.parentId === 'string' ? { parentId: candidate.parentId } : {}),
      ...(type === 'group' ? { childIds: Array.isArray(candidate.childIds) ? candidate.childIds.filter((id): id is string => typeof id === 'string') : [] } : {}),
      ...(type === 'tile' ? { chunks: structuredClone(record(candidate.chunks)) as NonNullable<TilemapLayer['chunks']> } : {}),
      ...(type === 'object' ? { objects: Array.isArray(candidate.objects) ? structuredClone(candidate.objects) as NonNullable<TilemapLayer['objects']> : [] } : {}),
    };
  }
  return {
    ...base,
    type: 'tilemap',
    orientation: value.orientation === 'isometric' ? 'isometric' : 'orthogonal',
    infinite: typeof value.infinite === 'boolean' ? value.infinite : false,
    width: positiveInteger(value.width, current?.width ?? 32),
    height: positiveInteger(value.height, current?.height ?? 32),
    tileWidth: positiveInteger(value.tileWidth, current?.tileWidth ?? 16),
    tileHeight: positiveInteger(value.tileHeight, current?.tileHeight ?? 16),
    tilesetIds: Array.isArray(value.tilesetIds) ? value.tilesetIds.filter((id): id is string => typeof id === 'string') : [],
    layerIds: rootLayerIds(orderedIds(value.layerIds, layers), layers),
    layers,
    properties: structuredClone(record(value.properties)) as PixelTilemap['properties'],
  };
}

export function normalizePixelAsset(value: unknown, current?: PixelAsset, timestamp = new Date().toISOString(), actorId = 'system'): PixelAsset | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'sprite') return normalizeSprite(value, current?.type === 'sprite' ? current : undefined, timestamp, actorId);
  if (value.type === 'tileset') return normalizeTileset(value, current?.type === 'tileset' ? current : undefined, timestamp, actorId);
  if (value.type === 'tilemap') return normalizeTilemap(value, current?.type === 'tilemap' ? current : undefined, timestamp, actorId);
  return undefined;
}

export function normalizePixelDocument(document: PixelDocument): PixelDocument {
  const normalized = structuredClone(document);
  normalized.stamps = Array.isArray(normalized.stamps) ? normalized.stamps : [];
  normalized.tileStamps = Array.isArray(normalized.tileStamps) ? normalized.tileStamps : [];
  normalized.bitmapFonts = Array.isArray(normalized.bitmapFonts) && normalized.bitmapFonts.length ? normalized.bitmapFonts : [createDefaultBitmapFont()];
  normalized.paletteCycles = Array.isArray(normalized.paletteCycles) ? normalized.paletteCycles : [];
  if (normalized.linkedAssets === undefined) normalized.linkedAssets = [];
  if (normalized.conversionDefaults === undefined) normalized.conversionDefaults = { resample: 'area', paletteMetric: 'oklab', dithering: 'none', alphaThreshold: 0.5 };
  const assets: PixelDocument['pixelAssets'] = {};
  const assetSource = record(normalized.pixelAssets);
  assertUniqueNormalizedEntityIds(assetSource, 'asset', (candidate) => ['sprite', 'tileset', 'tilemap'].includes(String(candidate.type)));
  for (const [key, value] of Object.entries(assetSource)) {
    const asset = normalizePixelAsset(value, undefined, normalized.updatedAt, 'system');
    if (asset) assets[asset.id || key] = asset;
  }
  normalized.pixelAssets = assets;
  normalized.assetIds = orderedIds(normalized.assetIds, assets);
  if (!assets[normalized.activeAssetId]) normalized.activeAssetId = normalized.assetIds[0] ?? '';
  return normalized;
}
