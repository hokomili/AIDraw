import { dirname, extname, join } from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { writePsdBuffer, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { PDFDocument } from 'pdf-lib';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import UPNG from 'upng-js';
import { getStroke } from 'perfect-freehand';
import {
  decodeTilemapChunk,
  type AIDrawDocument,
  type IllustrationDocument,
  type IllustrationObject,
  type PaintStyle,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import type { ExportFormat, ExportOptions } from '../common/contracts';
import { renderDocument, renderIllustration, renderSprite } from './render-document';

export type { ExportFormat } from '../common/contracts';

export const MAX_EXPORT_SCALE = 64;

const scalablePixelFormats = new Set<ExportFormat>(['png', 'jpeg', 'webp', 'svg', 'pdf', 'gif', 'apng', 'sprite-sheet']);
const MAX_SCALED_PIXELS = 64 * 1024 * 1024;

export function normalizeExportScale(value: unknown): number {
  const scale = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(scale) || scale < 1 || scale > MAX_EXPORT_SCALE) {
    throw new Error(`Export scale must be an integer from 1 to ${MAX_EXPORT_SCALE}.`);
  }
  return scale;
}

function resolveExportScale(document: AIDrawDocument, format: ExportFormat, options: ExportOptions): number {
  const scale = normalizeExportScale(options.scale);
  if (scale === 1) return scale;
  if (document.kind !== 'pixel') throw new Error('Nearest-neighbor export scaling is available for pixel documents.');
  if (!scalablePixelFormats.has(format)) throw new Error(`${format.toUpperCase()} does not support presentation scaling.`);
  return scale;
}

function assertScaledDimensions(width: number, height: number, scale: number): void {
  const scaledWidth = width * scale; const scaledHeight = height * scale;
  if (scaledWidth > 65_535 || scaledHeight > 65_535) throw new Error('Scaled export dimensions exceed the 65,535-pixel format limit.');
  if (scaledWidth * scaledHeight > MAX_SCALED_PIXELS) throw new Error('Scaled export exceeds the 64-megapixel safety limit.');
}

function nearestNeighborCanvas(source: Canvas, scale: number): Canvas {
  if (scale === 1) return source;
  assertScaledDimensions(source.width, source.height, scale);
  const output = createCanvas(source.width * scale, source.height * scale);
  const context = output.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, output.width, output.height);
  return output;
}

function nearestNeighborFrame(source: Uint8Array | Uint8ClampedArray, width: number, height: number, scale: number): Uint8Array {
  if (scale === 1) return Uint8Array.from(source);
  assertScaledDimensions(width, height, scale);
  const scaledWidth = width * scale; const output = new Uint8Array(scaledWidth * height * scale * 4);
  for (let sourceY = 0; sourceY < height; sourceY += 1) for (let repeatY = 0; repeatY < scale; repeatY += 1) {
    const targetY = sourceY * scale + repeatY;
    for (let sourceX = 0; sourceX < width; sourceX += 1) {
      const sourceOffset = (sourceY * width + sourceX) * 4;
      for (let repeatX = 0; repeatX < scale; repeatX += 1) {
        const targetOffset = (targetY * scaledWidth + sourceX * scale + repeatX) * 4;
        output[targetOffset] = source[sourceOffset]; output[targetOffset + 1] = source[sourceOffset + 1]; output[targetOffset + 2] = source[sourceOffset + 2]; output[targetOffset + 3] = source[sourceOffset + 3];
      }
    }
  }
  return output;
}

function scaleWarnings(scale: number): string[] {
  return scale === 1 ? [] : [`Exported at ${scale}× using nearest-neighbor pixel scaling.`];
}

export interface ExportArtifact {
  data: Buffer;
  mimeType: string;
  extension: string;
  report: { warnings: string[]; rasterized: string[] };
  companion?: { data: Buffer; extension: string; mimeType: string; name?: string };
  companions?: Array<{ data: Buffer; extension: string; mimeType: string; name: string }>;
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgId(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '-'); }

function paintId(object: IllustrationObject, slot: 'fill' | 'stroke'): string { return `paint-${svgId(object.id)}-${slot}`; }

function stylePaint(object: IllustrationObject, slot: 'fill' | 'stroke', style: PaintStyle): string {
  if (style.kind === 'none') return 'none';
  if (style.kind === 'solid') return xml(style.color);
  return `url(#${paintId(object, slot)})`;
}

function paintDefinition(object: IllustrationObject, slot: 'fill' | 'stroke', style: PaintStyle): string {
  if (style.kind !== 'linear-gradient' && style.kind !== 'radial-gradient') return '';
  const stops = style.stops.map((stop) => `<stop offset="${stop.offset}" stop-color="${xml(stop.color)}"/>`).join('');
  if (style.kind === 'linear-gradient') return `<linearGradient id="${paintId(object, slot)}" gradientUnits="userSpaceOnUse" x1="${style.x1}" y1="${style.y1}" x2="${style.x2}" y2="${style.y2}">${stops}</linearGradient>`;
  const radius = Math.hypot(style.x2 - style.x1, style.y2 - style.y1);
  return `<radialGradient id="${paintId(object, slot)}" gradientUnits="userSpaceOnUse" cx="${style.x1}" cy="${style.y1}" r="${radius}">${stops}</radialGradient>`;
}

function transform(object: IllustrationObject): string {
  const value = object.transform;
  return `translate(${value.x} ${value.y}) rotate(${value.rotation}) scale(${value.scaleX} ${value.scaleY}) skewX(${value.skewX}) skewY(${value.skewY})`;
}

function pressureData(object: Extract<IllustrationObject, { type: 'vector-stroke' }>): string {
  const outline = getStroke(object.points.map((point) => [point.x, point.y, point.pressure] as [number, number, number]), object.brush);
  if (outline.length === 0) return '';
  return `${outline.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join(' ')} Z`;
}

function svgObject(document: IllustrationDocument, object: IllustrationObject, geometryOnly = false): string {
  const effect = geometryOnly ? '' : `${(object.blur ?? 0) > 0 ? ` filter="url(#blur-${svgId(object.id)})"` : ''}${object.maskObjectId ? ` clip-path="url(#clip-${svgId(object.id)})"` : ''}`;
  const common = `transform="${transform(object)}"${geometryOnly ? '' : ` opacity="${object.opacity}" style="mix-blend-mode:${object.blendMode}"`}${effect}`;
  if (object.type === 'vector-stroke') return `<path ${common} d="${pressureData(object)}" fill="${xml(object.brush.color)}"/>`;
  if (object.type === 'path') return `<path ${common} d="${xml(object.pathData)}" fill="${geometryOnly ? '#000' : stylePaint(object, 'fill', object.fill)}" fill-rule="${object.fillRule}" stroke="${geometryOnly ? 'none' : stylePaint(object, 'stroke', object.stroke.paint)}" stroke-width="${geometryOnly ? 0 : object.stroke.width}"/>`;
  if (object.type === 'shape') {
    const style = `fill="${geometryOnly ? '#000' : stylePaint(object, 'fill', object.fill)}" stroke="${geometryOnly ? 'none' : stylePaint(object, 'stroke', object.stroke.paint)}" stroke-width="${geometryOnly ? 0 : object.stroke.width}"`;
    if (object.shape === 'rectangle') return `<rect ${common} ${style} width="${object.width}" height="${object.height}" rx="${object.cornerRadius ?? 0}"/>`;
    if (object.shape === 'ellipse') return `<ellipse ${common} ${style} cx="${object.width / 2}" cy="${object.height / 2}" rx="${Math.abs(object.width / 2)}" ry="${Math.abs(object.height / 2)}"/>`;
    if (object.shape === 'line' || object.shape === 'arrow') return `<line ${common} ${style} x1="0" y1="0" x2="${object.width}" y2="${object.height}"/>`;
    const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6);
    const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
    const points = Array.from({ length: count }, (_, index) => {
      const r = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius;
      const angle = -Math.PI / 2 + index / count * Math.PI * 2;
      return `${object.width / 2 + Math.cos(angle) * r},${object.height / 2 + Math.sin(angle) * r}`;
    }).join(' ');
    return `<polygon ${common} ${style} points="${points}"/>`;
  }
  if (object.type === 'text') {
    const range = object.ranges[0];
    return `<text ${common} fill="${xml(range?.color ?? '#27213c')}" font-family="${xml(range?.fontFamily ?? 'sans-serif')}" font-size="${range?.fontSize ?? 48}" font-weight="${range?.fontWeight ?? 500}">${xml(object.text)}</text>`;
  }
  if (object.type === 'image') {
    const asset = document.assets[object.assetId];
    return asset?.data ? `<image ${common} width="${object.width}" height="${object.height}" href="data:${asset.mimeType};base64,${asset.data}"/>` : '';
  }
  return '';
}

export function illustrationToSvg(document: IllustrationDocument): string {
  const definitions = Object.values(document.objects).flatMap((object) => {
    const entries: string[] = [];
    if (object.type === 'shape' || object.type === 'path') {
      entries.push(paintDefinition(object, 'fill', object.fill), paintDefinition(object, 'stroke', object.stroke.paint));
    }
    if ((object.blur ?? 0) > 0) entries.push(`<filter id="blur-${svgId(object.id)}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.max(0, object.blur ?? 0)}"/></filter>`);
    if (object.maskObjectId) { const mask = document.objects[object.maskObjectId]; if (mask) entries.push(`<clipPath id="clip-${svgId(object.id)}" clipPathUnits="userSpaceOnUse">${svgObject(document, mask, true)}</clipPath>`); }
    return entries.filter(Boolean);
  }).join('');
  const svgLayer = (id: string): string => {
    const layer = document.layers[id]; if (!layer?.visible) return '';
    const content = layer.type === 'vector'
      ? layer.objectIds.map((id) => document.objects[id]).filter(Boolean).map((object) => svgObject(document, object)).join('')
      : layer.type === 'paint'
        ? layer.strokes.map((stroke) => `<polyline fill="none" stroke="${xml(stroke.color)}" stroke-width="${stroke.size}" stroke-linecap="round" stroke-linejoin="round" opacity="${stroke.opacity}" points="${stroke.points.map((point) => `${point.x},${point.y}`).join(' ')}"/>`).join('')
        : layer.childIds.map(svgLayer).join('');
    return `<g id="${xml(layer.id)}" opacity="${layer.opacity}" style="mix-blend-mode:${layer.blendMode}">${content}</g>`;
  };
  const layers = document.layerIds.map(svgLayer).join('');
  const background = document.artboard.background ? `<rect width="100%" height="100%" fill="${xml(document.artboard.background)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${document.artboard.width}" height="${document.artboard.height}" viewBox="0 0 ${document.artboard.width} ${document.artboard.height}">${definitions ? `<defs>${definitions}</defs>` : ''}${background}${layers}</svg>`;
}

async function raster(document: AIDrawDocument, format: 'png' | 'jpeg' | 'webp', scale = 1): Promise<ExportArtifact> {
  const canvas = nearestNeighborCanvas(await renderDocument(document), scale);
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const data = format === 'png'
    ? canvas.toBuffer('image/png')
    : format === 'jpeg'
      ? canvas.toBuffer('image/jpeg', 0.92)
      : canvas.toBuffer('image/webp', 0.92);
  return { data, mimeType: mime, extension: format === 'jpeg' ? 'jpg' : format, report: { warnings: scaleWarnings(scale), rasterized: [] } };
}

async function pdf(document: AIDrawDocument, scale = 1): Promise<ExportArtifact> {
  const canvas = nearestNeighborCanvas(await renderDocument(document), scale);
  const png = canvas.toBuffer('image/png');
  const output = await PDFDocument.create();
  const page = output.addPage([canvas.width, canvas.height]);
  page.drawImage(await output.embedPng(png), { x: 0, y: 0, width: canvas.width, height: canvas.height });
  return { data: Buffer.from(await output.save()), mimeType: 'application/pdf', extension: 'pdf', report: { warnings: [...scaleWarnings(scale), 'PDF export preserves visual appearance; this build rasterizes effect groups and paint while SVG retains editable vectors.'], rasterized: ['composite'] } };
}

async function psd(document: AIDrawDocument): Promise<ExportArtifact> {
  const report = { warnings: [] as string[], rasterized: [] as string[] };
  let width: number; let height: number; const children: PsdLayer[] = [];
  if (document.kind === 'illustration') {
    width = document.artboard.width; height = document.artboard.height;
    for (const layerId of document.layerIds) {
      const layer = document.layers[layerId];
      const rendered = await renderIllustration(document, layerId);
      children.push({ name: layer.name, opacity: Math.round(layer.opacity * 255), hidden: !layer.visible, imageData: rendered.getContext('2d').getImageData(0, 0, width, height) });
      if (layer.type === 'vector') report.rasterized.push(layer.name);
    }
    report.warnings.push('Editable AIDraw objects are accompanied by visually faithful raster layer fallbacks because ag-psd cannot preserve every vector/text/effect feature.');
  } else {
    const asset = document.pixelAssets[document.activeAssetId];
    if (asset?.type !== 'sprite') throw new Error('PSD export from pixel mode requires an active sprite.');
    width = asset.width; height = asset.height;
    for (const layerId of asset.layerIds) {
      const layer = asset.layers[layerId]; if (layer.type !== 'pixel') continue;
      const rendered = renderSprite(document, asset, asset.frameIds[0], layerId);
      children.push({ name: layer.name, opacity: Math.round(layer.opacity * 255), hidden: !layer.visible, imageData: rendered.getContext('2d').getImageData(0, 0, width, height) });
    }
    report.warnings.push('Pixel PSD export writes current-frame cels as raster layers.');
  }
  const composite = await renderDocument(document);
  const value: Psd = { width, height, children, imageData: composite.getContext('2d').getImageData(0, 0, width, height) };
  return { data: writePsdBuffer(value, { generateThumbnail: true }), mimeType: 'image/vnd.adobe.photoshop', extension: 'psd', report };
}

function tilesetJson(document: PixelDocument, tileset: PixelTileset, image?: string) {
  const sprite = document.pixelAssets[tileset.spriteAssetId];
  return {
    type: 'tileset', version: '1.10', tiledversion: '1.11.2', name: tileset.name, tilewidth: tileset.tileWidth, tileheight: tileset.tileHeight,
    tilecount: tileset.columns * tileset.rows, columns: tileset.columns,
    image, imagewidth: sprite?.type === 'sprite' ? sprite.width : undefined, imageheight: sprite?.type === 'sprite' ? sprite.height : undefined,
    transformations: { hflip: tileset.transformations.hFlip, vflip: tileset.transformations.vFlip, rotate: tileset.transformations.rotate, preferuntransformed: false },
    tiles: Object.values(tileset.tiles).map((tile) => ({ id: tile.id, probability: tile.probability, animation: tile.animation.map((frame) => ({ tileid: frame.tileId, duration: frame.durationMs })), properties: Object.entries(tile.properties).map(([name, value]) => ({ name, value, type: typeof value })), objectgroup: tile.collisions.length ? { draworder: 'index', objects: tile.collisions.map((shape) => ({ id: Number.parseInt(shape.id.replace(/\D/g, ''), 10) || 1, name: '', type: '', x: shape.x, y: shape.y, width: shape.width, height: shape.height, ellipse: shape.type === 'ellipse', polygon: shape.type === 'polygon' ? shape.points : undefined, polyline: shape.type === 'polyline' ? shape.points : undefined })) } : undefined })),
    wangsets: tileset.wangSets.map((set) => ({ name: set.name, type: set.type, wangcolors: set.colors.map((color) => ({ name: color.name, color: color.color, tile: color.tileId, probability: color.probability })), wangtiles: set.tiles.map((tile) => ({ tileid: tile.tileId, wangid: tile.wangId })) })),
  };
}

export function tilemapToTiled(document: PixelDocument, map: PixelTilemap, images: Record<string, string> = {}) {
  let nextLayerId = 1;
  const layerJson = (id: string): Record<string, unknown> => {
    const layer = map.layers[id]; const common = { id: nextLayerId++, name: layer.name, visible: layer.visible, opacity: layer.opacity, parallaxx: layer.parallaxX, parallaxy: layer.parallaxY };
    if (layer.type === 'group') return { ...common, type: 'group', layers: (layer.childIds ?? []).map(layerJson) };
    if (layer.type === 'object') return { ...common, type: 'objectgroup', objects: (layer.objects ?? []).map((shape, index) => ({ id: Number.parseInt(shape.id.replace(/\D/g, ''), 10) || index + 1, x: shape.x, y: shape.y, width: shape.width ?? 0, height: shape.height ?? 0, ellipse: shape.type === 'ellipse' || undefined, polygon: shape.type === 'polygon' ? shape.points : undefined, polyline: shape.type === 'polyline' ? shape.points : undefined, properties: Object.entries(shape.properties).map(([name, value]) => ({ name, value, type: typeof value })) })) };
    const chunks = Object.values(layer.chunks ?? {}).map((chunk) => ({ x: chunk.x, y: chunk.y, width: chunk.width, height: chunk.height, data: Array.from(decodeTilemapChunk(chunk)) })); const data = Array<number>(map.width * map.height).fill(0);
    if (!map.infinite) for (const chunk of chunks) for (let localY = 0; localY < chunk.height; localY += 1) for (let localX = 0; localX < chunk.width; localX += 1) { const x = chunk.x + localX; const y = chunk.y + localY; if (x >= 0 && y >= 0 && x < map.width && y < map.height) data[y * map.width + x] = chunk.data[localY * chunk.width + localX] ?? 0; }
    return { ...common, type: 'tilelayer', ...(map.infinite ? { chunks } : { width: map.width, height: map.height, data }) };
  };
  return {
    type: 'map', version: '1.10', tiledversion: '1.11.2', orientation: map.orientation, renderorder: 'right-down', infinite: map.infinite,
    width: map.width, height: map.height, tilewidth: map.tileWidth, tileheight: map.tileHeight,
    properties: Object.entries(map.properties).map(([name, value]) => ({ name, value, type: typeof value })),
    tilesets: map.tilesetIds.map((id, index) => {
      const asset = document.pixelAssets[id];
      return asset?.type === 'tileset' ? { firstgid: asset.firstGid || index * 1_000_000 + 1, ...tilesetJson(document, asset, images[id]) } : { firstgid: index * 1_000_000 + 1 };
    }),
    layers: map.layerIds.map(layerJson),
  };
}

function tiledPropertyXml(properties: Record<string, string | number | boolean>): string {
  const values = Object.entries(properties); if (!values.length) return '';
  return `<properties>${values.map(([name, value]) => `<property name="${xml(name)}" type="${typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string'}" value="${xml(String(value))}"/>`).join('')}</properties>`;
}

function collisionXml(shape: PixelTileset['tiles'][number]['collisions'][number], index: number): string {
  const geometry = shape.type === 'ellipse' ? '<ellipse/>' : shape.type === 'polygon' || shape.type === 'polyline' ? `<${shape.type} points="${(shape.points ?? []).map((point) => `${point.x},${point.y}`).join(' ')}"/>` : '';
  return `<object id="${index + 1}" x="${shape.x}" y="${shape.y}" width="${shape.width ?? 0}" height="${shape.height ?? 0}">${geometry}${tiledPropertyXml(shape.properties)}</object>`;
}

function tilesetXml(document: PixelDocument, tileset: PixelTileset, image: string): string {
  const sprite = document.pixelAssets[tileset.spriteAssetId];
  const tiles = Object.values(tileset.tiles).filter((tile) => tile.probability !== 1 || tile.animation.length || tile.collisions.length || Object.keys(tile.properties).length).map((tile) => `<tile id="${tile.id}" probability="${tile.probability}">${tiledPropertyXml(tile.properties)}${tile.animation.length ? `<animation>${tile.animation.map((frame) => `<frame tileid="${frame.tileId}" duration="${frame.durationMs}"/>`).join('')}</animation>` : ''}${tile.collisions.length ? `<objectgroup>${tile.collisions.map(collisionXml).join('')}</objectgroup>` : ''}</tile>`).join('');
  const wangsets = tileset.wangSets.length ? `<wangsets>${tileset.wangSets.map((set) => `<wangset name="${xml(set.name)}" type="${set.type}">${set.colors.map((color) => `<wangcolor name="${xml(color.name)}" color="${xml(color.color)}" tile="${color.tileId}" probability="${color.probability}"/>`).join('')}${set.tiles.map((tile) => `<wangtile tileid="${tile.tileId}" wangid="${tile.wangId.join(',')}"/>`).join('')}</wangset>`).join('')}</wangsets>` : '';
  return `<tileset version="1.10" tiledversion="1.11.2" name="${xml(tileset.name)}" tilewidth="${tileset.tileWidth}" tileheight="${tileset.tileHeight}" tilecount="${tileset.columns * tileset.rows}" columns="${tileset.columns}"><image source="${xml(image)}" width="${sprite?.type === 'sprite' ? sprite.width : tileset.columns * tileset.tileWidth}" height="${sprite?.type === 'sprite' ? sprite.height : tileset.rows * tileset.tileHeight}"/><transformations hflip="${Number(tileset.transformations.hFlip)}" vflip="${Number(tileset.transformations.vFlip)}" rotate="${Number(tileset.transformations.rotate)}" preferuntransformed="0"/>${tiles}${wangsets}</tileset>`;
}

function tilemapXml(document: PixelDocument, map: PixelTilemap, images: Record<string, string>): string {
  let nextLayerId = 1;
  const layerXml = (id: string): string => {
    const layer = map.layers[id]; if (!layer) return '';
    const common = `id="${nextLayerId++}" name="${xml(layer.name)}" visible="${Number(layer.visible)}" opacity="${layer.opacity}" parallaxx="${layer.parallaxX}" parallaxy="${layer.parallaxY}"`;
    if (layer.type === 'group') return `<group ${common}>${(layer.childIds ?? []).map(layerXml).join('')}</group>`;
    if (layer.type === 'object') return `<objectgroup ${common}>${(layer.objects ?? []).map((shape, index) => collisionXml(shape, index)).join('')}</objectgroup>`;
    const chunks = Object.values(layer.chunks ?? {}).map((chunk) => ({ ...chunk, values: Array.from(decodeTilemapChunk(chunk)) }));
    if (map.infinite) return `<layer ${common} width="${map.width}" height="${map.height}"><data encoding="csv">${chunks.map((chunk) => `<chunk x="${chunk.x}" y="${chunk.y}" width="${chunk.width}" height="${chunk.height}">${chunk.values.join(',')}</chunk>`).join('')}</data></layer>`;
    const values = Array<number>(map.width * map.height).fill(0); for (const chunk of chunks) for (let y = 0; y < chunk.height; y += 1) for (let x = 0; x < chunk.width; x += 1) { const targetX = chunk.x + x; const targetY = chunk.y + y; if (targetX >= 0 && targetY >= 0 && targetX < map.width && targetY < map.height) values[targetY * map.width + targetX] = chunk.values[y * chunk.width + x] ?? 0; }
    return `<layer ${common} width="${map.width}" height="${map.height}"><data encoding="csv">${values.join(',')}</data></layer>`;
  };
  const tilesets = map.tilesetIds.map((id) => { const tileset = document.pixelAssets[id]; return tileset?.type === 'tileset' ? tilesetXml(document, tileset, images[id]).replace('<tileset ', `<tileset firstgid="${tileset.firstGid}" `) : ''; }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><map version="1.10" tiledversion="1.11.2" orientation="${map.orientation}" renderorder="right-down" infinite="${Number(map.infinite)}" width="${map.width}" height="${map.height}" tilewidth="${map.tileWidth}" tileheight="${map.tileHeight}">${tiledPropertyXml(map.properties)}${tilesets}${map.layerIds.map(layerXml).join('')}</map>`;
}

function safeAssetName(name: string, extension: string): string { return `${name.replace(/[<>:"/\\|?*]/g, '-').trim() || 'tileset'}.${extension}`; }

export function plannedExportCompanionPaths(document: AIDrawDocument, format: ExportFormat, target: string): string[] {
  if (format === 'sprite-sheet') return [`${target.slice(0, -extname(target).length)}.json`];
  if (format !== 'tiled-json' && format !== 'tiled-xml') return [];
  if (document.kind !== 'pixel') return [];
  const active = document.pixelAssets[document.activeAssetId];
  const tilesets = active?.type === 'tilemap'
    ? active.tilesetIds.map((id) => document.pixelAssets[id]).filter((asset): asset is PixelTileset => asset?.type === 'tileset')
    : active?.type === 'tileset' ? [active] : [];
  return tilesets
    .filter((tileset) => document.pixelAssets[tileset.spriteAssetId]?.type === 'sprite')
    .map((tileset) => join(dirname(target), safeAssetName(tileset.name, 'png')));
}

async function tiled(document: PixelDocument, format: 'tiled-json' | 'tiled-xml'): Promise<ExportArtifact> {
  const active = document.pixelAssets[document.activeAssetId]; if (active?.type !== 'tilemap' && active?.type !== 'tileset') throw new Error('Choose a tilemap or tileset before Tiled export.');
  const tilesets = active.type === 'tilemap' ? active.tilesetIds.map((id) => document.pixelAssets[id]).filter((asset): asset is PixelTileset => asset?.type === 'tileset') : [active]; const images: Record<string, string> = {}; const companions: NonNullable<ExportArtifact['companions']> = [];
  for (const tileset of tilesets) { const sprite = document.pixelAssets[tileset.spriteAssetId]; if (sprite?.type !== 'sprite') continue; const name = safeAssetName(tileset.name, 'png'); images[tileset.id] = name; companions.push({ name, extension: 'png', mimeType: 'image/png', data: renderSprite(document, sprite).toBuffer('image/png') }); }
  if (active.type === 'tileset') {
    const body = format === 'tiled-json' ? JSON.stringify(tilesetJson(document, active, images[active.id]), null, 2) : `<?xml version="1.0" encoding="UTF-8"?>${tilesetXml(document, active, images[active.id] ?? safeAssetName(active.name, 'png'))}`;
    return { data: Buffer.from(body), mimeType: format === 'tiled-json' ? 'application/json' : 'application/xml', extension: format === 'tiled-json' ? 'tsj' : 'tsx', companions, report: { warnings: [], rasterized: [] } };
  }
  const body = format === 'tiled-json' ? JSON.stringify(tilemapToTiled(document, active, images), null, 2) : tilemapXml(document, active, images);
  return { data: Buffer.from(body), mimeType: format === 'tiled-json' ? 'application/json' : 'application/xml', extension: format === 'tiled-json' ? 'tmj' : 'tmx', companions, report: { warnings: [], rasterized: [] } };
}

async function spriteSheet(document: PixelDocument, sprite: PixelSprite, scale = 1): Promise<ExportArtifact> {
  const columns = Math.ceil(Math.sqrt(sprite.frameIds.length)); const rows = Math.ceil(sprite.frameIds.length / columns);
  assertScaledDimensions(columns * sprite.width, rows * sprite.height, scale);
  const frameWidth = sprite.width * scale; const frameHeight = sprite.height * scale;
  const canvas = createCanvas(columns * frameWidth, rows * frameHeight); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
  const frames: Record<string, unknown> = {};
  sprite.frameIds.forEach((frameId, index) => {
    const x = index % columns * frameWidth; const y = Math.floor(index / columns) * frameHeight;
    context.drawImage(renderSprite(document, sprite, frameId), x, y, frameWidth, frameHeight);
    frames[frameId] = { frame: { x, y, w: frameWidth, h: frameHeight }, sourceSize: { w: sprite.width, h: sprite.height }, scale, duration: sprite.frames[frameId]?.durationMs ?? 100 };
  });
  return { data: canvas.toBuffer('image/png'), mimeType: 'image/png', extension: 'png', companion: { data: Buffer.from(JSON.stringify({ frames, meta: { app: 'AIDraw', image: `${sprite.name}.png`, size: { w: canvas.width, h: canvas.height }, scale, tags: sprite.tags } }, null, 2)), extension: 'json', mimeType: 'application/json' }, report: { warnings: scaleWarnings(scale), rasterized: [] } };
}

async function animatedImage(document: PixelDocument, sprite: PixelSprite, format: 'gif' | 'apng', scale = 1): Promise<ExportArtifact> {
  assertScaledDimensions(sprite.width, sprite.height, scale);
  const width = sprite.width * scale; const height = sprite.height * scale;
  const frames = sprite.frameIds.map((frameId) => nearestNeighborFrame(renderSprite(document, sprite, frameId).getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data, sprite.width, sprite.height, scale));
  const delays = sprite.frameIds.map((frameId) => sprite.frames[frameId]?.durationMs ?? 100);
  if (format === 'apng') return { data: Buffer.from(UPNG.encode(frames.map((frame) => frame.buffer as ArrayBuffer), width, height, 0, delays)), mimeType: 'image/apng', extension: 'apng', report: { warnings: scaleWarnings(scale), rasterized: [] } };
  const encoder = GIFEncoder(); frames.forEach((frame, index) => { const palette = quantize(frame, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true }); encoder.writeFrame(applyPalette(frame, palette, 'rgba4444'), width, height, { palette, transparent: true, transparentIndex: 0, delay: delays[index], repeat: 0 }); }); encoder.finish();
  return { data: Buffer.from(encoder.bytes()), mimeType: 'image/gif', extension: 'gif', report: { warnings: scaleWarnings(scale), rasterized: [] } };
}

export async function exportDocument(document: AIDrawDocument, format: ExportFormat, options: ExportOptions = {}): Promise<ExportArtifact> {
  const scale = resolveExportScale(document, format, options);
  if (format === 'png' || format === 'jpeg' || format === 'webp') return raster(document, format, scale);
  if (format === 'svg') {
    if (document.kind === 'illustration') return { data: Buffer.from(illustrationToSvg(document)), mimeType: 'image/svg+xml', extension: 'svg', report: { warnings: [], rasterized: [] } };
    const rasterized = await raster(document, 'png', scale);
    const canvas = nearestNeighborCanvas(await renderDocument(document), scale);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" shape-rendering="crispEdges"><image width="100%" height="100%" image-rendering="pixelated" href="data:image/png;base64,${rasterized.data.toString('base64')}"/></svg>`;
    return { data: Buffer.from(svg), mimeType: 'image/svg+xml', extension: 'svg', report: { warnings: [...scaleWarnings(scale), 'Pixel SVG export embeds nearest-neighbor raster artwork.'], rasterized: ['pixel artwork'] } };
  }
  if (format === 'pdf') return pdf(document, scale);
  if (format === 'psd') return psd(document);
  if (format === 'gif' || format === 'apng') { if (document.kind !== 'pixel') throw new Error('Animated export requires pixel mode.'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Choose a sprite before exporting animation.'); return animatedImage(document, sprite, format, scale); }
  if (format === 'sprite-sheet') {
    if (document.kind !== 'pixel') throw new Error('Sprite sheet export requires pixel mode.');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Choose a sprite before exporting a sprite sheet.');
    return spriteSheet(document, sprite, scale);
  }
  if (format === 'tiled-json' || format === 'tiled-xml') { if (document.kind !== 'pixel') throw new Error('Tiled export requires pixel mode.'); return tiled(document, format); }
  throw new Error(`Unsupported export format: ${format}`);
}
