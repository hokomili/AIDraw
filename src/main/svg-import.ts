import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { XMLParser } from 'fast-xml-parser';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createIllustrationDocument,
  MAX_ILLUSTRATION_TEXT_LENGTH,
  nowIso,
  validateDocument,
  type BlendMode,
  type DocumentAsset,
  type GroupObject,
  type ImageObject,
  type IllustrationDocument,
  type IllustrationObject,
  type PaintStyle,
  type PathObject,
  type ShapeObject,
  type StrokeStyle,
  type TextObject,
  type TextStyleRange,
  type Transform,
} from '@aidraw/core';
import { inspectImageHeader, MAX_INLINE_IMAGE_DIMENSION, MAX_INLINE_IMAGE_PIXELS } from './transaction-policy';

type Attributes = Record<string, unknown>;
type Style = Record<string, string>;
type Matrix = [number, number, number, number, number, number];

interface SvgNode {
  tag: string;
  attributes: Attributes;
  children: SvgNode[];
  text?: string;
}

interface CssRule { selectors: string[]; declarations: Style }
interface Bounds { x: number; y: number; width: number; height: number }
interface SvgViewBox { minX: number; minY: number; width: number; height: number }
interface SvgViewportContext { width: number; height: number }

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
const inheritedProperties = new Set(['color', 'fill', 'fill-rule', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'stroke', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'text-anchor', 'visibility']);
const presentationProperties = new Set([...inheritedProperties, 'clip-path', 'display', 'fill-opacity', 'filter', 'marker-end', 'mask', 'mix-blend-mode', 'opacity', 'stroke-opacity', 'text-decoration']);
const blendModes = new Set<BlendMode>(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']);
const supportedGeometry = new Set(['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'text', 'image']);
const MAX_EDITABLE_OBJECTS = 100_000;
const MAX_EMBEDDED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_ILLUSTRATION_TEXT_BOX_SIZE = 1_000_000;
const MAX_ILLUSTRATION_IMAGE_SIZE = 1_000_000;
const MAX_CANONICAL_ENTITY_NAME_LENGTH = 200;
const MAX_CANONICAL_COLOR_SOURCE_LENGTH = 256;
const MAX_CANONICAL_GRADIENT_STOPS = 32;
const MAX_CANONICAL_TEXT_RANGES = 100_000;
const NON_FINITE_SVG_TRANSFORM_ERROR = 'SVG transform produces non-finite canonical geometry.';
const INVALID_CANONICAL_SVG_ERROR = "SVG import produced content outside AIDraw's canonical illustration limits.";

interface AIDrawSvgTextBox { width: number; height: number; lineHeight: number }
interface AIDrawSvgImageCrop {
  displayWidth: number;
  displayHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  crop: { x: number; y: number; width: number; height: number };
}

function nodeFromOrdered(value: Record<string, unknown>): SvgNode | undefined {
  const tag = Object.keys(value).find((key) => key !== ':@');
  if (!tag) return undefined;
  const raw = value[tag];
  if (tag === '#text') return { tag, attributes: {}, children: [], text: String(raw ?? '') };
  const children = Array.isArray(raw) ? raw.map((entry) => nodeFromOrdered(entry as Record<string, unknown>)).filter((entry): entry is SvgNode => Boolean(entry)) : [];
  return { tag, attributes: (value[':@'] as Attributes | undefined) ?? {}, children };
}

function textContent(node: SvgNode): string {
  if (node.tag === '#text') return node.text ?? '';
  return node.children.map(textContent).join('');
}

function numberList(value: unknown): number[] {
  return String(value ?? '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi)?.map(Number).filter(Number.isFinite) ?? [];
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveLength(value: unknown, fallback: number): number {
  const parsed = finite(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function exactFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined;
}

function aidrawSvgTextBox(attributes: Attributes, warnings: Set<string>): AIDrawSvgTextBox | undefined {
  const marker = attributes['data-aidraw-text-box'];
  const fields = [attributes['data-aidraw-text-width'], attributes['data-aidraw-text-height'], attributes['data-aidraw-line-height']];
  if (marker === undefined && fields.every((value) => value === undefined)) return undefined;
  const width = exactFiniteNumber(fields[0]); const height = exactFiniteNumber(fields[1]); const lineHeight = exactFiniteNumber(fields[2]);
  if ((marker !== 1 && marker !== '1') || width === undefined || height === undefined || lineHeight === undefined || width < 0 || width > MAX_ILLUSTRATION_TEXT_BOX_SIZE || height < 0 || height > MAX_ILLUSTRATION_TEXT_BOX_SIZE || lineHeight < 0.1 || lineHeight > 10) {
    warnings.add('Invalid AIDraw SVG text-box metadata was ignored.');
    return undefined;
  }
  return { width, height, lineHeight };
}

function aidrawSvgImageCrop(attributes: Attributes, warnings: Set<string>): AIDrawSvgImageCrop | undefined {
  const marker = attributes['data-aidraw-image-crop'];
  const names = ['display-width', 'display-height', 'source-width', 'source-height', 'crop-x', 'crop-y', 'crop-width', 'crop-height'] as const;
  const fields = names.map((name) => attributes[`data-aidraw-${name}`]);
  if (marker === undefined && fields.every((value) => value === undefined)) return undefined;
  const values = fields.map(exactFiniteNumber);
  const [displayWidth, displayHeight, sourceWidth, sourceHeight, cropX, cropY, cropWidth, cropHeight] = values;
  const positive = [displayWidth, displayHeight, sourceWidth, sourceHeight, cropWidth, cropHeight];
  const valid = (marker === 1 || marker === '1')
    && values.every((value) => value !== undefined)
    && positive.every((value) => value! > 0 && value! <= MAX_ILLUSTRATION_IMAGE_SIZE)
    && cropX! >= 0 && cropX! <= MAX_ILLUSTRATION_IMAGE_SIZE
    && cropY! >= 0 && cropY! <= MAX_ILLUSTRATION_IMAGE_SIZE
    && cropX! + cropWidth! <= sourceWidth!
    && cropY! + cropHeight! <= sourceHeight!;
  if (!valid) {
    warnings.add('Invalid AIDraw SVG image-crop metadata was ignored.');
    return undefined;
  }
  return {
    displayWidth: displayWidth!, displayHeight: displayHeight!, sourceWidth: sourceWidth!, sourceHeight: sourceHeight!,
    crop: { x: cropX!, y: cropY!, width: cropWidth!, height: cropHeight! },
  };
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function translate(x: number, y: number): Matrix { return [1, 0, 0, 1, x, y]; }

function svgViewBox(value: unknown, warnings: Set<string>): SvgViewBox | undefined {
  if (value === undefined) return undefined;
  const source = String(value).trim();
  const pattern = /[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi;
  const values = [...source.matchAll(pattern)].map((match) => Number(match[0]));
  const residue = source.replace(pattern, '').replace(/[\s,]+/g, '');
  if (residue || values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) {
    warnings.add('Invalid SVG viewBox was ignored.');
    return undefined;
  }
  return { minX: values[0], minY: values[1], width: values[2], height: values[3] };
}

function svgViewportMatrix(attributes: Attributes, viewportWidth: number, viewportHeight: number, viewBox: SvgViewBox | undefined, warnings: Set<string>): Matrix {
  if (!viewBox) return IDENTITY_MATRIX;
  const defaultAlignment = { x: 0.5, y: 0.5, mode: 'meet' as const };
  const source = String(attributes.preserveAspectRatio ?? '').trim();
  let alignment: { x: number; y: number; mode: 'meet' | 'slice' | 'none' } = defaultAlignment;
  if (source) {
    const tokens = source.split(/\s+/); if (tokens[0] === 'defer') tokens.shift();
    if (tokens[0] === 'none' && tokens.length === 1) alignment = { x: 0, y: 0, mode: 'none' };
    else {
      const match = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(tokens[0] ?? '');
      const mode = tokens[1] ?? 'meet';
      if (match && tokens.length <= 2 && (mode === 'meet' || mode === 'slice')) {
        const factor = (value: string) => value === 'Min' ? 0 : value === 'Mid' ? 0.5 : 1;
        alignment = { x: factor(match[1]), y: factor(match[2]), mode };
      } else warnings.add('Invalid SVG preserveAspectRatio was reduced to the default xMidYMid meet behavior.');
    }
  }
  const scaleX = viewportWidth / viewBox.width; const scaleY = viewportHeight / viewBox.height;
  const cleanZero = (value: number) => Object.is(value, -0) ? 0 : value;
  if (alignment.mode === 'none') return [scaleX, 0, 0, scaleY, cleanZero(-viewBox.minX * scaleX), cleanZero(-viewBox.minY * scaleY)];
  const scale = alignment.mode === 'slice' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const x = (viewportWidth - viewBox.width * scale) * alignment.x - viewBox.minX * scale;
  const y = (viewportHeight - viewBox.height * scale) * alignment.y - viewBox.minY * scale;
  return [scale, 0, 0, scale, cleanZero(x), cleanZero(y)];
}

function svgViewportValue(value: unknown, reference: number): number | undefined {
  const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(%|px)?$/i.exec(String(value).trim());
  if (!match) return undefined;
  const number = Number(match[1]); const resolved = match[2] === '%' ? number / 100 * reference : number;
  return Number.isFinite(resolved) ? resolved : undefined;
}

function svgViewportLength(value: unknown, reference: number): number | undefined {
  if (value === undefined || String(value).trim() === 'auto') return reference;
  const resolved = svgViewportValue(value, reference);
  return resolved !== undefined && resolved > 0 ? resolved : undefined;
}

function svgViewportCoordinate(value: unknown, reference: number): number | undefined {
  if (value === undefined) return 0;
  return svgViewportValue(value, reference);
}

function matrixIsIdentity(matrix: Matrix): boolean {
  return matrix.every((value, index) => Number.isFinite(value) && Math.abs(value - IDENTITY_MATRIX[index]) <= Number.EPSILON * 16 * Math.max(1, Math.abs(value), Math.abs(IDENTITY_MATRIX[index])));
}

function finiteSvgMatrix(matrix: Matrix): Matrix {
  if (!matrix.every(Number.isFinite)) throw new Error(NON_FINITE_SVG_TRANSFORM_ERROR);
  return matrix;
}

function svgTransform(value: unknown): Matrix {
  let output = IDENTITY_MATRIX;
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  for (const match of String(value ?? '').matchAll(pattern)) {
    if (!['matrix', 'translate', 'scale', 'rotate', 'skewX', 'skewY'].includes(match[1])) continue;
    const args = (match[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (!args.every(Number.isFinite)) throw new Error(NON_FINITE_SVG_TRANSFORM_ERROR);
    let next: Matrix | undefined;
    if (match[1] === 'matrix' && args.length >= 6) next = args.slice(0, 6) as Matrix;
    else if (match[1] === 'translate') next = translate(args[0] ?? 0, args[1] ?? 0);
    else if (match[1] === 'scale') next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (match[1] === 'rotate') {
      const angle = (args[0] ?? 0) * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle); const rotation: Matrix = [cosine, sine, -sine, cosine, 0, 0];
      next = args.length >= 3 ? multiply(multiply(translate(args[1], args[2]), rotation), translate(-args[1], -args[2])) : rotation;
    } else if (match[1] === 'skewX') next = [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0];
    else if (match[1] === 'skewY') next = [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
    if (next) output = finiteSvgMatrix(multiply(output, finiteSvgMatrix(next)));
  }
  return output;
}

function transformFromMatrix(matrix: Matrix): Transform {
  finiteSvgMatrix(matrix);
  const scaleX = Math.hypot(matrix[0], matrix[1]);
  let transform: Transform;
  if (scaleX < 1e-12) transform = { ...IDENTITY_TRANSFORM, x: matrix[4], y: matrix[5], scaleX: 0, scaleY: Math.hypot(matrix[2], matrix[3]) };
  else {
    const cosine = matrix[0] / scaleX; const sine = matrix[1] / scaleX;
    const skew = cosine * matrix[2] + sine * matrix[3];
    const scaleY = -sine * matrix[2] + cosine * matrix[3];
    if (![scaleX, cosine, sine, skew, scaleY].every(Number.isFinite)) throw new Error(NON_FINITE_SVG_TRANSFORM_ERROR);
    transform = { x: matrix[4], y: matrix[5], scaleX, scaleY, rotation: Math.atan2(sine, cosine) * 180 / Math.PI, skewX: Math.atan(skew) * 180 / Math.PI, skewY: 0 };
  }
  if (!Object.values(transform).every(Number.isFinite)) throw new Error(NON_FINITE_SVG_TRANSFORM_ERROR);
  return transform;
}

function declarations(value: unknown): Style {
  const output: Style = {};
  for (const declaration of String(value ?? '').split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const name = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim().replace(/\s*!important\s*$/i, '');
    if (name && propertyValue) output[name] = propertyValue;
  }
  return output;
}

function cssRules(root: SvgNode, warnings: Set<string>): CssRule[] {
  const rules: CssRule[] = [];
  const visit = (node: SvgNode) => {
    if (node.tag === 'style') {
      const css = textContent(node).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1].split(',').map((selector) => selector.trim()).filter(Boolean);
        const simple = selectors.filter((selector) => /^(?:[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+)$/.test(selector));
        if (simple.length !== selectors.length) warnings.add('Complex SVG stylesheet selectors were ignored; tag, class, and ID selectors remain editable.');
        if (simple.length) rules.push({ selectors: simple, declarations: declarations(match[2]) });
      }
    }
    node.children.forEach(visit);
  };
  visit(root);
  return rules;
}

function selectorMatches(selector: string, node: SvgNode): boolean {
  if (selector.startsWith('#')) return String(node.attributes.id ?? '') === selector.slice(1);
  const classes = String(node.attributes.class ?? '').split(/\s+/).filter(Boolean);
  if (selector.startsWith('.')) return classes.includes(selector.slice(1));
  return node.tag.toLowerCase() === selector.toLowerCase();
}

function styleFor(node: SvgNode, parent: Style, rules: CssRule[]): Style {
  const style: Style = Object.fromEntries(Object.entries(parent).filter(([name]) => inheritedProperties.has(name)));
  for (const rule of rules) if (rule.selectors.some((selector) => selectorMatches(selector, node))) Object.assign(style, rule.declarations);
  for (const [name, value] of Object.entries(node.attributes)) if (presentationProperties.has(name.toLowerCase())) style[name.toLowerCase()] = String(value);
  Object.assign(style, declarations(node.attributes.style));
  return style;
}

function percentageCoordinate(value: unknown, origin: number, size: number, fallback: string): number {
  const source = String(value ?? fallback).trim();
  return source.endsWith('%') ? origin + finite(source, 0) / 100 * size : finite(source, origin);
}

function clamp01(value: unknown, fallback = 1): number { return Math.max(0, Math.min(1, finite(value, fallback))); }

function parsePoints(value: unknown): Array<{ x: number; y: number }> {
  const values = numberList(value);
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index + 1 < values.length; index += 2) points.push({ x: values[index], y: values[index + 1] });
  return points;
}

function pathFromPoints(points: Array<{ x: number; y: number }>, closed: boolean): string {
  if (!points.length) return '';
  return `${points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')}${closed ? ' Z' : ''}`;
}

function dataImage(value: unknown): { bytes: Buffer; mimeType: DocumentAsset['mimeType']; width: number; height: number } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(value ?? ''));
  if (!match) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.byteLength > MAX_EMBEDDED_IMAGE_BYTES) throw new Error('Embedded SVG image exceeds the 16 MiB safety limit.');
  const header = inspectImageHeader(bytes);
  if (header.width < 1 || header.height < 1 || header.width > MAX_INLINE_IMAGE_DIMENSION || header.height > MAX_INLINE_IMAGE_DIMENSION || header.width * header.height > MAX_INLINE_IMAGE_PIXELS) throw new Error('Embedded SVG image exceeds the 8192 px / 16 MP safety limit.');
  return { bytes, mimeType: header.mimeType, width: header.width, height: header.height };
}

export interface SvgImportResult { document: IllustrationDocument; warnings: string[] }

export function importEditableSvg(source: string, name: string): SvgImportResult {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: true, parseTagValue: false, preserveOrder: true, processEntities: false, trimValues: false }).parse(source) as Array<Record<string, unknown>>;
  const root = parsed.map(nodeFromOrdered).find((node) => node?.tag === 'svg');
  if (!root) throw new Error('SVG root element was not found.');
  const warnings = new Set<string>();
  const colorCanvas = createCanvas(1, 1); const colorContext = colorCanvas.getContext('2d'); const colorCache = new Map<string, string>();
  const rememberColor = (sourceColor: string, canonical: string): string => { if (colorCache.size < 4_096) colorCache.set(sourceColor, canonical); return canonical; };
  const canonicalColor = (value: string | undefined): string => {
    const sourceColor = String(value ?? '#000000').trim(); const cached = colorCache.get(sourceColor); if (cached) return cached;
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(sourceColor)) return rememberColor(sourceColor, sourceColor.toLowerCase());
    const shorthand = /^#([0-9a-f]{3,4})$/i.exec(sourceColor);
    if (shorthand) return rememberColor(sourceColor, `#${[...shorthand[1]].map((character) => character.repeat(2)).join('').toLowerCase()}`);
    let accepted = false;
    if (sourceColor && sourceColor.length <= MAX_CANONICAL_COLOR_SOURCE_LENGTH) {
      try {
        colorContext.fillStyle = '#010203'; colorContext.fillStyle = sourceColor; const first = String(colorContext.fillStyle);
        colorContext.fillStyle = '#040506'; colorContext.fillStyle = sourceColor; accepted = first === String(colorContext.fillStyle);
      } catch { accepted = false; }
    }
    if (!accepted) {
      warnings.add('Unsupported SVG color was replaced with canonical black.');
      return rememberColor(sourceColor, '#000000');
    }
    colorContext.clearRect(0, 0, 1, 1); colorContext.globalAlpha = 1; colorContext.globalCompositeOperation = 'source-over'; colorContext.fillStyle = sourceColor; colorContext.fillRect(0, 0, 1, 1);
    const channels = colorContext.getImageData(0, 0, 1, 1).data; const hex = (channel: number) => channel.toString(16).padStart(2, '0');
    return rememberColor(sourceColor, `#${hex(channels[0])}${hex(channels[1])}${hex(channels[2])}${channels[3] === 255 ? '' : hex(channels[3])}`);
  };
  const boundedName = (value: unknown, fallback: string): string => {
    const sourceName = String(value ?? '') || fallback;
    if (sourceName.length <= MAX_CANONICAL_ENTITY_NAME_LENGTH) return sourceName;
    warnings.add('SVG names longer than 200 characters were truncated for editable import.');
    return sourceName.slice(0, MAX_CANONICAL_ENTITY_NAME_LENGTH);
  };
  const boundedFontFamily = (value: string | undefined): string => {
    const sourceFamily = value?.trim() || 'sans-serif';
    if (sourceFamily.length <= MAX_CANONICAL_ENTITY_NAME_LENGTH) return sourceFamily;
    warnings.add('SVG font-family values longer than 200 characters were truncated for editable import.');
    return sourceFamily.slice(0, MAX_CANONICAL_ENTITY_NAME_LENGTH);
  };
  const viewBox = svgViewBox(root.attributes.viewBox, warnings);
  const width = Math.ceil(positiveLength(root.attributes.width, viewBox?.width || 1920));
  const height = Math.ceil(positiveLength(root.attributes.height, viewBox?.height || 1080));
  if (width > MAX_INLINE_IMAGE_DIMENSION || height > MAX_INLINE_IMAGE_DIMENSION || width * height > MAX_INLINE_IMAGE_PIXELS) throw new Error(`SVG artboard dimensions ${width}×${height} exceed AIDraw's 8192px/16MP import limit.`);
  const viewportMatrix = svgViewportMatrix(root.attributes, width, height, viewBox, warnings);
  if (!viewportMatrix.every(Number.isFinite)) throw new Error('SVG viewBox produces a non-finite viewport transform.');

  const document = createIllustrationDocument(name);
  document.artboard = { ...document.artboard, width, height, background: null };
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
  if (!layer || layer.type !== 'vector') throw new Error('Illustration vector layer is missing.');
  const rules = cssRules(root, warnings);
  const idNodes = new Map<string, SvgNode>();
  const index = (node: SvgNode) => { const id = String(node.attributes.id ?? ''); if (id) idNodes.set(id, node); node.children.forEach(index); };
  index(root);
  let objectCount = 0;
  const maskObjects = new Map<string, string>();

  const base = (node: SvgNode, style: Style, matrix: Matrix, fallbackName: string) => {
    objectCount += 1;
    if (objectCount > MAX_EDITABLE_OBJECTS) throw new Error(`SVG exceeds the ${MAX_EDITABLE_OBJECTS.toLocaleString('en-US')} editable-object limit.`);
    const timestamp = nowIso(); const mode = style['mix-blend-mode'] as BlendMode | undefined;
    return {
      id: createId('object'), revision: 0, name: boundedName(node.attributes['aria-label'] ?? node.attributes.id, fallbackName), createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: style.display !== 'none' && style.visibility !== 'hidden', locked: false, opacity: clamp01(style.opacity), blendMode: mode && blendModes.has(mode) ? mode : 'normal' as BlendMode,
      transform: transformFromMatrix(matrix),
    };
  };

  const add = <T extends IllustrationObject>(object: T): T => { document.objects[object.id] = object; layer.objectIds.push(object.id); return object; };

  const gradient = (id: string, bounds: Bounds, stack = new Set<string>()): PaintStyle | undefined => {
    if (stack.has(id)) { warnings.add('A cyclic SVG gradient reference was ignored.'); return undefined; }
    const node = idNodes.get(id); if (!node || !['linearGradient', 'radialGradient'].includes(node.tag)) return undefined;
    const nextStack = new Set(stack); nextStack.add(id);
    const href = String(node.attributes.href ?? node.attributes['xlink:href'] ?? '').replace(/^#/, '');
    const inherited = href ? idNodes.get(href) : undefined;
    const attributes = { ...(inherited?.attributes ?? {}), ...node.attributes };
    const stopNodes = node.children.filter((child) => child.tag === 'stop');
    const sourceStops = stopNodes.length ? stopNodes : inherited?.children.filter((child) => child.tag === 'stop') ?? [];
    if (sourceStops.length > MAX_CANONICAL_GRADIENT_STOPS) throw new Error(INVALID_CANONICAL_SVG_ERROR);
    const stops = sourceStops.map((stop, stopIndex) => {
      const stopStyle = { ...declarations(stop.attributes.style), ...Object.fromEntries(Object.entries(stop.attributes).map(([key, value]) => [key, String(value)])) };
      const offsetSource = String(stopStyle.offset ?? (sourceStops.length <= 1 ? 0 : stopIndex / (sourceStops.length - 1)));
      const offset = clamp01(offsetSource.endsWith('%') ? finite(offsetSource) / 100 : offsetSource, stopIndex / Math.max(1, sourceStops.length - 1));
      return { offset, color: canonicalColor(stopStyle['stop-color']), opacity: clamp01(stopStyle['stop-opacity']) };
    });
    if (!stops.length && href) return gradient(href, bounds, nextStack);
    if (!stops.length) stops.push({ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 });
    else if (stops.length === 1) stops.splice(0, 1, { ...stops[0], offset: 0 }, { ...stops[0], offset: 1 });
    const units = String(attributes.gradientUnits ?? 'objectBoundingBox');
    const box = units === 'userSpaceOnUse' ? { x: 0, y: 0, width, height } : bounds;
    const transform = svgTransform(attributes.gradientTransform);
    const apply = (x: number, y: number) => ({ x: transform[0] * x + transform[2] * y + transform[4], y: transform[1] * x + transform[3] * y + transform[5] });
    if (attributes.spreadMethod && attributes.spreadMethod !== 'pad') warnings.add('SVG gradient spread methods repeat/reflect were reduced to pad.');
    if (node.tag === 'linearGradient') {
      const start = apply(percentageCoordinate(attributes.x1, box.x, box.width, '0%'), percentageCoordinate(attributes.y1, box.y, box.height, '0%'));
      const end = apply(percentageCoordinate(attributes.x2, box.x, box.width, '100%'), percentageCoordinate(attributes.y2, box.y, box.height, '0%'));
      if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw new Error(NON_FINITE_SVG_TRANSFORM_ERROR);
      return { kind: 'linear-gradient', stops, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
    }
    const centerX = percentageCoordinate(attributes.cx, box.x, box.width, '50%'); const centerY = percentageCoordinate(attributes.cy, box.y, box.height, '50%');
    const radius = units === 'userSpaceOnUse' ? finite(attributes.r, Math.min(width, height) / 2) : percentageCoordinate(attributes.r, 0, Math.min(box.width, box.height), '50%');
    const center = apply(centerX, centerY); const edge = apply(centerX + radius, centerY);
    if (![center.x, center.y, edge.x, edge.y].every(Number.isFinite)) throw new Error(NON_FINITE_SVG_TRANSFORM_ERROR);
    if (attributes.fx !== undefined || attributes.fy !== undefined) warnings.add('Off-center SVG radial-gradient focal points were reduced to centered AIDraw gradients.');
    return { kind: 'radial-gradient', stops, x1: center.x, y1: center.y, x2: edge.x, y2: edge.y };
  };

  const paint = (value: string | undefined, bounds: Bounds, fallback: string, currentColor = '#000000'): PaintStyle => {
    const sourceValue = value ?? fallback;
    if (sourceValue === 'none') return { kind: 'none' };
    const reference = /^url\(\s*#([^\s)]+)\s*\)$/.exec(sourceValue);
    if (reference) return gradient(reference[1], bounds) ?? (warnings.add(`Unsupported SVG paint server #${reference[1]} was replaced with black.`), { kind: 'solid', color: '#000000' });
    return { kind: 'solid', color: canonicalColor(sourceValue === 'currentColor' ? currentColor : sourceValue) };
  };

  const stroke = (style: Style, bounds: Bounds): StrokeStyle => {
    const lineCap = ['butt', 'round', 'square'].includes(style['stroke-linecap']) ? style['stroke-linecap'] as StrokeStyle['lineCap'] : 'butt';
    const lineJoin = ['miter', 'round', 'bevel'].includes(style['stroke-linejoin']) ? style['stroke-linejoin'] as StrokeStyle['lineJoin'] : 'miter';
    const sourcePaint = style.stroke === 'currentColor' ? style.color ?? '#000000' : style.stroke;
    return { paint: paint(sourcePaint, bounds, 'none', style.color), width: Math.max(0, finite(style['stroke-width'], 1)), opacity: clamp01(style['stroke-opacity']), lineCap, lineJoin, dash: numberList(style['stroke-dasharray']) };
  };

  const blurFor = (style: Style): number | undefined => {
    const reference = /^url\(\s*#([^\s)]+)\s*\)$/.exec(style.filter ?? '');
    if (!reference) return undefined;
    const filter = idNodes.get(reference[1]); const gaussian = filter?.children.find((child) => child.tag === 'feGaussianBlur');
    if (!gaussian) { warnings.add(`SVG filter #${reference[1]} could not be represented and was omitted.`); return undefined; }
    return Math.max(0, numberList(gaussian.attributes.stdDeviation)[0] ?? 0);
  };

  const firstGeometry = (node: SvgNode, parentStyle: Style, prefix: Matrix, depth: number): IllustrationObject | undefined => {
    if (depth > 64) throw new Error('SVG nesting exceeds the 64-level safety limit.');
    if (node.tag === '#text' || node.tag === 'title' || node.tag === 'desc' || node.tag === 'metadata' || node.tag === 'style') return undefined;
    const style = styleFor(node, parentStyle, rules);
    const matrix = finiteSvgMatrix(multiply(prefix, svgTransform(node.attributes.transform)));
    void transformFromMatrix(matrix);
    if (supportedGeometry.has(node.tag)) return element(node, style, matrix, true);
    for (const child of node.children) { const result = firstGeometry(child, style, matrix, depth + 1); if (result) return result; }
    return undefined;
  };

  const maskFor = (reference: string): string | undefined => {
    const id = reference.replace(/^url\(\s*#|\s*\)$/g, '');
    if (maskObjects.has(id)) return maskObjects.get(id);
    const definition = idNodes.get(id); if (!definition) { warnings.add(`SVG clip or mask #${id} was not found.`); return undefined; }
    const before = objectCount;
    const object = firstGeometry(definition, {}, IDENTITY_MATRIX, 0);
    if (!object) { warnings.add(`SVG clip or mask #${id} contains no supported path geometry.`); return undefined; }
    object.visible = false; object.name = boundedName(`Mask · ${id}`, 'Mask'); maskObjects.set(id, object.id);
    if (objectCount - before > 1 || definition.children.filter((child) => supportedGeometry.has(child.tag)).length > 1) warnings.add('Multi-shape SVG clips/masks currently use their first editable geometry.');
    if (definition.tag === 'mask') warnings.add('SVG luminance/alpha masks were approximated with editable clipping geometry.');
    return object.id;
  };

  const finish = <T extends IllustrationObject>(object: T, style: Style, asMask: boolean): T => {
    object.blur = blurFor(style);
    const clip = style['clip-path'] ?? (style.mask as string | undefined);
    if (!asMask && clip) object.maskObjectId = maskFor(clip);
    if (style['fill-opacity'] !== undefined && style['fill-opacity'] !== '1') warnings.add('Per-fill SVG opacity is approximated by object/gradient opacity where possible.');
    return add(object);
  };

  const aidrawCroppedImage = (node: SvgNode, style: Style, matrix: Matrix, crop: AIDrawSvgImageCrop): ImageObject | undefined => {
    const meaningfulChildren = node.children.filter((child) => child.tag !== '#text' || Boolean(child.text?.trim()));
    const clipNodes = meaningfulChildren.filter((child) => child.tag === 'clipPath');
    const imageNodes = meaningfulChildren.filter((child) => child.tag === 'image');
    if (meaningfulChildren.length !== 2 || clipNodes.length !== 1 || imageNodes.length !== 1) return undefined;
    const clipNode = clipNodes[0]; const imageNode = imageNodes[0];
    const clipChildren = clipNode.children.filter((child) => child.tag !== '#text' || Boolean(child.text?.trim()));
    if (clipChildren.length !== 1 || clipChildren[0].tag !== 'rect') return undefined;
    const rectNode = clipChildren[0]; const clipId = String(clipNode.attributes.id ?? '');
    const clipReference = String(imageNode.attributes['clip-path'] ?? '');
    const exactKeys = (attributes: Attributes, allowed: Set<string>) => Object.keys(attributes).every((key) => allowed.has(key));
    if (!clipId
      || clipReference !== `url(#${clipId})`
      || !exactKeys(clipNode.attributes, new Set(['id']))
      || !exactKeys(rectNode.attributes, new Set(['width', 'height']))
      || !exactKeys(imageNode.attributes, new Set(['clip-path', 'x', 'y', 'width', 'height', 'preserveAspectRatio', 'href']))
      || imageNode.attributes.preserveAspectRatio !== 'none') return undefined;
    const numeric = [rectNode.attributes.width, rectNode.attributes.height, imageNode.attributes.x, imageNode.attributes.y, imageNode.attributes.width, imageNode.attributes.height].map(exactFiniteNumber);
    if (numeric.some((value) => value === undefined)) return undefined;
    const [rectWidth, rectHeight, imageX, imageY, imageWidth, imageHeight] = numeric as number[];
    const scaleX = crop.displayWidth / crop.crop.width; const scaleY = crop.displayHeight / crop.crop.height;
    const expected = [crop.displayWidth, crop.displayHeight, -crop.crop.x * scaleX, -crop.crop.y * scaleY, crop.sourceWidth * scaleX, crop.sourceHeight * scaleY];
    const nearlyEqual = (left: number, right: number) => Math.abs(left - right) <= Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right));
    if (![rectWidth, rectHeight, imageX, imageY, imageWidth, imageHeight].every((value, index) => nearlyEqual(value, expected[index]))) return undefined;
    const embedded = dataImage(imageNode.attributes.href);
    if (!embedded) return undefined;
    const assetId = createId('asset');
    const asset: DocumentAsset = { id: assetId, name: String(node.attributes['aria-label'] ?? node.attributes.id ?? 'Embedded SVG image'), mimeType: embedded.mimeType, byteLength: embedded.bytes.byteLength, sha256: createHash('sha256').update(embedded.bytes).digest('hex'), source: 'imported', data: embedded.bytes.toString('base64') };
    document.assets[asset.id] = asset;
    const object: ImageObject = {
      ...base(node, style, matrix, 'Image'),
      type: 'image', assetId, width: crop.displayWidth, height: crop.displayHeight, sourceWidth: crop.sourceWidth, sourceHeight: crop.sourceHeight, crop: crop.crop, filters: [],
    };
    return finish(object, style, false);
  };

  function element(node: SvgNode, style: Style, matrix: Matrix, asMask = false, visualPrefix: Matrix = IDENTITY_MATRIX): IllustrationObject | undefined {
    const visuallyFinite = (local: Matrix): Matrix => { finiteSvgMatrix(multiply(visualPrefix, local)); return local; };
    if (node.tag === 'rect') {
      const objectWidth = Math.max(0, finite(node.attributes.width)); const objectHeight = Math.max(0, finite(node.attributes.height)); const bounds = { x: 0, y: 0, width: objectWidth, height: objectHeight };
      const object: ShapeObject = { ...base(node, style, visuallyFinite(multiply(matrix, translate(finite(node.attributes.x), finite(node.attributes.y)))), 'Rectangle'), type: 'shape', shape: 'rectangle', width: objectWidth, height: objectHeight, cornerRadius: Math.max(0, finite(node.attributes.rx ?? node.attributes.ry)), fill: paint(style.fill, bounds, '#000000', style.color), stroke: stroke(style, bounds) };
      return finish(object, style, asMask);
    }
    if (node.tag === 'ellipse' || node.tag === 'circle') {
      const radiusX = Math.max(0, finite(node.attributes.rx ?? node.attributes.r)); const radiusY = Math.max(0, finite(node.attributes.ry ?? node.attributes.r)); const bounds = { x: 0, y: 0, width: radiusX * 2, height: radiusY * 2 };
      const object: ShapeObject = { ...base(node, style, visuallyFinite(multiply(matrix, translate(finite(node.attributes.cx, radiusX) - radiusX, finite(node.attributes.cy, radiusY) - radiusY))), 'Ellipse'), type: 'shape', shape: 'ellipse', width: radiusX * 2, height: radiusY * 2, fill: paint(style.fill, bounds, '#000000', style.color), stroke: stroke(style, bounds) };
      return finish(object, style, asMask);
    }
    if (node.tag === 'line') {
      const x1 = finite(node.attributes.x1); const y1 = finite(node.attributes.y1); const objectWidth = finite(node.attributes.x2) - x1; const objectHeight = finite(node.attributes.y2) - y1; const bounds = { x: 0, y: 0, width: Math.abs(objectWidth), height: Math.abs(objectHeight) };
      const arrow = Boolean(style['marker-end'] ?? node.attributes['marker-end']);
      const direction: Matrix = [objectWidth < 0 ? -1 : 1, 0, 0, objectHeight < 0 ? -1 : 1, 0, 0];
      const lineMatrix = multiply(multiply(matrix, translate(x1, y1)), direction);
      const object: ShapeObject = { ...base(node, style, visuallyFinite(lineMatrix), arrow ? 'Arrow' : 'Line'), type: 'shape', shape: arrow ? 'arrow' : 'line', width: Math.abs(objectWidth), height: Math.abs(objectHeight), fill: { kind: 'none' }, stroke: stroke(style, bounds) };
      return finish(object, style, asMask);
    }
    if (node.tag === 'path' || node.tag === 'polygon' || node.tag === 'polyline') {
      const pathData = node.tag === 'path' ? String(node.attributes.d ?? '') : pathFromPoints(parsePoints(node.attributes.points), node.tag === 'polygon');
      if (!pathData.trim()) return undefined;
      const bounds = { x: 0, y: 0, width, height };
      const object: PathObject = { ...base(node, style, visuallyFinite(matrix), node.tag === 'path' ? 'Path' : node.tag === 'polygon' ? 'Polygon' : 'Polyline'), type: 'path', pathData, closed: node.tag === 'polygon' || /[zZ]\s*$/.test(pathData), fill: paint(style.fill, bounds, node.tag === 'polyline' ? 'none' : '#000000', style.color), stroke: stroke(style, bounds), fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero' };
      if (style.fill?.startsWith('url(')) warnings.add('Object-bounding-box gradients on arbitrary SVG paths use the artboard as a conservative editable bound.');
      return finish(object, style, asMask);
    }
    if (node.tag === 'image') {
      const objectMatrix = visuallyFinite(multiply(matrix, translate(finite(node.attributes.x), finite(node.attributes.y))));
      const href = node.attributes.href ?? node.attributes['xlink:href']; const embedded = dataImage(href);
      if (!embedded) { warnings.add('External or unsupported SVG image references were omitted; embed PNG/JPEG/WebP/GIF data to retain editability.'); return undefined; }
      const assetId = createId('asset'); const asset: DocumentAsset = { id: assetId, name: String(node.attributes.id ?? 'Embedded SVG image'), mimeType: embedded.mimeType, byteLength: embedded.bytes.byteLength, sha256: createHash('sha256').update(embedded.bytes).digest('hex'), source: 'imported', data: embedded.bytes.toString('base64') }; document.assets[asset.id] = asset;
      const objectWidth = positiveLength(node.attributes.width, embedded.width); const objectHeight = positiveLength(node.attributes.height, embedded.height);
      const object = { ...base(node, style, objectMatrix, 'Image'), type: 'image' as const, assetId, width: objectWidth, height: objectHeight, sourceWidth: embedded.width, sourceHeight: embedded.height, filters: [] };
      if (node.attributes.preserveAspectRatio && node.attributes.preserveAspectRatio !== 'none') warnings.add('SVG image preserveAspectRatio is represented by the editable image box and may require crop adjustment.');
      return finish(object, style, asMask);
    }
    if (node.tag === 'text') {
      const ranges: TextStyleRange[] = []; let content = '';
      const appendText = (text: string, rangeStyle: Style) => {
        if (!text) return;
        if (content.length + text.length > MAX_ILLUSTRATION_TEXT_LENGTH || ranges.length >= MAX_CANONICAL_TEXT_RANGES) throw new Error(INVALID_CANONICAL_SVG_ERROR);
        const start = content.length; content += text; const fontSize = Math.max(1, finite(rangeStyle['font-size'], 48)); const fill = rangeStyle.fill === 'currentColor' ? rangeStyle.color ?? '#000000' : rangeStyle.fill;
        ranges.push({ start, end: content.length, fontFamily: boundedFontFamily(rangeStyle['font-family']), fontSize, fontWeight: Math.max(1, finite(rangeStyle['font-weight'], 400)), fontStyle: rangeStyle['font-style'] === 'italic' ? 'italic' : 'normal', color: canonicalColor(fill), letterSpacing: finite(rangeStyle['letter-spacing']), underline: rangeStyle['text-decoration']?.includes('underline') });
      };
      const collect = (value: SvgNode, inherited: Style) => { const current = styleFor(value, inherited, rules); if (value.tag === '#text') appendText(value.text ?? '', current); else value.children.forEach((child) => collect(child, current)); };
      node.children.forEach((child) => collect(child, style));
      if (!content) content = textContent(node);
      const fontSize = ranges[0]?.fontSize ?? Math.max(1, finite(style['font-size'], 48)); if (!ranges.length) appendText(content, style);
      const aidrawBox = aidrawSvgTextBox(node.attributes, warnings);
      const textWidth = aidrawBox?.width ?? positiveLength(node.attributes.width, Math.max(1, content.length * fontSize * 0.62)); const textHeight = aidrawBox?.height ?? positiveLength(node.attributes.height, fontSize * 1.3); const anchor = style['text-anchor']; const x = finite(node.attributes.x) - (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0);
      const object: TextObject = { ...base(node, style, visuallyFinite(multiply(matrix, translate(x, finite(node.attributes.y) - fontSize))), 'Text'), type: 'text', text: content, width: textWidth, height: textHeight, align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left', lineHeight: aidrawBox?.lineHeight ?? 1.2, ranges };
      if (node.children.some((child) => child.tag === 'tspan' && (child.attributes.x !== undefined || child.attributes.y !== undefined || child.attributes.dx !== undefined || child.attributes.dy !== undefined))) warnings.add('Per-tspan SVG positioning was reduced to contiguous styled text ranges.');
      return finish(object, style, asMask);
    }
    return undefined;
  }

  const viewportChildren = (childIds: string[], matrix: Matrix, name: string): string[] => {
    if (matrixIsIdentity(matrix)) return childIds;
    const wrapperNode: SvgNode = { tag: 'g', attributes: {}, children: [] };
    const wrapper: GroupObject = { ...base(wrapperNode, {}, matrix, name), type: 'group', childIds };
    return [finish(wrapper, {}, false).id];
  };

  const process = (node: SvgNode, parentStyle: Style, depth: number, viewport: SvgViewportContext, visualPrefix: Matrix, useStack = new Set<string>()): string[] => {
    if (depth > 64) throw new Error('SVG nesting exceeds the 64-level safety limit.');
    if (node.tag === '#text' || node.tag === 'defs' || node.tag === 'style' || node.tag === 'symbol' || ['linearGradient', 'radialGradient', 'filter', 'clipPath', 'mask', 'marker'].includes(node.tag)) return [];
    if (!supportedGeometry.has(node.tag) && node.tag !== 'use' && node.tag !== 'g' && node.tag !== 'svg') {
      if (node.tag !== 'title' && node.tag !== 'desc' && node.tag !== 'metadata') warnings.add(`Unsupported SVG <${node.tag}> content was omitted.`);
      return [];
    }
    const style = styleFor(node, parentStyle, rules);
    const nodeTransform = svgTransform(node.attributes.transform);
    void transformFromMatrix(nodeTransform);
    const nodeVisual = finiteSvgMatrix(multiply(visualPrefix, nodeTransform));
    if (node.tag === 'use') {
      const x = svgViewportCoordinate(node.attributes.x, viewport.width); const y = svgViewportCoordinate(node.attributes.y, viewport.height);
      if (x === undefined || y === undefined) warnings.add('Invalid SVG <use> position was reduced to the origin.');
      const useTransform = finiteSvgMatrix(multiply(nodeTransform, translate(x ?? 0, y ?? 0)));
      void transformFromMatrix(useTransform);
      const useVisual = finiteSvgMatrix(multiply(visualPrefix, useTransform));
      const reference = String(node.attributes.href ?? node.attributes['xlink:href'] ?? '').replace(/^#/, '');
      if (!reference || useStack.has(reference) || !idNodes.has(reference)) { warnings.add('An unresolved or cyclic SVG <use> reference was omitted.'); return []; }
      const nextStack = new Set(useStack); nextStack.add(reference); const sourceNode = idNodes.get(reference)!;
      let childIds: string[];
      if (sourceNode.tag === 'symbol') {
        const viewportWidth = svgViewportLength(node.attributes.width, viewport.width); const viewportHeight = svgViewportLength(node.attributes.height, viewport.height);
        if (viewportWidth === undefined || viewportHeight === undefined) { warnings.add('An SVG <use> symbol with invalid or zero viewport dimensions was omitted.'); return []; }
        const viewBox = svgViewBox(sourceNode.attributes.viewBox, warnings);
        const viewportMatrix = svgViewportMatrix(sourceNode.attributes, viewportWidth, viewportHeight, viewBox, warnings);
        if (!viewportMatrix.every(Number.isFinite)) { warnings.add('An SVG <use> symbol with an invalid viewport transform was omitted.'); return []; }
        const symbolTransform = svgTransform(sourceNode.attributes.transform);
        void transformFromMatrix(symbolTransform);
        const symbolVisual = finiteSvgMatrix(multiply(useVisual, symbolTransform));
        const childVisual = finiteSvgMatrix(multiply(symbolVisual, viewportMatrix));
        const childViewport = { width: viewBox?.width ?? viewportWidth, height: viewBox?.height ?? viewportHeight };
        const symbolStyle = styleFor(sourceNode, style, rules);
        const symbolChildren = sourceNode.children.flatMap((child) => process(child, symbolStyle, depth + 1, childViewport, childVisual, nextStack));
        if (!symbolChildren.length) return [];
        const mappedChildren = viewportChildren(symbolChildren, viewportMatrix, 'Symbol ViewBox');
        const symbol: GroupObject = { ...base(sourceNode, symbolStyle, symbolTransform, 'Symbol'), type: 'group', childIds: mappedChildren };
        childIds = [finish(symbol, symbolStyle, false).id];
        warnings.add('Nested SVG/symbol overflow clipping is not represented; transformed content remains editable outside its viewport.');
      } else childIds = process(sourceNode, style, depth + 1, viewport, useVisual, nextStack);
      if (!childIds.length) return [];
      const group: GroupObject = { ...base(node, style, useTransform, 'Use'), type: 'group', childIds };
      return [finish(group, style, false).id];
    }
    if (node.tag === 'g') {
      const crop = aidrawSvgImageCrop(node.attributes, warnings);
      if (crop) {
        const image = aidrawCroppedImage(node, style, nodeTransform, crop);
        if (image) return [image.id];
        warnings.add('AIDraw SVG image-crop metadata did not match its standard SVG crop and was ignored.');
      }
      const childIds = node.children.flatMap((child) => process(child, style, depth + 1, viewport, nodeVisual, useStack));
      if (!childIds.length) return [];
      const group: GroupObject = { ...base(node, style, nodeTransform, 'Group'), type: 'group', childIds };
      return [finish(group, style, false).id];
    }
    if (node.tag === 'svg') {
      const viewportWidth = svgViewportLength(node.attributes.width, viewport.width); const viewportHeight = svgViewportLength(node.attributes.height, viewport.height);
      if (viewportWidth === undefined || viewportHeight === undefined) { warnings.add('A nested SVG with invalid or zero viewport dimensions was omitted.'); return []; }
      const x = svgViewportCoordinate(node.attributes.x, viewport.width); const y = svgViewportCoordinate(node.attributes.y, viewport.height);
      if (x === undefined || y === undefined) warnings.add('Invalid nested SVG viewport position was reduced to the origin.');
      const nestedTransform = finiteSvgMatrix(multiply(nodeTransform, translate(x ?? 0, y ?? 0)));
      void transformFromMatrix(nestedTransform);
      const nestedVisual = finiteSvgMatrix(multiply(visualPrefix, nestedTransform));
      const viewBox = svgViewBox(node.attributes.viewBox, warnings);
      const viewportMatrix = svgViewportMatrix(node.attributes, viewportWidth, viewportHeight, viewBox, warnings);
      if (!viewportMatrix.every(Number.isFinite)) { warnings.add('A nested SVG with an invalid viewport transform was omitted.'); return []; }
      const childVisual = finiteSvgMatrix(multiply(nestedVisual, viewportMatrix));
      const childViewport = { width: viewBox?.width ?? viewportWidth, height: viewBox?.height ?? viewportHeight };
      const childIds = node.children.flatMap((child) => process(child, style, depth + 1, childViewport, childVisual, useStack));
      if (!childIds.length) return [];
      const mappedChildren = viewportChildren(childIds, viewportMatrix, 'Nested SVG ViewBox');
      const group: GroupObject = { ...base(node, style, nestedTransform, 'SVG viewport'), type: 'group', childIds: mappedChildren };
      warnings.add('Nested SVG/symbol overflow clipping is not represented; transformed content remains editable outside its viewport.');
      return [finish(group, style, false).id];
    }
    const object = element(node, style, nodeTransform, false, visualPrefix);
    if (object) return [object.id];
    warnings.add(`Unsupported SVG <${node.tag}> content was omitted.`);
    return [];
  };

  const rootStyle = styleFor(root, {}, rules);
  const topLevel = root.children.flatMap((child) => process(child, rootStyle, 0, { width, height }, viewportMatrix));
  if (!matrixIsIdentity(viewportMatrix) && topLevel.length) {
    const wrapperNode: SvgNode = { tag: 'g', attributes: {}, children: [] };
    const wrapper: GroupObject = { ...base(wrapperNode, rootStyle, viewportMatrix, 'ViewBox'), type: 'group', childIds: topLevel };
    finish(wrapper, rootStyle, false);
  }
  document.dirty = true;
  try {
    const canonical = validateDocument(document);
    if (canonical.kind !== 'illustration') throw new Error(INVALID_CANONICAL_SVG_ERROR);
    return { document: canonical, warnings: [...warnings] };
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_CANONICAL_SVG_ERROR) throw error;
    throw new Error(INVALID_CANONICAL_SVG_ERROR);
  }
}
