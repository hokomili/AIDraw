import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas as initializePsdCanvas, writePsdBuffer, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import UPNG from 'upng-js';
import { getStroke } from 'perfect-freehand';
import {
  decodeTilemapChunk,
  illustrationAnimationSamples,
  illustrationAtTime,
  normalizeTextStyleRanges,
  pixelAnimationSequence,
  type AIDrawDocument,
  type IllustrationDocument,
  type IllustrationObject,
  type PaintStyle,
  type PixelDocument,
  type PixelSprite,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import { exactSingleLayerAnimationFrame, exactSingleLayerGifFrame } from '../common/animation-palette';
import { splitColorAlpha } from '../common/color';
import { AIDRAW_PSD_EDITABLE_TEXT_SUFFIX, aidrawPsdLockFields, aidrawPsdTextMatrix } from '../common/psd-text';
import { MAX_PSD_EXPANDED_LAYER_PIXELS, MAX_PSD_LAYER_RECORDS, assertPsdLayerStructureBudget } from '../common/psd-limits';
import { MAX_STATIC_RASTER_PIXELS } from '../common/static-raster';
import { layoutStyledText } from '../common/text-layout';
import { MAX_INTERCHANGE_FIDELITY_ENTRIES, tryAppendInterchangeFidelityEntry, type InterchangeFidelityEntry } from '../common/interchange-fidelity';
import type { ExportFormat, ExportOptions } from '../common/contracts';
import { safeTiledAssetName } from './export-artifact-policy';
import { renderDocument, renderDocumentDimensions, renderIllustration, renderIllustrationLayerSource, renderSprite } from './render-document';
import { MAX_UTILITY_REPORT_SERIALIZED_BYTES, assertUtilityJsonBudget } from './utility-resource-policy';

initializePsdCanvas(createCanvas as unknown as (width: number, height: number) => HTMLCanvasElement);

export type { ExportFormat } from '../common/contracts';
export { plannedExportCompanionPaths } from './export-artifact-policy';

export const MAX_EXPORT_SCALE = 64;

const scalablePixelFormats = new Set<ExportFormat>(['png', 'jpeg', 'webp', 'svg', 'pdf', 'gif', 'apng', 'sprite-sheet']);
const MAX_SCALED_PIXELS = MAX_STATIC_RASTER_PIXELS;

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
  assertScaledDimensions(source.width, source.height, scale);
  if (scale === 1) return source;
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

function nearestNeighborIndexes(source: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  if (scale === 1) return Uint8Array.from(source);
  assertScaledDimensions(width, height, scale);
  const scaledWidth = width * scale; const output = new Uint8Array(scaledWidth * height * scale);
  for (let sourceY = 0; sourceY < height; sourceY += 1) for (let repeatY = 0; repeatY < scale; repeatY += 1) {
    const targetY = sourceY * scale + repeatY;
    for (let sourceX = 0; sourceX < width; sourceX += 1) for (let repeatX = 0; repeatX < scale; repeatX += 1) {
      output[targetY * scaledWidth + sourceX * scale + repeatX] = source[sourceY * width + sourceX];
    }
  }
  return output;
}

function encodeLosslessRgbaPng(source: Uint8Array | Uint8ClampedArray, width: number, height: number): Buffer {
  const input = Uint8Array.from(source).buffer;
  const encodePng = UPNG.encode as unknown as (images: ArrayBuffer[], imageWidth: number, imageHeight: number, colors: number, frameDelays?: number[], forbidPalette?: boolean) => ArrayBuffer;
  return Buffer.from(encodePng([input], width, height, 0, undefined, true));
}

function scaleWarnings(scale: number): string[] {
  return scale === 1 ? [] : [`Exported at ${scale}× using nearest-neighbor pixel scaling.`];
}

const FIDELITY_REPORT_TRUNCATION_WARNING = 'Structured fidelity reasons were truncated at 4,096 entries; human warnings and rasterized names remain available.';

export interface ExportArtifact {
  data: Buffer;
  mimeType: string;
  extension: string;
  report: { warnings: string[]; rasterized: string[]; fidelity?: InterchangeFidelityEntry[] };
  companion?: { data: Buffer; extension: string; mimeType: string; name?: string };
  companions?: Array<{ data: Buffer; extension: string; mimeType: string; name: string }>;
}

function exportReportFitsUtilityEnvelope(report: ExportArtifact['report']): boolean {
  try {
    assertUtilityJsonBudget(report, {
      label: 'Export report',
      maxBytes: MAX_UTILITY_REPORT_SERIALIZED_BYTES,
      maxNodes: MAX_INTERCHANGE_FIDELITY_ENTRIES * 8 + 4,
      maxDepth: 3,
    });
    return true;
  } catch {
    return false;
  }
}

export function boundedInterchangeExportReport(
  warnings: string[],
  rasterized: string[],
  fidelity: readonly InterchangeFidelityEntry[],
  producerTruncated = false,
): ExportArtifact['report'] {
  const base = { warnings, rasterized };
  if (!fidelity.length && !producerTruncated) return base;
  const complete = { ...base, fidelity: [...fidelity] };
  if (!producerTruncated && exportReportFitsUtilityEnvelope(complete)) return complete;

  const warned = warnings.includes(FIDELITY_REPORT_TRUNCATION_WARNING) ? warnings : [...warnings, FIDELITY_REPORT_TRUNCATION_WARNING];
  const warnedBase = { warnings: warned, rasterized };
  if (!exportReportFitsUtilityEnvelope(warnedBase)) return base;

  let minimum = 0; let maximum = fidelity.length;
  while (minimum < maximum) {
    const candidate = Math.ceil((minimum + maximum) / 2);
    if (exportReportFitsUtilityEnvelope({ ...warnedBase, fidelity: fidelity.slice(0, candidate) })) minimum = candidate;
    else maximum = candidate - 1;
  }
  return minimum > 0 ? { ...warnedBase, fidelity: fidelity.slice(0, minimum) } : warnedBase;
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
  const stops = style.stops.map((stop) => { const split = splitColorAlpha(stop.color); const opacity = Math.max(0, Math.min(1, split.opacity * (stop.opacity ?? 1))); return `<stop offset="${stop.offset}" stop-color="${xml(split.color)}"${opacity < 1 ? ` stop-opacity="${opacity}"` : ''}/>`; }).join('');
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

function svgObject(document: IllustrationDocument, object: IllustrationObject, geometryOnly = false, visiting = new Set<string>()): string {
  if ((!object.visible && !geometryOnly) || visiting.has(object.id)) return '';
  const effect = geometryOnly ? '' : `${(object.blur ?? 0) > 0 ? ` filter="url(#blur-${svgId(object.id)})"` : ''}${object.maskObjectId ? ` clip-path="url(#clip-${svgId(object.id)})"` : ''}`;
  const common = `transform="${transform(object)}"${geometryOnly ? '' : ` opacity="${object.opacity}" style="mix-blend-mode:${object.blendMode}"`}${effect}`;
  if (object.type === 'vector-stroke') return `<path ${common} d="${pressureData(object)}" fill="${xml(object.brush.color)}"/>`;
  if (object.type === 'group') {
    const next = new Set(visiting); next.add(object.id);
    return `<g ${common}>${object.childIds.map((id) => document.objects[id]).filter(Boolean).map((child) => svgObject(document, child, geometryOnly, next)).join('')}</g>`;
  }
  const strokeAttributes = (stroke: Extract<IllustrationObject, { type: 'path' | 'shape' }>['stroke']) => geometryOnly
    ? 'stroke="none" stroke-width="0"'
    : `stroke="${stylePaint(object, 'stroke', stroke.paint)}" stroke-width="${stroke.width}" stroke-opacity="${stroke.opacity}" stroke-linecap="${stroke.lineCap}" stroke-linejoin="${stroke.lineJoin}"${stroke.dash.length ? ` stroke-dasharray="${stroke.dash.join(' ')}"` : ''}`;
  if (object.type === 'path') return `<path ${common} d="${xml(object.pathData)}" fill="${geometryOnly ? '#000' : stylePaint(object, 'fill', object.fill)}" fill-rule="${object.fillRule}" ${strokeAttributes(object.stroke)}/>`;
  if (object.type === 'shape') {
    const style = `fill="${geometryOnly ? '#000' : stylePaint(object, 'fill', object.fill)}" ${strokeAttributes(object.stroke)}`;
    if (object.shape === 'rectangle') return `<rect ${common} ${style} width="${object.width}" height="${object.height}" rx="${object.cornerRadius ?? 0}"/>`;
    if (object.shape === 'ellipse') return `<ellipse ${common} ${style} cx="${object.width / 2}" cy="${object.height / 2}" rx="${Math.abs(object.width / 2)}" ry="${Math.abs(object.height / 2)}"/>`;
    if (object.shape === 'line') return `<line ${common} ${style} x1="0" y1="0" x2="${object.width}" y2="${object.height}"/>`;
    if (object.shape === 'arrow') {
      const angle = Math.atan2(object.height, object.width); const head = Math.max(10, object.stroke.width * 4);
      const first = { x: object.width - Math.cos(angle - 0.5) * head, y: object.height - Math.sin(angle - 0.5) * head };
      const second = { x: object.width - Math.cos(angle + 0.5) * head, y: object.height - Math.sin(angle + 0.5) * head };
      return `<path ${common} ${style} d="M 0 0 L ${object.width} ${object.height} M ${object.width} ${object.height} L ${first.x} ${first.y} M ${object.width} ${object.height} L ${second.x} ${second.y}"/>`;
    }
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
    const ranges = object.ranges.length ? object.ranges : [{ start: 0, end: object.text.length, fontFamily: 'sans-serif', fontSize: 48, fontWeight: 500, fontStyle: 'normal' as const, color: '#27213c', letterSpacing: 0 }];
    const content = ranges.map((range) => `<tspan fill="${xml(range.color)}" font-family="${xml(range.fontFamily)}" font-size="${range.fontSize}" font-weight="${range.fontWeight}" font-style="${range.fontStyle}" letter-spacing="${range.letterSpacing}"${range.underline ? ' text-decoration="underline"' : ''}>${xml(object.text.slice(range.start, range.end))}</tspan>`).join('');
    const anchor = object.align === 'center' ? 'middle' : object.align === 'right' ? 'end' : 'start';
    const x = object.align === 'center' ? object.width / 2 : object.align === 'right' ? object.width : 0;
    return `<text ${common} x="${x}" y="${ranges[0].fontSize}" text-anchor="${anchor}" data-aidraw-text-box="1" data-aidraw-text-width="${object.width}" data-aidraw-text-height="${object.height}" data-aidraw-line-height="${object.lineHeight}">${content}</text>`;
  }
  if (object.type === 'image') {
    const asset = document.assets[object.assetId];
    if (!asset?.data) return '';
    if (!object.crop) return `<image ${common} width="${object.width}" height="${object.height}" preserveAspectRatio="none" href="data:${asset.mimeType};base64,${asset.data}"/>`;
    const sourceWidth = object.sourceWidth ?? object.crop.x + object.crop.width; const sourceHeight = object.sourceHeight ?? object.crop.y + object.crop.height;
    const scaleX = object.width / object.crop.width; const scaleY = object.height / object.crop.height;
    return `<g ${common}><clipPath id="crop-${svgId(object.id)}"><rect width="${object.width}" height="${object.height}"/></clipPath><image clip-path="url(#crop-${svgId(object.id)})" x="${-object.crop.x * scaleX}" y="${-object.crop.y * scaleY}" width="${sourceWidth * scaleX}" height="${sourceHeight * scaleY}" preserveAspectRatio="none" href="data:${asset.mimeType};base64,${asset.data}"/></g>`;
  }
  return '';
}

export function illustrationToSvg(document: IllustrationDocument, paintLayerFallbacks: Record<string, string> = {}): string {
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
    const objectChildren = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
    const content = layer.type === 'vector'
      ? layer.objectIds.filter((id) => !objectChildren.has(id)).map((id) => document.objects[id]).filter(Boolean).map((object) => svgObject(document, object)).join('')
      : layer.type === 'paint'
        ? paintLayerFallbacks[layer.id]
          ? `<image width="${document.artboard.width}" height="${document.artboard.height}" href="data:image/png;base64,${paintLayerFallbacks[layer.id]}"/>`
          : layer.strokes.map((stroke) => `<polyline fill="none" stroke="${xml(stroke.color)}" stroke-width="${stroke.size}" stroke-linecap="round" stroke-linejoin="round" opacity="${stroke.opacity}" points="${stroke.points.map((point) => `${point.x},${point.y}`).join(' ')}"/>`).join('')
        : layer.childIds.map(svgLayer).join('');
    return `<g id="${xml(layer.id)}" opacity="${layer.opacity}" style="mix-blend-mode:${layer.blendMode}">${content}</g>`;
  };
  const layers = document.layerIds.map(svgLayer).join('');
  const background = document.artboard.background ? `<rect width="100%" height="100%" fill="${xml(document.artboard.background)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${document.artboard.width}" height="${document.artboard.height}" viewBox="0 0 ${document.artboard.width} ${document.artboard.height}">${definitions ? `<defs>${definitions}</defs>` : ''}${background}${layers}</svg>`;
}

async function illustrationSvg(document: IllustrationDocument): Promise<ExportArtifact> {
  const paintLayerFallbacks: Record<string, string> = {};
  const rasterized: string[] = [];
  const warnings = new Set<string>();
  const fidelity: InterchangeFidelityEntry[] = [];
  let fidelityTruncated = false;
  const recordFidelity = (entry: InterchangeFidelityEntry) => { if (!tryAppendInterchangeFidelityEntry(fidelity, entry)) fidelityTruncated = true; };
  const reachableVisibleLayerIds = new Set<string>();
  const collectVisibleLayer = (layerId: string) => {
    if (reachableVisibleLayerIds.has(layerId)) return;
    const layer = document.layers[layerId];
    if (!layer?.visible) return;
    reachableVisibleLayerIds.add(layerId);
    if (layer.type === 'group') for (const childId of layer.childIds) collectVisibleLayer(childId);
  };
  for (const layerId of document.layerIds) collectVisibleLayer(layerId);
  for (const layerId of reachableVisibleLayerIds) {
    const layer = document.layers[layerId];
    if (!layer) continue;
    const embedsPaintFallback = layer.type === 'paint' && layer.strokes.length > 0;
    if (embedsPaintFallback) {
      const source = await renderIllustrationLayerSource(document, layer.id);
      try { paintLayerFallbacks[layer.id] = source.toBuffer('image/png').toString('base64'); }
      finally { source.width = 1; source.height = 1; }
      rasterized.push(layer.name);
      recordFidelity({
        code: 'raster-fallback',
        subjectType: 'layer',
        subjectId: layer.id,
        subjectName: layer.name,
        detail: 'SVG export embeds this paint layer as a transparent PNG; authored paint, adjustment filters, and a vector layer mask are baked into the fallback where present.',
      });
    }
  }
  for (const layer of Object.values(document.layers)) {
    if (layer.type === 'paint') continue;
    if (layer.filters?.length) warnings.add(`Layer “${layer.name}” adjustment filters may vary between SVG viewers.`);
    if (layer.maskLayerId) warnings.add(`Layer mask on “${layer.name}” is not portable in SVG and should be visually checked.`);
  }
  for (const object of Object.values(document.objects)) {
    if (object.filters?.length) warnings.add(`Adjustment filters on “${object.name}” are not encoded in this SVG export.`);
    if (object.shadow) warnings.add(`Shadow on “${object.name}” is not encoded in this SVG export.`);
    if (object.type === 'text' && (object.align === 'justify' || object.text.includes('\n'))) warnings.add(`Text box layout for “${object.name}” may reflow in another SVG application.`);
    if (object.type === 'image' && !document.assets[object.assetId]?.data) warnings.add(`Image “${object.name}” is missing its embedded source and was omitted.`);
  }
  if (rasterized.length) warnings.add('Paint layers are embedded as transparent PNG fallbacks so erasing and natural-media brushes remain visually faithful.');
  return { data: Buffer.from(illustrationToSvg(document, paintLayerFallbacks)), mimeType: 'image/svg+xml', extension: 'svg', report: boundedInterchangeExportReport([...warnings], rasterized, fidelity, fidelityTruncated) };
}

async function raster(document: AIDrawDocument, format: 'png' | 'jpeg' | 'webp', scale = 1): Promise<ExportArtifact> {
  const dimensions = renderDocumentDimensions(document);
  assertScaledDimensions(dimensions.width, dimensions.height, scale);
  if (format === 'png' && document.kind === 'pixel') {
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite?.type === 'sprite') {
      const exact = exactSingleLayerAnimationFrame(document.palette, sprite, sprite.frameIds[0]);
      if (exact) {
        const scaled = nearestNeighborFrame(exact, sprite.width, sprite.height, scale);
        return { data: encodeLosslessRgbaPng(scaled, dimensions.width * scale, dimensions.height * scale), mimeType: 'image/png', extension: 'png', report: { warnings: scaleWarnings(scale), rasterized: [] } };
      }
    }
  }
  const canvas = nearestNeighborCanvas(await renderDocument(document), scale);
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const data = format === 'png'
    ? canvas.toBuffer('image/png')
    : format === 'jpeg'
      ? canvas.toBuffer('image/jpeg', 0.92)
      : canvas.toBuffer('image/webp', 0.92);
  return { data, mimeType: mime, extension: format === 'jpeg' ? 'jpg' : format, report: { warnings: scaleWarnings(scale), rasterized: [] } };
}

type PdfColor = { color: ReturnType<typeof rgb>; opacity: number };

function pdfColor(value: string): PdfColor | undefined {
  const split = splitColorAlpha(value);
  if (!/^#[0-9a-f]{6}$/i.test(split.color)) return undefined;
  return {
    color: rgb(
      Number.parseInt(split.color.slice(1, 3), 16) / 255,
      Number.parseInt(split.color.slice(3, 5), 16) / 255,
      Number.parseInt(split.color.slice(5, 7), 16) / 255,
    ),
    opacity: split.opacity,
  };
}

function pdfObjectHasSimpleTransform(object: IllustrationObject): boolean {
  const transform = object.transform;
  return transform.scaleX === 1 && transform.scaleY === 1 && transform.rotation === 0 && transform.skewX === 0 && transform.skewY === 0;
}

function pdfObjectHasEffects(object: IllustrationObject): boolean {
  return object.opacity < 0 || object.opacity > 1 || object.type === 'group' && object.opacity !== 1 || object.blendMode !== 'normal' || Boolean(object.blur || object.filters?.length || object.maskObjectId || object.shadow);
}

function solidPdfPaint(paint: PaintStyle): PdfColor | undefined {
  return paint.kind === 'solid' ? pdfColor(paint.color) : undefined;
}

function shapePdfPath(object: Extract<IllustrationObject, { type: 'shape' }>): string {
  if (object.shape === 'rectangle') {
    const radius = Math.max(0, Math.min(object.cornerRadius ?? 0, Math.abs(object.width) / 2, Math.abs(object.height) / 2));
    if (!radius) return `M 0 0 H ${object.width} V ${object.height} H 0 Z`;
    return `M ${radius} 0 H ${object.width - radius} Q ${object.width} 0 ${object.width} ${radius} V ${object.height - radius} Q ${object.width} ${object.height} ${object.width - radius} ${object.height} H ${radius} Q 0 ${object.height} 0 ${object.height - radius} V ${radius} Q 0 0 ${radius} 0 Z`;
  }
  if (object.shape === 'ellipse') return `M ${object.width} ${object.height / 2} A ${Math.abs(object.width / 2)} ${Math.abs(object.height / 2)} 0 1 0 0 ${object.height / 2} A ${Math.abs(object.width / 2)} ${Math.abs(object.height / 2)} 0 1 0 ${object.width} ${object.height / 2} Z`;
  if (object.shape === 'line') return `M 0 0 L ${object.width} ${object.height}`;
  if (object.shape === 'arrow') {
    const angle = Math.atan2(object.height, object.width); const head = Math.max(10, object.stroke.width * 4);
    const first = { x: object.width - Math.cos(angle - 0.5) * head, y: object.height - Math.sin(angle - 0.5) * head };
    const second = { x: object.width - Math.cos(angle + 0.5) * head, y: object.height - Math.sin(angle + 0.5) * head };
    return `M 0 0 L ${object.width} ${object.height} M ${object.width} ${object.height} L ${first.x} ${first.y} M ${object.width} ${object.height} L ${second.x} ${second.y}`;
  }
  const count = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6);
  const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
  return `${Array.from({ length: count }, (_, index) => {
    const pointRadius = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius;
    const angle = -Math.PI / 2 + index / count * Math.PI * 2;
    const x = object.width / 2 + Math.cos(angle) * pointRadius; const y = object.height / 2 + Math.sin(angle) * pointRadius;
    return `${index ? 'L' : 'M'} ${x} ${y}`;
  }).join(' ')} Z`;
}

function pdfPathForObject(object: IllustrationObject): string | undefined {
  if (object.type === 'vector-stroke') return pressureData(object);
  if (object.type === 'path') return object.pathData;
  if (object.type === 'shape') return shapePdfPath(object);
  return undefined;
}

function pdfObjectCanRemainNative(document: IllustrationDocument, object: IllustrationObject): boolean {
  if (!pdfObjectHasSimpleTransform(object) || pdfObjectHasEffects(object)) return false;
  if (object.type === 'group') return true;
  if (object.type === 'vector-stroke') return Boolean(pdfColor(object.brush.color));
  if (object.type === 'path' || object.type === 'shape') {
    if (object.type === 'path' && object.fillRule === 'evenodd') return false;
    return (object.fill.kind === 'none' || Boolean(solidPdfPaint(object.fill)))
      && (object.stroke.paint.kind === 'none' || Boolean(solidPdfPaint(object.stroke.paint)));
  }
  if (object.type === 'text') return true;
  if (object.type === 'image') return Boolean(document.assets[object.assetId]?.data);
  return false;
}

function pdfFontName(weight: number, italic: boolean): StandardFonts {
  if (weight >= 600 && italic) return StandardFonts.HelveticaBoldOblique;
  if (weight >= 600) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

async function rasterizedPdfObject(document: IllustrationDocument, layerId: string, objectId: string): Promise<Buffer> {
  const source = structuredClone(document); const layer = source.layers[layerId];
  if (!layer || layer.type !== 'vector') throw new Error('PDF object fallback requires a vector layer.');
  const closure = new Set<string>();
  const visit = (id: string) => {
    if (closure.has(id)) return; closure.add(id);
    const object = source.objects[id]; if (!object) return;
    if (object.maskObjectId) visit(object.maskObjectId);
    if (object.type === 'group') for (const childId of object.childIds) visit(childId);
  };
  visit(objectId);
  for (const object of Object.values(source.objects)) {
    object.visible = closure.has(object.id);
    if (object.type === 'group' && !closure.has(object.id)) object.childIds = object.childIds.filter((id) => !closure.has(id));
  }
  layer.objectIds = [objectId];
  return (await renderIllustration(source, layerId, false)).toBuffer('image/png');
}

async function drawPdfImage(output: PDFDocument, page: PDFPage, document: IllustrationDocument, object: Extract<IllustrationObject, { type: 'image' }>): Promise<void> {
  const asset = document.assets[object.assetId]; if (!asset?.data) throw new Error(`Image ${object.name} has no embedded source.`);
  let bytes: Buffer = Buffer.from(asset.data, 'base64'); let mimeType = asset.mimeType;
  if (object.crop || !['image/png', 'image/jpeg'].includes(mimeType)) {
    const source = await import('@napi-rs/canvas').then(({ loadImage }) => loadImage(bytes));
    const crop = object.crop ?? { x: 0, y: 0, width: source.width, height: source.height };
    const canvas = createCanvas(Math.max(1, Math.ceil(crop.width)), Math.max(1, Math.ceil(crop.height)));
    canvas.getContext('2d').drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    bytes = canvas.toBuffer('image/png'); mimeType = 'image/png';
  }
  const embedded = mimeType === 'image/jpeg' ? await output.embedJpg(bytes) : await output.embedPng(bytes);
  page.drawImage(embedded, { x: object.transform.x, y: document.artboard.height - object.transform.y - object.height, width: object.width, height: object.height, opacity: object.opacity });
}

async function illustrationPdf(document: IllustrationDocument): Promise<ExportArtifact> {
  const output = await PDFDocument.create(); const page = output.addPage([document.artboard.width, document.artboard.height]);
  const warnings = new Set<string>(); const rasterized: string[] = []; const fidelity: InterchangeFidelityEntry[] = []; const fonts = new Map<StandardFonts, PDFFont>(); let searchableImportedTextRuns = 0;
  let fidelityTruncated = false;
  const recordFidelity = (entry: InterchangeFidelityEntry) => { if (!tryAppendInterchangeFidelityEntry(fidelity, entry)) fidelityTruncated = true; };
  if (document.artboard.background) {
    const background = pdfColor(document.artboard.background);
    if (background) page.drawRectangle({ x: 0, y: 0, width: document.artboard.width, height: document.artboard.height, color: background.color, opacity: background.opacity });
  }
  const drawFallback = async (name: string, png: Buffer) => {
    const image = await output.embedPng(png); page.drawImage(image, { x: 0, y: 0, width: document.artboard.width, height: document.artboard.height }); rasterized.push(name);
  };
  const drawObject = async (layerId: string, objectId: string, visiting = new Set<string>(), invisibleText = false): Promise<void> => {
    if (visiting.has(objectId)) return;
    const object = document.objects[objectId]; if (!object?.visible) return;
    if (invisibleText && object.type !== 'text') return;
    if (!pdfObjectCanRemainNative(document, object)) {
      if (invisibleText) {
        warnings.add('Some imported PDF text could not remain searchable because its transform or effects require rasterization.');
        recordFidelity({ code: 'searchable-text-omitted', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'The imported text transform or effects cannot be represented by the searchable PDF text path.' });
        return;
      }
      await drawFallback(object.name, await rasterizedPdfObject(document, layerId, objectId));
      recordFidelity({ code: 'raster-fallback', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'The object uses a transform, paint, mask, blend mode, or effect outside the native PDF path.' });
      warnings.add('Unsupported object transforms, gradients, masks, blend modes, and effects are embedded as transparent raster fallbacks.');
      return;
    }
    if (object.type === 'group') {
      const next = new Set(visiting); next.add(objectId);
      for (const childId of object.childIds) await drawObject(layerId, childId, next, invisibleText);
      return;
    }
    if (object.type === 'image') { await drawPdfImage(output, page, document, object); return; }
    if (object.type === 'text') {
      const ranges = object.ranges.length ? object.ranges : [{ start: 0, end: object.text.length, fontFamily: 'sans-serif', fontSize: 48, fontWeight: 500, fontStyle: 'normal' as const, color: '#27213c', letterSpacing: 0 }];
      const substitutesFont = ranges.some((range) => !/^(arial|helvetica|sans-serif)$/i.test(range.fontFamily));
      try {
        const fontFor = async (weight: number, italic: boolean) => { const name = pdfFontName(weight, italic); let font = fonts.get(name); if (!font) { font = await output.embedFont(name); fonts.set(name, font); } return font; };
        for (const range of ranges) await fontFor(range.fontWeight, range.fontStyle === 'italic');
        if (invisibleText) {
          const style = ranges[0]; const font = fonts.get(pdfFontName(style.fontWeight, style.fontStyle === 'italic'))!;
          page.drawText(object.text, { x: object.transform.x, y: document.artboard.height - object.transform.y - style.fontSize, size: style.fontSize, font, color: rgb(0, 0, 0), opacity: 0 });
          searchableImportedTextRuns += 1;
          recordFidelity({ code: 'searchable-text-retained', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'Invisible searchable text remains selectable beneath covering artwork and must not be treated as redacted.' });
          if (substitutesFont) {
            warnings.add('PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.');
            recordFidelity({ code: 'font-substitution', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'Helvetica replaces a non-embedded document font in the PDF text path.' });
          }
          return;
        }
        const glyphs = layoutStyledText({ ...object, ranges }, (character, style) => fonts.get(pdfFontName(style.fontWeight, style.fontStyle === 'italic'))!.widthOfTextAtSize(character, style.fontSize));
        for (const glyph of glyphs) {
          const fill = pdfColor(glyph.style.color); if (!fill) throw new Error('Unsupported text color.'); const font = fonts.get(pdfFontName(glyph.style.fontWeight, glyph.style.fontStyle === 'italic'))!;
          page.drawText(glyph.character, { x: object.transform.x + glyph.x, y: document.artboard.height - object.transform.y - glyph.y - glyph.style.fontSize, size: glyph.style.fontSize, font, color: fill.color, opacity: fill.opacity * object.opacity });
          if (glyph.style.underline) page.drawLine({ start: { x: object.transform.x + glyph.x, y: document.artboard.height - object.transform.y - glyph.y - glyph.style.fontSize * 1.08 }, end: { x: object.transform.x + glyph.x + glyph.width, y: document.artboard.height - object.transform.y - glyph.y - glyph.style.fontSize * 1.08 }, thickness: Math.max(0.5, glyph.style.fontSize / 18), color: fill.color, opacity: fill.opacity * object.opacity });
        }
        if (substitutesFont) {
          warnings.add('PDF text remains searchable/editable but non-embedded document fonts are substituted with Helvetica.');
          recordFidelity({ code: 'font-substitution', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'Helvetica replaces a non-embedded document font in the PDF text path.' });
        }
      } catch {
        if (invisibleText) {
          warnings.add('Some imported PDF text could not remain searchable because it contains glyphs outside the built-in PDF font.');
          recordFidelity({ code: 'searchable-text-omitted', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'The imported text contains glyphs outside the built-in PDF font.' });
          return;
        }
        await drawFallback(object.name, await rasterizedPdfObject(document, layerId, objectId));
        recordFidelity({ code: 'raster-fallback', subjectType: 'object', subjectId: object.id, subjectName: object.name, detail: 'The text contains a glyph or paint outside the built-in PDF text path.' });
        warnings.add('Text containing glyphs outside the built-in PDF font was rasterized; the export report names the affected object.');
      }
      return;
    }
    const path = pdfPathForObject(object); if (!path) return;
    const fill = object.type === 'vector-stroke' ? pdfColor(object.brush.color) : solidPdfPaint(object.fill);
    const stroke = object.type === 'vector-stroke' ? undefined : solidPdfPaint(object.stroke.paint);
    const strokeOpacity = object.type === 'vector-stroke' ? 0 : object.stroke.opacity;
    const lineCap = object.type === 'vector-stroke' ? undefined : object.stroke.lineCap === 'round' ? LineCapStyle.Round : object.stroke.lineCap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Butt;
    page.drawSvgPath(path, { x: object.transform.x, y: document.artboard.height - object.transform.y, color: fill?.color, opacity: fill ? fill.opacity * object.opacity : undefined, borderColor: stroke?.color, borderOpacity: stroke ? stroke.opacity * strokeOpacity * object.opacity : undefined, borderWidth: object.type === 'vector-stroke' ? 0 : object.stroke.width, borderDashArray: object.type === 'vector-stroke' ? undefined : object.stroke.dash, borderLineCap: lineCap });
  };
  const drawLayer = async (layerId: string): Promise<void> => {
    const layer = document.layers[layerId]; if (!layer) return;
    if (!layer.visible) {
      if (layer.type === 'vector' && layer.interchangeRole === 'pdf-extracted-text') for (const objectId of layer.objectIds) await drawObject(layerId, objectId, new Set<string>(), true);
      return;
    }
    if (layer.opacity !== 1 || layer.blendMode !== 'normal' || layer.filters?.length || layer.maskLayerId) {
      await drawFallback(layer.name, (await renderIllustration(document, layerId, false)).toBuffer('image/png'));
      recordFidelity({ code: 'raster-fallback', subjectType: 'layer', subjectId: layer.id, subjectName: layer.name, detail: 'Layer compositing, adjustment filters, or a layer mask requires a transparent PDF raster fallback.' });
      warnings.add('Layer compositing, adjustment filters, and layer masks are embedded as transparent raster fallbacks.');
      return;
    }
    if (layer.type === 'paint') {
      if (layer.strokes.length || Object.keys(layer.tileAssetIds).length) {
        await drawFallback(layer.name, (await renderIllustration(document, layerId, false)).toBuffer('image/png'));
        recordFidelity({ code: 'raster-fallback', subjectType: 'layer', subjectId: layer.id, subjectName: layer.name, detail: 'Paint-layer content requires a transparent PDF raster fallback.' });
        warnings.add('Paint layers are embedded as transparent PNG fallbacks.');
      }
      return;
    }
    if (layer.type === 'group') { for (const childId of layer.childIds) await drawLayer(childId); return; }
    const childIds = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
    for (const objectId of layer.objectIds) if (!childIds.has(objectId)) await drawObject(layerId, objectId);
  };
  for (const layerId of document.layerIds) await drawLayer(layerId);
  if (searchableImportedTextRuns) {
    warnings.add('Invisible imported PDF text remains searchable and selectable even when visible artwork covers it; do not treat covering artwork as redaction.');
    warnings.add(`${searchableImportedTextRuns} imported PDF text run${searchableImportedTextRuns === 1 ? ' was' : 's were'} retained as invisible searchable content.`);
  }
  return { data: Buffer.from(await output.save()), mimeType: 'application/pdf', extension: 'pdf', report: boundedInterchangeExportReport([...warnings], rasterized, fidelity, fidelityTruncated) };
}

async function pdf(document: AIDrawDocument, scale = 1): Promise<ExportArtifact> {
  if (document.kind === 'illustration') return illustrationPdf(document);
  const dimensions = renderDocumentDimensions(document);
  assertScaledDimensions(dimensions.width, dimensions.height, scale);
  const canvas = nearestNeighborCanvas(await renderDocument(document), scale); const png = canvas.toBuffer('image/png'); const output = await PDFDocument.create(); const page = output.addPage([canvas.width, canvas.height]);
  page.drawImage(await output.embedPng(png), { x: 0, y: 0, width: canvas.width, height: canvas.height });
  return {
    data: Buffer.from(await output.save()), mimeType: 'application/pdf', extension: 'pdf',
    report: {
      warnings: [...scaleWarnings(scale), 'Pixel PDF export embeds nearest-neighbor raster artwork.'],
      rasterized: ['composite'],
      fidelity: [{ code: 'raster-fallback', subjectType: 'document', subjectId: document.id, subjectName: document.name, detail: 'Pixel PDF export embeds the document composite as nearest-neighbor raster artwork.' }],
    },
  };
}

function psdBlendMode(value: IllustrationDocument['layers'][string]['blendMode']): PsdLayer['blendMode'] {
  return value.replace(/-/g, ' ') as PsdLayer['blendMode'];
}

function psdTextColor(value: string): { r: number; g: number; b: number; a?: number } {
  const split = splitColorAlpha(value); const normalized = /^#[0-9a-f]{6}$/i.test(split.color) ? split.color : '#000000';
  return { r: Number.parseInt(normalized.slice(1, 3), 16), g: Number.parseInt(normalized.slice(3, 5), 16), b: Number.parseInt(normalized.slice(5, 7), 16), ...(split.opacity < 1 ? { a: Math.round(split.opacity * 255) } : {}) };
}

function psdTextLayer(object: Extract<IllustrationObject, { type: 'text' }>): PsdLayer {
  const ranges = normalizeTextStyleRanges(object.text, object.ranges); const first = ranges[0];
  const style = (range: typeof first) => ({ font: { name: range.fontFamily || 'ArialMT' }, fontSize: range.fontSize, leading: object.lineHeight * range.fontSize, fauxBold: range.fontWeight >= 600, fauxItalic: range.fontStyle === 'italic', tracking: Math.round(range.letterSpacing / Math.max(1, range.fontSize) * 1_000), underline: Boolean(range.underline), fillColor: psdTextColor(range.color) });
  return {
    name: `${object.name}${AIDRAW_PSD_EDITABLE_TEXT_SUFFIX}`, hidden: true, opacity: object.opacity, blendMode: psdBlendMode(object.blendMode), ...aidrawPsdLockFields(object.locked),
    left: object.transform.x, top: object.transform.y, right: object.transform.x + object.width, bottom: object.transform.y + object.height,
    text: {
      text: object.text, transform: [...aidrawPsdTextMatrix(object.transform, first.fontSize)], shapeType: 'box', boxBounds: [0, 0, object.width, object.height],
      style: style(first), styleRuns: ranges.map((range) => ({ length: range.end - range.start, style: style(range) })),
      paragraphStyle: { justification: object.align === 'justify' ? 'justify-left' : object.align },
    },
  };
}

export function assertPsdLayerRasterBudget(width: number, height: number, layerRasterCount: number): void {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) throw new RangeError('PSD raster dimensions must be positive safe integers.');
  assertScaledDimensions(width, height, 1);
  if (!Number.isSafeInteger(layerRasterCount) || layerRasterCount < 0) throw new RangeError('PSD raster layer count must be a nonnegative safe integer.');
  const pixels = width * height;
  if (layerRasterCount > Math.floor(MAX_PSD_EXPANDED_LAYER_PIXELS / pixels)) throw new RangeError('PSD layer rasters exceed the 64-megapixel expanded safety budget.');
}

function textObjectsInLayer(document: IllustrationDocument, layerId: string, maximumCount = Number.POSITIVE_INFINITY): Array<Extract<IllustrationObject, { type: 'text' }>> {
  const layer = document.layers[layerId]; if (!layer || layer.type !== 'vector') return [];
  const result: Array<Extract<IllustrationObject, { type: 'text' }>> = []; const visited = new Set<string>(); const pending = [...layer.objectIds].reverse();
  while (pending.length) {
    const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); const object = document.objects[id]; if (!object) continue;
    if (object.type === 'text') {
      if (object.visible && object.text.length > 0) {
        result.push(object);
        if (result.length > maximumCount) throw new RangeError(`PSD exceeds the ${MAX_PSD_LAYER_RECORDS.toLocaleString('en-US')}-layer safety limit.`);
      }
    } else if (object.type === 'group') for (let index = object.childIds.length - 1; index >= 0; index -= 1) pending.push(object.childIds[index]);
  }
  return result;
}

interface PsdExportBudget { layerRecords: number; maximumDepth: number; layerRasters: number }

function addPsdExportRecord(budget: PsdExportBudget, depth: number): void {
  budget.layerRecords += 1; budget.maximumDepth = Math.max(budget.maximumDepth, depth);
  assertPsdLayerStructureBudget(budget.layerRecords, budget.maximumDepth);
}

function illustrationPsdExportBudget(document: IllustrationDocument): PsdExportBudget {
  const budget: PsdExportBudget = { layerRecords: 0, maximumDepth: 0, layerRasters: 0 };
  const countLayer = (layerId: string, depth: number, ancestors = new Set<string>()): void => {
    const layer = document.layers[layerId]; if (!layer) return;
    if (ancestors.has(layerId)) throw new Error('Illustration layer hierarchy contains a cycle.');
    addPsdExportRecord(budget, depth);
    if (layer.type === 'group' && !layer.filters?.length && !layer.maskLayerId) {
      const next = new Set(ancestors); next.add(layerId);
      for (const childId of layer.childIds) countLayer(childId, depth + 1, next);
      return;
    }
    budget.layerRasters += 1;
    if (layer.type !== 'vector') return;
    const texts = textObjectsInLayer(document, layerId, Math.max(0, MAX_PSD_LAYER_RECORDS - budget.layerRecords - 1));
    if (!texts.length) return;
    addPsdExportRecord(budget, depth + 1);
    for (let index = 0; index < texts.length; index += 1) addPsdExportRecord(budget, depth + 1);
  };
  for (const layerId of document.layerIds) countLayer(layerId, 0);
  return budget;
}

function pixelPsdExportBudget(sprite: PixelSprite): PsdExportBudget {
  const budget: PsdExportBudget = { layerRecords: 0, maximumDepth: 0, layerRasters: 0 };
  const countLayer = (layerId: string, depth: number, ancestors = new Set<string>()): void => {
    const layer = sprite.layers[layerId]; if (!layer) return;
    if (ancestors.has(layerId)) throw new Error('Pixel layer hierarchy contains a cycle.');
    addPsdExportRecord(budget, depth);
    if (layer.type === 'pixel') { budget.layerRasters += 1; return; }
    const next = new Set(ancestors); next.add(layerId);
    for (const childId of layer.childIds ?? []) countLayer(childId, depth + 1, next);
  };
  for (const layerId of sprite.layerIds) countLayer(layerId, 0);
  return budget;
}

async function renderPsdLayerFallback(document: IllustrationDocument, layerId: string): Promise<NonNullable<PsdLayer['imageData']>> {
  if (!document.layers[layerId]) throw new Error(`Layer ${layerId} is missing.`);
  const rendered = await renderIllustrationLayerSource(document, layerId);
  try { return rendered.getContext('2d').getImageData(0, 0, document.artboard.width, document.artboard.height); }
  finally { rendered.width = 1; rendered.height = 1; }
}

function renderPsdPixelLayer(document: Extract<AIDrawDocument, { kind: 'pixel' }>, sprite: PixelSprite, layerId: string): NonNullable<PsdLayer['imageData']> {
  const layer = sprite.layers[layerId];
  if (!layer || layer.type !== 'pixel') throw new Error(`Pixel layer ${layerId} is missing.`);
  const source: PixelSprite = { ...sprite, layers: { ...sprite.layers, [layerId]: { ...layer, visible: true, opacity: 1, blendMode: 'normal' } } };
  const rendered = renderSprite(document, source, source.frameIds[0], layerId);
  try { return rendered.getContext('2d').getImageData(0, 0, source.width, source.height); }
  finally { rendered.width = 1; rendered.height = 1; }
}

async function psd(document: AIDrawDocument): Promise<ExportArtifact> {
  const report = { warnings: [] as string[], rasterized: [] as string[] };
  const fidelity: InterchangeFidelityEntry[] = [];
  let fidelityTruncated = false;
  const recordFidelity = (entry: InterchangeFidelityEntry) => { if (!tryAppendInterchangeFidelityEntry(fidelity, entry)) fidelityTruncated = true; };
  let width: number; let height: number; const children: PsdLayer[] = [];
  if (document.kind === 'illustration') {
    width = document.artboard.width; height = document.artboard.height;
    const budget = illustrationPsdExportBudget(document); assertPsdLayerRasterBudget(width, height, budget.layerRasters);
    let editableTextCount = 0;
    const exportLayer = async (layerId: string): Promise<PsdLayer | undefined> => {
      const layer = document.layers[layerId]; if (!layer) return undefined;
      const common = { name: layer.name, opacity: layer.opacity, hidden: !layer.visible, blendMode: psdBlendMode(layer.blendMode), ...aidrawPsdLockFields(layer.locked) };
      if (layer.type === 'group' && !layer.filters?.length && !layer.maskLayerId) {
        const nested: PsdLayer[] = [];
        for (const childId of layer.childIds) { const entry = await exportLayer(childId); if (entry) nested.push(entry); }
        return { ...common, children: nested, opened: true };
      }
      const imageData = await renderPsdLayerFallback(document, layerId); report.rasterized.push(layer.name);
      recordFidelity({ code: 'raster-fallback', subjectType: 'layer', subjectId: layer.id, subjectName: layer.name, detail: 'The illustration layer is represented by a visually faithful PSD raster fallback.' });
      if (layer.type !== 'vector') {
        if (layer.type === 'group') {
          report.warnings.push(`Layer group “${layer.name}” was flattened because its filter or mask cannot be represented safely in PSD.`);
          recordFidelity({ code: 'flattened-layer', subjectType: 'layer', subjectId: layer.id, subjectName: layer.name, detail: 'A group filter or mask prevents safe editable PSD child-layer representation.' });
        }
        return { ...common, imageData };
      }
      const texts = textObjectsInLayer(document, layerId);
      if (!texts.length) return { ...common, imageData };
      editableTextCount += texts.length;
      return { ...common, children: [{ name: `${layer.name} · visual fallback`, imageData }, ...texts.map(psdTextLayer)], opened: true };
    };
    for (const layerId of document.layerIds) { const entry = await exportLayer(layerId); if (entry) children.push(entry); }
    report.warnings.push('Vector and paint layers include visually faithful raster fallbacks because PSD cannot preserve every AIDraw path, mask, blend, and effect feature.');
    if (editableTextCount) report.warnings.push(`${editableTextCount} styled text object${editableTextCount === 1 ? '' : 's'} were also written as hidden editable PSD text layers beside their visible fallbacks.`);
  } else {
    const asset = document.pixelAssets[document.activeAssetId];
    if (asset?.type !== 'sprite') throw new Error('PSD export from pixel mode requires an active sprite.');
    width = asset.width; height = asset.height;
    const budget = pixelPsdExportBudget(asset); assertPsdLayerRasterBudget(width, height, budget.layerRasters);
    const exportLayer = (layerId: string, ancestors = new Set<string>()): PsdLayer | undefined => {
      const layer = asset.layers[layerId]; if (!layer) return undefined;
      if (ancestors.has(layerId)) throw new Error('Pixel layer hierarchy contains a cycle.');
      const common = { name: layer.name, opacity: layer.opacity, hidden: !layer.visible, blendMode: psdBlendMode(layer.blendMode), ...aidrawPsdLockFields(layer.locked) };
      if (layer.type === 'pixel') return { ...common, imageData: renderPsdPixelLayer(document, asset, layerId) };
      const next = new Set(ancestors); next.add(layerId);
      const nested = (layer.childIds ?? []).map((childId) => exportLayer(childId, next)).filter((entry): entry is PsdLayer => Boolean(entry));
      return { ...common, children: nested, opened: true };
    };
    children.push(...asset.layerIds.map((layerId) => exportLayer(layerId)).filter((entry): entry is PsdLayer => Boolean(entry)));
    report.warnings.push('Pixel PSD export writes the current frame as a raster layer/group hierarchy; later animation frames are not included.');
    if (asset.frameIds.length > 1) {
      const omittedFrames = asset.frameIds.length - 1;
      recordFidelity({ code: 'animation-frames-omitted', subjectType: 'document', subjectId: document.id, subjectName: document.name, detail: `${omittedFrames} later animation frame${omittedFrames === 1 ? '' : 's'} ${omittedFrames === 1 ? 'is' : 'are'} not included in the PSD.` });
    }
  }
  const composite = await renderDocument(document);
  let compositeImageData: NonNullable<Psd['imageData']>;
  try { compositeImageData = composite.getContext('2d').getImageData(0, 0, width, height); }
  finally { composite.width = 1; composite.height = 1; }
  const value: Psd = { width, height, children, imageData: compositeImageData };
  return { data: writePsdBuffer(value, { generateThumbnail: true }), mimeType: 'image/vnd.adobe.photoshop', extension: 'psd', report: boundedInterchangeExportReport(report.warnings, report.rasterized, fidelity, fidelityTruncated) };
}

function tiledPropertyJson(properties: Record<string, string | number | boolean>) {
  return Object.entries(properties).map(([name, value]) => ({ name, value, type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string' }));
}

function tiledObjectJson(shape: PixelTileset['tiles'][number]['collisions'][number], index: number) {
  const { name, class: className, ...properties } = shape.properties;
  return { id: Number.parseInt(shape.id.replace(/\D/g, ''), 10) || index + 1, name: typeof name === 'string' ? name : '', type: typeof className === 'string' ? className : '', x: shape.x, y: shape.y, width: shape.width ?? 0, height: shape.height ?? 0, ellipse: shape.type === 'ellipse' || undefined, polygon: shape.type === 'polygon' ? shape.points : undefined, polyline: shape.type === 'polyline' ? shape.points : undefined, properties: tiledPropertyJson(properties) };
}

function tilesetJson(document: PixelDocument, tileset: PixelTileset, image?: string) {
  const sprite = document.pixelAssets[tileset.spriteAssetId];
  return {
    type: 'tileset', version: '1.10', tiledversion: '1.11.2', name: tileset.name, tilewidth: tileset.tileWidth, tileheight: tileset.tileHeight, margin: tileset.margin, spacing: tileset.spacing,
    tilecount: tileset.columns * tileset.rows, columns: tileset.columns,
    image, imagewidth: sprite?.type === 'sprite' ? sprite.width : undefined, imageheight: sprite?.type === 'sprite' ? sprite.height : undefined,
    transformations: { hflip: tileset.transformations.hFlip, vflip: tileset.transformations.vFlip, rotate: tileset.transformations.rotate, preferuntransformed: false },
    tiles: Object.values(tileset.tiles).map((tile) => ({ id: tile.id, probability: tile.probability, animation: tile.animation.map((frame) => ({ tileid: frame.tileId, duration: frame.durationMs })), properties: tiledPropertyJson(tile.properties), objectgroup: tile.collisions.length ? { draworder: 'index', objects: tile.collisions.map(tiledObjectJson) } : undefined })),
    wangsets: tileset.wangSets.map((set) => ({ name: set.name, type: set.type, colors: set.colors.map((color) => ({ name: color.name, color: color.color, tile: color.tileId, probability: color.probability })), wangtiles: set.tiles.map((tile) => ({ tileid: tile.tileId, wangid: tile.wangId })) })),
  };
}

export function tilemapToTiled(document: PixelDocument, map: PixelTilemap, images: Record<string, string> = {}) {
  let nextLayerId = 1;
  const layerJson = (id: string): Record<string, unknown> => {
    const layer = map.layers[id]; const common = { id: nextLayerId++, name: layer.name, visible: layer.visible, opacity: layer.opacity, parallaxx: layer.parallaxX, parallaxy: layer.parallaxY };
    if (layer.type === 'group') return { ...common, type: 'group', layers: (layer.childIds ?? []).map(layerJson) };
    if (layer.type === 'object') return { ...common, type: 'objectgroup', objects: (layer.objects ?? []).map(tiledObjectJson) };
    const chunks = Object.values(layer.chunks ?? {}).map((chunk) => ({ x: chunk.x, y: chunk.y, width: chunk.width, height: chunk.height, data: Array.from(decodeTilemapChunk(chunk)) })); const data = Array<number>(map.width * map.height).fill(0);
    if (!map.infinite) for (const chunk of chunks) for (let localY = 0; localY < chunk.height; localY += 1) for (let localX = 0; localX < chunk.width; localX += 1) { const x = chunk.x + localX; const y = chunk.y + localY; if (x >= 0 && y >= 0 && x < map.width && y < map.height) data[y * map.width + x] = chunk.data[localY * chunk.width + localX] ?? 0; }
    return { ...common, type: 'tilelayer', ...(map.infinite ? { chunks } : { width: map.width, height: map.height, data }) };
  };
  return {
    type: 'map', version: '1.10', tiledversion: '1.11.2', orientation: map.orientation, renderorder: 'right-down', infinite: map.infinite,
    width: map.width, height: map.height, tilewidth: map.tileWidth, tileheight: map.tileHeight,
    properties: tiledPropertyJson(map.properties),
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
  const { name, class: className, ...properties } = shape.properties;
  const geometry = shape.type === 'ellipse' ? '<ellipse/>' : shape.type === 'polygon' || shape.type === 'polyline' ? `<${shape.type} points="${(shape.points ?? []).map((point) => `${point.x},${point.y}`).join(' ')}"/>` : '';
  return `<object id="${index + 1}" name="${xml(typeof name === 'string' ? name : '')}" type="${xml(typeof className === 'string' ? className : '')}" x="${shape.x}" y="${shape.y}" width="${shape.width ?? 0}" height="${shape.height ?? 0}">${geometry}${tiledPropertyXml(properties)}</object>`;
}

function tilesetXml(document: PixelDocument, tileset: PixelTileset, image: string): string {
  const sprite = document.pixelAssets[tileset.spriteAssetId];
  const tiles = Object.values(tileset.tiles).filter((tile) => tile.probability !== 1 || tile.animation.length || tile.collisions.length || Object.keys(tile.properties).length).map((tile) => `<tile id="${tile.id}" probability="${tile.probability}">${tiledPropertyXml(tile.properties)}${tile.animation.length ? `<animation>${tile.animation.map((frame) => `<frame tileid="${frame.tileId}" duration="${frame.durationMs}"/>`).join('')}</animation>` : ''}${tile.collisions.length ? `<objectgroup>${tile.collisions.map(collisionXml).join('')}</objectgroup>` : ''}</tile>`).join('');
  const wangsets = tileset.wangSets.length ? `<wangsets>${tileset.wangSets.map((set) => `<wangset name="${xml(set.name)}" type="${set.type}">${set.colors.map((color) => `<wangcolor name="${xml(color.name)}" color="${xml(color.color)}" tile="${color.tileId}" probability="${color.probability}"/>`).join('')}${set.tiles.map((tile) => `<wangtile tileid="${tile.tileId}" wangid="${tile.wangId.join(',')}"/>`).join('')}</wangset>`).join('')}</wangsets>` : '';
  return `<tileset version="1.10" tiledversion="1.11.2" name="${xml(tileset.name)}" tilewidth="${tileset.tileWidth}" tileheight="${tileset.tileHeight}" margin="${tileset.margin}" spacing="${tileset.spacing}" tilecount="${tileset.columns * tileset.rows}" columns="${tileset.columns}"><image source="${xml(image)}" width="${sprite?.type === 'sprite' ? sprite.width : tileset.columns * tileset.tileWidth}" height="${sprite?.type === 'sprite' ? sprite.height : tileset.rows * tileset.tileHeight}"/><transformations hflip="${Number(tileset.transformations.hFlip)}" vflip="${Number(tileset.transformations.vFlip)}" rotate="${Number(tileset.transformations.rotate)}" preferuntransformed="0"/>${tiles}${wangsets}</tileset>`;
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

async function tiled(document: PixelDocument, format: 'tiled-json' | 'tiled-xml'): Promise<ExportArtifact> {
  const active = document.pixelAssets[document.activeAssetId]; if (active?.type !== 'tilemap' && active?.type !== 'tileset') throw new Error('Choose a tilemap or tileset before Tiled export.');
  const tilesets = active.type === 'tilemap' ? active.tilesetIds.map((id) => document.pixelAssets[id]).filter((asset): asset is PixelTileset => asset?.type === 'tileset') : [active]; const images: Record<string, string> = {}; const companions: NonNullable<ExportArtifact['companions']> = [];
  for (const tileset of tilesets) { const sprite = document.pixelAssets[tileset.spriteAssetId]; if (sprite?.type !== 'sprite') continue; const name = safeTiledAssetName(tileset.name, 'png'); images[tileset.id] = name; companions.push({ name, extension: 'png', mimeType: 'image/png', data: renderSprite(document, sprite).toBuffer('image/png') }); }
  if (active.type === 'tileset') {
    const body = format === 'tiled-json' ? JSON.stringify(tilesetJson(document, active, images[active.id]), null, 2) : `<?xml version="1.0" encoding="UTF-8"?>${tilesetXml(document, active, images[active.id] ?? safeTiledAssetName(active.name, 'png'))}`;
    return { data: Buffer.from(body), mimeType: format === 'tiled-json' ? 'application/json' : 'application/xml', extension: format === 'tiled-json' ? 'tsj' : 'tsx', companions, report: { warnings: [], rasterized: [] } };
  }
  const body = format === 'tiled-json' ? JSON.stringify(tilemapToTiled(document, active, images), null, 2) : tilemapXml(document, active, images);
  return { data: Buffer.from(body), mimeType: format === 'tiled-json' ? 'application/json' : 'application/xml', extension: format === 'tiled-json' ? 'tmj' : 'tmx', companions, report: { warnings: [], rasterized: [] } };
}

function animationExportWarnings(sprite: PixelSprite, tagId: string | undefined, scale: number): string[] {
  const tag = tagId ? sprite.tags.find((entry) => entry.id === tagId) : undefined;
  return [...scaleWarnings(scale), ...(tag ? [`Exported animation tag “${tag.name}” using ${tag.direction} playback.`] : [])];
}

async function spriteSheet(document: PixelDocument, sprite: PixelSprite, scale = 1, tagId?: string): Promise<ExportArtifact> {
  const frameIds = pixelAnimationSequence(sprite, tagId); const columns = Math.ceil(Math.sqrt(frameIds.length)); const rows = Math.ceil(frameIds.length / columns);
  assertScaledDimensions(columns * sprite.width, rows * sprite.height, scale);
  const frameWidth = sprite.width * scale; const frameHeight = sprite.height * scale;
  const sheetWidth = columns * frameWidth; const sheetHeight = rows * frameHeight;
  const frames: Record<string, unknown> = {};
  frameIds.forEach((frameId, index) => {
    const x = index % columns * frameWidth; const y = Math.floor(index / columns) * frameHeight;
    const key = frames[frameId] ? `${frameId}#${index}` : frameId; frames[key] = { frame: { x, y, w: frameWidth, h: frameHeight }, sourceFrameId: frameId, sourceSize: { w: sprite.width, h: sprite.height }, scale, duration: sprite.frames[frameId]?.durationMs ?? 100 };
  });
  const firstExact = exactSingleLayerAnimationFrame(document.palette, sprite, frameIds[0]); let exactSheet = firstExact ? new Uint8Array(sheetWidth * sheetHeight * 4) : undefined;
  if (exactSheet) for (let index = 0; index < frameIds.length; index += 1) {
    const frame = index === 0 ? firstExact : exactSingleLayerAnimationFrame(document.palette, sprite, frameIds[index]);
    if (!frame) { exactSheet = undefined; break; }
    const scaled = nearestNeighborFrame(frame, sprite.width, sprite.height, scale); const targetX = index % columns * frameWidth; const targetY = Math.floor(index / columns) * frameHeight;
    for (let y = 0; y < frameHeight; y += 1) exactSheet.set(scaled.subarray(y * frameWidth * 4, (y + 1) * frameWidth * 4), ((targetY + y) * sheetWidth + targetX) * 4);
  }
  let data: Buffer;
  if (exactSheet) data = encodeLosslessRgbaPng(exactSheet, sheetWidth, sheetHeight);
  else {
    const canvas = createCanvas(sheetWidth, sheetHeight); const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
    frameIds.forEach((frameId, index) => context.drawImage(renderSprite(document, sprite, frameId), index % columns * frameWidth, Math.floor(index / columns) * frameHeight, frameWidth, frameHeight)); data = canvas.toBuffer('image/png');
  }
  return { data, mimeType: 'image/png', extension: 'png', companion: { data: Buffer.from(JSON.stringify({ frames, meta: { app: 'AIDraw', image: `${sprite.name}.png`, size: { w: sheetWidth, h: sheetHeight }, scale, frameOrder: frameIds, selectedTagId: tagId, tags: sprite.tags } }, null, 2)), extension: 'json', mimeType: 'application/json' }, report: { warnings: animationExportWarnings(sprite, tagId, scale), rasterized: [] } };
}

async function animatedImage(document: PixelDocument, sprite: PixelSprite, format: 'gif' | 'apng', scale = 1, tagId?: string): Promise<ExportArtifact> {
  assertScaledDimensions(sprite.width, sprite.height, scale);
  const width = sprite.width * scale; const height = sprite.height * scale;
  const frameIds = pixelAnimationSequence(sprite, tagId);
  const delays = frameIds.map((frameId) => sprite.frames[frameId]?.durationMs ?? 100); const warnings = animationExportWarnings(sprite, tagId, scale);
  if (format === 'apng') {
    const frames = frameIds.map((frameId) => {
      const exact = exactSingleLayerAnimationFrame(document.palette, sprite, frameId);
      const rgba = exact ?? renderSprite(document, sprite, frameId).getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data;
      return nearestNeighborFrame(rgba, sprite.width, sprite.height, scale);
    });
    // upng-js sizes its output buffer from the first raw frame and only adds 100
    // bytes total, which truncates tiny animations where per-frame chunk overhead
    // is larger than the pixel payload. A small per-frame reserve on frame zero
    // grows that allocation without changing the encoded image rectangle.
    const inputs = frames.map((frame, index) => { if (index) return frame.buffer as ArrayBuffer; const reserved = new Uint8Array(frame.byteLength + 128); reserved.set(frame); for (let offset = frame.byteLength + 3; offset < reserved.length; offset += 4) reserved[offset] = 255; return reserved.buffer; });
    // The maintained runtime exposes a sixth `forbidPlte` argument, but the
    // DefinitelyTyped declaration still stops at `delays`.
    const encodeApng = UPNG.encode as unknown as (images: ArrayBuffer[], frameWidth: number, frameHeight: number, colors: number, frameDelays?: number[], forbidPalette?: boolean) => ArrayBuffer;
    return { data: Buffer.from(encodeApng(inputs, width, height, 0, delays, true)), mimeType: 'image/apng', extension: 'apng', report: { warnings, rasterized: [] } };
  }
  const exactFrames = frameIds.map((frameId) => exactSingleLayerGifFrame(document.palette, sprite, frameId));
  const encoder = GIFEncoder();
  if (exactFrames.every((frame): frame is NonNullable<typeof frame> => frame !== undefined)) {
    exactFrames.forEach((frame, index) => encoder.writeFrame(nearestNeighborIndexes(frame.indexes, sprite.width, sprite.height, scale), width, height, { palette: frame.palette, transparent: true, transparentIndex: 0, delay: delays[index], repeat: 0 }));
  } else {
    frameIds.forEach((frameId, index) => {
      const frame = nearestNeighborFrame(renderSprite(document, sprite, frameId).getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data, sprite.width, sprite.height, scale);
      const palette = quantize(frame, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true }); encoder.writeFrame(applyPalette(frame, palette, 'rgba4444'), width, height, { palette, transparent: true, transparentIndex: 0, delay: delays[index], repeat: 0 });
    });
  }
  encoder.finish();
  return { data: Buffer.from(encoder.bytes()), mimeType: 'image/gif', extension: 'gif', report: { warnings, rasterized: [] } };
}

const MAX_ANIMATION_EXPANDED_PIXELS = 64 * 1024 * 1024;

async function animatedIllustrationImage(document: IllustrationDocument, format: 'gif' | 'apng'): Promise<ExportArtifact> {
  if (!document.animation.keyframeIds.length) throw new Error('Illustration animation export requires at least one keyframe.');
  assertScaledDimensions(document.artboard.width, document.artboard.height, 1);
  const samples = illustrationAnimationSamples(document.animation, 1_000);
  if (samples.length * document.artboard.width * document.artboard.height > MAX_ANIMATION_EXPANDED_PIXELS) throw new Error('Illustration animation exceeds the 64-megapixel expanded-frame safety budget. Reduce its dimensions, duration, or frame rate.');
  const frames: Uint8Array[] = []; const delays: number[] = [];
  for (const sample of samples) {
    const canvas = await renderIllustration(illustrationAtTime(document, sample.timeMs));
    frames.push(Uint8Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data));
    delays.push(Math.max(10, Math.round(sample.delayMs)));
  }
  const warnings = [`Rasterized ${frames.length} illustration frames at ${document.animation.framesPerSecond} fps using ${document.animation.playback} playback.`];
  if (format === 'apng') {
    const inputs = frames.map((frame, index) => { if (index) return frame.buffer as ArrayBuffer; const reserved = new Uint8Array(frame.byteLength + 128); reserved.set(frame); for (let offset = frame.byteLength + 3; offset < reserved.length; offset += 4) reserved[offset] = 255; return reserved.buffer; });
    const encodeApng = UPNG.encode as unknown as (images: ArrayBuffer[], frameWidth: number, frameHeight: number, colors: number, frameDelays?: number[], forbidPalette?: boolean) => ArrayBuffer;
    return { data: Buffer.from(encodeApng(inputs, document.artboard.width, document.artboard.height, 0, delays, true)), mimeType: 'image/apng', extension: 'apng', report: { warnings, rasterized: ['illustration animation frames'] } };
  }
  const encoder = GIFEncoder();
  frames.forEach((frame, index) => { const palette = quantize(frame, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true }); encoder.writeFrame(applyPalette(frame, palette, 'rgba4444'), document.artboard.width, document.artboard.height, { palette, transparent: true, transparentIndex: 0, delay: delays[index], repeat: index === 0 ? (document.animation.playback === 'once' ? -1 : 0) : undefined }); });
  encoder.finish();
  return { data: Buffer.from(encoder.bytes()), mimeType: 'image/gif', extension: 'gif', report: { warnings, rasterized: ['illustration animation frames'] } };
}

export async function exportDocument(document: AIDrawDocument, format: ExportFormat, options: ExportOptions = {}): Promise<ExportArtifact> {
  const scale = resolveExportScale(document, format, options);
  if (format === 'png' || format === 'jpeg' || format === 'webp') return raster(document, format, scale);
  if (format === 'svg') {
    if (document.kind === 'illustration') return illustrationSvg(document);
    const rasterized = await raster(document, 'png', scale);
    const dimensions = renderDocumentDimensions(document); const width = dimensions.width * scale; const height = dimensions.height * scale;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" shape-rendering="crispEdges"><image width="100%" height="100%" image-rendering="pixelated" href="data:image/png;base64,${rasterized.data.toString('base64')}"/></svg>`;
    return { data: Buffer.from(svg), mimeType: 'image/svg+xml', extension: 'svg', report: { warnings: [...scaleWarnings(scale), 'Pixel SVG export embeds nearest-neighbor raster artwork.'], rasterized: ['pixel artwork'] } };
  }
  if (format === 'pdf') return pdf(document, scale);
  if (format === 'psd') return psd(document);
  if (format === 'gif' || format === 'apng') {
    if (document.kind === 'illustration') return animatedIllustrationImage(document, format);
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Choose a sprite before exporting animation.'); return animatedImage(document, sprite, format, scale, options.animationTagId);
  }
  if (format === 'sprite-sheet') {
    if (document.kind !== 'pixel') throw new Error('Sprite sheet export requires pixel mode.');
    const sprite = document.pixelAssets[document.activeAssetId]; if (sprite?.type !== 'sprite') throw new Error('Choose a sprite before exporting a sprite sheet.');
    return spriteSheet(document, sprite, scale, options.animationTagId);
  }
  if (format === 'tiled-json' || format === 'tiled-xml') { if (document.kind !== 'pixel') throw new Error('Tiled export requires pixel mode.'); return tiled(document, format); }
  throw new Error(`Unsupported export format: ${format}`);
}
