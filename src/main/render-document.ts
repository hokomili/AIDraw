import { Canvas, Path2D, createCanvas, loadImage } from '@napi-rs/canvas';
import { getStroke } from 'perfect-freehand';
import {
  assertImageCollectionTilemapMode,
  decodeTiledGid,
  decodeTilemapChunk,
  isImageCollectionTileset,
  resolveTilesetForGid,
  tilesetTileSourceAssetId,
  type AIDrawDocument,
  type BlendMode,
  type IllustrationDocument,
  type IllustrationObject,
  type PaintStyle,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
} from '@aidraw/core';
import { BoundedResourceCache } from '../common/bounded-resource-cache';
import { applyCanvasStrokeStyle } from '../common/canvas-stroke';
import { colorWithOpacity } from '../common/color';
import { illustrationGroupRequiresIsolation, illustrationObjectHasTransform } from '../common/illustration-geometry';
import { illustrationRegionBacking, illustrationRegionCanRenderLocally, paintTileCacheEntriesForIllustrationRegion, phaseExactIllustrationObjectIntersectsRegion, type IllustrationRasterRegion } from '../common/illustration-region';
import { isometricCellRect, isometricObjectMatrix, isometricProjectionExtent } from '../common/isometric-projection';
import { isometricMapTileArtworkEnvelope, isometricTileArtworkIntersects, isometricTileArtworkPlacement } from '../common/isometric-tile-artwork';
import { drawMapObjectOverlay, mapObjectsIntersectingRasterRegion } from '../common/map-object-render';
import { tileObjectArtworkIntersects, tileObjectArtworkPlacement, tileObjectFallbackColor } from '../common/tile-object-artwork';
import { orthogonalCellRect, orthogonalObjectMatrix, orthogonalProjectionExtent } from '../common/orthogonal-projection';
import { orthogonalMapTileArtworkEnvelope, orthogonalTileArtworkIntersects, orthogonalTileArtworkPlacement } from '../common/orthogonal-tile-artwork';
import { paintTileCachePlan } from '../common/paint-tile-cache';
import { renderRasterStroke } from '../common/raster-brush';
import { drawPixelSpriteRegion, pixelSpriteRegionPlan, type PixelSpriteRegion } from '../common/pixel-sprite-render';
import { MAX_STATIC_RASTER_PIXELS, MAX_STATIC_RASTER_SIDE, assertStaticRasterDimensions } from '../common/static-raster';
import { renderStyledText } from '../common/text-layout';
import { tileAnimationFrameAt, tilesetTileSourceRect } from '../common/tile-animation';
import { isometricTileRenderCells } from '../common/tile-render-order';
import { tilemapChunksIntersectingRegion } from '../common/tilemap-region';
import { composedVisibleTilemapLayers } from '../common/tilemap-layer-composition';
import { ensureBundledNativeCanvasFonts } from './canvas-fonts';

type Context = ReturnType<Canvas['getContext']>;
type LoadedImage = Awaited<ReturnType<typeof loadImage>>;

const MAX_PAINT_TILE_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const paintTileImageCache = new Map<string, { bytes: number; promise: Promise<LoadedImage> }>();
let paintTileImageCacheBytes = 0;
const MAX_RENDER_SCRATCH_CANVAS_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_MAP_TILE_SOURCE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_MAP_TILE_SOURCE_CACHE_ENTRIES = 1_024;
// Canvas2D can resolve coverage differently at a backing-surface edge even
// when translated geometry is identical. Keep requested pixels away from that
// edge before a raw crop; the margin contracts at static-raster limits.
const TILEMAP_REGION_OVERSCAN_PIXELS = 4;
const renderScratchCanvasCache: Canvas[] = [];
let renderScratchCanvasCacheBytes = 0;

function acquireScratchCanvas(width: number, height: number): Canvas {
  const cachedIndex = renderScratchCanvasCache.findIndex((canvas) => canvas.width === width && canvas.height === height);
  const canvas = cachedIndex >= 0 ? renderScratchCanvasCache.splice(cachedIndex, 1)[0] : createCanvas(width, height);
  if (cachedIndex >= 0) renderScratchCanvasCacheBytes -= width * height * 4;
  canvas.getContext('2d').reset();
  return canvas;
}

function releaseScratchCanvas(canvas: Canvas): void {
  // Reuse one bounded full-artboard compositing surface across sequential
  // layers and renders. Creating a fresh native Skia surface per layer leaves
  // allocator high-water behind even after its JS wrapper becomes unreachable.
  const bytes = canvas.width * canvas.height * 4;
  canvas.getContext('2d').reset();
  if (bytes <= MAX_RENDER_SCRATCH_CANVAS_CACHE_BYTES && renderScratchCanvasCacheBytes + bytes <= MAX_RENDER_SCRATCH_CANVAS_CACHE_BYTES) {
    renderScratchCanvasCache.push(canvas);
    renderScratchCanvasCacheBytes += bytes;
    return;
  }
  canvas.width = 1;
  canvas.height = 1;
}

function releaseCanvas(canvas: Canvas): void {
  canvas.width = 1;
  canvas.height = 1;
}

async function cachedPaintTileImage(assetSha256: string, data: string, tileSize: number): Promise<LoadedImage> {
  const key = `${assetSha256.toLowerCase()}:${tileSize}`;
  const existing = paintTileImageCache.get(key);
  if (existing) {
    paintTileImageCache.delete(key); paintTileImageCache.set(key, existing);
    return existing.promise;
  }
  const bytes = tileSize * tileSize * 4;
  const promise = loadImage(Buffer.from(data, 'base64'));
  paintTileImageCache.set(key, { bytes, promise }); paintTileImageCacheBytes += bytes;
  while (paintTileImageCacheBytes > MAX_PAINT_TILE_IMAGE_CACHE_BYTES && paintTileImageCache.size > 1) {
    const oldest = paintTileImageCache.entries().next().value as [string, { bytes: number }] | undefined;
    if (!oldest || oldest[0] === key) break;
    paintTileImageCache.delete(oldest[0]); paintTileImageCacheBytes -= oldest[1].bytes;
  }
  try { return await promise; } catch (error) { const retained = paintTileImageCache.get(key); if (retained?.promise === promise) { paintTileImageCache.delete(key); paintTileImageCacheBytes -= bytes; } throw error; }
}

function composite(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : mode;
}

function paint(context: Context, style: PaintStyle): string | ReturnType<Context['createLinearGradient']> | undefined {
  if (style.kind === 'none') return undefined;
  if (style.kind === 'solid') return style.color;
  const gradient = style.kind === 'linear-gradient'
    ? context.createLinearGradient(style.x1, style.y1, style.x2, style.y2)
    : context.createRadialGradient(style.x1, style.y1, 0, style.x2, style.y2, Math.hypot(style.x2 - style.x1, style.y2 - style.y1));
  for (const stop of style.stops) gradient.addColorStop(stop.offset, colorWithOpacity(stop.color, stop.opacity));
  return gradient;
}

function pressurePath(object: Extract<IllustrationObject, { type: 'vector-stroke' }>): Path2D {
  const outline = getStroke(object.points.map((point) => [point.x, point.y, point.pressure] as [number, number, number]), object.brush);
  const path = new Path2D();
  if (outline.length === 0) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let index = 1; index < outline.length - 1; index += 1) {
    const current = outline[index]; const next = outline[index + 1];
    path.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) / 2, (current[1] + next[1]) / 2);
  }
  path.closePath();
  return path;
}

function localObjectPath(object: IllustrationObject): Path2D | undefined {
  if (object.type === 'vector-stroke') return pressurePath(object);
  if (object.type === 'path') return new Path2D(object.pathData);
  const path = new Path2D();
  if (object.type === 'shape') {
    if (object.shape === 'rectangle') path.roundRect(0, 0, object.width, object.height, object.cornerRadius ?? 0);
    else if (object.shape === 'ellipse') path.ellipse(object.width / 2, object.height / 2, Math.abs(object.width / 2), Math.abs(object.height / 2), 0, 0, Math.PI * 2);
    else if (object.shape === 'line' || object.shape === 'arrow') { path.moveTo(0, 0); path.lineTo(object.width, object.height); }
    else { const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6); const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2; for (let index = 0; index < count; index += 1) { const r = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? .45) : radius; const angle = -Math.PI / 2 + index / count * Math.PI * 2; const x = object.width / 2 + Math.cos(angle) * r; const y = object.height / 2 + Math.sin(angle) * r; if (!index) path.moveTo(x, y); else path.lineTo(x, y); } path.closePath(); }
    return path;
  }
  if (object.type === 'text' || object.type === 'image') { path.rect(0, 0, object.width, object.height); return path; }
  return undefined;
}

function objectMatrix(object: IllustrationObject) {
  const value = object.transform; const angle = value.rotation * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle); const skewX = Math.tan(value.skewX * Math.PI / 180); const skewY = Math.tan(value.skewY * Math.PI / 180);
  return { a: cosine * value.scaleX - sine * skewY, b: sine * value.scaleX + cosine * skewY, c: cosine * skewX - sine * value.scaleY, d: sine * skewX + cosine * value.scaleY, e: value.x, f: value.y };
}

function transformedObjectPath(object: IllustrationObject): Path2D | undefined { const local = localObjectPath(object); if (!local) return undefined; const world = new Path2D(); world.addPath(local, objectMatrix(object)); return world; }

function adjustmentFilter(filters: IllustrationObject['filters']): string { return (filters ?? []).map((filter) => filter.type === 'brightness' ? `brightness(${Math.max(0, 1 + filter.value)})` : filter.type === 'contrast' ? `contrast(${Math.max(0, 1 + filter.value)})` : filter.type === 'saturation' ? `saturate(${Math.max(0, 1 + filter.value)})` : filter.type === 'hue' ? `hue-rotate(${filter.value}deg)` : `blur(${Math.max(0, filter.value)}px)`).join(' '); }

function objectFilter(object: IllustrationObject): string {
  const filters: string[] = [];
  if ((object.blur ?? 0) > 0) filters.push(`blur(${Math.max(0, object.blur ?? 0)}px)`);
  const adjustments = adjustmentFilter(object.filters); if (adjustments) filters.push(adjustments);
  return filters.join(' ') || 'none';
}

async function drawIllustrationObject(context: Context, document: IllustrationDocument, object: IllustrationObject): Promise<void> {
  if (!object.visible) return;
  context.save();
  context.translate(object.transform.x, object.transform.y);
  context.rotate(object.transform.rotation * Math.PI / 180);
  context.transform(object.transform.scaleX, Math.tan(object.transform.skewY * Math.PI / 180), Math.tan(object.transform.skewX * Math.PI / 180), object.transform.scaleY, 0, 0);
  context.globalAlpha = object.opacity;
  context.globalCompositeOperation = composite(object.blendMode);
  context.filter = objectFilter(object);
  if (object.shadow) { context.shadowColor = object.shadow.color; context.shadowBlur = object.shadow.blur; context.shadowOffsetX = object.shadow.offsetX; context.shadowOffsetY = object.shadow.offsetY; }
  if (object.type === 'vector-stroke') {
    context.fillStyle = object.brush.color;
    context.fill(pressurePath(object));
  } else if (object.type === 'path') {
    const path = new Path2D(object.pathData);
    const fill = paint(context, object.fill);
    if (fill) { context.fillStyle = fill; context.fill(path, object.fillRule); }
    const stroke = paint(context, object.stroke.paint);
    if (stroke && object.stroke.width > 0) { context.strokeStyle = stroke; applyCanvasStrokeStyle(context, object.stroke); context.stroke(path); }
  } else if (object.type === 'shape') {
    const path = new Path2D();
    if (object.shape === 'rectangle') path.roundRect(0, 0, object.width, object.height, object.cornerRadius ?? 0);
    else if (object.shape === 'ellipse') path.ellipse(object.width / 2, object.height / 2, Math.abs(object.width / 2), Math.abs(object.height / 2), 0, 0, Math.PI * 2);
    else if (object.shape === 'line' || object.shape === 'arrow') {
      path.moveTo(0, 0); path.lineTo(object.width, object.height);
      if (object.shape === 'arrow') {
        const angle = Math.atan2(object.height, object.width); const head = Math.max(10, object.stroke.width * 4);
        path.moveTo(object.width, object.height); path.lineTo(object.width - Math.cos(angle - 0.5) * head, object.height - Math.sin(angle - 0.5) * head);
        path.moveTo(object.width, object.height); path.lineTo(object.width - Math.cos(angle + 0.5) * head, object.height - Math.sin(angle + 0.5) * head);
      }
    } else {
      const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6);
      const cx = object.width / 2; const cy = object.height / 2; const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
      for (let index = 0; index < count; index += 1) {
        const r = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius;
        const angle = -Math.PI / 2 + index / count * Math.PI * 2;
        const x = cx + Math.cos(angle) * r; const y = cy + Math.sin(angle) * r;
        if (index === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
    }
    const fill = paint(context, object.fill);
    if (fill) { context.fillStyle = fill; context.fill(path); }
    const stroke = paint(context, object.stroke.paint);
    if (stroke && object.stroke.width > 0) { context.strokeStyle = stroke; applyCanvasStrokeStyle(context, object.stroke); context.stroke(path); }
  } else if (object.type === 'text') {
    renderStyledText(context, object);
  } else if (object.type === 'image') {
    const asset = document.assets[object.assetId];
    if (asset?.data) { const image = await loadImage(Buffer.from(asset.data, 'base64')); if (object.crop) context.drawImage(image, object.crop.x, object.crop.y, object.crop.width, object.crop.height, 0, 0, object.width, object.height); else context.drawImage(image, 0, 0, object.width, object.height); }
  }
  context.restore();
}

async function renderIllustrationSurface(document: IllustrationDocument, region: IllustrationRasterRegion, onlyLayerId?: string, includeBackground = true, neutralizeOnlyLayer = false, restrictPaintTilesToRegion = false, restrictObjectsToRegion = false): Promise<Canvas> {
  ensureBundledNativeCanvasFonts();
  const canvas = createCanvas(region.width, region.height);
  const context = canvas.getContext('2d');
  context.save();
  context.translate(-region.x, -region.y);
  const paintTileImages = new Map<string, LoadedImage>();
  if (includeBackground && document.artboard.background) { context.fillStyle = document.artboard.background; context.fillRect(0, 0, document.artboard.width, document.artboard.height); }
  const objectChildren = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
  const drawObjectEntry = async (
    target: Context,
    objectId: string,
    visiting = new Set<string>(),
    parentTranslation: Readonly<{ x: number; y: number }> = { x: 0, y: 0 },
  ): Promise<void> => {
    if (visiting.has(objectId)) return;
    const object = document.objects[objectId]; if (!object?.visible) return;
    if (object.type !== 'group') {
      if (restrictObjectsToRegion && !phaseExactIllustrationObjectIntersectsRegion(object, region, parentTranslation)) return;
      target.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) target.clip(maskPath); await drawIllustrationObject(target, document, object); target.restore(); return;
    }
    const nextVisiting = new Set(visiting); nextVisiting.add(objectId);
    const childTranslation = restrictObjectsToRegion
      ? { x: parentTranslation.x + object.transform.x, y: parentTranslation.y + object.transform.y }
      : parentTranslation;
    const transformed = illustrationObjectHasTransform(object); const isolate = illustrationGroupRequiresIsolation(object);
    if (!isolate) {
      target.save();
      try {
        if (transformed) { target.translate(object.transform.x, object.transform.y); target.rotate(object.transform.rotation * Math.PI / 180); target.transform(object.transform.scaleX, Math.tan(object.transform.skewY * Math.PI / 180), Math.tan(object.transform.skewX * Math.PI / 180), object.transform.scaleY, 0, 0); }
        for (const childId of object.childIds) await drawObjectEntry(target, childId, nextVisiting, childTranslation);
      } finally { target.restore(); }
      return;
    }
    const buffer = acquireScratchCanvas(region.width, region.height); const bufferContext = buffer.getContext('2d'); bufferContext.translate(-region.x, -region.y);
    try {
      for (const childId of object.childIds) await drawObjectEntry(bufferContext, childId, nextVisiting, childTranslation);
      target.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) target.clip(maskPath);
      target.translate(object.transform.x, object.transform.y); target.rotate(object.transform.rotation * Math.PI / 180); target.transform(object.transform.scaleX, Math.tan(object.transform.skewY * Math.PI / 180), Math.tan(object.transform.skewX * Math.PI / 180), object.transform.scaleY, 0, 0); target.globalAlpha *= object.opacity; target.globalCompositeOperation = composite(object.blendMode); target.filter = objectFilter(object); if (object.shadow) { target.shadowColor = object.shadow.color; target.shadowBlur = object.shadow.blur; target.shadowOffsetX = object.shadow.offsetX; target.shadowOffsetY = object.shadow.offsetY; } target.drawImage(buffer, region.x, region.y); target.restore();
    } finally { releaseScratchCanvas(buffer); }
  };
  const drawLayer = async (layerId: string, target: Context = context): Promise<void> => {
    const layer = document.layers[layerId];
    const neutralize = neutralizeOnlyLayer && layerId === onlyLayerId;
    if (!layer || (!layer.visible && !neutralize)) return;
    const drawContents = async (output: Context) => {
      if (layer.type === 'paint') {
        const plan = paintTileCachePlan(layer, document.assets);
        let cachedTiles: Array<{ image: LoadedImage; tileX: number; tileY: number }> | undefined;
        if (plan) {
          try {
            cachedTiles = [];
            const entries = restrictPaintTilesToRegion
              ? paintTileCacheEntriesForIllustrationRegion(plan.entries, layer.tileSize, region)
              : plan.entries;
            for (const entry of entries) {
              let image = paintTileImages.get(entry.assetId);
              if (!image) {
                image = await cachedPaintTileImage(entry.asset.sha256, entry.asset.data!, layer.tileSize);
                if (image.width !== layer.tileSize || image.height !== layer.tileSize) throw new Error('Paint tile dimensions do not match the layer tile size');
                paintTileImages.set(entry.assetId, image);
              }
              cachedTiles.push({ image, tileX: entry.tileX, tileY: entry.tileY });
            }
          } catch { cachedTiles = undefined; }
        }
        if (cachedTiles && plan) {
          for (const entry of cachedTiles) output.drawImage(entry.image, entry.tileX * layer.tileSize, entry.tileY * layer.tileSize);
          for (const stroke of layer.strokes.slice(plan.strokeCount)) renderRasterStroke(output, stroke);
        } else for (const stroke of layer.strokes) renderRasterStroke(output, stroke);
      }
      if (layer.type === 'vector') for (const objectId of layer.objectIds) if (!objectChildren.has(objectId)) await drawObjectEntry(output, objectId);
      if (layer.type === 'group') for (const childId of layer.childIds) await drawLayer(childId, output);
    };
    target.save();
    const maskLayer = layer.maskLayerId ? document.layers[layer.maskLayerId] : undefined;
    if (maskLayer?.type === 'vector') { const maskPath = new Path2D(); for (const objectId of maskLayer.objectIds) { const path = document.objects[objectId] ? transformedObjectPath(document.objects[objectId]) : undefined; if (path) maskPath.addPath(path); } target.clip(maskPath); }
    const opacity = neutralize ? 1 : layer.opacity; const blendMode = neutralize ? 'normal' : layer.blendMode;
    if (opacity !== 1 || blendMode !== 'normal' || layer.filters?.length) {
      const buffer = acquireScratchCanvas(region.width, region.height); const bufferContext = buffer.getContext('2d'); bufferContext.translate(-region.x, -region.y);
      try { await drawContents(bufferContext); target.globalAlpha *= opacity; target.globalCompositeOperation = composite(blendMode); target.filter = adjustmentFilter(layer.filters); target.drawImage(buffer, region.x, region.y); }
      finally { releaseScratchCanvas(buffer); }
    } else await drawContents(target);
    target.restore();
  };
  if (onlyLayerId) await drawLayer(onlyLayerId); else for (const layerId of document.layerIds) await drawLayer(layerId);
  context.restore();
  return canvas;
}

function sameRegion(left: IllustrationRasterRegion, right: IllustrationRasterRegion): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function cropIllustrationSurface(source: Canvas, x: number, y: number, width: number, height: number): Canvas {
  const canvas = createCanvas(width, height);
  const pixels = source.getContext('2d').getImageData(x, y, width, height);
  canvas.getContext('2d').putImageData(pixels, 0, 0);
  return canvas;
}

export async function renderIllustration(document: IllustrationDocument, onlyLayerId?: string, includeBackground = true): Promise<Canvas> {
  return renderIllustrationSurface(document, { x: 0, y: 0, width: document.artboard.width, height: document.artboard.height }, onlyLayerId, includeBackground);
}

export async function renderIllustrationLayerSource(document: IllustrationDocument, layerId: string): Promise<Canvas> {
  return renderIllustrationSurface(document, { x: 0, y: 0, width: document.artboard.width, height: document.artboard.height }, layerId, false, true);
}

export async function renderIllustrationRegion(document: IllustrationDocument, requested: IllustrationRasterRegion, onlyLayerId?: string, includeBackground = true): Promise<Canvas> {
  const backing = illustrationRegionBacking(document, requested);
  assertStaticRasterDimensions(backing.width, backing.height, 'Illustration raster region');
  if (!illustrationRegionCanRenderLocally(document, onlyLayerId)) {
    const full = await renderIllustration(document, onlyLayerId, includeBackground);
    if (requested.x === 0 && requested.y === 0 && requested.width === full.width && requested.height === full.height) return full;
    try { return cropIllustrationSurface(full, requested.x, requested.y, requested.width, requested.height); }
    finally { releaseCanvas(full); }
  }
  const source = await renderIllustrationSurface(document, backing, onlyLayerId, includeBackground, false, true, true);
  if (sameRegion(requested, backing)) return source;
  try { return cropIllustrationSurface(source, requested.x - backing.x, requested.y - backing.y, requested.width, requested.height); }
  finally { releaseCanvas(source); }
}

export function renderSprite(document: PixelDocument, sprite: PixelSprite, frameId = sprite.frameIds[0], onlyLayerId?: string): Canvas {
  const canvas = createCanvas(sprite.width, sprite.height);
  const context = canvas.getContext('2d');
  drawPixelSpriteRegion(context, sprite, frameId, document.palette, { x: 0, y: 0, width: sprite.width, height: sprite.height }, { onlyLayerId });
  return canvas;
}

export interface RenderedSpriteRegion {
  canvas: Canvas;
  sample: PixelSpriteRegion;
}

export function renderSpriteRegion(document: PixelDocument, sprite: PixelSprite, source: PixelSpriteRegion, frameId = sprite.frameIds[0]): RenderedSpriteRegion {
  const plan = pixelSpriteRegionPlan(sprite, source);
  const canvas = createCanvas(plan.render.width, plan.render.height);
  if (!plan.empty) drawPixelSpriteRegion(canvas.getContext('2d'), sprite, frameId, document.palette, plan.render);
  return { canvas, sample: plan.sample };
}

export function renderTilemapDimensions(map: PixelTilemap): { width: number; height: number } {
  const isometric = map.orientation === 'isometric';
  const projected = isometric
    ? isometricProjectionExtent(map.width, map.height, map.tileWidth, map.tileHeight)
    : orthogonalProjectionExtent(map.width, map.height, map.tileWidth, map.tileHeight);
  return { width: Math.max(1, Math.ceil(projected.width)), height: Math.max(1, Math.ceil(projected.height)) };
}

function renderTilemapSurface(document: PixelDocument, map: PixelTilemap, region: PixelSpriteRegion, onlyLayerId?: string, tileAnimationTimeMs = 0): Canvas {
  assertImageCollectionTilemapMode(document, map);
  const isometric = map.orientation === 'isometric';
  const dimensions = renderTilemapDimensions(map);
  const orthogonalArtworkEnvelope = isometric ? undefined : orthogonalMapTileArtworkEnvelope(document, map);
  const isometricArtworkEnvelope = isometric ? isometricMapTileArtworkEnvelope(document, map) : undefined;
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw new RangeError('Tilemap raster regions must use nonnegative safe-integer coordinates and positive safe-integer dimensions.');
  if (!Number.isSafeInteger(region.x + region.width) || !Number.isSafeInteger(region.y + region.height) || region.x + region.width > dimensions.width || region.y + region.height > dimensions.height) throw new RangeError('Tilemap raster region falls outside the nominal projected bounds.');
  assertStaticRasterDimensions(region.width, region.height, 'Tilemap raster region');
  const canvas = createCanvas(region.width, region.height); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false; context.translate(-region.x, -region.y);
  const sources = new BoundedResourceCache<RenderedSpriteRegion>(MAX_MAP_TILE_SOURCE_CACHE_ENTRIES, MAX_MAP_TILE_SOURCE_CACHE_BYTES, (source) => releaseCanvas(source.canvas));
  const animatedLocalIds = new Map<string, number>();
  const animatedLocalId = (tileset: Parameters<typeof tilesetTileSourceRect>[0], localId: number) => {
    const key = `${tileset.id}\0${localId}`; const cached = animatedLocalIds.get(key); if (cached !== undefined) return cached;
    const sampled = tileAnimationFrameAt(tileset.tiles[localId]?.animation ?? [], tileAnimationTimeMs)?.tileId ?? localId; animatedLocalIds.set(key, sampled); return sampled;
  };
  const visibleLayers = composedVisibleTilemapLayers(map, onlyLayerId);
  try { for (const entry of visibleLayers) {
    const { layer } = entry;
    const layerRegion = entry.offsetX === 0 && entry.offsetY === 0 ? region : { ...region, x: region.x - entry.offsetX, y: region.y - entry.offsetY };
    context.save(); context.translate(entry.offsetX, entry.offsetY);
    context.globalAlpha = entry.opacity;
    if (layer.type === 'object') {
      const matrix = isometric
        ? isometricObjectMatrix(map.height, map.tileWidth, map.tileHeight, map.tileWidth, map.tileHeight)
        : orthogonalObjectMatrix(map.tileWidth, map.tileHeight, map.tileWidth, map.tileHeight);
      const unitScale = isometric ? map.tileWidth / Math.max(map.tileWidth, map.tileHeight) : 1;
      for (const object of layer.objects ?? []) {
        if (object.type !== 'tile') {
          if (!mapObjectsIntersectingRasterRegion([object], matrix, layerRegion, { unitScale }).length) continue;
          context.save(); context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f); drawMapObjectOverlay(context, object, { unitScale }); context.restore();
          continue;
        }
        const decoded = decodeTiledGid(object.gid);
        const resolved = resolveTilesetForGid(document, map, decoded.gid);
        const sourceAsset = resolved?.tileset.spriteAssetId ? document.pixelAssets[resolved.tileset.spriteAssetId] : undefined;
        const placement = tileObjectArtworkPlacement(object, map.orientation, matrix, 1, resolved?.tileset);
        if (!tileObjectArtworkIntersects(placement, layerRegion)) continue;
        if (resolved && sourceAsset?.type === 'sprite') {
          const sourceRect = tilesetTileSourceRect(resolved.tileset, animatedLocalId(resolved.tileset, resolved.localId), sourceAsset);
          const plan = pixelSpriteRegionPlan(sourceAsset, sourceRect); const frameId = sourceAsset.frameIds[0]; const cacheKey = `${sourceAsset.id}\0${frameId}\0${sourceRect.x},${sourceRect.y},${sourceRect.width},${sourceRect.height}`;
          const source = sources.acquire(cacheKey, plan.render.width * plan.render.height * 4, () => renderSpriteRegion(document, sourceAsset, sourceRect, frameId));
          try {
            const sampled = source.value;
            context.save(); context.translate(placement.center.x, placement.center.y); context.transform(placement.transform.a, placement.transform.b, placement.transform.c, placement.transform.d, 0, 0); context.drawImage(sampled.canvas, sampled.sample.x, sampled.sample.y, sampled.sample.width, sampled.sample.height, -placement.width / 2, -placement.height / 2, placement.width, placement.height); context.restore();
          } finally { source.release(); }
        } else {
          context.save(); context.translate(placement.center.x, placement.center.y); context.transform(placement.transform.a, placement.transform.b, placement.transform.c, placement.transform.d, 0, 0); context.fillStyle = tileObjectFallbackColor(decoded.gid); context.fillRect(-placement.width / 2, -placement.height / 2, placement.width, placement.height); context.restore();
        }
      }
      context.restore();
      continue;
    }
    if (layer.type !== 'tile' || !layer.chunks) { context.restore(); continue; }
    const candidateChunks = tilemapChunksIntersectingRegion(Object.values(layer.chunks), {
      orientation: map.orientation,
      rows: map.height,
      tileWidth: map.tileWidth,
      tileHeight: map.tileHeight,
      orthogonalArtworkEnvelope,
      isometricArtworkEnvelope,
    }, layerRegion);
    const drawCell = (tileX: number, tileY: number, raw: number) => {
      const decoded = decodeTiledGid(raw); if (!decoded.gid) return;
      const rect = isometric
        ? isometricCellRect(tileX, tileY, map.height, map.tileWidth, map.tileHeight)
        : orthogonalCellRect(tileX, tileY, map.tileWidth, map.tileHeight);
      const resolved = resolveTilesetForGid(document, map, decoded.gid);
      const renderedLocalId = resolved ? animatedLocalId(resolved.tileset, resolved.localId) : undefined;
      const sourceAssetId = resolved && renderedLocalId !== undefined ? tilesetTileSourceAssetId(resolved.tileset, renderedLocalId) : undefined;
      const sourceAsset = sourceAssetId ? document.pixelAssets[sourceAssetId] : undefined;
      const sourceIsRenderable = sourceAsset?.type === 'sprite';
      const artworkPlacement = resolved && sourceIsRenderable
        ? isometric
          ? isometricTileArtworkPlacement(rect, map.tileWidth, map.tileHeight, { width: resolved.tileset.tileWidth, height: resolved.tileset.tileHeight }, decoded, resolved.tileset.tileOffset)
          : orthogonalTileArtworkPlacement(rect, map.tileWidth, map.tileHeight, { width: isImageCollectionTileset(resolved.tileset) ? sourceAsset.width : resolved.tileset.tileWidth, height: isImageCollectionTileset(resolved.tileset) ? sourceAsset.height : resolved.tileset.tileHeight }, decoded, resolved.tileset.tileOffset)
        : undefined;
      const artworkIntersects = artworkPlacement
        ? isometric
          ? isometricTileArtworkIntersects(artworkPlacement.bounds, layerRegion)
          : orthogonalTileArtworkIntersects(artworkPlacement.bounds, layerRegion)
        : rect.x + rect.width > layerRegion.x && rect.y + rect.height > layerRegion.y && rect.x < layerRegion.x + layerRegion.width && rect.y < layerRegion.y + layerRegion.height;
      if (!artworkIntersects) return;
      if (resolved && sourceAsset?.type === 'sprite') {
        const sourceRect = tilesetTileSourceRect(resolved.tileset, renderedLocalId!, sourceAsset);
        const plan = pixelSpriteRegionPlan(sourceAsset, sourceRect); const frameId = sourceAsset.frameIds[0]; const cacheKey = `${sourceAsset.id}\0${frameId}\0${sourceRect.x},${sourceRect.y},${sourceRect.width},${sourceRect.height}`;
        const source = sources.acquire(cacheKey, plan.render.width * plan.render.height * 4, () => renderSpriteRegion(document, sourceAsset, sourceRect, frameId));
        try {
          const sampled = source.value;
          const placement = artworkPlacement!;
          context.save(); try { context.translate(placement.centerX, placement.centerY); context.transform(placement.transform.a, placement.transform.b, placement.transform.c, placement.transform.d, 0, 0); context.drawImage(sampled.canvas, sampled.sample.x, sampled.sample.y, sampled.sample.width, sampled.sample.height, -placement.width / 2, -placement.height / 2, placement.width, placement.height); } finally { context.restore(); }
        } finally { source.release(); }
      } else { const visibleGid = resolved && renderedLocalId !== undefined ? resolved.tileset.firstGid + renderedLocalId : decoded.gid; context.fillStyle = `hsl(${visibleGid * 47 % 360} 55% 60%)`; context.fillRect(rect.x, rect.y, rect.width, rect.height); }
    };
    if (isometric) for (const cell of isometricTileRenderCells(candidateChunks, (chunk) => decodeTilemapChunk(chunk))) drawCell(cell.x, cell.y, cell.raw);
    else for (const chunk of candidateChunks) {
      const values = decodeTilemapChunk(chunk);
      for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) drawCell(chunk.x + x, chunk.y + y, values[y * 32 + x] ?? 0);
    }
    context.restore();
  } } finally { sources.clear(); }
  return canvas;
}

export function renderTilemapRegion(document: PixelDocument, map: PixelTilemap, region: PixelSpriteRegion, onlyLayerId?: string, tileAnimationTimeMs = 0): Canvas {
  const dimensions = renderTilemapDimensions(map);
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw new RangeError('Tilemap raster regions must use nonnegative safe-integer coordinates and positive safe-integer dimensions.');
  if (!Number.isSafeInteger(region.x + region.width) || !Number.isSafeInteger(region.y + region.height) || region.x + region.width > dimensions.width || region.y + region.height > dimensions.height) throw new RangeError('Tilemap raster region falls outside the nominal projected bounds.');
  assertStaticRasterDimensions(region.width, region.height, 'Tilemap raster region');
  let left = Math.min(TILEMAP_REGION_OVERSCAN_PIXELS, region.x);
  let right = Math.min(TILEMAP_REGION_OVERSCAN_PIXELS, dimensions.width - region.x - region.width);
  let top = Math.min(TILEMAP_REGION_OVERSCAN_PIXELS, region.y);
  let bottom = Math.min(TILEMAP_REGION_OVERSCAN_PIXELS, dimensions.height - region.y - region.height);
  while (region.width + left + right > MAX_STATIC_RASTER_SIDE) { if (right > left) right -= 1; else left -= 1; }
  while (region.height + top + bottom > MAX_STATIC_RASTER_SIDE) { if (bottom > top) bottom -= 1; else top -= 1; }
  while ((region.width + left + right) * (region.height + top + bottom) > MAX_STATIC_RASTER_PIXELS) {
    if (bottom > 0) bottom -= 1;
    else if (top > 0) top -= 1;
    else if (right > 0) right -= 1;
    else if (left > 0) left -= 1;
  }
  const expanded = { x: region.x - left, y: region.y - top, width: region.width + left + right, height: region.height + top + bottom };
  const surface = renderTilemapSurface(document, map, expanded, onlyLayerId, tileAnimationTimeMs);
  if (expanded.x === region.x && expanded.y === region.y && expanded.width === region.width && expanded.height === region.height) return surface;
  try {
    const pixels = surface.getContext('2d').getImageData(region.x - expanded.x, region.y - expanded.y, region.width, region.height);
    const canvas = createCanvas(region.width, region.height); canvas.getContext('2d').putImageData(pixels, 0, 0); return canvas;
  } finally { releaseCanvas(surface); }
}

export function renderTilemap(document: PixelDocument, map: PixelTilemap, onlyLayerId?: string, tileAnimationTimeMs = 0): Canvas {
  const dimensions = renderTilemapDimensions(map);
  assertStaticRasterDimensions(dimensions.width, dimensions.height, 'Tilemap raster');
  return renderTilemapRegion(document, map, { x: 0, y: 0, ...dimensions }, onlyLayerId, tileAnimationTimeMs);
}

export function renderPixelAsset(document: PixelDocument, assetId = document.activeAssetId, frameId?: string, layerId?: string): Canvas {
  const asset = document.pixelAssets[assetId];
  if (asset?.type === 'sprite') return renderSprite(document, asset, frameId ?? asset.frameIds[0], layerId);
  if (asset?.type === 'tilemap') return renderTilemap(document, asset, layerId);
  if (asset?.type === 'tileset') {
    const sprite = asset.spriteAssetId ? document.pixelAssets[asset.spriteAssetId] : undefined;
    if (sprite?.type === 'sprite') return renderSprite(document, sprite, frameId ?? sprite.frameIds[0], layerId);
  }
  return createCanvas(1, 1);
}

export async function renderDocument(document: AIDrawDocument): Promise<Canvas> {
  if (document.kind === 'illustration') return renderIllustration(document);
  return renderPixelAsset(document);
}

export function renderDocumentDimensions(document: AIDrawDocument): { width: number; height: number } {
  if (document.kind === 'illustration') return { width: document.artboard.width, height: document.artboard.height };
  const active = document.pixelAssets[document.activeAssetId];
  const sourceId = active?.type === 'tileset' ? active.spriteAssetId : undefined;
  const asset = active?.type === 'tileset' ? sourceId ? document.pixelAssets[sourceId] : undefined : active;
  if (asset?.type === 'sprite') return { width: asset.width, height: asset.height };
  if (asset?.type === 'tilemap') return renderTilemapDimensions(asset);
  return { width: 1, height: 1 };
}
