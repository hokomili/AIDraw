import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync, inflateSync } from 'node:zlib';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import UPNG from 'upng-js';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { XMLParser } from 'fast-xml-parser';
import { nativeImage } from 'electron';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createIllustrationDocument,
  createPixelDocument,
  createPixelSprite,
  createPixelTileset,
  nowIso,
  writePixels,
  writeTiles,
  type AIDrawDocument,
  type CollisionShape,
  type DocumentAsset,
  type IllustrationLayer,
  type ImageObject,
  type PaintStyle,
  type PathObject,
  type ShapeObject,
  type StrokeStyle,
  type TextObject,
  type TileDefinition,
  type WangSet,
} from '@aidraw/core';
import { quantizeToPalette } from './quantize';

export interface ImportResult { documents: AIDrawDocument[]; warnings: string[] }

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function solid(color: string | undefined, fallback = '#27213c'): PaintStyle { return color === 'none' ? { kind: 'none' } : { kind: 'solid', color: color ?? fallback }; }
function stroke(color: string | undefined, width: number | undefined): StrokeStyle { return { paint: solid(color, '#27213c'), width: width ?? 1, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] }; }

function entityBase(name: string, layerId: string) {
  const timestamp = nowIso();
  return { id: createId('object'), revision: 0, name, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: structuredClone(IDENTITY_TRANSFORM) };
}

function imageAsset(name: string, mimeType: string, bytes: Buffer, source: DocumentAsset['source'] = 'imported'): DocumentAsset {
  return { id: createId('asset'), name, mimeType, byteLength: bytes.byteLength, sha256: sha256(bytes), source, data: bytes.toString('base64') };
}

function importRaster(bytes: Buffer, name: string, mimeType: string, pixelMode: boolean): ImportResult {
  const decoded = nativeImage.createFromBuffer(bytes);
  if (decoded.isEmpty()) throw new Error('Image is corrupt or uses an unsupported codec.');
  const size = decoded.getSize();
  if (pixelMode) {
    const document = createPixelDocument('sprite', name);
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    sprite.width = size.width; sprite.height = size.height;
    const cel = Object.values(sprite.cels)[0];
    const asset = imageAsset(name, mimeType, bytes);
    document.assets[asset.id] = asset;
    writePixels(cel, quantizeToPalette(bytes, size.width, size.height, document.palette));
    document.dirty = true;
    return { documents: [document], warnings: ['Full-color image quantized to the active indexed palette; the source image is embedded for reproducibility.'] };
  }
  const document = createIllustrationDocument(name);
  document.artboard.width = size.width; document.artboard.height = size.height; document.artboard.background = null;
  const layer = document.layerIds.map((id) => document.layers[id]).find((entry) => entry.type === 'vector')!;
  const asset = imageAsset(name, mimeType, bytes); document.assets[asset.id] = asset;
  const object: ImageObject = { ...entityBase(name, layer.id), type: 'image', assetId: asset.id, width: size.width, height: size.height, filters: [] };
  document.objects[object.id] = object; if (layer.type === 'vector') layer.objectIds.push(object.id);
  document.dirty = true;
  return { documents: [document], warnings: [] };
}

function importApng(bytes: Buffer, name: string): ImportResult | undefined {
  const decoded = UPNG.decode(Uint8Array.from(bytes).buffer); const rgbaFrames = UPNG.toRGBA8(decoded); if (rgbaFrames.length <= 1 && !decoded.tabs.acTL) return undefined;
  const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, decoded.width, decoded.height); document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id; const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0]; sprite.frames[firstFrameId].durationMs = Math.max(1, decoded.frames[0]?.delay ?? 100);
  rgbaFrames.forEach((rgba, index) => {
    const canvas = createCanvas(decoded.width, decoded.height); canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), decoded.width, decoded.height), 0, 0); const png = canvas.toBuffer('image/png');
    if (index === 0) { writePixels(firstCel, quantizeToPalette(png, decoded.width, decoded.height, document.palette)); return; }
    const timestamp = nowIso(); const frameId = createId('frame'); const celId = createId('cel'); sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: Math.max(1, decoded.frames[index]?.delay ?? 100) }; sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} }; writePixels(sprite.cels[celId], quantizeToPalette(png, decoded.width, decoded.height, document.palette));
  });
  const source = imageAsset(`${name} source`, 'image/apng', bytes); document.assets[source.id] = source;
  document.dirty = true; return { documents: [document], warnings: [] };
}

function importGif(bytes: Buffer, name: string): ImportResult {
  const parsed = parseGIF(Uint8Array.from(bytes).buffer); const frames = decompressFrames(parsed, true);
  if (!frames.length) throw new Error('GIF contains no decodable frames.');
  const width = parsed.lsd.width; const height = parsed.lsd.height; const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, width, height);
  document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id;
  const layerId = sprite.layerIds[0]; const firstFrameId = sprite.frameIds[0]; const firstCel = Object.values(sprite.cels)[0]; const canvas = createCanvas(width, height); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
  frames.forEach((frame, index) => {
    const restore = frame.disposalType === 3 ? context.getImageData(0, 0, width, height) : undefined;
    const patchCanvas = createCanvas(frame.dims.width, frame.dims.height); patchCanvas.getContext('2d').putImageData(new ImageData(frame.patch, frame.dims.width, frame.dims.height), 0, 0);
    context.drawImage(patchCanvas, frame.dims.left, frame.dims.top); const png = canvas.toBuffer('image/png');
    if (index === 0) {
      sprite.frames[firstFrameId].durationMs = Math.max(10, frame.delay || 100); writePixels(firstCel, quantizeToPalette(png, width, height, document.palette));
    } else {
      const timestamp = nowIso(); const frameId = createId('frame'); const celId = createId('cel'); sprite.frameIds.push(frameId);
      sprite.frames[frameId] = { id: frameId, revision: 0, name: `Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: Math.max(10, frame.delay || 100) };
      sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} }; writePixels(sprite.cels[celId], quantizeToPalette(png, width, height, document.palette));
    }
    if (frame.disposalType === 2) context.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
    else if (frame.disposalType === 3 && restore) context.putImageData(restore, 0, 0);
  });
  const source = imageAsset(`${name} source`, 'image/gif', bytes); document.assets[source.id] = source; document.dirty = true;
  return { documents: [document], warnings: [] };
}

async function importSpriteSheet(bytes: Buffer, name: string, filePath: string): Promise<ImportResult> {
  const metadata = JSON.parse(bytes.toString('utf8')) as Record<string, any>; const frameSources = Array.isArray(metadata.frames) ? metadata.frames : Object.entries(metadata.frames ?? {}).map(([filename, frame]) => ({ filename, ...(frame as Record<string, unknown>) }));
  if (!frameSources.length) throw new Error('Sprite-sheet metadata contains no frames.'); const imageReference = String(metadata.meta?.image ?? `${name}.png`); const imagePath = resolve(dirname(filePath), imageReference); const imageBytes = await readFile(imagePath); const sourceImage = nativeImage.createFromBuffer(imageBytes); if (sourceImage.isEmpty()) throw new Error(`Sprite-sheet image ${imageReference} is unreadable.`);
  const firstRect = frameSources[0].frame ?? frameSources[0]; const width = Number(firstRect.w ?? firstRect.width); const height = Number(firstRect.h ?? firstRect.height); const document = createPixelDocument('sprite', name); const sprite = createPixelSprite(name, width, height); document.pixelAssets = { [sprite.id]: sprite }; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id; const layerId = sprite.layerIds[0]; const importedFrameIds: string[] = [];
  for (let index = 0; index < frameSources.length; index += 1) { const source = frameSources[index]; const rect = source.frame ?? source; const png = sourceImage.crop({ x: Number(rect.x ?? 0), y: Number(rect.y ?? 0), width: Number(rect.w ?? rect.width ?? width), height: Number(rect.h ?? rect.height ?? height) }).resize({ width, height, quality: 'best' }).toPNG(); let frameId: string; let celId: string;
    if (index === 0) { frameId = sprite.frameIds[0]; celId = Object.values(sprite.cels)[0].id; sprite.frames[frameId].name = String(source.filename ?? source.name ?? 'Frame 1'); sprite.frames[frameId].durationMs = Math.max(1, Number(source.duration ?? 100)); }
    else { const timestamp = nowIso(); frameId = createId('frame'); celId = createId('cel'); sprite.frameIds.push(frameId); sprite.frames[frameId] = { id: frameId, revision: 0, name: String(source.filename ?? source.name ?? `Frame ${index + 1}`), createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: Math.max(1, Number(source.duration ?? 100)) }; sprite.cels[celId] = { id: celId, revision: 0, name: `Pixels · Frame ${index + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId, frameId, chunks: {} }; }
    importedFrameIds.push(frameId); writePixels(sprite.cels[celId], quantizeToPalette(png, width, height, document.palette));
  }
  const tags = arrayify(metadata.meta?.frameTags ?? metadata.meta?.tags); sprite.tags = tags.map((tag: any) => { const from = typeof tag.from === 'number' ? importedFrameIds[tag.from] : importedFrameIds.includes(tag.fromFrameId) ? tag.fromFrameId : importedFrameIds[0]; const to = typeof tag.to === 'number' ? importedFrameIds[tag.to] : importedFrameIds.includes(tag.toFrameId) ? tag.toFrameId : importedFrameIds.at(-1)!; return { id: createId('tag'), name: String(tag.name ?? 'Animation'), fromFrameId: from, toFrameId: to, direction: tag.direction === 'reverse' || tag.direction === 'ping-pong' || tag.direction === 'pingpong' ? (tag.direction === 'reverse' ? 'reverse' : 'ping-pong') : 'forward', color: String(tag.color ?? '#9b87f5') }; });
  const embedded = imageAsset(basename(imagePath), `image/${extname(imagePath).slice(1).replace('jpg', 'jpeg') || 'png'}`, imageBytes); document.assets[embedded.id] = embedded; document.linkedAssets.push({ id: createId('link'), name: basename(imagePath), mode: 'linked', relativePath: relative(dirname(filePath), imagePath).replace(/\\/g, '/'), sha256: embedded.sha256, cachedPreviewAssetId: embedded.id }); document.dirty = true; return { documents: [document], warnings: [] };
}

function arrayify<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function importSvg(bytes: Buffer, name: string): ImportResult {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: true });
  const root = parser.parse(bytes.toString('utf8')).svg as Record<string, unknown> | undefined;
  if (!root) throw new Error('SVG root element was not found.');
  const width = Number(root.width ?? String(root.viewBox ?? '0 0 1920 1080').split(/\s+/)[2] ?? 1920);
  const height = Number(root.height ?? String(root.viewBox ?? '0 0 1920 1080').split(/\s+/)[3] ?? 1080);
  const document = createIllustrationDocument(name); document.artboard.width = width; document.artboard.height = height; document.artboard.background = null;
  const layer = document.layerIds.map((id) => document.layers[id]).find((entry) => entry.type === 'vector')!;
  const add = (object: ShapeObject | PathObject | TextObject) => { document.objects[object.id] = object; if (layer.type === 'vector') layer.objectIds.push(object.id); };
  for (const rect of arrayify(root.rect as Record<string, unknown> | Array<Record<string, unknown>>)) {
    const object: ShapeObject = { ...entityBase(String(rect.id ?? 'Rectangle'), layer.id), type: 'shape', shape: 'rectangle', width: Number(rect.width ?? 0), height: Number(rect.height ?? 0), cornerRadius: Number(rect.rx ?? 0), fill: solid(String(rect.fill ?? '#27213c')), stroke: stroke(rect.stroke ? String(rect.stroke) : 'none', Number(rect['stroke-width'] ?? 1)) };
    object.transform.x = Number(rect.x ?? 0); object.transform.y = Number(rect.y ?? 0); add(object);
  }
  for (const ellipse of [...arrayify(root.ellipse as Record<string, unknown> | Array<Record<string, unknown>>), ...arrayify(root.circle as Record<string, unknown> | Array<Record<string, unknown>>)]) {
    const rx = Number(ellipse.rx ?? ellipse.r ?? 0); const ry = Number(ellipse.ry ?? ellipse.r ?? 0);
    const object: ShapeObject = { ...entityBase(String(ellipse.id ?? 'Ellipse'), layer.id), type: 'shape', shape: 'ellipse', width: rx * 2, height: ry * 2, fill: solid(String(ellipse.fill ?? '#27213c')), stroke: stroke(ellipse.stroke ? String(ellipse.stroke) : 'none', Number(ellipse['stroke-width'] ?? 1)) };
    object.transform.x = Number(ellipse.cx ?? rx) - rx; object.transform.y = Number(ellipse.cy ?? ry) - ry; add(object);
  }
  for (const path of arrayify(root.path as Record<string, unknown> | Array<Record<string, unknown>>)) {
    add({ ...entityBase(String(path.id ?? 'Path'), layer.id), type: 'path', pathData: String(path.d ?? ''), closed: /[zZ]\s*$/.test(String(path.d ?? '')), fill: solid(String(path.fill ?? 'none')), stroke: stroke(path.stroke ? String(path.stroke) : 'none', Number(path['stroke-width'] ?? 1)), fillRule: path['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero' });
  }
  for (const line of arrayify(root.line as Record<string, unknown> | Array<Record<string, unknown>>)) {
    const object: ShapeObject = { ...entityBase(String(line.id ?? 'Line'), layer.id), type: 'shape', shape: 'line', width: Number(line.x2 ?? 0) - Number(line.x1 ?? 0), height: Number(line.y2 ?? 0) - Number(line.y1 ?? 0), fill: { kind: 'none' }, stroke: stroke(String(line.stroke ?? '#27213c'), Number(line['stroke-width'] ?? 1)) };
    object.transform.x = Number(line.x1 ?? 0); object.transform.y = Number(line.y1 ?? 0); add(object);
  }
  for (const text of arrayify(root.text as Record<string, unknown> | Array<Record<string, unknown>>)) {
    const content = String(text['#text'] ?? text.text ?? ''); const fontSize = Number(text['font-size'] ?? 48);
    const object: TextObject = { ...entityBase(String(text.id ?? 'Text'), layer.id), type: 'text', text: content, width: Math.max(1, content.length * fontSize), height: fontSize * 1.3, align: 'left', lineHeight: 1.2, ranges: [{ start: 0, end: content.length, fontFamily: String(text['font-family'] ?? 'sans-serif'), fontSize, fontWeight: Number(text['font-weight'] ?? 400), fontStyle: text['font-style'] === 'italic' ? 'italic' : 'normal', color: String(text.fill ?? '#27213c'), letterSpacing: Number(text['letter-spacing'] ?? 0) }] };
    object.transform.x = Number(text.x ?? 0); object.transform.y = Number(text.y ?? 0) - fontSize; add(object);
  }
  document.dirty = true;
  const unsupported = ['g', 'defs', 'filter', 'mask', 'clipPath', 'use', 'foreignObject'].filter((tag) => root[tag] !== undefined);
  return { documents: [document], warnings: unsupported.length ? [`SVG elements requiring more complex interpretation were preserved only when referenced by supported objects: ${unsupported.join(', ')}.`] : [] };
}

function flattenPsdLayers(layers: PsdLayer[] | undefined, prefix = ''): Array<{ layer: PsdLayer; name: string }> {
  return (layers ?? []).flatMap((layer, index) => layer.children?.length ? flattenPsdLayers(layer.children, `${prefix}${layer.name ?? `Group ${index + 1}`}/`) : [{ layer, name: `${prefix}${layer.name ?? `Layer ${index + 1}`}` }]);
}

function canvasImageData(source: NonNullable<PsdLayer['imageData']>): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
}

function importPsd(bytes: Buffer, name: string, pixelMode: boolean): ImportResult {
  const psd = readPsd(bytes, { useImageData: true, logMissingFeatures: false });
  if (pixelMode) {
    const document = createPixelDocument('project', name);
    document.assetIds = []; document.pixelAssets = {};
    for (const { layer, name: layerName } of flattenPsdLayers(psd.children)) {
      if (!layer.imageData) continue;
      const canvas = createCanvas(layer.imageData.width, layer.imageData.height); canvas.getContext('2d').putImageData(canvasImageData(layer.imageData), 0, 0);
      const png = canvas.toBuffer('image/png'); const sprite = createPixelSprite(layerName, layer.imageData.width, layer.imageData.height);
      const cel = Object.values(sprite.cels)[0]; writePixels(cel, quantizeToPalette(png, sprite.width, sprite.height, document.palette));
      document.pixelAssets[sprite.id] = sprite; document.assetIds.push(sprite.id); if (!document.activeAssetId) document.activeAssetId = sprite.id;
    }
    if (!document.assetIds.length) { const sprite = createPixelSprite('Composite', psd.width, psd.height); document.pixelAssets[sprite.id] = sprite; document.assetIds = [sprite.id]; document.activeAssetId = sprite.id; }
    document.dirty = true;
    return { documents: [document], warnings: ['PSD layers were independently quantized into pixel sprites. Unsupported effects use decoded raster fallbacks.'] };
  }
  const document = createIllustrationDocument(name); document.artboard.width = psd.width; document.artboard.height = psd.height; document.artboard.background = null;
  const initialLayers = [...document.layerIds]; for (const id of initialLayers) delete document.layers[id]; document.layerIds = [];
  for (const { layer, name: layerName } of flattenPsdLayers(psd.children)) {
    if (!layer.imageData) continue;
    const timestamp = nowIso();
    const vectorLayer: IllustrationLayer = { id: createId('layer'), revision: 0, name: layerName, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: !layer.hidden, locked: false, opacity: (layer.opacity ?? 255) / 255, blendMode: 'normal', type: 'vector', objectIds: [] };
    const canvas = createCanvas(layer.imageData.width, layer.imageData.height); canvas.getContext('2d').putImageData(canvasImageData(layer.imageData), 0, 0); const png = canvas.toBuffer('image/png');
    const asset = imageAsset(layerName, 'image/png', png); document.assets[asset.id] = asset;
    const object: ImageObject = { ...entityBase(layerName, vectorLayer.id), type: 'image', assetId: asset.id, width: layer.imageData.width, height: layer.imageData.height, filters: [] };
    object.transform.x = layer.left ?? 0; object.transform.y = layer.top ?? 0; document.objects[object.id] = object; vectorLayer.objectIds.push(object.id); document.layers[vectorLayer.id] = vectorLayer; document.layerIds.push(vectorLayer.id);
  }
  document.dirty = true;
  return { documents: [document], warnings: ['PSD layer pixels were preserved. Unsupported effects, advanced text, and color modes are flattened into explicit raster fallbacks.'] };
}

function tiledProperties(value: any): Record<string, string | number | boolean> {
  if (!value) return {};
  if (!Array.isArray(value) && typeof value === 'object' && !value.property && !('name' in value)) return value;
  const result: Record<string, string | number | boolean> = {};
  for (const property of arrayify(value.property ?? value)) {
    const raw = property.value ?? property['#text'] ?? '';
    result[String(property.name ?? '')] = property.type === 'bool' ? raw === true || raw === 'true' : property.type === 'int' || property.type === 'float' ? Number(raw) : String(raw);
  }
  return result;
}

function tiledObject(source: any): CollisionShape {
  const polygon = source.polygon?.points ?? source.polygon; const polyline = source.polyline?.points ?? source.polyline;
  const explicitType = ['rectangle', 'ellipse', 'polygon', 'polyline'].includes(source.type) ? source.type as CollisionShape['type'] : undefined;
  const parsePoints = (value: unknown): Array<{ x: number; y: number }> | undefined => typeof value === 'string' ? value.split(/\s+/).filter(Boolean).map((point) => { const [x, y] = point.split(',').map(Number); return { x, y }; }) : Array.isArray(value) ? value.map((point: any) => ({ x: Number(point.x), y: Number(point.y) })) : undefined;
  return { id: String(source.id ?? createId('collision')), type: explicitType ?? (polygon ? 'polygon' : polyline ? 'polyline' : source.ellipse ? 'ellipse' : 'rectangle'), x: Number(source.x ?? 0), y: Number(source.y ?? 0), width: Number(source.width ?? 0), height: Number(source.height ?? 0), points: parsePoints(polygon ?? polyline) ?? parsePoints(source.points), properties: { name: String(source.name ?? ''), class: String(source.class ?? (explicitType ? '' : source.type) ?? ''), ...tiledProperties(source.properties) } };
}

function tiledData(source: any, width: number, height: number): number[] {
  if (Array.isArray(source)) return source.map(Number);
  if (source?.tile) return arrayify(source.tile).map((tile: any) => Number(tile.gid ?? 0));
  const text = String(source?.['#text'] ?? source ?? '').trim(); const encoding = source?.encoding;
  if (!text) return Array<number>(Math.max(0, width * height)).fill(0);
  if (encoding === 'csv' || text.includes(',')) return text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (encoding === 'base64') {
    let payload = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    if (source.compression === 'zlib') payload = inflateSync(payload); else if (source.compression === 'gzip') payload = gunzipSync(payload); else if (source.compression) throw new Error(`Unsupported Tiled layer compression: ${source.compression}`);
    const gids: number[] = []; for (let offset = 0; offset + 3 < payload.length; offset += 4) gids.push(payload.readUInt32LE(offset)); return gids;
  }
  return text.split(/\s+/).filter(Boolean).map(Number);
}

function xmlTileset(source: any): Record<string, any> {
  if (source.source) return { firstgid: source.firstgid, source: source.source };
  const tiles = arrayify(source.tile).map((tile: any) => ({ id: Number(tile.id), probability: Number(tile.probability ?? 1), properties: tiledProperties(tile.properties), animation: arrayify(tile.animation?.frame).map((frame: any) => ({ tileid: Number(frame.tileid), duration: Number(frame.duration ?? 100) })), objectgroup: tile.objectgroup ? { objects: arrayify(tile.objectgroup.object).map(tiledObject) } : undefined }));
  const wangsets = arrayify(source.wangsets?.wangset).map((set: any) => ({ name: set.name, type: set.type, wangcolors: arrayify(set.wangcolor).map((color: any) => ({ name: color.name, color: color.color, tile: Number(color.tile ?? -1), probability: Number(color.probability ?? 1) })), wangtiles: arrayify(set.wangtile).map((tile: any) => ({ tileid: Number(tile.tileid), wangid: String(tile.wangid ?? '').split(',').map(Number) })) }));
  return { ...source, type: 'tileset', image: source.image?.source, imagewidth: source.image?.width, imageheight: source.image?.height, tiles, wangsets, properties: tiledProperties(source.properties), transformations: source.transformations };
}

function xmlLayer(source: any, type: 'tilelayer' | 'objectgroup' | 'group'): Record<string, any> {
  if (type === 'group') return { ...source, type, layers: [...arrayify(source.layer).map((entry) => xmlLayer(entry, 'tilelayer')), ...arrayify(source.objectgroup).map((entry) => xmlLayer(entry, 'objectgroup')), ...arrayify(source.group).map((entry) => xmlLayer(entry, 'group'))] };
  if (type === 'objectgroup') return { ...source, type, objects: arrayify(source.object).map(tiledObject) };
  const data = source.data ?? {}; const chunks = arrayify(data.chunk).map((chunk: any) => ({ x: Number(chunk.x), y: Number(chunk.y), width: Number(chunk.width), height: Number(chunk.height), data: tiledData({ ...chunk, encoding: data.encoding, compression: data.compression }, Number(chunk.width), Number(chunk.height)) }));
  return { ...source, type, ...(chunks.length ? { chunks } : { data: tiledData(data, Number(source.width ?? 0), Number(source.height ?? 0)) }) };
}

function parseTiled(bytes: Buffer, extension: string): Record<string, any> {
  if (extension === '.tmj' || extension === '.tsj' || extension === '.json') return JSON.parse(bytes.toString('utf8')) as Record<string, any>;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: true, parseTagValue: false, trimValues: true }); const parsed = parser.parse(bytes.toString('utf8')) as Record<string, any>;
  if (parsed.tileset) return xmlTileset(parsed.tileset);
  const map = parsed.map; if (!map) throw new Error('Tiled XML contains neither a map nor a tileset.');
  return { ...map, type: 'map', properties: tiledProperties(map.properties), tilesets: arrayify(map.tileset).map(xmlTileset), layers: [...arrayify(map.layer).map((entry) => xmlLayer(entry, 'tilelayer')), ...arrayify(map.objectgroup).map((entry) => xmlLayer(entry, 'objectgroup')), ...arrayify(map.group).map((entry) => xmlLayer(entry, 'group'))] };
}

function wangId(value: unknown): WangSet['tiles'][number]['wangId'] {
  const values = (Array.isArray(value) ? value : String(value ?? '').split(',')).map(Number); while (values.length < 8) values.push(0); return values.slice(0, 8) as WangSet['tiles'][number]['wangId'];
}

async function attachTileset(document: ReturnType<typeof createPixelDocument>, sourceReference: any, rootFilePath: string, fallbackTileWidth: number, fallbackTileHeight: number, warnings: string[]) {
  let source = sourceReference; let baseDirectory = dirname(rootFilePath);
  if (sourceReference.source) {
    const externalPath = resolve(baseDirectory, String(sourceReference.source)); const externalBytes = await readFile(externalPath); source = parseTiled(externalBytes, extname(externalPath).toLowerCase()); baseDirectory = dirname(externalPath);
  }
  const tileWidth = Number(source.tilewidth ?? fallbackTileWidth); const tileHeight = Number(source.tileheight ?? fallbackTileHeight); let imageWidth = Number(source.imagewidth ?? 0); let imageHeight = Number(source.imageheight ?? 0); let imageBytes: Buffer | undefined; let imagePath: string | undefined;
  if (typeof source.image === 'string') {
    imagePath = resolve(baseDirectory, source.image);
    try { imageBytes = await readFile(imagePath); const decoded = nativeImage.createFromBuffer(imageBytes); if (decoded.isEmpty()) throw new Error('image codec is unsupported'); const size = decoded.getSize(); imageWidth ||= size.width; imageHeight ||= size.height; } catch (error) { warnings.push(`Tileset image ${source.image} could not be loaded: ${error instanceof Error ? error.message : String(error)}.`); }
  }
  const columns = Math.max(1, Number(source.columns ?? (Math.floor(imageWidth / tileWidth) || 1))); const tileCount = Math.max(1, Number(source.tilecount ?? columns * Math.max(1, Math.floor(imageHeight / tileHeight)))); const rows = Math.max(1, Math.ceil(tileCount / columns)); const sprite = createPixelSprite(String(source.name ?? 'Tileset pixels'), Math.max(tileWidth, imageWidth || columns * tileWidth), Math.max(tileHeight, imageHeight || rows * tileHeight));
  if (imageBytes) { const cel = Object.values(sprite.cels)[0]; writePixels(cel, quantizeToPalette(imageBytes, sprite.width, sprite.height, document.palette)); const embedded = imageAsset(basename(imagePath!), `image/${extname(imagePath!).slice(1).replace('jpg', 'jpeg') || 'png'}`, imageBytes); document.assets[embedded.id] = embedded; document.linkedAssets.push({ id: createId('link'), name: basename(imagePath!), mode: 'linked', relativePath: relative(dirname(rootFilePath), imagePath!).replace(/\\/g, '/'), sha256: embedded.sha256, cachedPreviewAssetId: embedded.id }); }
  const tileset = createPixelTileset(String(source.name ?? 'Tileset'), sprite.id, tileWidth, tileHeight, columns, rows); tileset.firstGid = Math.max(1, Number(sourceReference.firstgid ?? 1)); const margin = Number(source.margin ?? 0); const spacing = Number(source.spacing ?? 0); const metadata = new Map(arrayify(source.tiles ?? source.tile).map((tile: any) => [Number(tile.id), tile]));
  for (let id = 0; id < tileCount; id += 1) { const tile = metadata.get(id); const definition: TileDefinition = { id, sourceX: margin + id % columns * (tileWidth + spacing), sourceY: margin + Math.floor(id / columns) * (tileHeight + spacing), probability: Number(tile?.probability ?? 1), animation: arrayify(tile?.animation).map((frame: any) => ({ tileId: Number(frame.tileid ?? frame.tileId), durationMs: Number(frame.duration ?? frame.durationMs ?? 100) })), collisions: arrayify(tile?.objectgroup?.objects ?? tile?.collisions).map(tiledObject), properties: tiledProperties(tile?.properties) }; tileset.tiles[id] = definition; }
  tileset.wangSets = arrayify(source.wangsets).map((set: any): WangSet => ({ id: createId('wang'), name: String(set.name ?? 'Terrain'), type: set.type === 'corner' || set.type === 'edge' ? set.type : 'mixed', colors: arrayify(set.wangcolors).map((color: any, index) => ({ id: index + 1, name: String(color.name ?? `Terrain ${index + 1}`), color: String(color.color ?? '#ff00ff'), tileId: Number(color.tile ?? -1), probability: Number(color.probability ?? 1) })), tiles: arrayify(set.wangtiles).map((tile: any) => ({ tileId: Number(tile.tileid), wangId: wangId(tile.wangid) })) }));
  const transforms = source.transformations; if (transforms) tileset.transformations = { hFlip: transforms.hflip !== false && transforms.hflip !== 0, vFlip: transforms.vflip !== false && transforms.vflip !== 0, rotate: transforms.rotate !== false && transforms.rotate !== 0 };
  document.pixelAssets[sprite.id] = sprite; document.assetIds.push(sprite.id); document.pixelAssets[tileset.id] = tileset; document.assetIds.push(tileset.id); return tileset;
}

async function importTiled(bytes: Buffer, name: string, filePath: string): Promise<ImportResult> {
  const tiled = parseTiled(bytes, extname(filePath).toLowerCase()); const warnings: string[] = [];
  if (tiled.type === 'tileset') { const document = createPixelDocument('project', name); document.assetIds = []; document.pixelAssets = {}; const tileset = await attachTileset(document, tiled, filePath, Number(tiled.tilewidth ?? 16), Number(tiled.tileheight ?? 16), warnings); document.activeAssetId = tileset.id; document.dirty = true; return { documents: [document], warnings }; }
  if (tiled.type !== 'map') throw new Error('Tiled file is neither a map nor a tileset.');
  const document = createPixelDocument('tilemap', name); const map = document.pixelAssets[document.activeAssetId]; if (map.type !== 'tilemap') throw new Error('Expected map');
  map.name = String(tiled.name ?? name); map.orientation = tiled.orientation === 'isometric' ? 'isometric' : 'orthogonal'; if (!['orthogonal', 'isometric'].includes(String(tiled.orientation ?? 'orthogonal'))) warnings.push(`Tiled ${tiled.orientation} orientation was converted to orthogonal.`); map.infinite = Boolean(tiled.infinite); map.width = Number(tiled.width ?? 0); map.height = Number(tiled.height ?? 0); map.tileWidth = Number(tiled.tilewidth ?? 16); map.tileHeight = Number(tiled.tileheight ?? 16); map.properties = tiledProperties(tiled.properties); map.layerIds = []; map.layers = {}; map.tilesetIds = [];
  for (const source of arrayify(tiled.tilesets)) { const tileset = await attachTileset(document, source, filePath, map.tileWidth, map.tileHeight, warnings); map.tilesetIds.push(tileset.id); }
  const addLayer = (source: any, parentId?: string): string => {
    const timestamp = nowIso(); const id = createId('map-layer'); const type = source.type === 'objectgroup' ? 'object' as const : source.type === 'group' ? 'group' as const : 'tile' as const;
    const layer = { id, revision: 0, name: String(source.name ?? 'Layer'), createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type, visible: source.visible !== false && source.visible !== 0, locked: false, opacity: Number(source.opacity ?? 1), parentId, childIds: type === 'group' ? [] : undefined, chunks: type === 'tile' ? {} : undefined, objects: type === 'object' ? arrayify(source.objects).map(tiledObject) : undefined, parallaxX: Number(source.parallaxx ?? 1), parallaxY: Number(source.parallaxy ?? 1) };
    map.layers[id] = layer; if (parentId) map.layers[parentId].childIds?.push(id); else map.layerIds.push(id);
    if (type === 'tile' && layer.chunks) for (const chunk of source.chunks ?? [{ x: 0, y: 0, width: Number(source.width ?? map.width), height: Number(source.height ?? map.height), data: source.data ?? [] }]) { const width = Number(chunk.width || map.width || 1); const changes = arrayify(chunk.data).map((gid, index) => ({ x: Number(chunk.x ?? 0) + index % width, y: Number(chunk.y ?? 0) + Math.floor(index / width), gid: Number(gid) })); writeTiles(layer.chunks, changes); }
    if (type === 'group') for (const child of arrayify(source.layers)) addLayer(child, id); return id;
  };
  for (const source of arrayify(tiled.layers)) addLayer(source); document.dirty = true; return { documents: [document], warnings };
}

async function importPdf(bytes: Buffer, name: string, pixelMode: boolean): Promise<ImportResult> {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const source = await pdfjs.getDocument({ data: Uint8Array.from(bytes) }).promise; const documents: AIDrawDocument[] = [];
  for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
    const page = await source.getPage(pageNumber); const viewport = page.getViewport({ scale: 1 }); const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    await page.render({ canvas: null, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise; const pageName = source.numPages > 1 ? `${name} · Page ${pageNumber}` : name; const imported = importRaster(canvas.toBuffer('image/png'), pageName, 'image/png', pixelMode); const document = imported.documents[0];
    if (document.kind === 'illustration') {
      const timestamp = nowIso(); const textLayer: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'Editable PDF text (hidden)', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: false, locked: false, opacity: 1, blendMode: 'normal', type: 'vector', objectIds: [] }; const text = await page.getTextContent();
      for (const item of text.items) if ('str' in item && item.str) { const fontSize = Math.max(1, Math.hypot(item.transform[0], item.transform[1])); const object: TextObject = { ...entityBase(item.str.slice(0, 32), textLayer.id), type: 'text', text: item.str, width: Math.max(1, item.width), height: Math.max(1, item.height || fontSize), align: 'left', lineHeight: 1.2, ranges: [{ start: 0, end: item.str.length, fontFamily: item.fontName || 'sans-serif', fontSize, fontWeight: 400, fontStyle: 'normal', color: '#000000', letterSpacing: 0 }] }; object.transform.x = item.transform[4]; object.transform.y = viewport.height - item.transform[5] - fontSize; document.objects[object.id] = object; textLayer.objectIds.push(object.id); }
      if (textLayer.objectIds.length) { document.layers[textLayer.id] = textLayer; document.layerIds.push(textLayer.id); }
    }
    documents.push(document);
  }
  return { documents, warnings: ['PDF pages retain a faithful raster fallback. Extracted text is placed on a hidden editable layer; unsupported operators and effects remain rasterized.'] };
}

export async function importDocument(filePath: string, pixelMode = false): Promise<ImportResult> {
  const bytes = await readFile(filePath); const extension = extname(filePath).toLowerCase(); const name = basename(filePath, extension);
  if ((extension === '.png' || extension === '.apng') && pixelMode) { const animated = importApng(bytes, name); if (animated) return animated; }
  if (extension === '.gif' && pixelMode) return importGif(bytes, name);
  if (['.png', '.apng', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return importRaster(bytes, name, extension === '.png' || extension === '.apng' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : 'image/jpeg', pixelMode);
  if (extension === '.svg') return pixelMode ? importRaster(Buffer.from(nativeImage.createFromBuffer(bytes).toPNG()), name, 'image/png', true) : importSvg(bytes, name);
  if (extension === '.psd') return importPsd(bytes, name, pixelMode);
  if (extension === '.pdf') return importPdf(bytes, name, pixelMode);
  if (extension === '.json' && pixelMode) { const metadata = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; if (metadata.frames && metadata.meta) return importSpriteSheet(bytes, name, filePath); }
  if (extension === '.tmj' || extension === '.tmx' || extension === '.tsj' || extension === '.tsx' || extension === '.json') return importTiled(bytes, name, filePath);
  throw new Error(`Unsupported import format: ${extension}`);
}
