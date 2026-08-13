import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createIllustrationDocument,
  nowIso,
  type BlendMode,
  type DocumentAsset,
  type GroupObject,
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

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
const inheritedProperties = new Set(['color', 'fill', 'fill-rule', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'stroke', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'text-anchor', 'visibility']);
const presentationProperties = new Set([...inheritedProperties, 'clip-path', 'display', 'fill-opacity', 'filter', 'marker-end', 'mask', 'mix-blend-mode', 'opacity', 'stroke-opacity', 'text-decoration']);
const blendModes = new Set<BlendMode>(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']);
const supportedGeometry = new Set(['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'text', 'image']);
const MAX_EDITABLE_OBJECTS = 100_000;
const MAX_EMBEDDED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_ILLUSTRATION_TEXT_BOX_SIZE = 1_000_000;

interface AIDrawSvgTextBox { width: number; height: number; lineHeight: number }

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

function aidrawSvgTextBox(attributes: Attributes, warnings: Set<string>): AIDrawSvgTextBox | undefined {
  const marker = attributes['data-aidraw-text-box'];
  const fields = [attributes['data-aidraw-text-width'], attributes['data-aidraw-text-height'], attributes['data-aidraw-line-height']];
  if (marker === undefined && fields.every((value) => value === undefined)) return undefined;
  const exactNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined;
  };
  const width = exactNumber(fields[0]); const height = exactNumber(fields[1]); const lineHeight = exactNumber(fields[2]);
  if ((marker !== 1 && marker !== '1') || width === undefined || height === undefined || lineHeight === undefined || width < 0 || width > MAX_ILLUSTRATION_TEXT_BOX_SIZE || height < 0 || height > MAX_ILLUSTRATION_TEXT_BOX_SIZE || lineHeight < 0.1 || lineHeight > 10) {
    warnings.add('Invalid AIDraw SVG text-box metadata was ignored.');
    return undefined;
  }
  return { width, height, lineHeight };
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

function svgTransform(value: unknown): Matrix {
  let output = IDENTITY_MATRIX;
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  for (const match of String(value ?? '').matchAll(pattern)) {
    const args = numberList(match[2]);
    let next: Matrix | undefined;
    if (match[1] === 'matrix' && args.length >= 6) next = args.slice(0, 6) as Matrix;
    else if (match[1] === 'translate') next = translate(args[0] ?? 0, args[1] ?? 0);
    else if (match[1] === 'scale') next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (match[1] === 'rotate') {
      const angle = (args[0] ?? 0) * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle); const rotation: Matrix = [cosine, sine, -sine, cosine, 0, 0];
      next = args.length >= 3 ? multiply(multiply(translate(args[1], args[2]), rotation), translate(-args[1], -args[2])) : rotation;
    } else if (match[1] === 'skewX') next = [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0];
    else if (match[1] === 'skewY') next = [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
    if (next) output = multiply(output, next);
  }
  return output;
}

function transformFromMatrix(matrix: Matrix): Transform {
  const scaleX = Math.hypot(matrix[0], matrix[1]);
  if (scaleX < 1e-12) return { ...IDENTITY_TRANSFORM, x: matrix[4], y: matrix[5], scaleX: 0, scaleY: Math.hypot(matrix[2], matrix[3]) };
  const cosine = matrix[0] / scaleX; const sine = matrix[1] / scaleX;
  const skew = cosine * matrix[2] + sine * matrix[3];
  const scaleY = -sine * matrix[2] + cosine * matrix[3];
  return { x: matrix[4], y: matrix[5], scaleX, scaleY, rotation: Math.atan2(sine, cosine) * 180 / Math.PI, skewX: Math.atan(skew) * 180 / Math.PI, skewY: 0 };
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
  const viewBox = numberList(root.attributes.viewBox);
  const width = Math.ceil(positiveLength(root.attributes.width, viewBox[2] || 1920));
  const height = Math.ceil(positiveLength(root.attributes.height, viewBox[3] || 1080));
  if (width > MAX_INLINE_IMAGE_DIMENSION || height > MAX_INLINE_IMAGE_DIMENSION || width * height > MAX_INLINE_IMAGE_PIXELS) throw new Error(`SVG artboard dimensions ${width}×${height} exceed AIDraw's 8192px/16MP import limit.`);

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
      id: createId('object'), revision: 0, name: String(node.attributes['aria-label'] ?? node.attributes.id ?? fallbackName), createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
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
    const stops = sourceStops.map((stop, stopIndex) => {
      const stopStyle = { ...declarations(stop.attributes.style), ...Object.fromEntries(Object.entries(stop.attributes).map(([key, value]) => [key, String(value)])) };
      const offsetSource = String(stopStyle.offset ?? (sourceStops.length <= 1 ? 0 : stopIndex / (sourceStops.length - 1)));
      const offset = clamp01(offsetSource.endsWith('%') ? finite(offsetSource) / 100 : offsetSource, stopIndex / Math.max(1, sourceStops.length - 1));
      return { offset, color: stopStyle['stop-color'] ?? '#000000', opacity: clamp01(stopStyle['stop-opacity']) };
    });
    if (!stops.length && href) return gradient(href, bounds, nextStack);
    if (!stops.length) stops.push({ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 });
    const units = String(attributes.gradientUnits ?? 'objectBoundingBox');
    const box = units === 'userSpaceOnUse' ? { x: 0, y: 0, width, height } : bounds;
    const transform = svgTransform(attributes.gradientTransform);
    const apply = (x: number, y: number) => ({ x: transform[0] * x + transform[2] * y + transform[4], y: transform[1] * x + transform[3] * y + transform[5] });
    if (attributes.spreadMethod && attributes.spreadMethod !== 'pad') warnings.add('SVG gradient spread methods repeat/reflect were reduced to pad.');
    if (node.tag === 'linearGradient') {
      const start = apply(percentageCoordinate(attributes.x1, box.x, box.width, '0%'), percentageCoordinate(attributes.y1, box.y, box.height, '0%'));
      const end = apply(percentageCoordinate(attributes.x2, box.x, box.width, '100%'), percentageCoordinate(attributes.y2, box.y, box.height, '0%'));
      return { kind: 'linear-gradient', stops, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
    }
    const centerX = percentageCoordinate(attributes.cx, box.x, box.width, '50%'); const centerY = percentageCoordinate(attributes.cy, box.y, box.height, '50%');
    const radius = units === 'userSpaceOnUse' ? finite(attributes.r, Math.min(width, height) / 2) : percentageCoordinate(attributes.r, 0, Math.min(box.width, box.height), '50%');
    const center = apply(centerX, centerY); const edge = apply(centerX + radius, centerY);
    if (attributes.fx !== undefined || attributes.fy !== undefined) warnings.add('Off-center SVG radial-gradient focal points were reduced to centered AIDraw gradients.');
    return { kind: 'radial-gradient', stops, x1: center.x, y1: center.y, x2: edge.x, y2: edge.y };
  };

  const paint = (value: string | undefined, bounds: Bounds, fallback: string): PaintStyle => {
    const sourceValue = value ?? fallback;
    if (sourceValue === 'none') return { kind: 'none' };
    const reference = /^url\(\s*#([^\s)]+)\s*\)$/.exec(sourceValue);
    if (reference) return gradient(reference[1], bounds) ?? (warnings.add(`Unsupported SVG paint server #${reference[1]} was replaced with black.`), { kind: 'solid', color: '#000000' });
    return { kind: 'solid', color: sourceValue === 'currentColor' ? '#000000' : sourceValue };
  };

  const stroke = (style: Style, bounds: Bounds): StrokeStyle => {
    const lineCap = ['butt', 'round', 'square'].includes(style['stroke-linecap']) ? style['stroke-linecap'] as StrokeStyle['lineCap'] : 'butt';
    const lineJoin = ['miter', 'round', 'bevel'].includes(style['stroke-linejoin']) ? style['stroke-linejoin'] as StrokeStyle['lineJoin'] : 'miter';
    return { paint: paint(style.stroke, bounds, 'none'), width: Math.max(0, finite(style['stroke-width'], 1)), opacity: clamp01(style['stroke-opacity']), lineCap, lineJoin, dash: numberList(style['stroke-dasharray']) };
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
    const style = styleFor(node, parentStyle, rules);
    const matrix = multiply(prefix, svgTransform(node.attributes.transform));
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
    object.visible = false; object.name = `Mask · ${id}`; maskObjects.set(id, object.id);
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

  function element(node: SvgNode, style: Style, matrix: Matrix, asMask = false): IllustrationObject | undefined {
    if (node.tag === 'rect') {
      const objectWidth = Math.max(0, finite(node.attributes.width)); const objectHeight = Math.max(0, finite(node.attributes.height)); const bounds = { x: 0, y: 0, width: objectWidth, height: objectHeight };
      const object: ShapeObject = { ...base(node, style, multiply(matrix, translate(finite(node.attributes.x), finite(node.attributes.y))), 'Rectangle'), type: 'shape', shape: 'rectangle', width: objectWidth, height: objectHeight, cornerRadius: Math.max(0, finite(node.attributes.rx ?? node.attributes.ry)), fill: paint(style.fill, bounds, '#000000'), stroke: stroke(style, bounds) };
      return finish(object, style, asMask);
    }
    if (node.tag === 'ellipse' || node.tag === 'circle') {
      const radiusX = Math.max(0, finite(node.attributes.rx ?? node.attributes.r)); const radiusY = Math.max(0, finite(node.attributes.ry ?? node.attributes.r)); const bounds = { x: 0, y: 0, width: radiusX * 2, height: radiusY * 2 };
      const object: ShapeObject = { ...base(node, style, multiply(matrix, translate(finite(node.attributes.cx, radiusX) - radiusX, finite(node.attributes.cy, radiusY) - radiusY)), 'Ellipse'), type: 'shape', shape: 'ellipse', width: radiusX * 2, height: radiusY * 2, fill: paint(style.fill, bounds, '#000000'), stroke: stroke(style, bounds) };
      return finish(object, style, asMask);
    }
    if (node.tag === 'line') {
      const x1 = finite(node.attributes.x1); const y1 = finite(node.attributes.y1); const objectWidth = finite(node.attributes.x2) - x1; const objectHeight = finite(node.attributes.y2) - y1; const bounds = { x: 0, y: 0, width: Math.abs(objectWidth), height: Math.abs(objectHeight) };
      const arrow = Boolean(style['marker-end'] ?? node.attributes['marker-end']);
      const object: ShapeObject = { ...base(node, style, multiply(matrix, translate(x1, y1)), arrow ? 'Arrow' : 'Line'), type: 'shape', shape: arrow ? 'arrow' : 'line', width: objectWidth, height: objectHeight, fill: { kind: 'none' }, stroke: stroke(style, bounds) };
      return finish(object, style, asMask);
    }
    if (node.tag === 'path' || node.tag === 'polygon' || node.tag === 'polyline') {
      const pathData = node.tag === 'path' ? String(node.attributes.d ?? '') : pathFromPoints(parsePoints(node.attributes.points), node.tag === 'polygon');
      if (!pathData.trim()) return undefined;
      const bounds = { x: 0, y: 0, width, height };
      const object: PathObject = { ...base(node, style, matrix, node.tag === 'path' ? 'Path' : node.tag === 'polygon' ? 'Polygon' : 'Polyline'), type: 'path', pathData, closed: node.tag === 'polygon' || /[zZ]\s*$/.test(pathData), fill: paint(style.fill, bounds, node.tag === 'polyline' ? 'none' : '#000000'), stroke: stroke(style, bounds), fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero' };
      if (style.fill?.startsWith('url(')) warnings.add('Object-bounding-box gradients on arbitrary SVG paths use the artboard as a conservative editable bound.');
      return finish(object, style, asMask);
    }
    if (node.tag === 'image') {
      const href = node.attributes.href ?? node.attributes['xlink:href']; const embedded = dataImage(href);
      if (!embedded) { warnings.add('External or unsupported SVG image references were omitted; embed PNG/JPEG/WebP/GIF data to retain editability.'); return undefined; }
      const assetId = createId('asset'); const asset: DocumentAsset = { id: assetId, name: String(node.attributes.id ?? 'Embedded SVG image'), mimeType: embedded.mimeType, byteLength: embedded.bytes.byteLength, sha256: createHash('sha256').update(embedded.bytes).digest('hex'), source: 'imported', data: embedded.bytes.toString('base64') }; document.assets[asset.id] = asset;
      const objectWidth = positiveLength(node.attributes.width, embedded.width); const objectHeight = positiveLength(node.attributes.height, embedded.height);
      const object = { ...base(node, style, multiply(matrix, translate(finite(node.attributes.x), finite(node.attributes.y))), 'Image'), type: 'image' as const, assetId, width: objectWidth, height: objectHeight, sourceWidth: embedded.width, sourceHeight: embedded.height, filters: [] };
      if (node.attributes.preserveAspectRatio && node.attributes.preserveAspectRatio !== 'none') warnings.add('SVG image preserveAspectRatio is represented by the editable image box and may require crop adjustment.');
      return finish(object, style, asMask);
    }
    if (node.tag === 'text') {
      const ranges: TextStyleRange[] = []; let content = '';
      const appendText = (text: string, rangeStyle: Style) => { if (!text) return; const start = content.length; content += text; const fontSize = Math.max(1, finite(rangeStyle['font-size'], 48)); ranges.push({ start, end: content.length, fontFamily: rangeStyle['font-family'] ?? 'sans-serif', fontSize, fontWeight: Math.max(1, finite(rangeStyle['font-weight'], 400)), fontStyle: rangeStyle['font-style'] === 'italic' ? 'italic' : 'normal', color: rangeStyle.fill ?? '#000000', letterSpacing: finite(rangeStyle['letter-spacing']), underline: rangeStyle['text-decoration']?.includes('underline') }); };
      const collect = (value: SvgNode, inherited: Style) => { const current = styleFor(value, inherited, rules); if (value.tag === '#text') appendText(value.text ?? '', current); else value.children.forEach((child) => collect(child, current)); };
      node.children.forEach((child) => collect(child, style));
      if (!content) content = textContent(node);
      const fontSize = ranges[0]?.fontSize ?? Math.max(1, finite(style['font-size'], 48)); if (!ranges.length) appendText(content, style);
      const aidrawBox = aidrawSvgTextBox(node.attributes, warnings);
      const textWidth = aidrawBox?.width ?? positiveLength(node.attributes.width, Math.max(1, content.length * fontSize * 0.62)); const textHeight = aidrawBox?.height ?? positiveLength(node.attributes.height, fontSize * 1.3); const anchor = style['text-anchor']; const x = finite(node.attributes.x) - (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0);
      const object: TextObject = { ...base(node, style, multiply(matrix, translate(x, finite(node.attributes.y) - fontSize)), 'Text'), type: 'text', text: content, width: textWidth, height: textHeight, align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left', lineHeight: aidrawBox?.lineHeight ?? 1.2, ranges };
      if (node.children.some((child) => child.tag === 'tspan' && (child.attributes.x !== undefined || child.attributes.y !== undefined || child.attributes.dx !== undefined || child.attributes.dy !== undefined))) warnings.add('Per-tspan SVG positioning was reduced to contiguous styled text ranges.');
      return finish(object, style, asMask);
    }
    return undefined;
  }

  const process = (node: SvgNode, parentStyle: Style, depth: number, useStack = new Set<string>()): string[] => {
    if (depth > 64) throw new Error('SVG nesting exceeds the 64-level safety limit.');
    if (node.tag === '#text' || node.tag === 'defs' || node.tag === 'style' || ['linearGradient', 'radialGradient', 'filter', 'clipPath', 'mask', 'marker'].includes(node.tag)) return [];
    const style = styleFor(node, parentStyle, rules);
    if (node.tag === 'use') {
      const reference = String(node.attributes.href ?? node.attributes['xlink:href'] ?? '').replace(/^#/, '');
      if (!reference || useStack.has(reference) || !idNodes.has(reference)) { warnings.add('An unresolved or cyclic SVG <use> reference was omitted.'); return []; }
      const nextStack = new Set(useStack); nextStack.add(reference); const sourceNode = idNodes.get(reference)!;
      const childIds = process(sourceNode, style, depth + 1, nextStack);
      if (!childIds.length) return [];
      const group: GroupObject = { ...base(node, style, multiply(svgTransform(node.attributes.transform), translate(finite(node.attributes.x), finite(node.attributes.y))), 'Use'), type: 'group', childIds };
      return [finish(group, style, false).id];
    }
    if (node.tag === 'g' || node.tag === 'svg' || node.tag === 'symbol') {
      const childIds = node.children.flatMap((child) => process(child, style, depth + 1, useStack));
      if (!childIds.length) return [];
      const offsetX = node.tag === 'svg' ? finite(node.attributes.x) : 0; const offsetY = node.tag === 'svg' ? finite(node.attributes.y) : 0;
      const group: GroupObject = { ...base(node, style, multiply(svgTransform(node.attributes.transform), translate(offsetX, offsetY)), node.tag === 'g' ? 'Group' : 'SVG viewport'), type: 'group', childIds };
      return [finish(group, style, false).id];
    }
    const object = element(node, style, svgTransform(node.attributes.transform));
    if (object) return [object.id];
    if (node.tag !== 'title' && node.tag !== 'desc' && node.tag !== 'metadata') warnings.add(`Unsupported SVG <${node.tag}> content was omitted.`);
    return [];
  };

  const rootStyle = styleFor(root, {}, rules);
  const topLevel = root.children.flatMap((child) => process(child, rootStyle, 0));
  const minX = viewBox[0] ?? 0; const minY = viewBox[1] ?? 0;
  if ((minX || minY) && topLevel.length) {
    const wrapperNode: SvgNode = { tag: 'g', attributes: {}, children: [] };
    const wrapper: GroupObject = { ...base(wrapperNode, rootStyle, translate(-minX, -minY), 'ViewBox'), type: 'group', childIds: topLevel };
    finish(wrapper, rootStyle, false);
  }
  document.dirty = true;
  return { document, warnings: [...warnings] };
}
