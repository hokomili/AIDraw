import type { IllustrationDocument, IllustrationObject, PaintLayer, Transform } from '@aidraw/core';
import { paintTileCachePlan, type PaintTileCacheEntry } from './paint-tile-cache';

export interface IllustrationRasterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ILLUSTRATION_REGION_OVERSCAN_PIXELS = 4;

function isIntegerTranslation(transform: Transform): boolean {
  return Number.isSafeInteger(transform.x)
    && Number.isSafeInteger(transform.y)
    && transform.scaleX === 1
    && transform.scaleY === 1
    && transform.rotation === 0
    && transform.skewX === 0
    && transform.skewY === 0;
}

function objectCanRenderPhaseExactly(document: IllustrationDocument, object: IllustrationObject): boolean {
  if (object.opacity !== 1
    || object.blendMode !== 'normal'
    || object.maskObjectId
    || (object.blur ?? 0) !== 0
    || object.shadow
    || object.filters?.length) return false;
  if (object.type === 'group') return isIntegerTranslation(object.transform);
  if (object.type === 'image') {
    const asset = document.assets[object.assetId];
    if (!asset?.data || asset.mimeType !== 'image/png'
      || !isIntegerTranslation(object.transform)
      || !Number.isSafeInteger(object.width)
      || !Number.isSafeInteger(object.height)
      || object.width < 1
      || object.height < 1
      || !Number.isSafeInteger(object.sourceWidth)
      || !Number.isSafeInteger(object.sourceHeight)
      || object.sourceWidth! < 1
      || object.sourceHeight! < 1) return false;
    if (!object.crop) return true;
    const { x, y, width, height } = object.crop;
    return [x, y, width, height].every(Number.isSafeInteger)
      && x >= 0
      && y >= 0
      && width > 0
      && height > 0
      && Number.isSafeInteger(x + width)
      && Number.isSafeInteger(y + height)
      && x + width <= object.sourceWidth!
      && y + height <= object.sourceHeight!;
  }
  if (object.type !== 'shape'
    || !['rectangle', 'polygon', 'star'].includes(object.shape)
    || !isIntegerTranslation(object.transform)
    || !Number.isSafeInteger(object.width)
    || !Number.isSafeInteger(object.height)
    || object.width < 0
    || object.height < 0
    || (object.fill.kind !== 'none' && object.fill.kind !== 'solid')) return false;
  if (object.shape === 'rectangle') {
    const cornerRadius = object.cornerRadius ?? 0;
    if (cornerRadius !== 0) return false;
  }
  if (object.shape === 'polygon' || object.shape === 'star') {
    const sides = object.sides ?? (object.shape === 'star' ? 5 : 6);
    if (!Number.isSafeInteger(sides) || sides < 3 || sides > 1_000) return false;
    const innerRadius = object.innerRadius ?? 0.45;
    if (object.shape === 'star' && (!Number.isFinite(innerRadius) || innerRadius < 0 || innerRadius > 1)) return false;
  }
  return object.stroke.paint.kind === 'none' || object.stroke.width <= 0;
}

function paintLayerCanRenderPhaseExactly(document: IllustrationDocument, layer: PaintLayer): boolean {
  if (layer.strokes.length === 0 && Object.keys(layer.tileAssetIds).length === 0) return true;
  const plan = paintTileCachePlan(layer, document.assets);
  if (!plan || plan.strokeCount !== layer.strokes.length) return false;
  return plan.entries.every((entry) => {
    const x = entry.tileX * layer.tileSize;
    const y = entry.tileY * layer.tileSize;
    return Number.isSafeInteger(x)
      && Number.isSafeInteger(y)
      && Number.isSafeInteger(x + layer.tileSize)
      && Number.isSafeInteger(y + layer.tileSize);
  });
}

export function paintTileCacheEntriesForIllustrationRegion(
  entries: readonly PaintTileCacheEntry[],
  tileSize: number,
  region: IllustrationRasterRegion,
): PaintTileCacheEntry[] {
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  return entries.filter((entry) => {
    const x = entry.tileX * tileSize;
    const y = entry.tileY * tileSize;
    return x < right && x + tileSize > region.x && y < bottom && y + tileSize > region.y;
  });
}

/**
 * Canvas coverage is not generally invariant when identical geometry is
 * translated onto a differently sized backing surface. The regional path is
 * therefore limited to the integer-translated square-rectangle/polygon/star
 * subset and integer-source/destination/crop embedded PNGs proven byte-exact
 * by parity coverage, structural containers, and complete materialized paint
 * caches whose pixels can be copied at integer tile coordinates. Live paint
 * tails and richer vector/raster content retain the established full-artboard
 * render and raw-crop path.
 */
export function illustrationRegionCanRenderLocally(document: IllustrationDocument, onlyLayerId?: string): boolean {
  const objectChildren = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
  const visitedLayers = new Set<string>();
  const visitingLayers = new Set<string>();
  const visitedObjects = new Set<string>();
  const visitingObjects = new Set<string>();
  const graphVisitedObjects = new Set<string>();
  const graphVisitingObjects = new Set<string>();

  const visitObjectGraph = (objectId: string): boolean => {
    if (graphVisitedObjects.has(objectId)) return true;
    if (graphVisitingObjects.has(objectId)) return false;
    const object = document.objects[objectId];
    if (!object) return false;
    graphVisitingObjects.add(objectId);
    const valid = object.type !== 'group' || object.childIds.every(visitObjectGraph);
    graphVisitingObjects.delete(objectId);
    if (valid) graphVisitedObjects.add(objectId);
    return valid;
  };

  const visitObject = (objectId: string): boolean => {
    if (visitedObjects.has(objectId)) return true;
    if (visitingObjects.has(objectId)) return false;
    const object = document.objects[objectId];
    if (!object) return false;
    if (!object.visible) { visitedObjects.add(objectId); return true; }
    if (!objectCanRenderPhaseExactly(document, object)) return false;
    visitingObjects.add(objectId);
    const local = object.type !== 'group' || object.childIds.every(visitObject);
    visitingObjects.delete(objectId);
    if (local) visitedObjects.add(objectId);
    return local;
  };

  const visitLayer = (layerId: string): boolean => {
    if (visitedLayers.has(layerId)) return true;
    if (visitingLayers.has(layerId)) return false;
    const layer = document.layers[layerId];
    if (!layer) return false;
    if (!layer.visible) { visitedLayers.add(layerId); return true; }
    if (layer.opacity !== 1 || layer.blendMode !== 'normal' || layer.maskLayerId || layer.filters?.length) return false;
    visitingLayers.add(layerId);
    const local = layer.type === 'paint'
      ? paintLayerCanRenderPhaseExactly(document, layer)
      : layer.type === 'vector'
        ? layer.objectIds.every(visitObjectGraph)
          && layer.objectIds.filter((objectId) => !objectChildren.has(objectId)).every(visitObject)
        : layer.childIds.every(visitLayer);
    visitingLayers.delete(layerId);
    if (local) visitedLayers.add(layerId);
    return local;
  };

  return onlyLayerId ? visitLayer(onlyLayerId) : document.layerIds.every(visitLayer);
}

export function illustrationRegionBacking(
  document: IllustrationDocument,
  region: IllustrationRasterRegion,
): IllustrationRasterRegion {
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
    || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) {
    throw new RangeError('Illustration raster regions must use nonnegative safe-integer coordinates and positive safe-integer dimensions.');
  }
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom)
    || right > document.artboard.width || bottom > document.artboard.height) {
    throw new RangeError('Illustration raster region falls outside the artboard bounds.');
  }
  const x = Math.max(0, region.x - ILLUSTRATION_REGION_OVERSCAN_PIXELS);
  const y = Math.max(0, region.y - ILLUSTRATION_REGION_OVERSCAN_PIXELS);
  const expandedRight = Math.min(document.artboard.width, right + ILLUSTRATION_REGION_OVERSCAN_PIXELS);
  const expandedBottom = Math.min(document.artboard.height, bottom + ILLUSTRATION_REGION_OVERSCAN_PIXELS);
  return { x, y, width: expandedRight - x, height: expandedBottom - y };
}
