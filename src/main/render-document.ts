import { Canvas, Path2D, createCanvas, loadImage } from '@napi-rs/canvas';
import { getStroke } from 'perfect-freehand';
import {
  decodePixelChunk,
  decodeTiledGid,
  decodeTilemapChunk,
  resolveTilesetForGid,
  type AIDrawDocument,
  type BlendMode,
  type IllustrationDocument,
  type IllustrationObject,
  type PaintStyle,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
} from '@aidraw/core';
import { colorWithOpacity } from '../common/color';
import { paintTileCachePlan } from '../common/paint-tile-cache';
import { renderRasterStroke } from '../common/raster-brush';
import { renderStyledText } from '../common/text-layout';

type Context = ReturnType<Canvas['getContext']>;
type LoadedImage = Awaited<ReturnType<typeof loadImage>>;

const MAX_PAINT_TILE_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const paintTileImageCache = new Map<string, { bytes: number; promise: Promise<LoadedImage> }>();
let paintTileImageCacheBytes = 0;

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
    if (stroke && object.stroke.width > 0) { context.strokeStyle = stroke; context.lineWidth = object.stroke.width; context.setLineDash(object.stroke.dash); context.stroke(path); }
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
    if (stroke && object.stroke.width > 0) { context.strokeStyle = stroke; context.lineWidth = object.stroke.width; context.lineCap = object.stroke.lineCap; context.lineJoin = object.stroke.lineJoin; context.setLineDash(object.stroke.dash); context.stroke(path); }
  } else if (object.type === 'text') {
    renderStyledText(context, object);
  } else if (object.type === 'image') {
    const asset = document.assets[object.assetId];
    if (asset?.data) { const image = await loadImage(Buffer.from(asset.data, 'base64')); if (object.crop) context.drawImage(image, object.crop.x, object.crop.y, object.crop.width, object.crop.height, 0, 0, object.width, object.height); else context.drawImage(image, 0, 0, object.width, object.height); }
  }
  context.restore();
}

export async function renderIllustration(document: IllustrationDocument, onlyLayerId?: string, includeBackground = true): Promise<Canvas> {
  const canvas = createCanvas(document.artboard.width, document.artboard.height);
  const context = canvas.getContext('2d');
  const paintTileImages = new Map<string, LoadedImage>();
  if (includeBackground && document.artboard.background) { context.fillStyle = document.artboard.background; context.fillRect(0, 0, canvas.width, canvas.height); }
  const objectChildren = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
  const drawObjectEntry = async (target: Context, objectId: string, visiting = new Set<string>()): Promise<void> => {
    if (visiting.has(objectId)) return;
    const object = document.objects[objectId]; if (!object?.visible) return;
    if (object.type !== 'group') { target.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) target.clip(maskPath); await drawIllustrationObject(target, document, object); target.restore(); return; }
    const nextVisiting = new Set(visiting); nextVisiting.add(objectId);
    const transformed = object.transform.x !== 0 || object.transform.y !== 0 || object.transform.scaleX !== 1 || object.transform.scaleY !== 1 || object.transform.rotation !== 0 || object.transform.skewX !== 0 || object.transform.skewY !== 0;
    const isolate = transformed || object.opacity !== 1 || object.blendMode !== 'normal' || Boolean(object.blur || object.shadow || object.maskObjectId || object.filters?.length);
    if (!isolate) { for (const childId of object.childIds) await drawObjectEntry(target, childId, nextVisiting); return; }
    const buffer = createCanvas(document.artboard.width, document.artboard.height); const bufferContext = buffer.getContext('2d');
    for (const childId of object.childIds) await drawObjectEntry(bufferContext, childId, nextVisiting);
    target.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) target.clip(maskPath);
    target.translate(object.transform.x, object.transform.y); target.rotate(object.transform.rotation * Math.PI / 180); target.transform(object.transform.scaleX, Math.tan(object.transform.skewY * Math.PI / 180), Math.tan(object.transform.skewX * Math.PI / 180), object.transform.scaleY, 0, 0); target.globalAlpha *= object.opacity; target.globalCompositeOperation = composite(object.blendMode); target.filter = objectFilter(object); if (object.shadow) { target.shadowColor = object.shadow.color; target.shadowBlur = object.shadow.blur; target.shadowOffsetX = object.shadow.offsetX; target.shadowOffsetY = object.shadow.offsetY; } target.drawImage(buffer, 0, 0); target.restore();
  };
  const drawLayer = async (layerId: string, target: Context = context): Promise<void> => {
    const layer = document.layers[layerId];
    if (!layer?.visible) return;
    const drawContents = async (output: Context) => {
      if (layer.type === 'paint') {
        const plan = paintTileCachePlan(layer, document.assets);
        let cachedTiles: Array<{ image: LoadedImage; tileX: number; tileY: number }> | undefined;
        if (plan) {
          try {
            cachedTiles = [];
            for (const entry of plan.entries) {
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
    if (layer.opacity !== 1 || layer.blendMode !== 'normal' || layer.filters?.length) {
      const buffer = createCanvas(document.artboard.width, document.artboard.height); await drawContents(buffer.getContext('2d')); target.globalAlpha *= layer.opacity; target.globalCompositeOperation = composite(layer.blendMode); target.filter = adjustmentFilter(layer.filters); target.drawImage(buffer, 0, 0);
    } else await drawContents(target);
    target.restore();
  };
  if (onlyLayerId) await drawLayer(onlyLayerId); else for (const layerId of document.layerIds) await drawLayer(layerId);
  return canvas;
}

export function renderSprite(document: PixelDocument, sprite: PixelSprite, frameId = sprite.frameIds[0], onlyLayerId?: string): Canvas {
  const canvas = createCanvas(sprite.width, sprite.height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  const visibleLayers: Array<{ layer: PixelSprite['layers'][string]; opacity: number }> = []; const visit = (id: string, opacity = 1) => { const layer = sprite.layers[id]; if (!layer?.visible) return; const combined = opacity * layer.opacity; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined); else visibleLayers.push({ layer, opacity: combined }); }; if (onlyLayerId) visit(onlyLayerId); else for (const id of sprite.layerIds) visit(id);
  for (const entry of visibleLayers) {
    const { layer } = entry; if (layer.type !== 'pixel') continue;
    const directCel = Object.values(sprite.cels).find((cel) => cel.layerId === layer.id && cel.frameId === frameId);
    const cel = directCel?.linkedToCelId ? sprite.cels[directCel.linkedToCelId] ?? directCel : directCel;
    if (!cel) continue;
    context.globalAlpha = entry.opacity; context.globalCompositeOperation = composite(layer.blendMode);
    for (const chunk of Object.values(cel.chunks)) {
      const values = decodePixelChunk(chunk);
      for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
        const documentX = chunk.x + x; const documentY = chunk.y + y;
        if (documentX < 0 || documentY < 0 || documentX >= sprite.width || documentY >= sprite.height) continue;
        const index = values[y * 32 + x] ?? 0; if (index === 0) continue;
        context.fillStyle = (sprite.paletteOverrides[frameId] ?? document.palette)[index]?.color ?? '#ff00ff';
        context.fillRect(documentX, documentY, 1, 1);
      }
    }
  }
  return canvas;
}

export function renderTilemap(document: PixelDocument, map: PixelTilemap, onlyLayerId?: string): Canvas {
  const isometric = map.orientation === 'isometric';
  const width = isometric ? Math.max(1, Math.ceil((map.width + map.height) * map.tileWidth / 2)) : map.width * map.tileWidth;
  const height = isometric ? Math.max(1, Math.ceil((map.width + map.height) * map.tileHeight / 2)) : map.height * map.tileHeight;
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
  const sources = new Map<string, Canvas>();
  const visibleLayers: Array<{ layer: PixelTilemap['layers'][string]; opacity: number }> = []; const visit = (id: string, opacity = 1) => { const layer = map.layers[id]; if (!layer?.visible) return; const combined = opacity * layer.opacity; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined); else visibleLayers.push({ layer, opacity: combined }); }; if (onlyLayerId) visit(onlyLayerId); else for (const id of map.layerIds) visit(id);
  for (const entry of visibleLayers) {
    const { layer } = entry; if (layer.type !== 'tile' || !layer.chunks) continue;
    context.globalAlpha = entry.opacity;
    for (const chunk of Object.values(layer.chunks)) {
      const values = decodeTilemapChunk(chunk);
      for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
        const raw = values[y * 32 + x] ?? 0; const decoded = decodeTiledGid(raw); if (!decoded.gid) continue;
        const tileX = chunk.x + x; const tileY = chunk.y + y;
        const dx = isometric ? (tileX - tileY) * map.tileWidth / 2 + map.height * map.tileWidth / 2 : tileX * map.tileWidth;
        const dy = isometric ? (tileX + tileY) * map.tileHeight / 2 : tileY * map.tileHeight;
        const resolved = resolveTilesetForGid(document, map, decoded.gid); const sourceAsset = resolved ? document.pixelAssets[resolved.tileset.spriteAssetId] : undefined;
        if (resolved && sourceAsset?.type === 'sprite') {
          let source = sources.get(sourceAsset.id); if (!source) { source = renderSprite(document, sourceAsset); sources.set(sourceAsset.id, source); }
          const definition = resolved.tileset.tiles[resolved.localId]; const sx = definition?.sourceX ?? resolved.localId % resolved.tileset.columns * resolved.tileset.tileWidth; const sy = definition?.sourceY ?? Math.floor(resolved.localId / resolved.tileset.columns) * resolved.tileset.tileHeight;
          context.save(); context.translate(dx + map.tileWidth / 2, dy + map.tileHeight / 2); if (decoded.diagonal) { context.rotate(Math.PI / 2); context.scale(1, -1); } context.scale(decoded.hFlip ? -1 : 1, decoded.vFlip ? -1 : 1); context.drawImage(source, sx, sy, resolved.tileset.tileWidth, resolved.tileset.tileHeight, -map.tileWidth / 2, -map.tileHeight / 2, map.tileWidth, map.tileHeight); context.restore();
        } else { context.fillStyle = `hsl(${decoded.gid * 47 % 360} 55% 60%)`; context.fillRect(dx, dy, map.tileWidth, map.tileHeight); }
      }
    }
  }
  return canvas;
}

export function renderPixelAsset(document: PixelDocument, assetId = document.activeAssetId, frameId?: string, layerId?: string): Canvas {
  const asset = document.pixelAssets[assetId];
  if (asset?.type === 'sprite') return renderSprite(document, asset, frameId ?? asset.frameIds[0], layerId);
  if (asset?.type === 'tilemap') return renderTilemap(document, asset, layerId);
  if (asset?.type === 'tileset') {
    const sprite = document.pixelAssets[asset.spriteAssetId];
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
  const asset = active?.type === 'tileset' ? document.pixelAssets[active.spriteAssetId] : active;
  if (asset?.type === 'sprite') return { width: asset.width, height: asset.height };
  if (asset?.type === 'tilemap') return asset.orientation === 'isometric'
    ? { width: Math.max(1, Math.ceil((asset.width + asset.height) * asset.tileWidth / 2)), height: Math.max(1, Math.ceil((asset.width + asset.height) * asset.tileHeight / 2)) }
    : { width: Math.max(1, asset.width * asset.tileWidth), height: Math.max(1, asset.height * asset.tileHeight) };
  return { width: 1, height: 1 };
}
