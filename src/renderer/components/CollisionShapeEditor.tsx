import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CollisionShape, PixelDocument, PixelSprite } from '@aidraw/core';
import { readPixel } from '@aidraw/core';
import { deleteMapObjectPoint, insertMapObjectPoint, mapObjectAtPoint, moveMapObjectPoint, nearestMapObjectSegment, transformMapObject, type MapPoint } from '../../common/map-objects';

interface CollisionGesture {
  shape: CollisionShape;
  mode: 'move' | 'resize' | 'point';
  pointIndex?: number;
  start: MapPoint;
  current: MapPoint;
  lockPromise: Promise<{ acquired: boolean; lockId?: string }>;
}

interface CollisionShapeEditorProps {
  documentId: string;
  tilesetId: string;
  sprite?: PixelSprite;
  palette: PixelDocument['palette'];
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  shapes: CollisionShape[];
  selectedId?: string;
  onSelect(id?: string): void;
  onCommit(shape: CollisionShape, label: string): void;
}

function visiblePixelLayers(sprite: PixelSprite): Array<{ layer: PixelSprite['layers'][string]; opacity: number }> {
  const result: Array<{ layer: PixelSprite['layers'][string]; opacity: number }> = [];
  const visit = (id: string, opacity: number) => {
    const layer = sprite.layers[id]; if (!layer?.visible) return;
    const combined = opacity * layer.opacity;
    if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined);
    else result.push({ layer, opacity: combined });
  };
  for (const id of sprite.layerIds) visit(id, 1);
  return result;
}

function resolveCel(sprite: PixelSprite, layerId: string, frameId: string) {
  let cel = Object.values(sprite.cels).find((entry) => entry.layerId === layerId && entry.frameId === frameId);
  const seen = new Set<string>();
  while (cel?.linkedToCelId && !seen.has(cel.id)) { seen.add(cel.id); cel = sprite.cels[cel.linkedToCelId] ?? cel; }
  return cel;
}

function gestureShape(gesture: CollisionGesture): CollisionShape {
  const delta = { x: gesture.current.x - gesture.start.x, y: gesture.current.y - gesture.start.y };
  return gesture.mode === 'point' ? moveMapObjectPoint(gesture.shape, gesture.pointIndex ?? -1, delta) : transformMapObject(gesture.shape, gesture.mode, delta);
}

export function CollisionShapeEditor(props: CollisionShapeEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gesture, setGesture] = useState<CollisionGesture>();
  const scale = Math.max(0.25, Math.min(12, 240 / Math.max(1, props.width), 200 / Math.max(1, props.height)));
  const displayWidth = Math.max(1, Math.round(props.width * scale));
  const displayHeight = Math.max(1, Math.round(props.height * scale));
  const shownShapes = props.shapes.map((shape) => gesture?.shape.id === shape.id ? gestureShape(gesture) : shape);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const dpr = window.devicePixelRatio || 1; canvas.width = Math.round(displayWidth * dpr); canvas.height = Math.round(displayHeight * dpr); canvas.style.width = `${displayWidth}px`; canvas.style.height = `${displayHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.imageSmoothingEnabled = false; context.clearRect(0, 0, displayWidth, displayHeight);
    const checker = Math.max(4, Math.round(scale * 2)); context.fillStyle = '#f6f1eb'; context.fillRect(0, 0, displayWidth, displayHeight); context.fillStyle = '#e1dcd5';
    for (let y = 0; y < displayHeight; y += checker) for (let x = 0; x < displayWidth; x += checker) if ((x / checker + y / checker) % 2 === 0) context.fillRect(x, y, checker, checker);
    if (props.sprite) {
      const frameId = props.sprite.frameIds[0]; const palette = props.sprite.paletteOverrides[frameId] ?? props.palette;
      for (const { layer, opacity } of visiblePixelLayers(props.sprite)) {
        if (layer.type !== 'pixel') continue; const cel = resolveCel(props.sprite, layer.id, frameId); if (!cel) continue;
        context.globalAlpha = opacity; context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
        for (let y = 0; y < props.height; y += 1) for (let x = 0; x < props.width; x += 1) { const index = readPixel(cel, props.sourceX + x, props.sourceY + y); if (!index) continue; context.fillStyle = palette[index]?.color ?? '#ff00ff'; context.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale)); }
      }
    }
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    if (scale >= 5) { context.beginPath(); context.strokeStyle = 'rgba(55,43,72,.13)'; context.lineWidth = 1; for (let x = 0; x <= props.width; x += 1) { context.moveTo(x * scale + .5, 0); context.lineTo(x * scale + .5, displayHeight); } for (let y = 0; y <= props.height; y += 1) { context.moveTo(0, y * scale + .5); context.lineTo(displayWidth, y * scale + .5); } context.stroke(); }
    const toScreen = (point: MapPoint) => ({ x: point.x * scale, y: point.y * scale });
    for (const shape of shownShapes) {
      const selected = shape.id === props.selectedId; const origin = toScreen({ x: shape.x, y: shape.y }); const width = (shape.width ?? 1) * scale; const height = (shape.height ?? 1) * scale;
      context.save(); context.fillStyle = selected ? 'rgba(116,84,216,.24)' : 'rgba(36,157,147,.18)'; context.strokeStyle = selected ? '#6948d2' : '#23877f'; context.lineWidth = selected ? 2 : 1.25; context.setLineDash(shape.type === 'polyline' ? [5, 3] : []); context.beginPath();
      if (shape.type === 'rectangle') context.rect(origin.x, origin.y, width, height); else if (shape.type === 'ellipse') context.ellipse(origin.x + width / 2, origin.y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2); else if (shape.points?.length) { shape.points.forEach((point, index) => { const target = toScreen({ x: shape.x + point.x, y: shape.y + point.y }); if (index) context.lineTo(target.x, target.y); else context.moveTo(target.x, target.y); }); if (shape.type === 'polygon') context.closePath(); }
      if (shape.type !== 'polyline') context.fill(); context.stroke(); context.setLineDash([]);
      if (selected && (shape.type === 'rectangle' || shape.type === 'ellipse')) { context.fillStyle = '#fff'; context.fillRect(origin.x + width - 4, origin.y + height - 4, 8, 8); context.strokeStyle = '#6948d2'; context.strokeRect(origin.x + width - 4, origin.y + height - 4, 8, 8); }
      if (selected && shape.points) for (const point of shape.points) { const target = toScreen({ x: shape.x + point.x, y: shape.y + point.y }); context.fillStyle = '#fff'; context.beginPath(); context.arc(target.x, target.y, 4, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#6948d2'; context.stroke(); }
      context.restore();
    }
  }, [displayHeight, displayWidth, props.height, props.palette, props.selectedId, props.sourceX, props.sourceY, props.sprite, props.width, scale, shownShapes]);

  const toPoint = (event: ReactPointerEvent<HTMLCanvasElement>): MapPoint => { const bounds = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - bounds.left) * props.width / bounds.width, y: (event.clientY - bounds.top) * props.height / bounds.height }; };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return; const point = toPoint(event); const threshold = 7 / scale; const selected = props.shapes.find((shape) => shape.id === props.selectedId);
    let hit = selected ?? [...props.shapes].reverse().find((shape) => mapObjectAtPoint(shape, point, threshold)); let mode: CollisionGesture['mode'] = 'move'; let pointIndex: number | undefined;
    if (selected?.points) { pointIndex = selected.points.findIndex((entry) => Math.hypot(selected.x + entry.x - point.x, selected.y + entry.y - point.y) <= threshold); if (pointIndex >= 0) { hit = selected; mode = 'point'; } else pointIndex = undefined;
      if (event.ctrlKey && pointIndex !== undefined) { const minimum = selected.type === 'polygon' ? 3 : 2; if (selected.points.length <= minimum) return; const next = deleteMapObjectPoint(selected, pointIndex); void window.aidraw.acquireHumanLock({ documentId: props.documentId, objectIds: [props.tilesetId] }).then(async (lock) => { try { if (lock.acquired) props.onCommit(next, 'Delete collision point'); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } }); return; }
      if (event.altKey && pointIndex === undefined) { const nearest = nearestMapObjectSegment(selected, point); if (nearest && nearest.distance <= threshold) { const next = insertMapObjectPoint(selected, nearest.segmentIndex, nearest.point); void window.aidraw.acquireHumanLock({ documentId: props.documentId, objectIds: [props.tilesetId] }).then(async (lock) => { try { if (lock.acquired) props.onCommit(next, 'Insert collision point'); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } }); return; } }
    }
    if (hit && mode === 'move' && (hit.type === 'rectangle' || hit.type === 'ellipse') && Math.hypot(hit.x + (hit.width ?? 1) - point.x, hit.y + (hit.height ?? 1) - point.y) <= threshold) mode = 'resize';
    if (!hit || (mode === 'move' && !mapObjectAtPoint(hit, point, threshold))) { props.onSelect(undefined); return; }
    event.currentTarget.setPointerCapture(event.pointerId); props.onSelect(hit.id); setGesture({ shape: structuredClone(hit), mode, pointIndex, start: point, current: point, lockPromise: window.aidraw.acquireHumanLock({ documentId: props.documentId, objectIds: [props.tilesetId] }) });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (gesture) setGesture({ ...gesture, current: toPoint(event) }); };
  const finishGesture = async (event: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
    if (!gesture) return; const current = toPoint(event); const final = { ...gesture, current }; setGesture(undefined); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); const lock = await gesture.lockPromise;
    try { if (commit && lock.acquired) props.onCommit(gestureShape(final), gesture.mode === 'point' ? 'Move collision point' : gesture.mode === 'resize' ? 'Resize collision' : 'Move collision'); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
  };

  return <div className="collision-shape-editor"><canvas ref={canvasRef} aria-label="Tile collision canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => void finishGesture(event, true)} onPointerCancel={(event) => void finishGesture(event, false)} /><small>Drag shapes and points · Alt-click an edge to insert · Ctrl-click a point to delete.</small></div>;
}
