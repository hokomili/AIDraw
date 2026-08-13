import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CollisionShape, PixelDocument, PixelSprite } from '@aidraw/core';
import { deleteMapObjectPoint, insertMapObjectPoint, mapObjectAtPoint, moveMapObjectPoint, moveMapObjectSelection, nearestMapObjectSegment, transformMapObject, type MapPoint } from '../../common/map-objects';
import { drawSpriteRegionThumbnail } from '../canvas/pixel-bitmap';

interface CollisionGesture {
  shapes: CollisionShape[];
  selectedIds: string[];
  primaryId: string;
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
  selectedIds: string[];
  onSelect(ids: string[]): void;
  onCommit(shapes: CollisionShape[], label: string): void;
}

function gestureShapes(gesture: CollisionGesture): CollisionShape[] {
  const delta = { x: gesture.current.x - gesture.start.x, y: gesture.current.y - gesture.start.y };
  if (gesture.mode === 'move') return moveMapObjectSelection(gesture.shapes, gesture.selectedIds, delta);
  return gesture.shapes.map((shape) => shape.id !== gesture.primaryId ? shape : gesture.mode === 'point' ? moveMapObjectPoint(shape, gesture.pointIndex ?? -1, delta) : transformMapObject(shape, 'resize', delta));
}

export function CollisionShapeEditor(props: CollisionShapeEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gesture, setGesture] = useState<CollisionGesture>();
  const scale = Math.max(Number.EPSILON, Math.min(12, 240 / Math.max(1, props.width), 200 / Math.max(1, props.height)));
  const displayWidth = Math.max(1, Math.round(props.width * scale));
  const displayHeight = Math.max(1, Math.round(props.height * scale));
  const selectedIds = useMemo(() => props.selectedIds.filter((id) => props.shapes.some((shape) => shape.id === id)), [props.selectedIds, props.shapes]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const previewById = new Map((gesture ? gestureShapes(gesture) : []).map((shape) => [shape.id, shape]));
  const shownShapes = props.shapes.map((shape) => previewById.get(shape.id) ?? shape);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const dpr = window.devicePixelRatio || 1; canvas.width = Math.round(displayWidth * dpr); canvas.height = Math.round(displayHeight * dpr); canvas.style.width = `${displayWidth}px`; canvas.style.height = `${displayHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.imageSmoothingEnabled = false; context.clearRect(0, 0, displayWidth, displayHeight);
    if (props.sprite) drawSpriteRegionThumbnail(context, props.sprite, props.sprite.frameIds[0], props.palette, { x: props.sourceX, y: props.sourceY, width: props.width, height: props.height }, displayWidth, displayHeight);
    const checker = Math.max(4, Math.round(scale * 2)); context.save(); context.globalAlpha = 1; context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#f6f1eb'; context.fillRect(0, 0, displayWidth, displayHeight); context.fillStyle = '#e1dcd5';
    for (let y = 0; y < displayHeight; y += checker) for (let x = 0; x < displayWidth; x += checker) if ((x / checker + y / checker) % 2 === 0) context.fillRect(x, y, checker, checker); context.restore();
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    if (scale >= 5) { context.beginPath(); context.strokeStyle = 'rgba(55,43,72,.13)'; context.lineWidth = 1; for (let x = 0; x <= props.width; x += 1) { context.moveTo(x * scale + .5, 0); context.lineTo(x * scale + .5, displayHeight); } for (let y = 0; y <= props.height; y += 1) { context.moveTo(0, y * scale + .5); context.lineTo(displayWidth, y * scale + .5); } context.stroke(); }
    const toScreen = (point: MapPoint) => ({ x: point.x * scale, y: point.y * scale });
    for (const shape of shownShapes) {
      const selected = selectedSet.has(shape.id); const origin = toScreen({ x: shape.x, y: shape.y }); const width = (shape.width ?? 1) * scale; const height = (shape.height ?? 1) * scale;
      context.save(); context.fillStyle = selected ? 'rgba(116,84,216,.24)' : 'rgba(36,157,147,.18)'; context.strokeStyle = selected ? '#6948d2' : '#23877f'; context.lineWidth = selected ? 2 : 1.25; context.setLineDash(shape.type === 'polyline' ? [5, 3] : []); context.beginPath();
      if (shape.type === 'rectangle') context.rect(origin.x, origin.y, width, height); else if (shape.type === 'ellipse') context.ellipse(origin.x + width / 2, origin.y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2); else if (shape.points?.length) { shape.points.forEach((point, index) => { const target = toScreen({ x: shape.x + point.x, y: shape.y + point.y }); if (index) context.lineTo(target.x, target.y); else context.moveTo(target.x, target.y); }); if (shape.type === 'polygon') context.closePath(); }
      if (shape.type !== 'polyline') context.fill(); context.stroke(); context.setLineDash([]);
      if (selectedIds.length === 1 && selected && (shape.type === 'rectangle' || shape.type === 'ellipse')) { context.fillStyle = '#fff'; context.fillRect(origin.x + width - 4, origin.y + height - 4, 8, 8); context.strokeStyle = '#6948d2'; context.strokeRect(origin.x + width - 4, origin.y + height - 4, 8, 8); }
      if (selectedIds.length === 1 && selected && shape.points) for (const point of shape.points) { const target = toScreen({ x: shape.x + point.x, y: shape.y + point.y }); context.fillStyle = '#fff'; context.beginPath(); context.arc(target.x, target.y, 4, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#6948d2'; context.stroke(); }
      context.restore();
    }
  }, [displayHeight, displayWidth, props.height, props.palette, props.sourceX, props.sourceY, props.sprite, props.width, scale, selectedIds, selectedSet, shownShapes]);

  const toPoint = (event: ReactPointerEvent<HTMLCanvasElement>): MapPoint => { const bounds = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - bounds.left) * props.width / bounds.width, y: (event.clientY - bounds.top) * props.height / bounds.height }; };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return; const point = toPoint(event); const threshold = 7 / scale; const onlySelected = selectedIds.length === 1 ? props.shapes.find((shape) => shape.id === selectedIds[0]) : undefined;
    let hit: CollisionShape | undefined; let mode: CollisionGesture['mode'] = 'move'; let pointIndex: number | undefined;
    if (onlySelected?.points) { pointIndex = onlySelected.points.findIndex((entry) => Math.hypot(onlySelected.x + entry.x - point.x, onlySelected.y + entry.y - point.y) <= threshold); if (pointIndex >= 0) { hit = onlySelected; mode = 'point'; } else pointIndex = undefined;
      if (event.ctrlKey && pointIndex !== undefined) { const minimum = onlySelected.type === 'polygon' ? 3 : 2; if (onlySelected.points.length <= minimum) return; const next = deleteMapObjectPoint(onlySelected, pointIndex); void window.aidraw.acquireHumanLock({ documentId: props.documentId, objectIds: [props.tilesetId] }).then(async (lock) => { try { if (lock.acquired) props.onCommit([next], 'Delete collision point'); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } }); return; }
      if (event.altKey && pointIndex === undefined) { const nearest = nearestMapObjectSegment(onlySelected, point); if (nearest && nearest.distance <= threshold) { const next = insertMapObjectPoint(onlySelected, nearest.segmentIndex, nearest.point); void window.aidraw.acquireHumanLock({ documentId: props.documentId, objectIds: [props.tilesetId] }).then(async (lock) => { try { if (lock.acquired) props.onCommit([next], 'Insert collision point'); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } }); return; } }
    }
    if (!hit && onlySelected && (onlySelected.type === 'rectangle' || onlySelected.type === 'ellipse') && Math.hypot(onlySelected.x + (onlySelected.width ?? 1) - point.x, onlySelected.y + (onlySelected.height ?? 1) - point.y) <= threshold) { hit = onlySelected; mode = 'resize'; }
    hit ??= [...props.shapes].reverse().find((shape) => mapObjectAtPoint(shape, point, threshold));
    if (hit && mode === 'move' && (hit.type === 'rectangle' || hit.type === 'ellipse') && Math.hypot(hit.x + (hit.width ?? 1) - point.x, hit.y + (hit.height ?? 1) - point.y) <= threshold) mode = 'resize';
    if (!hit || (mode === 'move' && !mapObjectAtPoint(hit, point, threshold))) { if (!event.shiftKey) props.onSelect([]); return; }
    if (event.shiftKey) { props.onSelect(selectedSet.has(hit.id) ? selectedIds.filter((id) => id !== hit!.id) : [...selectedIds, hit.id]); return; }
    const movingIds = mode === 'move' && selectedSet.has(hit.id) ? selectedIds : [hit.id]; const movingSet = new Set(movingIds); const shapes = props.shapes.filter((shape) => movingSet.has(shape.id)).map((shape) => structuredClone(shape));
    event.currentTarget.setPointerCapture(event.pointerId); props.onSelect(movingIds); setGesture({ shapes, selectedIds: movingIds, primaryId: hit.id, mode: movingIds.length > 1 ? 'move' : mode, pointIndex, start: point, current: point, lockPromise: window.aidraw.acquireHumanLock({ documentId: props.documentId, objectIds: [props.tilesetId] }) });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (gesture) setGesture({ ...gesture, current: toPoint(event) }); };
  const finishGesture = async (event: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
    if (!gesture) return; const current = toPoint(event); const final = { ...gesture, current }; setGesture(undefined); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); const lock = await gesture.lockPromise;
    const changed = gestureShapes(final); try { if (commit && lock.acquired) props.onCommit(changed, gesture.mode === 'point' ? 'Move collision point' : gesture.mode === 'resize' ? 'Resize collision' : changed.length > 1 ? `Move ${changed.length} collisions` : 'Move collision'); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
  };

  return <div className="collision-shape-editor"><canvas ref={canvasRef} aria-label="Tile collision canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => void finishGesture(event, true)} onPointerCancel={(event) => void finishGesture(event, false)} /><small>Shift-click to add or remove shapes · drag the selection together · Alt-click an edge to insert · Ctrl-click a point to delete.</small></div>;
}
