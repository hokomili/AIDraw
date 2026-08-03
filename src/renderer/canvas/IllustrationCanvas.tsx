import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  nowIso,
  type IllustrationDocument,
  type IllustrationObject,
  type PaintStyle,
  type PathObject,
  type PointSample,
  type RasterStroke,
  type ShapeObject,
  type StrokeStyle,
  type TextObject,
  type VectorStrokeObject,
} from '@aidraw/core';
import { useEditorStore } from '../store';
import { collectReplayMasks } from '../replay';
import { canvasFont } from '../../common/canvas-font';
import { approximateLocalObjectBounds } from '../../common/illustration-geometry';
import { outlinePath, pressureOutline } from './geometry';

interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Gesture {
  kind: 'stroke' | 'shape' | 'move' | 'pan' | 'lasso' | 'gradient' | 'crop' | 'node';
  start: PointSample;
  points: PointSample[];
  end: PointSample;
  object?: IllustrationObject;
  originalTransform?: IllustrationObject['transform'];
  lockPromise?: Promise<{ acquired: boolean; lockId?: string }>;
  panOrigin?: { x: number; y: number };
  arrow?: boolean;
  radial?: boolean;
  pathObject?: PathObject;
  pathNodeIndex?: number;
}

const noPaint: PaintStyle = { kind: 'none' };

function solid(color: string): PaintStyle {
  return { kind: 'solid', color };
}

function strokeStyle(color: string, width: number, opacity: number): StrokeStyle {
  return { paint: solid(color), width, opacity, lineCap: 'round', lineJoin: 'round', dash: [] };
}

function objectBase(layerId: string, name: string) {
  const timestamp = nowIso();
  return {
    id: createId('object'),
    revision: 0,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id,
    layerId,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
    transform: structuredClone(IDENTITY_TRANSFORM),
  };
}

function paintValue(style: PaintStyle, context: CanvasRenderingContext2D): string | CanvasGradient | undefined {
  if (style.kind === 'none') return undefined;
  if (style.kind === 'solid') return style.color;
  const gradient = style.kind === 'linear-gradient'
    ? context.createLinearGradient(style.x1, style.y1, style.x2, style.y2)
    : context.createRadialGradient(style.x1, style.y1, 0, style.x2, style.y2, Math.hypot(style.x2 - style.x1, style.y2 - style.y1));
  for (const stop of style.stops) gradient.addColorStop(stop.offset, stop.color);
  return gradient;
}

function applyObjectTransform(context: CanvasRenderingContext2D, object: IllustrationObject): void {
  const transform = object.transform;
  context.translate(transform.x, transform.y);
  context.rotate((transform.rotation * Math.PI) / 180);
  context.transform(transform.scaleX, Math.tan((transform.skewY * Math.PI) / 180), Math.tan((transform.skewX * Math.PI) / 180), transform.scaleY, 0, 0);
  context.globalAlpha *= object.opacity;
  context.globalCompositeOperation = object.blendMode === 'normal' ? 'source-over' : object.blendMode;
  if (object.shadow) { context.shadowColor = object.shadow.color; context.shadowBlur = object.shadow.blur; context.shadowOffsetX = object.shadow.offsetX; context.shadowOffsetY = object.shadow.offsetY; }
}

function localObjectPath(object: IllustrationObject): Path2D | undefined {
  const path = new Path2D();
  if (object.type === 'path') return new Path2D(object.pathData);
  if (object.type === 'vector-stroke') return outlinePath(pressureOutline(object.points, object.brush));
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

function objectMatrix(object: IllustrationObject): DOMMatrix2DInit {
  const value = object.transform; const angle = value.rotation * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle); const skewX = Math.tan(value.skewX * Math.PI / 180); const skewY = Math.tan(value.skewY * Math.PI / 180);
  return { a: cosine * value.scaleX - sine * skewY, b: sine * value.scaleX + cosine * skewY, c: cosine * skewX - sine * value.scaleY, d: sine * skewX + cosine * value.scaleY, e: value.x, f: value.y };
}

function transformedObjectPath(object: IllustrationObject): Path2D | undefined {
  const local = localObjectPath(object); if (!local) return undefined; const value = objectMatrix(object); const world = new Path2D(); world.addPath(local, new DOMMatrix([value.a!, value.b!, value.c!, value.d!, value.e!, value.f!])); return world;
}
function worldToLocal(object: IllustrationObject, point: PointSample): { x: number; y: number } { const value = objectMatrix(object); const local = new DOMMatrix([value.a!, value.b!, value.c!, value.d!, value.e!, value.f!]).inverse().transformPoint(new DOMPoint(point.x, point.y)); return { x: local.x, y: local.y }; }

function imageFilter(object: Extract<IllustrationObject, { type: 'image' }>): string {
  return object.filters.map((filter) => filter.type === 'brightness' ? `brightness(${Math.max(0, 1 + filter.value)})` : filter.type === 'contrast' ? `contrast(${Math.max(0, 1 + filter.value)})` : filter.type === 'saturation' ? `saturate(${Math.max(0, 1 + filter.value)})` : filter.type === 'hue' ? `hue-rotate(${filter.value}deg)` : `blur(${Math.max(0, filter.value)}px)`).join(' ');
}

function objectFilter(object: IllustrationObject): string {
  const filters: string[] = [];
  if ((object.blur ?? 0) > 0) filters.push(`blur(${Math.max(0, object.blur ?? 0)}px)`);
  if (object.type === 'image') { const imageFilters = imageFilter(object); if (imageFilters) filters.push(imageFilters); }
  return filters.join(' ') || 'none';
}

function drawShape(context: CanvasRenderingContext2D, object: ShapeObject): void {
  const path = new Path2D();
  if (object.shape === 'rectangle') path.roundRect(0, 0, object.width, object.height, object.cornerRadius ?? 0);
  else if (object.shape === 'ellipse') path.ellipse(object.width / 2, object.height / 2, Math.abs(object.width / 2), Math.abs(object.height / 2), 0, 0, Math.PI * 2);
  else if (object.shape === 'line' || object.shape === 'arrow') {
    path.moveTo(0, 0); path.lineTo(object.width, object.height);
    if (object.shape === 'arrow') {
      const angle = Math.atan2(object.height, object.width);
      const head = Math.max(10, object.stroke.width * 4);
      path.moveTo(object.width, object.height);
      path.lineTo(object.width - Math.cos(angle - 0.5) * head, object.height - Math.sin(angle - 0.5) * head);
      path.moveTo(object.width, object.height);
      path.lineTo(object.width - Math.cos(angle + 0.5) * head, object.height - Math.sin(angle + 0.5) * head);
    }
  } else {
    const sides = object.shape === 'star' ? Math.max(3, object.sides ?? 5) * 2 : Math.max(3, object.sides ?? 6);
    const cx = object.width / 2;
    const cy = object.height / 2;
    const radius = Math.min(Math.abs(object.width), Math.abs(object.height)) / 2;
    for (let index = 0; index < sides; index += 1) {
      const pointRadius = object.shape === 'star' && index % 2 ? radius * (object.innerRadius ?? 0.45) : radius;
      const angle = -Math.PI / 2 + (index / sides) * Math.PI * 2;
      const x = cx + Math.cos(angle) * pointRadius;
      const y = cy + Math.sin(angle) * pointRadius;
      if (index === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  }
  const fill = paintValue(object.fill, context);
  if (fill) { context.fillStyle = fill; context.fill(path, 'nonzero'); }
  const stroke = paintValue(object.stroke.paint, context);
  if (stroke && object.stroke.width > 0) {
    context.strokeStyle = stroke;
    context.lineWidth = object.stroke.width;
    context.lineCap = object.stroke.lineCap;
    context.lineJoin = object.stroke.lineJoin;
    context.setLineDash(object.stroke.dash);
    context.globalAlpha *= object.stroke.opacity;
    context.stroke(path);
  }
}

function drawObject(context: CanvasRenderingContext2D, object: IllustrationObject, selected: boolean, imageCache?: Map<string, HTMLImageElement>): void {
  if (!object.visible) return;
  context.save();
  applyObjectTransform(context, object);
  context.filter = objectFilter(object);
  if (object.type === 'vector-stroke') {
    context.fillStyle = object.brush.color;
    context.fill(outlinePath(pressureOutline(object.points, object.brush)));
  } else if (object.type === 'shape') drawShape(context, object);
  else if (object.type === 'path') {
    const path = new Path2D(object.pathData);
    const fill = paintValue(object.fill, context);
    if (fill) { context.fillStyle = fill; context.fill(path, object.fillRule); }
    const stroke = paintValue(object.stroke.paint, context);
    if (stroke) { context.strokeStyle = stroke; context.lineWidth = object.stroke.width; context.stroke(path); }
  } else if (object.type === 'text') {
    context.textBaseline = 'top'; const ranges = object.ranges.length ? object.ranges : [{ start: 0, end: object.text.length, fontFamily: 'sans-serif', fontSize: 48, fontWeight: 500, fontStyle: 'normal' as const, color: '#27213c', letterSpacing: 0 }];
    const measurements = ranges.map((range) => { context.font = canvasFont(range); const text = object.text.slice(range.start, range.end); return context.measureText(text).width + Math.max(0, text.length - 1) * range.letterSpacing; }); const total = measurements.reduce((sum, value) => sum + value, 0); let cursorX = object.align === 'center' ? (object.width - total) / 2 : object.align === 'right' ? object.width - total : 0;
    ranges.forEach((range, rangeIndex) => { const text = object.text.slice(range.start, range.end); context.font = canvasFont(range); context.fillStyle = range.color; for (const character of text) { context.fillText(character, cursorX, 0); const width = context.measureText(character).width; if (range.underline) context.fillRect(cursorX, range.fontSize * 1.05, width, Math.max(1, range.fontSize / 18)); cursorX += width + range.letterSpacing; } cursorX += measurements[rangeIndex] - (text.split('').reduce((sum, character) => sum + context.measureText(character).width, 0) + Math.max(0, text.length - 1) * range.letterSpacing); });
  } else if (object.type === 'image') {
    const image = imageCache?.get(object.assetId);
    if (image?.complete && object.crop) context.drawImage(image, object.crop.x, object.crop.y, object.crop.width, object.crop.height, 0, 0, object.width, object.height);
    else if (image?.complete) context.drawImage(image, 0, 0, object.width, object.height);
    else {
      context.fillStyle = '#ded8e8';
      context.fillRect(0, 0, object.width, object.height);
      context.strokeStyle = '#8c83a1';
      context.strokeRect(0, 0, object.width, object.height);
      context.beginPath(); context.moveTo(0, 0); context.lineTo(object.width, object.height); context.moveTo(object.width, 0); context.lineTo(0, object.height); context.stroke();
    }
  }
  if (selected) {
    context.filter = 'none';
    const bounds = approximateBounds(object);
    context.globalAlpha = 1;
    context.setLineDash([6, 4]);
    context.lineWidth = 1.5;
    context.strokeStyle = '#7454d8';
    context.strokeRect(bounds.x - 5, bounds.y - 5, bounds.width + 10, bounds.height + 10);
    context.setLineDash([]);
  }
  context.restore();
}

function approximateBounds(object: IllustrationObject): { x: number; y: number; width: number; height: number } {
  return approximateLocalObjectBounds(object);
}

function hitTest(document: IllustrationDocument, point: PointSample): IllustrationObject | undefined {
  const objects = Object.values(document.objects).reverse();
  return objects.find((object) => {
    if (!object.visible || object.locked) return false;
    const bounds = approximateBounds(object);
    const x = point.x - object.transform.x;
    const y = point.y - object.transform.y;
    return x >= bounds.x - 8 && y >= bounds.y - 8 && x <= bounds.x + bounds.width + 8 && y <= bounds.y + bounds.height + 8;
  });
}

function snappedTransform(document: IllustrationDocument, object: IllustrationObject, raw: IllustrationObject['transform']): { transform: IllustrationObject['transform']; guideX?: number; guideY?: number } {
  const bounds = approximateBounds(object); const threshold = 8;
  const xTargets = [0, document.artboard.width / 2, document.artboard.width]; const yTargets = [0, document.artboard.height / 2, document.artboard.height];
  for (const other of Object.values(document.objects)) if (other.id !== object.id && other.visible) {
    const otherBounds = approximateBounds(other); xTargets.push(other.transform.x + otherBounds.x, other.transform.x + otherBounds.x + otherBounds.width / 2, other.transform.x + otherBounds.x + otherBounds.width); yTargets.push(other.transform.y + otherBounds.y, other.transform.y + otherBounds.y + otherBounds.height / 2, other.transform.y + otherBounds.y + otherBounds.height);
  }
  const xOffsets = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width]; const yOffsets = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
  let bestX = raw.x; let bestY = raw.y; let guideX: number | undefined; let guideY: number | undefined; let dx = threshold; let dy = threshold;
  for (const target of xTargets) for (const offset of xOffsets) { const candidate = target - offset; const distance = Math.abs(raw.x - candidate); if (distance < dx) { dx = distance; bestX = candidate; guideX = target; } }
  for (const target of yTargets) for (const offset of yOffsets) { const candidate = target - offset; const distance = Math.abs(raw.y - candidate); if (distance < dy) { dy = distance; bestY = candidate; guideY = target; } }
  return { transform: { ...raw, x: bestX, y: bestY }, guideX, guideY };
}

function cubicPath(points: PointSample[]): string {
  const clean = points.filter((point, index) => !index || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > .1); if (clean.length < 2) return '';
  let path = `M ${clean[0].x} ${clean[0].y}`;
  for (let index = 0; index < clean.length - 1; index += 1) { const p0 = clean[Math.max(0, index - 1)]; const p1 = clean[index]; const p2 = clean[index + 1]; const p3 = clean[Math.min(clean.length - 1, index + 2)]; const c1x = p1.x + (p2.x - p0.x) / 6; const c1y = p1.y + (p2.y - p0.y) / 6; const c2x = p2.x - (p3.x - p1.x) / 6; const c2y = p2.y - (p3.y - p1.y) / 6; path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`; }
  return path;
}

function pathNumbers(pathData: string): number[] { return [...pathData.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)].map((match) => Number(match[0])); }
function replacePathNode(pathData: string, nodeIndex: number, x: number, y: number): string { let numberIndex = 0; return pathData.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, (value) => { const current = numberIndex++; if (current === nodeIndex * 2) return String(x); if (current === nodeIndex * 2 + 1) return String(y); return value; }); }

export function IllustrationCanvas({ document }: { document: IllustrationDocument }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());
  const [imageRevision, setImageRevision] = useState(0);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [gesture, setGesture] = useState<Gesture>();
  const [pathPoints, setPathPoints] = useState<PointSample[]>([]);
  const tool = useEditorStore((state) => state.selectedTool);
  const color = useEditorStore((state) => state.primaryColor);
  const brushSize = useEditorStore((state) => state.brushSize);
  const brushPreset = useEditorStore((state) => state.brushPreset);
  const opacity = useEditorStore((state) => state.opacity);
  const zoom = useEditorStore((state) => state.zoom);
  const setZoom = useEditorStore((state) => state.setZoom);
  const apply = useEditorStore((state) => state.apply);
  const selectedIds = useEditorStore((state) => state.selectedEntityIds);
  const setSelectedId = useEditorStore((state) => state.setSelectedEntity);
  const setSelectedIds = useEditorStore((state) => state.setSelectedEntities);
  const toggleSelectedId = useEditorStore((state) => state.toggleSelectedEntity);
  const revealRequest = useEditorStore((state) => state.revealRequest);
  const handledRevealRef = useRef<string | undefined>(undefined);
  const playbackMap = useEditorStore((state) => state.playbacks);
  const playbacks = Object.values(playbackMap).filter((entry) => entry.documentId === document.id);

  const view: ViewTransform = (() => {
    const fit = Math.min((size.width - 128) / document.artboard.width, (size.height - 112) / document.artboard.height);
    const scale = Math.max(0.01, fit * zoom);
    return {
      scale,
      offsetX: (size.width - document.artboard.width * scale) / 2 + pan.x,
      offsetY: (size.height - document.artboard.height * scale) / 2 + pan.y,
    };
  })();

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!revealRequest || revealRequest.documentId !== document.id || handledRevealRef.current === revealRequest.id) return;
    const object = document.objects[revealRequest.objectId];
    if (!object) return;
    handledRevealRef.current = revealRequest.id;
    const bounds = approximateLocalObjectBounds(object);
    const centerX = object.transform.x + (bounds.x + bounds.width / 2) * object.transform.scaleX;
    const centerY = object.transform.y + (bounds.y + bounds.height / 2) * object.transform.scaleY;
    setPan({
      x: (document.artboard.width / 2 - centerX) * view.scale,
      y: (document.artboard.height / 2 - centerY) * view.scale,
    });
  }, [document, revealRequest, view.scale]);

  useEffect(() => {
    for (const asset of Object.values(document.assets)) {
      if (!asset.data || !asset.mimeType.startsWith('image/') || imageCacheRef.current.has(asset.id)) continue;
      const image = new Image();
      image.onload = () => setImageRevision((value) => value + 1);
      image.src = `data:${asset.mimeType};base64,${asset.data}`;
      imageCacheRef.current.set(asset.id, image);
    }
  }, [document.assets]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.save();
    context.translate(view.offsetX, view.offsetY);
    context.scale(view.scale, view.scale);
    context.shadowColor = 'rgba(53, 43, 68, .16)';
    context.shadowBlur = 28 / view.scale;
    context.shadowOffsetY = 9 / view.scale;
    context.fillStyle = document.artboard.background ?? '#ffffff00';
    context.fillRect(0, 0, document.artboard.width, document.artboard.height);
    context.shadowColor = 'transparent';
    context.save();
    context.beginPath();
    context.rect(0, 0, document.artboard.width, document.artboard.height);
    context.clip();
    const replayMasks = collectReplayMasks(playbacks);

    const drawLayer = (layerId: string) => {
      const layer = document.layers[layerId];
      if (!layer?.visible) return;
      context.save();
      context.globalAlpha = layer.opacity;
      context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
      const maskLayer = layer.maskLayerId ? document.layers[layer.maskLayerId] : undefined;
      if (maskLayer?.type === 'vector') { const maskPath = new Path2D(); for (const objectId of maskLayer.objectIds) { const path = document.objects[objectId] ? transformedObjectPath(document.objects[objectId]) : undefined; if (path) maskPath.addPath(path); } context.clip(maskPath); }
      if (layer.type === 'paint') {
        for (const stroke of layer.strokes) {
          if (replayMasks.strokeIds.has(stroke.id)) continue;
          context.save();
          context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
          context.globalAlpha *= stroke.opacity;
          context.globalAlpha *= stroke.flow;
          context.strokeStyle = stroke.color;
          context.lineWidth = stroke.size;
          context.lineCap = stroke.preset === 'marker' ? 'square' : 'round';
          context.lineJoin = 'round';
          context.filter = stroke.preset === 'soft-round' || stroke.preset === 'airbrush' ? `blur(${stroke.size * (stroke.preset === 'airbrush' ? .35 : .18)}px)` : 'none';
          context.beginPath();
          stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
          context.stroke();
          context.restore();
        }
      } else if (layer.type === 'vector') {
        for (const objectId of layer.objectIds) {
          if (replayMasks.objectIds.has(objectId)) continue;
          const object = document.objects[objectId];
          if (object) { context.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) context.clip(maskPath); drawObject(context, object, selectedIds.includes(object.id), imageCacheRef.current); context.restore(); }
        }
      } else for (const childId of layer.childIds) drawLayer(childId);
      context.restore();
    };
    for (const layerId of document.layerIds) drawLayer(layerId);

    for (const playback of playbacks) {
      context.save();
      for (const operation of playback.operations) {
        try {
          if (operation.kind === 'illustration.paint.stroke') {
            const stroke = operation.stroke;
            const points = Array.isArray(stroke.points) ? stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) : [];
            if (!points.length) continue;
            context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
            context.globalAlpha = stroke.opacity * stroke.flow;
            context.strokeStyle = stroke.color;
            context.lineWidth = stroke.size;
            context.lineCap = stroke.preset === 'marker' ? 'square' : 'round'; context.lineJoin = 'round'; context.filter = stroke.preset === 'soft-round' || stroke.preset === 'airbrush' ? `blur(${stroke.size * (stroke.preset === 'airbrush' ? .35 : .18)}px)` : 'none'; context.beginPath();
            points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
            context.stroke();
          } else if (operation.kind === 'illustration.object.add' || operation.kind === 'illustration.object.replace') {
            drawObject(context, operation.object, false, imageCacheRef.current);
          }
        } catch {
          // A malformed transient playback must never take down the editor.
        }
      }
      context.restore();
    }

    if (gesture) {
      context.save();
      if (gesture.kind === 'stroke') {
        if (tool === 'pen' || tool === 'pencil') {
          context.fillStyle = color;
          context.globalAlpha = opacity;
          context.fill(outlinePath(pressureOutline(gesture.points, { size: brushSize, thinning: tool === 'pen' ? 0.62 : 0.12, smoothing: tool === 'pen' ? 0.65 : 0.25, streamline: 0.35, simulatePressure: false })));
        } else {
          context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
          context.globalAlpha = opacity;
          context.strokeStyle = color;
          context.lineWidth = brushSize;
          context.lineCap = 'round'; context.lineJoin = 'round'; context.beginPath();
          gesture.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
          context.stroke();
        }
      } else if (gesture.kind === 'shape') {
        const shape = gestureToShape(gesture, tool, document, color, brushSize, opacity);
        if (shape) drawShape(context, shape);
      } else if (gesture.kind === 'move' && gesture.object && gesture.originalTransform) {
        const preview = structuredClone(gesture.object);
        const snapped = snappedTransform(document, gesture.object, { ...gesture.originalTransform, x: gesture.originalTransform.x + gesture.end.x - gesture.start.x, y: gesture.originalTransform.y + gesture.end.y - gesture.start.y });
        preview.transform = snapped.transform;
        context.globalAlpha = 0.72;
        drawObject(context, preview, true, imageCacheRef.current);
        context.globalAlpha = 1; context.strokeStyle = '#ef6387'; context.lineWidth = 1 / view.scale; context.setLineDash([5 / view.scale, 4 / view.scale]);
        if (snapped.guideX !== undefined) { context.beginPath(); context.moveTo(snapped.guideX, 0); context.lineTo(snapped.guideX, document.artboard.height); context.stroke(); }
        if (snapped.guideY !== undefined) { context.beginPath(); context.moveTo(0, snapped.guideY); context.lineTo(document.artboard.width, snapped.guideY); context.stroke(); }
        context.setLineDash([]);
      } else if (gesture.kind === 'lasso') {
        const x = Math.min(gesture.start.x, gesture.end.x); const y = Math.min(gesture.start.y, gesture.end.y); const width = Math.abs(gesture.end.x - gesture.start.x); const height = Math.abs(gesture.end.y - gesture.start.y);
        context.fillStyle = 'rgba(130, 104, 221, .08)'; context.fillRect(x, y, width, height); context.strokeStyle = '#7454d8'; context.lineWidth = 1.5 / view.scale; context.setLineDash([6 / view.scale, 4 / view.scale]); context.strokeRect(x, y, width, height); context.setLineDash([]);
      } else if (gesture.kind === 'gradient') {
        context.strokeStyle = '#8268dd'; context.lineWidth = 2 / view.scale; context.beginPath(); context.moveTo(gesture.start.x, gesture.start.y); context.lineTo(gesture.end.x, gesture.end.y); context.stroke(); context.fillStyle = '#fff';
        for (const point of [gesture.start, gesture.end]) { context.beginPath(); context.arc(point.x, point.y, 5 / view.scale, 0, Math.PI * 2); context.fill(); context.stroke(); }
      } else if (gesture.kind === 'crop') {
        const x = Math.min(gesture.start.x, gesture.end.x); const y = Math.min(gesture.start.y, gesture.end.y); const width = Math.abs(gesture.end.x - gesture.start.x); const height = Math.abs(gesture.end.y - gesture.start.y); const shade = new Path2D(); shade.rect(0, 0, document.artboard.width, document.artboard.height); shade.rect(x, y, width, height); context.fillStyle = 'rgba(0,0,0,.25)'; context.fill(shade, 'evenodd'); context.strokeStyle = '#fff'; context.lineWidth = 1 / view.scale; context.strokeRect(x, y, width, height);
      } else if (gesture.kind === 'node' && gesture.pathObject && gesture.pathNodeIndex !== undefined) {
        const local = worldToLocal(gesture.pathObject, gesture.end); const preview = { ...gesture.pathObject, pathData: replacePathNode(gesture.pathObject.pathData, gesture.pathNodeIndex, local.x, local.y) }; drawObject(context, preview, true, imageCacheRef.current);
      }
      context.restore();
    }

    if (pathPoints.length) { context.save(); context.strokeStyle = '#8268dd'; context.lineWidth = 2 / view.scale; const preview = cubicPath(pathPoints); if (preview) context.stroke(new Path2D(preview)); context.fillStyle = '#fff'; for (const point of pathPoints) { context.beginPath(); context.arc(point.x, point.y, 4 / view.scale, 0, Math.PI * 2); context.fill(); context.stroke(); } context.restore(); }
    if (tool === 'node') for (const id of selectedIds) { const object = document.objects[id]; if (object?.type !== 'path') continue; const values = pathNumbers(object.pathData); const matrix = objectMatrix(object); context.save(); context.transform(matrix.a!, matrix.b!, matrix.c!, matrix.d!, matrix.e!, matrix.f!); context.fillStyle = '#fff'; context.strokeStyle = '#7454d8'; context.lineWidth = 1.5 / view.scale; for (let index = 0; index + 1 < values.length; index += 2) { context.beginPath(); context.arc(values[index], values[index + 1], 4 / view.scale, 0, Math.PI * 2); context.fill(); context.stroke(); } context.restore(); }

    context.restore();
    context.lineWidth = 1 / view.scale;
    context.strokeStyle = 'rgba(67, 52, 86, .25)';
    context.strokeRect(0, 0, document.artboard.width, document.artboard.height);
    context.restore();
  }, [brushPreset, brushSize, color, document, gesture, imageRevision, opacity, pathPoints, playbacks, selectedIds, size, tool, view.offsetX, view.offsetY, view.scale]);

  const toWorld = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): PointSample => ({
    x: (event.nativeEvent.offsetX - view.offsetX) / view.scale,
    y: (event.nativeEvent.offsetY - view.offsetY) / view.scale,
    pressure: event.pressure || 0.5,
    time: event.timeStamp,
  }), [view]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toWorld(event);
    if (tool === 'zoom') { setZoom(zoom * (event.shiftKey ? 0.8 : 1.25)); return; }
    if (tool === 'hand' || event.button === 1 || event.buttons === 4) {
      setGesture({ kind: 'pan', start: point, end: point, points: [point], panOrigin: pan });
      return;
    }
    if (tool === 'bezier') {
      const points = [...pathPoints, point];
      if (event.detail >= 2 && points.length >= 3) { const pathData = cubicPath(points); const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked); if (pathData && layer?.type === 'vector') { const object: PathObject = { ...objectBase(layer.id, 'Bézier path'), type: 'path', pathData, closed: event.altKey, fillRule: 'nonzero', fill: event.altKey ? solid(`${color}44`) : noPaint, stroke: strokeStyle(color, Math.max(1, Math.min(brushSize, 24)), opacity) }; void apply('Add Bézier path', [{ kind: 'illustration.object.add', object }]); } setPathPoints([]); }
      else setPathPoints(points);
      return;
    }
    if (tool === 'node') {
      const selectedPath = selectedIds.map((id) => document.objects[id]).find((entry): entry is PathObject => entry?.type === 'path');
      if (selectedPath) { const local = worldToLocal(selectedPath, point); const numbers = pathNumbers(selectedPath.pathData); let bestIndex = -1; let distance = 12 / view.scale; for (let index = 0; index + 1 < numbers.length; index += 2) { const current = Math.hypot(numbers[index] - local.x, numbers[index + 1] - local.y); if (current < distance) { distance = current; bestIndex = index / 2; } } if (bestIndex >= 0) { const lockPromise = window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [selectedPath.id] }); setGesture({ kind: 'node', start: point, end: point, points: [point], pathObject: selectedPath, pathNodeIndex: bestIndex, lockPromise }); return; } }
      setSelectedId(hitTest(document, point)?.id); return;
    }
    if (tool === 'gradient') { const object = hitTest(document, point); if (object && (object.type === 'shape' || object.type === 'path')) { setSelectedId(object.id); setGesture({ kind: 'gradient', start: point, end: point, points: [point], object, radial: event.altKey, lockPromise: window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] }) }); } return; }
    if (tool === 'crop') { const object = hitTest(document, point); if (object?.type === 'image') { setSelectedId(object.id); setGesture({ kind: 'crop', start: point, end: point, points: [point], object, lockPromise: window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] }) }); } return; }
    if (tool === 'lasso') { setGesture({ kind: 'lasso', start: point, end: point, points: [point] }); return; }
    if (tool === 'select') {
      const object = hitTest(document, point);
      if (event.shiftKey && object) { toggleSelectedId(object.id); return; }
      setSelectedId(object?.id);
      if (object) {
        const lockPromise = window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] });
        setGesture({ kind: 'move', start: point, end: point, points: [point], object, originalTransform: structuredClone(object.transform), lockPromise });
      }
      return;
    }
    if (tool === 'text') {
      const text = window.prompt('Text', 'A bright idea');
      const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
      if (text && layer?.type === 'vector') {
        const object: TextObject = {
          ...objectBase(layer.id, 'Text'), type: 'text', text, width: 600, height: 80, align: 'left', lineHeight: 1.2,
          ranges: [{ start: 0, end: text.length, fontFamily: 'Segoe UI', fontSize: 64, fontWeight: 700, fontStyle: 'normal', color, letterSpacing: 0 }],
        };
        object.transform.x = point.x; object.transform.y = point.y;
        void apply('Add text', [{ kind: 'illustration.object.add', object }]);
      }
      return;
    }
    if (tool === 'eyedropper') {
      const context = canvasRef.current?.getContext('2d');
      if (context) {
        const pixel = context.getImageData(event.nativeEvent.offsetX * (window.devicePixelRatio || 1), event.nativeEvent.offsetY * (window.devicePixelRatio || 1), 1, 1).data;
        useEditorStore.getState().setColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`);
      }
      return;
    }
    const kind = ['line', 'rectangle', 'ellipse', 'polygon', 'star'].includes(tool) ? 'shape' : 'stroke';
    setGesture({ kind, start: point, end: point, points: [point], arrow: tool === 'line' && event.altKey });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!gesture) return;
    const point = toWorld(event);
    if (gesture.kind === 'pan' && gesture.panOrigin) {
      setPan({ x: gesture.panOrigin.x + event.movementX, y: gesture.panOrigin.y + event.movementY });
      setGesture({ ...gesture, panOrigin: { x: gesture.panOrigin.x + event.movementX, y: gesture.panOrigin.y + event.movementY }, end: point });
    } else setGesture({ ...gesture, end: point, points: gesture.kind === 'stroke' ? [...gesture.points, point] : gesture.points });
  };

  const finishGesture = async () => {
    if (!gesture) return;
    setGesture(undefined);
    if (gesture.kind === 'move' && gesture.object && gesture.originalTransform) {
      const lock = await gesture.lockPromise;
      if (lock?.acquired) {
        const object = structuredClone(gesture.object);
        object.transform = snappedTransform(document, gesture.object, { ...gesture.originalTransform, x: gesture.originalTransform.x + gesture.end.x - gesture.start.x, y: gesture.originalTransform.y + gesture.end.y - gesture.start.y }).transform;
        await apply('Move object', [{ kind: 'illustration.object.replace', object, expectedRevision: gesture.object.revision }]);
        if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId);
      }
      return;
    }
    if (gesture.kind === 'lasso') {
      const x1 = Math.min(gesture.start.x, gesture.end.x); const y1 = Math.min(gesture.start.y, gesture.end.y); const x2 = Math.max(gesture.start.x, gesture.end.x); const y2 = Math.max(gesture.start.y, gesture.end.y);
      const ids = Object.values(document.objects).filter((object) => { const bounds = approximateBounds(object); const left = object.transform.x + bounds.x; const top = object.transform.y + bounds.y; return object.visible && left <= x2 && top <= y2 && left + bounds.width >= x1 && top + bounds.height >= y1; }).map((object) => object.id);
      setSelectedIds(ids); return;
    }
    if (gesture.kind === 'gradient' && gesture.object && (gesture.object.type === 'shape' || gesture.object.type === 'path')) {
      const lock = await gesture.lockPromise; if (!lock?.acquired) return; const start = worldToLocal(gesture.object, gesture.start); const end = worldToLocal(gesture.object, gesture.end); const object = { ...gesture.object, fill: { kind: gesture.radial ? 'radial-gradient' as const : 'linear-gradient' as const, x1: start.x, y1: start.y, x2: end.x, y2: end.y, stops: [{ offset: 0, color }, { offset: 1, color: useEditorStore.getState().secondaryColor }] } };
      await apply('Edit gradient', [{ kind: 'illustration.object.replace', object, expectedRevision: gesture.object.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
    }
    if (gesture.kind === 'crop' && gesture.object?.type === 'image') {
      const lock = await gesture.lockPromise; if (!lock?.acquired) return; const start = worldToLocal(gesture.object, gesture.start); const end = worldToLocal(gesture.object, gesture.end); const left = Math.max(0, Math.min(gesture.object.width, Math.min(start.x, end.x))); const top = Math.max(0, Math.min(gesture.object.height, Math.min(start.y, end.y))); const right = Math.max(0, Math.min(gesture.object.width, Math.max(start.x, end.x))); const bottom = Math.max(0, Math.min(gesture.object.height, Math.max(start.y, end.y))); const base = gesture.object.crop ?? { x: 0, y: 0, width: gesture.object.width, height: gesture.object.height }; const object = { ...gesture.object, crop: { x: base.x + left / gesture.object.width * base.width, y: base.y + top / gesture.object.height * base.height, width: (right - left) / gesture.object.width * base.width, height: (bottom - top) / gesture.object.height * base.height } };
      if (object.crop.width > 0 && object.crop.height > 0) await apply('Crop image', [{ kind: 'illustration.object.replace', object, expectedRevision: gesture.object.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
    }
    if (gesture.kind === 'node' && gesture.pathObject && gesture.pathNodeIndex !== undefined) {
      const lock = await gesture.lockPromise; if (!lock?.acquired) return; const local = worldToLocal(gesture.pathObject, gesture.end); const object = { ...gesture.pathObject, pathData: replacePathNode(gesture.pathObject.pathData, gesture.pathNodeIndex, local.x, local.y) }; await apply('Move path node', [{ kind: 'illustration.object.replace', object, expectedRevision: gesture.pathObject.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
    }
    if (gesture.kind === 'stroke' && gesture.points.length > 0) {
      if (tool === 'pen' || tool === 'pencil') {
        const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
        if (!layer || layer.type !== 'vector') return;
        const object: VectorStrokeObject = {
          ...objectBase(layer.id, tool === 'pen' ? 'Pressure stroke' : 'Pencil stroke'),
          type: 'vector-stroke', points: gesture.points,
          brush: { size: brushSize, thinning: tool === 'pen' ? 0.62 : 0.12, smoothing: tool === 'pen' ? 0.65 : 0.25, streamline: 0.35, simulatePressure: false, color },
        };
        await apply(object.name, [{ kind: 'illustration.object.add', object }]);
      } else {
        const layer = Object.values(document.layers).find((entry) => entry.type === 'paint' && entry.visible && !entry.locked);
        if (!layer || layer.type !== 'paint') return;
        const stroke: RasterStroke = {
          id: createId('stroke'), actorId: HUMAN_ACTOR.id, points: gesture.points, color, size: brushSize, opacity,
          hardness: tool === 'eraser' || brushPreset === 'hard-round' || brushPreset === 'pencil' ? 1 : brushPreset === 'marker' ? .85 : brushPreset === 'soft-round' ? .35 : .15,
          flow: brushPreset === 'airbrush' ? .35 : brushPreset === 'marker' ? .7 : 1,
          mode: tool === 'eraser' ? 'erase' : 'paint', preset: tool === 'eraser' ? 'eraser' : brushPreset,
        };
        await apply(tool === 'eraser' ? 'Erase paint' : 'Paint stroke', [{ kind: 'illustration.paint.stroke', layerId: layer.id, stroke, expectedRevision: layer.revision }]);
      }
    } else if (gesture.kind === 'shape') {
      const shape = gestureToShape(gesture, tool, document, color, brushSize, opacity);
      if (shape) await apply(`Add ${shape.shape}`, [{ kind: 'illustration.object.add', object: shape }]);
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey) setZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1));
    else setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
  };

  return (
    <div className="canvas-container illustration-canvas-container" ref={containerRef}>
      <canvas
        ref={canvasRef}
        role="application"
        aria-label={`Illustration canvas for ${document.name}`}
        tabIndex={0}
        className={`drawing-canvas tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => void finishGesture()}
        onPointerCancel={() => void finishGesture()}
        onWheel={onWheel}
      />
      <div className="canvas-ruler horizontal" /><div className="canvas-ruler vertical" />
      {useEditorStore.getState().snapshot?.mcp.sessions.filter((entry) => entry.documentId === document.id && entry.cursor).map((entry) => {
        const cursor = entry.cursor!;
        return <div key={entry.actor.id} className="agent-cursor" style={{ left: view.offsetX + cursor.x * view.scale, top: view.offsetY + cursor.y * view.scale, '--actor': entry.actor.color } as React.CSSProperties}><span>{entry.actor.name}</span></div>;
      })}
    </div>
  );
}

function gestureToShape(
  gesture: Gesture,
  tool: string,
  document: IllustrationDocument,
  color: string,
  brushSize: number,
  opacity: number,
): ShapeObject | undefined {
  const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
  if (!layer || layer.type !== 'vector') return undefined;
  const shapeType = tool === 'line' ? gesture.arrow ? 'arrow' : 'line' : tool === 'rectangle' ? 'rectangle' : tool === 'ellipse' ? 'ellipse' : tool === 'polygon' ? 'polygon' : 'star';
  const isLine = shapeType === 'line' || shapeType === 'arrow';
  const x = isLine ? gesture.start.x : Math.min(gesture.start.x, gesture.end.x);
  const y = isLine ? gesture.start.y : Math.min(gesture.start.y, gesture.end.y);
  const width = isLine ? gesture.end.x - gesture.start.x : Math.abs(gesture.end.x - gesture.start.x);
  const height = isLine ? gesture.end.y - gesture.start.y : Math.abs(gesture.end.y - gesture.start.y);
  if (Math.abs(width) < 1 && Math.abs(height) < 1) return undefined;
  const object: ShapeObject = {
    ...objectBase(layer.id, `${shapeType[0].toUpperCase()}${shapeType.slice(1)}`), type: 'shape', shape: shapeType,
    width, height, sides: shapeType === 'star' ? 5 : 6, innerRadius: 0.46,
    fill: isLine ? noPaint : solid(`${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`),
    stroke: strokeStyle(color, Math.max(1, Math.min(brushSize, 24)), opacity), cornerRadius: shapeType === 'rectangle' ? 12 : undefined,
  };
  object.transform.x = x; object.transform.y = y;
  return object;
}
