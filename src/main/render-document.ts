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
import { canvasFont } from '../common/canvas-font';

type Context = ReturnType<Canvas['getContext']>;

function composite(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : mode;
}

function paint(context: Context, style: PaintStyle): string | ReturnType<Context['createLinearGradient']> | undefined {
  if (style.kind === 'none') return undefined;
  if (style.kind === 'solid') return style.color;
  const gradient = style.kind === 'linear-gradient'
    ? context.createLinearGradient(style.x1, style.y1, style.x2, style.y2)
    : context.createRadialGradient(style.x1, style.y1, 0, style.x2, style.y2, Math.hypot(style.x2 - style.x1, style.y2 - style.y1));
  for (const stop of style.stops) gradient.addColorStop(stop.offset, stop.color);
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

function imageFilter(object: Extract<IllustrationObject, { type: 'image' }>): string { return object.filters.map((filter) => filter.type === 'brightness' ? `brightness(${Math.max(0, 1 + filter.value)})` : filter.type === 'contrast' ? `contrast(${Math.max(0, 1 + filter.value)})` : filter.type === 'saturation' ? `saturate(${Math.max(0, 1 + filter.value)})` : filter.type === 'hue' ? `hue-rotate(${filter.value}deg)` : `blur(${Math.max(0, filter.value)}px)`).join(' '); }

function objectFilter(object: IllustrationObject): string {
  const filters: string[] = [];
  if ((object.blur ?? 0) > 0) filters.push(`blur(${Math.max(0, object.blur ?? 0)}px)`);
  if (object.type === 'image') { const imageFilters = imageFilter(object); if (imageFilters) filters.push(imageFilters); }
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
    context.textBaseline = 'top'; const ranges = object.ranges.length ? object.ranges : [{ start: 0, end: object.text.length, fontFamily: 'sans-serif', fontSize: 48, fontWeight: 500, fontStyle: 'normal' as const, color: '#27213c', letterSpacing: 0 }];
    const measurements = ranges.map((range) => { context.font = canvasFont(range); const value = object.text.slice(range.start, range.end); return context.measureText(value).width + Math.max(0, value.length - 1) * range.letterSpacing; }); const total = measurements.reduce((sum, value) => sum + value, 0); let x = object.align === 'center' ? (object.width - total) / 2 : object.align === 'right' ? object.width - total : 0;
    for (const range of ranges) { context.font = canvasFont(range); context.fillStyle = range.color; for (const character of object.text.slice(range.start, range.end)) { context.fillText(character, x, 0); const width = context.measureText(character).width; if (range.underline) context.fillRect(x, range.fontSize * 1.05, width, Math.max(1, range.fontSize / 18)); x += width + range.letterSpacing; } }
  } else if (object.type === 'image') {
    const asset = document.assets[object.assetId];
    if (asset?.data) { const image = await loadImage(Buffer.from(asset.data, 'base64')); if (object.crop) context.drawImage(image, object.crop.x, object.crop.y, object.crop.width, object.crop.height, 0, 0, object.width, object.height); else context.drawImage(image, 0, 0, object.width, object.height); }
  }
  context.restore();
}

export async function renderIllustration(document: IllustrationDocument, onlyLayerId?: string): Promise<Canvas> {
  const canvas = createCanvas(document.artboard.width, document.artboard.height);
  const context = canvas.getContext('2d');
  if (document.artboard.background) { context.fillStyle = document.artboard.background; context.fillRect(0, 0, canvas.width, canvas.height); }
  const drawLayer = async (layerId: string): Promise<void> => {
    const layer = document.layers[layerId];
    if (!layer?.visible) return;
    context.save(); context.globalAlpha = layer.opacity; context.globalCompositeOperation = composite(layer.blendMode);
    const maskLayer = layer.maskLayerId ? document.layers[layer.maskLayerId] : undefined;
    if (maskLayer?.type === 'vector') { const maskPath = new Path2D(); for (const objectId of maskLayer.objectIds) { const path = document.objects[objectId] ? transformedObjectPath(document.objects[objectId]) : undefined; if (path) maskPath.addPath(path); } context.clip(maskPath); }
    if (layer.type === 'paint') for (const stroke of layer.strokes) {
      context.save(); context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'; context.globalAlpha *= stroke.opacity * stroke.flow;
      context.strokeStyle = stroke.color; context.lineWidth = stroke.size; context.lineCap = stroke.preset === 'marker' ? 'square' : 'round'; context.lineJoin = 'round'; context.filter = stroke.preset === 'soft-round' || stroke.preset === 'airbrush' ? `blur(${stroke.size * (stroke.preset === 'airbrush' ? .35 : .18)}px)` : 'none'; context.beginPath();
      stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); context.restore();
    }
    if (layer.type === 'vector') for (const objectId of layer.objectIds) {
      const object = document.objects[objectId]; if (object) { context.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) context.clip(maskPath); await drawIllustrationObject(context, document, object); context.restore(); }
    }
    if (layer.type === 'group') for (const childId of layer.childIds) await drawLayer(childId);
    context.restore();
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

function renderTilemap(document: PixelDocument, map: PixelTilemap): Canvas {
  const isometric = map.orientation === 'isometric';
  const width = isometric ? Math.max(1, Math.ceil((map.width + map.height) * map.tileWidth / 2)) : map.width * map.tileWidth;
  const height = isometric ? Math.max(1, Math.ceil((map.width + map.height) * map.tileHeight / 2)) : map.height * map.tileHeight;
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
  const sources = new Map<string, Canvas>();
  const visibleLayers: Array<{ layer: PixelTilemap['layers'][string]; opacity: number }> = []; const visit = (id: string, opacity = 1) => { const layer = map.layers[id]; if (!layer?.visible) return; const combined = opacity * layer.opacity; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined); else visibleLayers.push({ layer, opacity: combined }); }; for (const id of map.layerIds) visit(id);
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

export async function renderDocument(document: AIDrawDocument): Promise<Canvas> {
  if (document.kind === 'illustration') return renderIllustration(document);
  const asset = document.pixelAssets[document.activeAssetId];
  if (asset?.type === 'sprite') return renderSprite(document, asset);
  if (asset?.type === 'tilemap') return renderTilemap(document, asset);
  if (asset?.type === 'tileset') {
    const sprite = document.pixelAssets[asset.spriteAssetId];
    if (sprite?.type === 'sprite') return renderSprite(document, sprite);
  }
  return createCanvas(1, 1);
}
