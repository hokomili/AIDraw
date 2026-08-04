import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  BUILT_IN_RASTER_BRUSH_PRESETS,
  createId,
  illustrationKeyframesForObject,
  nowIso,
  rasterBrushDynamics,
  resolveRasterBrushPreset,
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
import { EntryDialog } from '../components/EditorDialog';
import { colorWithOpacity } from '../../common/color';
import { paintTileCachePlan } from '../../common/paint-tile-cache';
import { renderRasterStroke } from '../../common/raster-brush';
import { renderStyledText } from '../../common/text-layout';
import { snapObjectTransform } from '../../common/snapping';
import { combineSelection, lassoSelectsBounds, type SelectionCombination } from '../../common/lasso';
import { approximateLocalObjectBounds } from '../../common/illustration-geometry';
import { cropImageObject, normalizedDisplayCrop } from '../../common/image-crop';
import {
  hitSelectionHandle,
  objectWorldBounds,
  rotateSelection,
  scaleSelection,
  selectionHandlePoints,
  selectionWorldBounds,
  type ScaleHandle,
  type WorldBounds,
} from '../../common/selection-transform';
import { convertPathNode, deletePathNode, inspectPathNodes, insertPathNode, movePathPoint, nearestPathLocation, type PathPointKind } from '../../common/path-nodes';
import { outlinePath, pressureOutline } from './geometry';

interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Gesture {
  kind: 'stroke' | 'shape' | 'move' | 'scale' | 'rotate' | 'pan' | 'lasso' | 'gradient' | 'crop' | 'node' | 'guide';
  start: PointSample;
  points: PointSample[];
  end: PointSample;
  object?: IllustrationObject;
  originalObjects?: IllustrationObject[];
  selectionBounds?: WorldBounds;
  scaleHandle?: ScaleHandle;
  constrain?: boolean;
  lockPromise?: Promise<{ acquired: boolean; lockId?: string }>;
  panOrigin?: { x: number; y: number };
  arrow?: boolean;
  radial?: boolean;
  pathObject?: PathObject;
  pathNodeIndex?: number;
  pathPointKind?: PathPointKind;
  guideId?: string;
  selectionCombination?: SelectionCombination;
  containment?: boolean;
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
  for (const stop of style.stops) gradient.addColorStop(stop.offset, colorWithOpacity(stop.color, stop.opacity));
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

function adjustmentFilter(filters: IllustrationObject['filters']): string {
  return (filters ?? []).map((filter) => filter.type === 'brightness' ? `brightness(${Math.max(0, 1 + filter.value)})` : filter.type === 'contrast' ? `contrast(${Math.max(0, 1 + filter.value)})` : filter.type === 'saturation' ? `saturate(${Math.max(0, 1 + filter.value)})` : filter.type === 'hue' ? `hue-rotate(${filter.value}deg)` : `blur(${Math.max(0, filter.value)}px)`).join(' ');
}

function objectFilter(object: IllustrationObject): string {
  const filters: string[] = [];
  if ((object.blur ?? 0) > 0) filters.push(`blur(${Math.max(0, object.blur ?? 0)}px)`);
  const adjustments = adjustmentFilter(object.filters); if (adjustments) filters.push(adjustments);
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
    renderStyledText(context, object);
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

function hitTestAll(document: IllustrationDocument, point: PointSample, context?: CanvasRenderingContext2D, viewScale = 1): IllustrationObject[] {
  return Object.values(document.objects).reverse().filter((object) => {
    if (!object.visible || object.locked) return false;
    const localPath = localObjectPath(object);
    if (context && localPath) {
      try {
        const local = worldToLocal(object, point); context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
        const tolerance = 8 / Math.max(0.05, viewScale * Math.max(Math.abs(object.transform.scaleX), Math.abs(object.transform.scaleY), 0.05));
        let hit = object.type === 'vector-stroke' || object.type === 'text' || object.type === 'image' || ((object.type === 'shape' || object.type === 'path') && object.fill.kind !== 'none') ? context.isPointInPath(localPath, local.x, local.y) : false;
        if (!hit && (object.type === 'shape' || object.type === 'path')) { context.lineWidth = Math.max(tolerance, object.stroke.width + tolerance); hit = context.isPointInStroke(localPath, local.x, local.y); }
        context.restore(); if (hit) return true;
      } catch { /* Approximate bounds remain a safe fallback for unsupported paths. */ }
    }
    const bounds = objectWorldBounds(object); const tolerance = 8 / Math.max(0.05, viewScale);
    return point.x >= bounds.x - tolerance && point.y >= bounds.y - tolerance && point.x <= bounds.x + bounds.width + tolerance && point.y <= bounds.y + bounds.height + tolerance;
  });
}

function hitTest(document: IllustrationDocument, point: PointSample, context?: CanvasRenderingContext2D, viewScale = 1): IllustrationObject | undefined { return hitTestAll(document, point, context, viewScale)[0]; }

function transformedGestureObjects(gesture: Gesture, document: IllustrationDocument): IllustrationObject[] {
  if (!gesture.originalObjects?.length) return [];
  if (gesture.kind === 'scale' && gesture.selectionBounds && gesture.scaleHandle) {
    return scaleSelection(gesture.originalObjects, gesture.selectionBounds, gesture.scaleHandle, gesture.end, Boolean(gesture.constrain));
  }
  if (gesture.kind === 'rotate' && gesture.selectionBounds) {
    return rotateSelection(gesture.originalObjects, gesture.selectionBounds, gesture.start, gesture.end, gesture.constrain ? 15 : undefined);
  }
  if (gesture.kind !== 'move') return gesture.originalObjects.map((object) => structuredClone(object));
  const deltaX = gesture.end.x - gesture.start.x;
  const deltaY = gesture.end.y - gesture.start.y;
  return gesture.originalObjects.map((source) => {
    const object = structuredClone(source);
    const raw = { ...source.transform, x: source.transform.x + deltaX, y: source.transform.y + deltaY };
    object.transform = gesture.originalObjects?.length === 1 ? snapObjectTransform(document, source, raw).transform : raw;
    return object;
  });
}

function drawSelectionControls(context: CanvasRenderingContext2D, bounds: WorldBounds, viewScale: number): void {
  const lineWidth = 1.5 / viewScale;
  const handleSize = 10 / viewScale;
  const handles = selectionHandlePoints(bounds, viewScale);
  context.save();
  context.globalAlpha = 1;
  context.filter = 'none';
  context.strokeStyle = '#7454d8';
  context.fillStyle = '#fff';
  context.lineWidth = lineWidth;
  context.setLineDash([6 / viewScale, 4 / viewScale]);
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(bounds.x + bounds.width / 2, bounds.y);
  context.lineTo(handles.rotate.x, handles.rotate.y);
  context.stroke();
  for (const handle of ['north-west', 'north-east', 'south-east', 'south-west'] as const) {
    const point = handles[handle];
    context.fillRect(point.x - handleSize / 2, point.y - handleSize / 2, handleSize, handleSize);
    context.strokeRect(point.x - handleSize / 2, point.y - handleSize / 2, handleSize, handleSize);
  }
  context.beginPath();
  context.arc(handles.rotate.x, handles.rotate.y, handleSize / 2, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function cubicPath(points: PointSample[]): string {
  const clean = points.filter((point, index) => !index || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > .1); if (clean.length < 2) return '';
  let path = `M ${clean[0].x} ${clean[0].y}`;
  for (let index = 0; index < clean.length - 1; index += 1) { const p0 = clean[Math.max(0, index - 1)]; const p1 = clean[index]; const p2 = clean[index + 1]; const p3 = clean[Math.min(clean.length - 1, index + 2)]; const c1x = p1.x + (p2.x - p0.x) / 6; const c1y = p1.y + (p2.y - p0.y) / 6; const c2x = p2.x - (p3.x - p1.x) / 6; const c2y = p2.y - (p3.y - p1.y) / 6; path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`; }
  return path;
}

function safePathNodes(pathData: string) { try { return inspectPathNodes(pathData); } catch { return []; } }

export function IllustrationCanvas({ document }: { document: IllustrationDocument }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());
  const [imageRevision, setImageRevision] = useState(0);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [gesture, setGesture] = useState<Gesture>();
  const [pathPoints, setPathPoints] = useState<PointSample[]>([]);
  const [textDialogPoint, setTextDialogPoint] = useState<PointSample>();
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
  const setCanvasViewport = useEditorStore((state) => state.setCanvasViewport);
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
    setCanvasViewport({ x: -view.offsetX / view.scale, y: -view.offsetY / view.scale, width: size.width / view.scale, height: size.height / view.scale });
  }, [setCanvasViewport, size.height, size.width, view.offsetX, view.offsetY, view.scale]);

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
    const objectChildren = new Set(Object.values(document.objects).flatMap((object) => object.type === 'group' ? object.childIds : []));
    const surface = () => { const value = window.document.createElement('canvas'); value.width = document.artboard.width; value.height = document.artboard.height; return value; };
    const drawObjectEntry = (target: CanvasRenderingContext2D, objectId: string, visiting = new Set<string>()) => {
      if (visiting.has(objectId) || replayMasks.objectIds.has(objectId)) return;
      const object = document.objects[objectId]; if (!object?.visible) return;
      if (object.type !== 'group') {
        target.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) target.clip(maskPath); drawObject(target, object, tool !== 'select' && selectedIds.includes(object.id), imageCacheRef.current); target.restore(); return;
      }
      const nextVisiting = new Set(visiting); nextVisiting.add(objectId);
      const transformed = object.transform.x !== 0 || object.transform.y !== 0 || object.transform.scaleX !== 1 || object.transform.scaleY !== 1 || object.transform.rotation !== 0 || object.transform.skewX !== 0 || object.transform.skewY !== 0;
      const isolate = transformed || object.opacity !== 1 || object.blendMode !== 'normal' || Boolean(object.blur || object.shadow || object.maskObjectId || object.filters?.length);
      if (!isolate) { for (const childId of object.childIds) drawObjectEntry(target, childId, nextVisiting); return; }
      const buffer = surface(); const bufferContext = buffer.getContext('2d'); if (!bufferContext) return;
      for (const childId of object.childIds) drawObjectEntry(bufferContext, childId, nextVisiting);
      target.save(); const mask = object.maskObjectId ? document.objects[object.maskObjectId] : undefined; const maskPath = mask ? transformedObjectPath(mask) : undefined; if (maskPath) target.clip(maskPath); applyObjectTransform(target, object); target.filter = objectFilter(object); target.drawImage(buffer, 0, 0); target.restore();
    };

    const drawLayer = (layerId: string, target = context) => {
      const layer = document.layers[layerId];
      if (!layer?.visible) return;
      const drawContents = (output: CanvasRenderingContext2D) => {
        if (layer.type === 'paint') {
          const plan = paintTileCachePlan(layer, document.assets);
          const masksCachedStroke = plan ? layer.strokes.slice(0, plan.strokeCount).some((stroke) => replayMasks.strokeIds.has(stroke.id)) : false;
          const loadedTiles = !masksCachedStroke && plan ? plan.entries.map((entry) => ({ ...entry, image: imageCacheRef.current.get(entry.assetId) })).filter((entry) => entry.image?.complete && entry.image.naturalWidth === layer.tileSize && entry.image.naturalHeight === layer.tileSize) : [];
          const useCache = Boolean(plan && !masksCachedStroke && loadedTiles.length === plan.entries.length);
          if (useCache) for (const entry of loadedTiles) output.drawImage(entry.image!, entry.tileX * layer.tileSize, entry.tileY * layer.tileSize);
          for (const stroke of layer.strokes.slice(useCache ? plan!.strokeCount : 0)) {
            if (replayMasks.strokeIds.has(stroke.id)) continue;
            renderRasterStroke(output, stroke);
          }
        } else if (layer.type === 'vector') {
          for (const objectId of layer.objectIds) if (!objectChildren.has(objectId)) drawObjectEntry(output, objectId);
        } else for (const childId of layer.childIds) drawLayer(childId, output);
      };
      const isolated = layer.opacity !== 1 || layer.blendMode !== 'normal' || Boolean(layer.filters?.length);
      target.save();
      const maskLayer = layer.maskLayerId ? document.layers[layer.maskLayerId] : undefined;
      if (maskLayer?.type === 'vector') { const maskPath = new Path2D(); for (const objectId of maskLayer.objectIds) { const path = document.objects[objectId] ? transformedObjectPath(document.objects[objectId]) : undefined; if (path) maskPath.addPath(path); } target.clip(maskPath); }
      if (isolated) {
        const buffer = surface(); const bufferContext = buffer.getContext('2d'); if (bufferContext) { drawContents(bufferContext); target.globalAlpha *= layer.opacity; target.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode; target.filter = adjustmentFilter(layer.filters); target.drawImage(buffer, 0, 0); }
      } else drawContents(target);
      target.restore();
    };
    for (const layerId of document.layerIds) drawLayer(layerId);

    context.save(); context.globalAlpha = 0.9; context.lineWidth = 1 / view.scale; context.setLineDash([4 / view.scale, 3 / view.scale]);
    for (const guide of document.guides ?? []) { const position = gesture?.kind === 'guide' && gesture.guideId === guide.id ? (guide.orientation === 'vertical' ? gesture.end.x : gesture.end.y) : guide.position; context.strokeStyle = guide.color; context.beginPath(); if (guide.orientation === 'vertical') { context.moveTo(position, 0); context.lineTo(position, document.artboard.height); } else { context.moveTo(0, position); context.lineTo(document.artboard.width, position); } context.stroke(); }
    context.setLineDash([]); context.restore();

    for (const playback of playbacks) {
      context.save();
      for (const operation of playback.operations) {
        try {
          if (operation.kind === 'illustration.paint.stroke') {
            const stroke = operation.stroke;
            const points = Array.isArray(stroke.points) ? stroke.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) : [];
            if (!points.length) continue;
            renderRasterStroke(context, { ...stroke, points });
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
          const presetId = tool === 'eraser' ? 'eraser' : brushPreset;
          const preset = resolveRasterBrushPreset(presetId, document.brushPresets ?? []);
          const builtIn = presetId in BUILT_IN_RASTER_BRUSH_PRESETS;
          renderRasterStroke(context, {
            id: 'gesture-preview', actorId: HUMAN_ACTOR.id, points: gesture.points, color, size: brushSize, opacity,
            hardness: preset.hardness, flow: preset.flow, mode: tool === 'eraser' ? 'erase' : 'paint',
            preset: tool === 'eraser' ? 'eraser' : builtIn ? presetId as RasterStroke['preset'] : 'custom',
            brushPresetId: preset.id, dynamics: rasterBrushDynamics(preset, 0),
          });
        }
      } else if (gesture.kind === 'shape') {
        const shape = gestureToShape(gesture, tool, document, color, brushSize, opacity);
        if (shape) drawShape(context, shape);
      } else if (gesture.kind === 'move' || gesture.kind === 'scale' || gesture.kind === 'rotate') {
        const previews = transformedGestureObjects(gesture, document);
        context.globalAlpha = 0.72;
        for (const preview of previews) drawObject(context, preview, false, imageCacheRef.current);
        if (gesture.kind === 'move' && previews.length === 1 && gesture.originalObjects?.[0]) {
          const snapped = snapObjectTransform(document, gesture.originalObjects[0], previews[0].transform);
          context.globalAlpha = 1; context.strokeStyle = '#ef6387'; context.lineWidth = 1 / view.scale; context.setLineDash([5 / view.scale, 4 / view.scale]);
          if (snapped.guideX !== undefined) { context.beginPath(); context.moveTo(snapped.guideX, 0); context.lineTo(snapped.guideX, document.artboard.height); context.stroke(); }
          if (snapped.guideY !== undefined) { context.beginPath(); context.moveTo(0, snapped.guideY); context.lineTo(document.artboard.width, snapped.guideY); context.stroke(); }
          context.setLineDash([]);
        }
      } else if (gesture.kind === 'lasso') {
        const polygon = [...gesture.points, gesture.end]; context.fillStyle = 'rgba(130, 104, 221, .08)'; context.strokeStyle = '#7454d8'; context.lineWidth = 1.5 / view.scale; context.setLineDash([6 / view.scale, 4 / view.scale]); context.beginPath(); polygon.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); if (polygon.length > 2) context.closePath(); context.fill(); context.stroke(); context.setLineDash([]);
      } else if (gesture.kind === 'gradient') {
        context.strokeStyle = '#8268dd'; context.lineWidth = 2 / view.scale; context.beginPath(); context.moveTo(gesture.start.x, gesture.start.y); context.lineTo(gesture.end.x, gesture.end.y); context.stroke(); context.fillStyle = '#fff';
        for (const point of [gesture.start, gesture.end]) { context.beginPath(); context.arc(point.x, point.y, 5 / view.scale, 0, Math.PI * 2); context.fill(); context.stroke(); }
      } else if (gesture.kind === 'crop') {
        if (gesture.object?.type === 'image') {
          const start = worldToLocal(gesture.object, gesture.start); const end = worldToLocal(gesture.object, gesture.end); const rect = normalizedDisplayCrop(gesture.object, start, end, gesture.constrain ? gesture.object.width / gesture.object.height : undefined); const matrix = objectMatrix(gesture.object);
          context.save(); context.transform(matrix.a!, matrix.b!, matrix.c!, matrix.d!, matrix.e!, matrix.f!); const shade = new Path2D(); shade.rect(0, 0, gesture.object.width, gesture.object.height); shade.rect(rect.x, rect.y, rect.width, rect.height); context.fillStyle = 'rgba(0,0,0,.32)'; context.fill(shade, 'evenodd'); context.strokeStyle = '#fff'; context.lineWidth = 1.5 / view.scale; context.setLineDash([6 / view.scale, 4 / view.scale]); context.strokeRect(rect.x, rect.y, rect.width, rect.height); context.setLineDash([]); for (const point of [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }]) { context.fillStyle = '#fff'; context.fillRect(point.x - 4 / view.scale, point.y - 4 / view.scale, 8 / view.scale, 8 / view.scale); context.strokeStyle = '#7454d8'; context.strokeRect(point.x - 4 / view.scale, point.y - 4 / view.scale, 8 / view.scale, 8 / view.scale); } context.restore();
        }
      } else if (gesture.kind === 'node' && gesture.pathObject && gesture.pathNodeIndex !== undefined && gesture.pathPointKind) {
        const local = worldToLocal(gesture.pathObject, gesture.end); const preview = { ...gesture.pathObject, pathData: movePathPoint(gesture.pathObject.pathData, gesture.pathNodeIndex, gesture.pathPointKind, local.x, local.y, Boolean(gesture.constrain) && gesture.pathPointKind !== 'anchor') }; drawObject(context, preview, true, imageCacheRef.current);
      }
      context.restore();
    }

    if (pathPoints.length) { context.save(); context.strokeStyle = '#8268dd'; context.lineWidth = 2 / view.scale; const preview = cubicPath(pathPoints); if (preview) context.stroke(new Path2D(preview)); context.fillStyle = '#fff'; for (const point of pathPoints) { context.beginPath(); context.arc(point.x, point.y, 4 / view.scale, 0, Math.PI * 2); context.fill(); context.stroke(); } context.restore(); }
    if (tool === 'node') for (const id of selectedIds) {
      const object = document.objects[id]; if (object?.type !== 'path') continue; const nodes = safePathNodes(object.pathData); const matrix = objectMatrix(object);
      context.save(); context.transform(matrix.a!, matrix.b!, matrix.c!, matrix.d!, matrix.e!, matrix.f!); context.fillStyle = '#fff'; context.strokeStyle = '#7454d8'; context.lineWidth = 1.5 / view.scale;
      for (const node of nodes) {
        for (const handle of [{ present: node.hasHandleIn, point: node.handleIn }, { present: node.hasHandleOut, point: node.handleOut }]) if (handle.present) { context.beginPath(); context.moveTo(node.anchor.x, node.anchor.y); context.lineTo(handle.point.x, handle.point.y); context.stroke(); context.beginPath(); context.arc(handle.point.x, handle.point.y, 3.5 / view.scale, 0, Math.PI * 2); context.fill(); context.stroke(); }
        const size = 8 / view.scale; context.fillRect(node.anchor.x - size / 2, node.anchor.y - size / 2, size, size); context.strokeRect(node.anchor.x - size / 2, node.anchor.y - size / 2, size, size);
      }
      context.restore();
    }
    if (tool === 'crop' && !gesture) for (const id of selectedIds) {
      const object = document.objects[id]; if (object?.type !== 'image') continue; const matrix = objectMatrix(object); context.save(); context.transform(matrix.a!, matrix.b!, matrix.c!, matrix.d!, matrix.e!, matrix.f!); context.strokeStyle = '#7454d8'; context.lineWidth = 1.5 / view.scale; context.setLineDash([7 / view.scale, 4 / view.scale]); context.strokeRect(0, 0, object.width, object.height); context.setLineDash([]); for (const point of [{ x: 0, y: 0 }, { x: object.width, y: 0 }, { x: object.width, y: object.height }, { x: 0, y: object.height }]) { context.fillStyle = '#fff'; context.fillRect(point.x - 4 / view.scale, point.y - 4 / view.scale, 8 / view.scale, 8 / view.scale); context.strokeStyle = '#7454d8'; context.strokeRect(point.x - 4 / view.scale, point.y - 4 / view.scale, 8 / view.scale, 8 / view.scale); } context.restore();
    }
    if (tool === 'select') {
      const selectedObjects = selectedIds.map((id) => document.objects[id]).filter((object): object is IllustrationObject => Boolean(object?.visible));
      const displayedObjects = gesture && (gesture.kind === 'move' || gesture.kind === 'scale' || gesture.kind === 'rotate') ? transformedGestureObjects(gesture, document) : selectedObjects;
      const bounds = selectionWorldBounds(displayedObjects);
      if (bounds) drawSelectionControls(context, bounds, view.scale);
    }

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
    const animationPreview = useEditorStore.getState().canvasAnimation;
    if (animationPreview?.illustrationTimeMs !== undefined && animationPreview.playing) useEditorStore.getState().setCanvasAnimation({ ...animationPreview, playing: false });
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
      if (selectedPath) {
        const local = worldToLocal(selectedPath, point); const nodes = safePathNodes(selectedPath.pathData); let best: { nodeIndex: number; pointKind: PathPointKind; distance: number; nodeKind: 'corner' | 'smooth' } | undefined; const threshold = 12 / view.scale;
        for (const node of nodes) for (const candidate of [{ pointKind: 'anchor' as const, point: node.anchor, present: true }, { pointKind: 'in' as const, point: node.handleIn, present: node.hasHandleIn }, { pointKind: 'out' as const, point: node.handleOut, present: node.hasHandleOut }]) {
          if (!candidate.present) continue; const candidateDistance = Math.hypot(candidate.point.x - local.x, candidate.point.y - local.y);
          if (candidateDistance < threshold && (!best || candidateDistance < best.distance)) best = { nodeIndex: node.index, pointKind: candidate.pointKind, distance: candidateDistance, nodeKind: node.kind };
        }
        if (best) {
          if (best.pointKind === 'anchor' && (event.ctrlKey || event.metaKey)) {
            void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [selectedPath.id] }); if (!lock.acquired) return; try { const object = { ...selectedPath, pathData: deletePathNode(selectedPath.pathData, best.nodeIndex) }; await apply('Delete path node', [{ kind: 'illustration.object.replace', object, expectedRevision: selectedPath.revision }]); } catch { /* Minimum-node paths remain unchanged. */ } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })();
            return;
          }
          if (best.pointKind === 'anchor' && event.detail >= 2) {
            void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [selectedPath.id] }); if (!lock.acquired) return; try { const nodeKind = best.nodeKind === 'smooth' ? 'corner' : 'smooth'; const object = { ...selectedPath, pathData: convertPathNode(selectedPath.pathData, best.nodeIndex, nodeKind) }; await apply(`Convert to ${nodeKind} node`, [{ kind: 'illustration.object.replace', object, expectedRevision: selectedPath.revision }]); } catch { /* Invalid endpoint conversions remain unchanged. */ } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })();
            return;
          }
          const lockPromise = window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [selectedPath.id] }); setGesture({ kind: 'node', start: point, end: point, points: [point], pathObject: selectedPath, pathNodeIndex: best.nodeIndex, pathPointKind: best.pointKind, lockPromise }); return;
        }
        if (event.altKey) {
          try {
            const location = nearestPathLocation(selectedPath.pathData, local.x, local.y);
            if (location.distance < threshold) { void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [selectedPath.id] }); if (!lock.acquired) return; try { const object = { ...selectedPath, pathData: insertPathNode(selectedPath.pathData, location.segmentIndex, location.time) }; await apply('Insert path node', [{ kind: 'illustration.object.replace', object, expectedRevision: selectedPath.revision }]); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })(); return; }
          } catch { /* Unsupported path data falls through to object selection. */ }
        }
      }
      setSelectedId(hitTest(document, point, canvasRef.current?.getContext('2d') ?? undefined, view.scale)?.id); return;
    }
    if (tool === 'gradient') { const object = hitTest(document, point, canvasRef.current?.getContext('2d') ?? undefined, view.scale); if (object && (object.type === 'shape' || object.type === 'path')) { setSelectedId(object.id); setGesture({ kind: 'gradient', start: point, end: point, points: [point], object, radial: event.altKey, lockPromise: window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] }) }); } return; }
    if (tool === 'crop') { const object = hitTest(document, point, canvasRef.current?.getContext('2d') ?? undefined, view.scale); if (object?.type === 'image') { setSelectedId(object.id); setGesture({ kind: 'crop', start: point, end: point, points: [point], object, lockPromise: window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [object.id] }) }); } return; }
    if (tool === 'lasso') { const selectionCombination: SelectionCombination = event.shiftKey && event.altKey ? 'intersect' : event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'replace'; setGesture({ kind: 'lasso', start: point, end: point, points: [point], selectionCombination, containment: event.ctrlKey || event.metaKey }); return; }
    if (tool === 'select') {
      const guide = (document.guides ?? []).find((entry) => !entry.locked && Math.abs((entry.orientation === 'vertical' ? point.x : point.y) - entry.position) <= 5 / view.scale);
      if (guide) { setGesture({ kind: 'guide', start: point, end: point, points: [point], guideId: guide.id }); return; }
      const selectedObjects = selectedIds
        .map((id) => document.objects[id])
        .filter((object): object is IllustrationObject => Boolean(object?.visible && !object.locked));
      const selectedBounds = selectionWorldBounds(selectedObjects);
      const handle = selectedBounds ? hitSelectionHandle(point, selectedBounds, view.scale) : undefined;
      if (handle) {
        const lockPromise = window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: selectedObjects.map((object) => object.id) });
        setGesture({
          kind: handle === 'rotate' ? 'rotate' : 'scale',
          start: point,
          end: point,
          points: [point],
          originalObjects: selectedObjects.map((object) => structuredClone(object)),
          selectionBounds: selectedBounds,
          scaleHandle: handle === 'rotate' ? undefined : handle,
          constrain: event.shiftKey,
          lockPromise,
        });
        return;
      }
      const hits = hitTestAll(document, point, canvasRef.current?.getContext('2d') ?? undefined, view.scale);
      if (event.altKey && hits.length) { const selectedIndex = hits.findIndex((entry) => selectedIds.includes(entry.id)); const next = hits[(selectedIndex + 1) % hits.length]; setSelectedId(next.id); return; }
      const object = hits[0];
      if (event.shiftKey && object) { toggleSelectedId(object.id); return; }
      setSelectedId(object?.id);
      if (object) {
        const movingObjects = selectedIds.includes(object.id) && selectedObjects.length ? selectedObjects : [object];
        const lockPromise = window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: movingObjects.map((entry) => entry.id) });
        setGesture({ kind: 'move', start: point, end: point, points: [point], originalObjects: movingObjects.map((entry) => structuredClone(entry)), lockPromise });
      }
      return;
    }
    if (tool === 'text') {
      setTextDialogPoint(point);
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
    } else setGesture({ ...gesture, end: point, constrain: event.shiftKey, points: gesture.kind === 'stroke' || gesture.kind === 'lasso' ? [...gesture.points, point] : gesture.points });
  };

  const finishGesture = async () => {
    if (!gesture) return;
    setGesture(undefined);
    if (gesture.kind === 'guide' && gesture.guideId) {
      const guide = (document.guides ?? []).find((entry) => entry.id === gesture.guideId); if (!guide || guide.locked) return;
      const position = guide.orientation === 'vertical' ? gesture.end.x : gesture.end.y;
      await apply('Move guide', [{ kind: 'illustration.guides.replace', guides: document.guides.map((entry) => entry.id === guide.id ? { ...entry, position } : entry), expectedRevision: document.revision }]); return;
    }
    if ((gesture.kind === 'move' || gesture.kind === 'scale' || gesture.kind === 'rotate') && gesture.originalObjects?.length) {
      const lock = await gesture.lockPromise;
      if (lock?.acquired) {
        try {
          const objects = transformedGestureObjects(gesture, document);
          const label = gesture.kind === 'move' ? `Move ${objects.length === 1 ? 'object' : `${objects.length} objects`}` : gesture.kind === 'scale' ? `Scale ${objects.length === 1 ? 'object' : `${objects.length} objects`}` : `Rotate ${objects.length === 1 ? 'object' : `${objects.length} objects`}`;
          const animationTime = useEditorStore.getState().canvasAnimation?.illustrationTimeMs;
          if (animationTime === undefined) await apply(label, objects.map((object, index) => ({ kind: 'illustration.object.replace' as const, object, expectedRevision: gesture.originalObjects![index].revision })));
          else {
            const timestamp = nowIso(); const timeMs = Math.round(animationTime);
            await apply(`${label} at ${timeMs} ms`, objects.map((object) => {
              const existing = illustrationKeyframesForObject(document, object.id).find((keyframe) => keyframe.timeMs === timeMs);
              return {
                kind: 'illustration.animation.keyframe.upsert' as const,
                keyframe: {
                  id: existing?.id ?? createId('keyframe'), revision: existing?.revision ?? 0, name: `${object.name} · ${(timeMs / 1_000).toFixed(2)}s`,
                  createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, createdBy: existing?.createdBy ?? HUMAN_ACTOR.id,
                  objectId: object.id, timeMs, transform: structuredClone(object.transform), opacity: object.opacity, visible: object.visible, easing: existing?.easing ?? 'ease-in-out' as const,
                },
                expectedRevision: existing?.revision,
              };
            }));
          }
        } finally {
          if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId);
        }
      }
      return;
    }
    if (gesture.kind === 'lasso') {
      const polygon = [...gesture.points, gesture.end]; const ids = Object.values(document.objects).filter((object) => object.visible && lassoSelectsBounds(polygon, objectWorldBounds(object), Boolean(gesture.containment))).map((object) => object.id);
      setSelectedIds(combineSelection(selectedIds, ids, gesture.selectionCombination ?? 'replace')); return;
    }
    if (gesture.kind === 'gradient' && gesture.object && (gesture.object.type === 'shape' || gesture.object.type === 'path')) {
      const lock = await gesture.lockPromise; if (!lock?.acquired) return; const start = worldToLocal(gesture.object, gesture.start); const end = worldToLocal(gesture.object, gesture.end); const object = { ...gesture.object, fill: { kind: gesture.radial ? 'radial-gradient' as const : 'linear-gradient' as const, x1: start.x, y1: start.y, x2: end.x, y2: end.y, stops: [{ offset: 0, color }, { offset: 1, color: useEditorStore.getState().secondaryColor }] } };
      await apply('Edit gradient', [{ kind: 'illustration.object.replace', object, expectedRevision: gesture.object.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
    }
    if (gesture.kind === 'crop' && gesture.object?.type === 'image') {
      const lock = await gesture.lockPromise; if (!lock?.acquired) return; const start = worldToLocal(gesture.object, gesture.start); const end = worldToLocal(gesture.object, gesture.end); const rect = normalizedDisplayCrop(gesture.object, start, end, gesture.constrain ? gesture.object.width / gesture.object.height : undefined);
      if (rect.width > 0 && rect.height > 0) await apply('Crop image', [{ kind: 'illustration.object.replace', object: cropImageObject(gesture.object, rect), expectedRevision: gesture.object.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
    }
    if (gesture.kind === 'node' && gesture.pathObject && gesture.pathNodeIndex !== undefined && gesture.pathPointKind) {
      const lock = await gesture.lockPromise; if (!lock?.acquired) return; const local = worldToLocal(gesture.pathObject, gesture.end); const object = { ...gesture.pathObject, pathData: movePathPoint(gesture.pathObject.pathData, gesture.pathNodeIndex, gesture.pathPointKind, local.x, local.y, Boolean(gesture.constrain) && gesture.pathPointKind !== 'anchor') }; await apply(gesture.pathPointKind === 'anchor' ? 'Move path node' : 'Move path handle', [{ kind: 'illustration.object.replace', object, expectedRevision: gesture.pathObject.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
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
        const presetId = tool === 'eraser' ? 'eraser' : brushPreset;
        const preset = resolveRasterBrushPreset(presetId, document.brushPresets ?? []);
        const builtIn = presetId in BUILT_IN_RASTER_BRUSH_PRESETS;
        const stroke: RasterStroke = {
          id: createId('stroke'), actorId: HUMAN_ACTOR.id, points: gesture.points, color, size: brushSize, opacity,
          hardness: preset.hardness, flow: preset.flow,
          mode: tool === 'eraser' ? 'erase' : 'paint', preset: tool === 'eraser' ? 'eraser' : builtIn ? presetId as RasterStroke['preset'] : 'custom',
          brushPresetId: preset.id, dynamics: rasterBrushDynamics(preset, Date.now() >>> 0),
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

  const addTextAtPoint = async (text: string) => {
    const point = textDialogPoint;
    const value = text.trim();
    if (!point || !value) return;
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector' && entry.visible && !entry.locked);
    if (layer?.type !== 'vector') return;
    const object: TextObject = {
      ...objectBase(layer.id, 'Text'), type: 'text', text: value, width: 600, height: 80, align: 'left', lineHeight: 1.2,
      ranges: [{ start: 0, end: value.length, fontFamily: 'Segoe UI', fontSize: 64, fontWeight: 700, fontStyle: 'normal', color, letterSpacing: 0 }],
    };
    object.transform.x = point.x;
    object.transform.y = point.y;
    if (await apply('Add text', [{ kind: 'illustration.object.add', object }])) setTextDialogPoint(undefined);
  };

  const cancelGesture = async () => {
    const pending = gesture;
    setGesture(undefined);
    const lock = await pending?.lockPromise;
    if (lock?.lockId) await window.aidraw.releaseHumanLock(lock.lockId);
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
        onPointerCancel={() => void cancelGesture()}
        onWheel={onWheel}
      />
      <div className="canvas-ruler horizontal" /><div className="canvas-ruler vertical" />
      {useEditorStore.getState().snapshot?.mcp.sessions.filter((entry) => entry.documentId === document.id && entry.cursor).map((entry) => {
        const cursor = entry.cursor!;
        return <div key={entry.actor.id} className="agent-cursor" style={{ left: view.offsetX + cursor.x * view.scale, top: view.offsetY + cursor.y * view.scale, '--actor': entry.actor.color } as React.CSSProperties}><span>{entry.actor.name}</span></div>;
      })}
      {textDialogPoint && <EntryDialog
        title="Add illustration text"
        description="Text remains editable as a styled vector object. Typography can be refined in the inspector."
        label="Text"
        initialValue="A bright idea"
        submitLabel="Add text"
        validate={(value) => value.trim() ? undefined : 'Enter at least one visible character.'}
        preview={(value) => <><strong>Preview</strong><span className="illustration-text-preview">{value || 'Your text'}</span></>}
        onSubmit={addTextAtPoint}
        onClose={() => setTextDialogPoint(undefined)}
      />}
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
