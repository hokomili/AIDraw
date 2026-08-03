import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import {
  decodePixelChunk,
  decodeTiledGid,
  decodeTilemapChunk,
  HUMAN_ACTOR,
  createId,
  nowIso,
  readPixel,
  resolveTilesetForGid,
  selectWangTile,
  type PixelCel,
  type PixelDocument,
  type PixelSprite,
  type TilemapChunk,
} from '@aidraw/core';
import { ChevronLeft, ChevronRight, Eye, FlipHorizontal2, Grid3X3, Pause, Play, Repeat2 } from 'lucide-react';
import { useEditorStore } from '../store';
import { collectReplayMasks, replayPointKey, replayTileLayerKey } from '../replay';
import { bresenham, ellipsePixels } from './geometry';
import { clientPointToPixel } from './pixel-coordinates';

interface PixelPoint { x: number; y: number }
interface PixelView { scale: number; offsetX: number; offsetY: number; logicalWidth: number; logicalHeight: number }

function recordValues<T>(value: unknown): T[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter((entry) => Boolean(entry) && typeof entry === 'object') as T[];
}

function celFor(sprite: PixelSprite, layerId: string, frameId: string): PixelCel | undefined {
  const cel = recordValues<PixelCel>(sprite.cels).find((entry) => entry.layerId === layerId && entry.frameId === frameId);
  if (!cel?.linkedToCelId) return cel;
  return sprite.cels?.[cel.linkedToCelId] ?? cel;
}

function visibleSpriteLayers(sprite: PixelSprite): Array<{ layer: PixelSprite['layers'][string]; opacity: number }> {
  const result: Array<{ layer: PixelSprite['layers'][string]; opacity: number }> = []; const visit = (id: string, opacity = 1) => { const layer = sprite.layers?.[id]; if (!layer?.visible) return; const combined = opacity * layer.opacity; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined); else result.push({ layer, opacity: combined }); }; for (const id of sprite.layerIds ?? []) visit(id); return result;
}

function editableSpriteLayer(sprite: PixelSprite): PixelSprite['layers'][string] | undefined { return [...visibleSpriteLayers(sprite)].reverse().map((entry) => entry.layer).find((layer) => layer.type === 'pixel' && !layer.locked); }

function safeDecodePixelChunk(value: unknown): Uint8Array | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const chunk = value as PixelCel['chunks'][string];
  if (![chunk.x, chunk.y, chunk.width, chunk.height].every(Number.isFinite) || chunk.width !== 32 || chunk.height !== 32 || typeof chunk.data !== 'string') return undefined;
  try {
    const decoded = decodePixelChunk(chunk);
    return decoded.length === chunk.width * chunk.height ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function safeDecodeTilemapChunk(value: unknown): Uint32Array | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const chunk = value as TilemapChunk;
  if (![chunk.x, chunk.y, chunk.width, chunk.height].every(Number.isFinite) || chunk.width !== 32 || chunk.height !== 32 || typeof chunk.data !== 'string') return undefined;
  try {
    const decoded = decodeTilemapChunk(chunk);
    return decoded.length === chunk.width * chunk.height ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function pixelAt(sprite: PixelSprite, frameId: string, x: number, y: number): number {
  for (const { layer } of [...visibleSpriteLayers(sprite)].reverse()) {
    if (layer.type !== 'pixel') continue;
    const cel = celFor(sprite, layer.id, frameId);
    if (!cel) continue;
    const value = readPixel(cel, x, y);
    if (value !== 0) return value;
  }
  return 0;
}

function drawChecker(context: CanvasRenderingContext2D, width: number, height: number, cell = 8): void {
  context.fillStyle = '#f5f1eb'; context.fillRect(0, 0, width, height);
  context.fillStyle = '#e5e0d9';
  for (let y = 0; y < height; y += cell) for (let x = 0; x < width; x += cell) if ((x / cell + y / cell) % 2 === 0) context.fillRect(x, y, cell, cell);
}

function spriteBitmap(sprite: PixelSprite, frameId: string, palette: PixelDocument['palette']): HTMLCanvasElement {
  const canvas = window.document.createElement('canvas'); canvas.width = sprite.width; canvas.height = sprite.height;
  const context = canvas.getContext('2d')!; context.imageSmoothingEnabled = false;
  for (const { layer, opacity } of visibleSpriteLayers(sprite)) {
    if (layer.type !== 'pixel') continue;
    const cel = celFor(sprite, layer.id, frameId); if (!cel) continue; context.globalAlpha = opacity; context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
    for (const chunk of recordValues<PixelCel['chunks'][string]>(cel.chunks)) {
      const values = safeDecodePixelChunk(chunk); if (!values) continue;
      for (let y = 0; y < chunk.height; y += 1) for (let x = 0; x < chunk.width; x += 1) {
        const index = values[y * chunk.width + x] ?? 0; if (!index) continue;
        context.fillStyle = (sprite.paletteOverrides?.[frameId] ?? palette)[index]?.color ?? '#ff00ff'; context.fillRect(chunk.x + x, chunk.y + y, 1, 1);
      }
    }
  }
  return canvas;
}

function uniqueChanges(points: PixelPoint[], index: number): Array<{ x: number; y: number; index: number }> {
  const changes = new Map<string, { x: number; y: number; index: number }>();
  for (const point of points) changes.set(`${point.x},${point.y}`, { ...point, index });
  return [...changes.values()];
}

function brushPoints(center: PixelPoint, size: number): PixelPoint[] {
  const diameter = Math.max(1, Math.round(size));
  const start = -Math.floor((diameter - 1) / 2);
  const end = Math.ceil((diameter - 1) / 2);
  const points: PixelPoint[] = [];
  for (let y = start; y <= end; y += 1) for (let x = start; x <= end; x += 1) {
    if (diameter <= 2 || x * x + y * y <= (diameter / 2 + 0.25) ** 2) points.push({ x: center.x + x, y: center.y + y });
  }
  return points;
}

function rectangleOutline(start: PixelPoint, end: PixelPoint): PixelPoint[] {
  return [
    ...bresenham(start.x, start.y, end.x, start.y), ...bresenham(end.x, start.y, end.x, end.y),
    ...bresenham(end.x, end.y, start.x, end.y), ...bresenham(start.x, end.y, start.x, start.y),
  ];
}

function frameChanges(tool: string, start: PixelPoint, end: PixelPoint): PixelPoint[] {
  if (tool === 'line') return bresenham(start.x, start.y, end.x, end.y);
  if (tool === 'rectangle') return rectangleOutline(start, end);
  if (tool === 'ellipse') return ellipsePixels(start.x, start.y, end.x, end.y);
  return [];
}

function floodFill(sprite: PixelSprite, frameId: string, start: PixelPoint, replacement: number): PixelPoint[] {
  const target = pixelAt(sprite, frameId, start.x, start.y);
  if (target === replacement) return [];
  const result: PixelPoint[] = [];
  const queue = [start];
  const visited = new Set<string>();
  while (queue.length) {
    const point = queue.pop()!;
    const key = `${point.x},${point.y}`;
    if (visited.has(key) || point.x < 0 || point.y < 0 || point.x >= sprite.width || point.y >= sprite.height) continue;
    visited.add(key);
    if (pixelAt(sprite, frameId, point.x, point.y) !== target) continue;
    result.push(point);
    queue.push({ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 });
  }
  return result;
}

function floodSelect(sprite: PixelSprite, frameId: string, start: PixelPoint): PixelPoint[] {
  const target = pixelAt(sprite, frameId, start.x, start.y);
  const result: PixelPoint[] = []; const queue = [start]; const visited = new Set<string>();
  while (queue.length) {
    const point = queue.pop()!; const key = `${point.x},${point.y}`;
    if (visited.has(key) || point.x < 0 || point.y < 0 || point.x >= sprite.width || point.y >= sprite.height) continue;
    visited.add(key); if (pixelAt(sprite, frameId, point.x, point.y) !== target) continue; result.push(point);
    queue.push({ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 });
  }
  return result;
}

function rectangleFill(start: PixelPoint, end: PixelPoint): PixelPoint[] {
  const result: PixelPoint[] = [];
  for (let y = Math.min(start.y, end.y); y <= Math.max(start.y, end.y); y += 1) for (let x = Math.min(start.x, end.x); x <= Math.max(start.x, end.x); x += 1) result.push({ x, y });
  return result;
}

function pixelPerfect(points: PixelPoint[]): PixelPoint[] {
  const deduped = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()];
  if (deduped.length < 3) return deduped;
  const result = [deduped[0]];
  for (let index = 1; index < deduped.length - 1; index += 1) {
    const before = result.at(-1)!; const point = deduped[index]; const after = deduped[index + 1];
    const isCornerDouble = Math.abs(before.x - after.x) === 1 && Math.abs(before.y - after.y) === 1 && (point.x === before.x || point.y === before.y);
    if (!isCornerDouble) result.push(point);
  }
  result.push(deduped.at(-1)!); return result;
}

function bayerVisible(point: PixelPoint): boolean {
  const matrix = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  return matrix[((point.y % 4) + 4) % 4][((point.x % 4) + 4) % 4] < 8;
}

function bitmapTextPoints(text: string, origin: PixelPoint): PixelPoint[] {
  const canvas = window.document.createElement('canvas'); canvas.width = Math.max(1, text.length * 8); canvas.height = 10;
  const context = canvas.getContext('2d', { willReadFrequently: true })!; context.imageSmoothingEnabled = false; context.font = '8px monospace'; context.textBaseline = 'top'; context.fillStyle = '#fff'; context.fillText(text, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data; const points: PixelPoint[] = [];
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) if (data[(y * canvas.width + x) * 4 + 3] >= 128) points.push({ x: origin.x + x, y: origin.y + y });
  return points;
}

export function PixelCanvas({ document }: { document: PixelDocument }) {
  const asset = document.pixelAssets[document.activeAssetId];
  const tileset = asset?.type === 'tileset' ? asset : undefined;
  const sourceAsset = tileset ? document.pixelAssets[tileset.spriteAssetId] : undefined;
  const sprite = asset?.type === 'sprite' ? asset : sourceAsset?.type === 'sprite' ? sourceAsset : undefined;
  const tilemap = asset?.type === 'tilemap' ? asset : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [start, setStart] = useState<PixelPoint>();
  const [cursor, setCursor] = useState<PixelPoint>();
  const [preview, setPreview] = useState<PixelPoint[]>([]);
  const [selection, setSelection] = useState<PixelPoint[]>([]);
  const [lockPromise, setLockPromise] = useState<Promise<{ acquired: boolean; lockId?: string }>>();
  const [frameId, setFrameId] = useState(sprite?.frameIds[0]);
  const [playing, setPlaying] = useState(false);
  const [pingPong, setPingPong] = useState(false);
  const [playDirection, setPlayDirection] = useState<1 | -1>(1);
  const [onionSkin, setOnionSkin] = useState(true);
  const [wrapPreview, setWrapPreview] = useState(false);
  const [symmetry, setSymmetry] = useState<'none' | 'horizontal' | 'vertical' | 'both'>('none');
  const [paletteCycling, setPaletteCycling] = useState(false);
  const [paletteOffset, setPaletteOffset] = useState(0);
  const tool = useEditorStore((state) => state.selectedTool);
  const zoom = useEditorStore((state) => state.zoom);
  const setZoom = useEditorStore((state) => state.setZoom);
  const brushSize = useEditorStore((state) => state.brushSize);
  const pixelIndex = useEditorStore((state) => state.pixelIndex);
  const setPixelIndex = useEditorStore((state) => state.setPixelIndex);
  const apply = useEditorStore((state) => state.apply);
  const playbackMap = useEditorStore((state) => state.playbacks);
  const playbacks = Object.values(playbackMap).filter((entry) => entry.documentId === document.id);
  const activeFrameId = sprite?.frameIds.includes(frameId ?? '') ? frameId : sprite?.frameIds[0];
  const hasTimeline = Boolean(sprite && !tileset);

  useEffect(() => {
    if (!paletteCycling || document.palette.length <= 2) return;
    const timer = window.setInterval(() => setPaletteOffset((value) => (value + 1) % (document.palette.length - 1)), 180);
    return () => window.clearInterval(timer);
  }, [document.palette.length, paletteCycling]);

  useEffect(() => {
    if (!playing || !sprite || sprite.frameIds.length < 2) return;
    const currentIndex = sprite.frameIds.indexOf(activeFrameId ?? sprite.frameIds[0]);
    const current = sprite.frames[sprite.frameIds[Math.max(0, currentIndex)]];
    const timeout = window.setTimeout(() => {
      let nextDirection = playDirection; let nextIndex = currentIndex + nextDirection;
      if (pingPong && (nextIndex < 0 || nextIndex >= sprite.frameIds.length)) { nextDirection = nextDirection === 1 ? -1 : 1; setPlayDirection(nextDirection); nextIndex = currentIndex + nextDirection; }
      if (!pingPong) nextIndex = (currentIndex + 1) % sprite.frameIds.length;
      setFrameId(sprite.frameIds[Math.max(0, Math.min(sprite.frameIds.length - 1, nextIndex))]);
    }, current?.durationMs ?? 100);
    return () => window.clearTimeout(timeout);
  }, [activeFrameId, pingPong, playDirection, playing, sprite]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height - (hasTimeline ? 92 : 0)) }));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [hasTimeline]);

  const logical = useMemo(() => {
    if (sprite) return { width: sprite.width, height: sprite.height, unitX: 1, unitY: 1 };
    if (tilemap) return { width: tilemap.width, height: tilemap.height, unitX: tilemap.tileWidth, unitY: tilemap.tileHeight };
    return { width: 1, height: 1, unitX: 1, unitY: 1 };
  }, [sprite, tilemap]);

  const view: PixelView = useMemo(() => {
    const fit = Math.max(1, Math.floor(Math.min((size.width - 120) / logical.width, (size.height - 100) / logical.height)));
    const scale = Math.max(1, Math.round(fit * zoom));
    return {
      scale,
      offsetX: Math.round((size.width - logical.width * scale) / 2 + pan.x),
      offsetY: Math.round((size.height - logical.height * scale) / 2 + pan.y),
      logicalWidth: logical.width,
      logicalHeight: logical.height,
    };
  }, [logical, pan, size, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, size.width, size.height);
    context.save();
    context.translate(view.offsetX, view.offsetY);
    const replayMasks = collectReplayMasks(playbacks);
    if (sprite) {
      for (const [celId, points] of [...replayMasks.celPixels]) {
        const linkedCelId = sprite.cels[celId]?.linkedToCelId;
        if (!linkedCelId) continue;
        const linkedPoints = replayMasks.celPixels.get(linkedCelId) ?? new Set<string>();
        for (const point of points) linkedPoints.add(point);
        replayMasks.celPixels.set(linkedCelId, linkedPoints);
      }
    }
    context.shadowColor = 'rgba(47, 39, 63, .2)'; context.shadowBlur = 24; context.shadowOffsetY = 8;
    drawChecker(context, logical.width * view.scale, logical.height * view.scale, Math.max(4, view.scale));
    context.shadowColor = 'transparent';

    if (sprite && activeFrameId) {
      const paletteColor = (index: number) => {
        if (!index) return document.palette[0]?.color ?? '#00000000';
        const cycled = paletteCycling && document.palette.length > 1 ? 1 + ((index - 1 + paletteOffset) % (document.palette.length - 1)) : index;
        return (sprite.paletteOverrides[activeFrameId] ?? document.palette)[cycled]?.color ?? '#ff00ff';
      };
      const drawFrame = (targetFrame: string, alpha: number, tint?: string) => {
        context.globalAlpha = alpha;
        for (const entry of visibleSpriteLayers(sprite)) {
          const { layer } = entry;
          if (layer.type !== 'pixel') continue;
          const cel = celFor(sprite, layer.id, targetFrame);
          if (!cel) continue;
          const hiddenPixels = replayMasks.celPixels.get(cel.id);
          context.globalAlpha = alpha * entry.opacity; context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;
          for (const chunk of recordValues<PixelCel['chunks'][string]>(cel.chunks)) {
            const values = safeDecodePixelChunk(chunk); if (!values) continue;
            for (let localY = 0; localY < chunk.height; localY += 1) for (let localX = 0; localX < chunk.width; localX += 1) {
              const x = chunk.x + localX;
              const y = chunk.y + localY;
              if (x < 0 || y < 0 || x >= sprite.width || y >= sprite.height) continue;
              if (hiddenPixels?.has(replayPointKey(x, y))) continue;
              const paletteIndex = values[localY * chunk.width + localX] ?? 0;
              if (paletteIndex === 0) continue;
              context.fillStyle = tint ?? paletteColor(paletteIndex);
              context.fillRect(x * view.scale, y * view.scale, view.scale, view.scale);
            }
          }
        }
      };
      if (onionSkin && sprite.frameIds.length > 1) {
        const index = sprite.frameIds.indexOf(activeFrameId);
        if (index > 0) drawFrame(sprite.frameIds[index - 1], 0.22, '#51bfc0');
        if (index < sprite.frameIds.length - 1) drawFrame(sprite.frameIds[index + 1], 0.18, '#ef7297');
      }
      drawFrame(activeFrameId, 1);
      if (wrapPreview) {
        context.globalAlpha = 0.25;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          context.save(); context.translate(Number(dx) * sprite.width * view.scale, Number(dy) * sprite.height * view.scale); drawFrame(activeFrameId, 1); context.restore();
        }
      }
      context.globalCompositeOperation = 'source-over';
      if (tileset) {
        context.globalAlpha = 1; context.strokeStyle = 'rgba(45, 36, 59, .55)'; context.lineWidth = 1.5;
        context.beginPath();
        for (let x = 0; x <= sprite.width; x += tileset.tileWidth) { context.moveTo(x * view.scale + 0.5, 0); context.lineTo(x * view.scale + 0.5, sprite.height * view.scale); }
        for (let y = 0; y <= sprite.height; y += tileset.tileHeight) { context.moveTo(0, y * view.scale + 0.5); context.lineTo(sprite.width * view.scale, y * view.scale + 0.5); }
        context.stroke();
      }
    } else if (tilemap) {
      const mapSources = new Map<string, HTMLCanvasElement>();
      const visibleLayers: Array<{ layer: typeof tilemap.layers[string]; opacity: number }> = []; const visit = (id: string, opacity = 1) => { const layer = tilemap.layers[id]; if (!layer?.visible) return; const combined = opacity * layer.opacity; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined); else visibleLayers.push({ layer, opacity: combined }); }; for (const id of tilemap.layerIds) visit(id);
      for (const entry of visibleLayers) {
        const { layer } = entry;
        if (layer.type !== 'tile' || !layer.chunks) continue;
        const hiddenCells = replayMasks.tileCells.get(replayTileLayerKey(tilemap.id, layer.id));
        context.globalAlpha = entry.opacity;
        for (const chunk of Object.values(layer.chunks)) {
          const values = safeDecodeTilemapChunk(chunk); if (!values) continue;
          for (let localY = 0; localY < 32; localY += 1) for (let localX = 0; localX < 32; localX += 1) {
            const raw = values[localY * 32 + localX] ?? 0; const decoded = decodeTiledGid(raw);
            if (!decoded.gid) continue;
            const x = chunk.x + localX;
            const y = chunk.y + localY;
            if (hiddenCells?.has(replayPointKey(x, y))) continue;
            const resolved = resolveTilesetForGid(document, tilemap, decoded.gid); const mapSourceAsset = resolved ? document.pixelAssets[resolved.tileset.spriteAssetId] : undefined;
            let mapSource = mapSourceAsset?.type === 'sprite' ? mapSources.get(mapSourceAsset.id) : undefined; if (!mapSource && mapSourceAsset?.type === 'sprite') { mapSource = spriteBitmap(mapSourceAsset, mapSourceAsset.frameIds[0], document.palette); mapSources.set(mapSourceAsset.id, mapSource); }
            const definition = resolved?.tileset.tiles[resolved.localId]; const sourceX = resolved ? definition?.sourceX ?? resolved.localId % resolved.tileset.columns * resolved.tileset.tileWidth : 0;
            const sourceY = resolved ? definition?.sourceY ?? Math.floor(resolved.localId / resolved.tileset.columns) * resolved.tileset.tileHeight : 0;
            const drawTile = (screenX: number, screenY: number) => { if (!mapSource || !resolved) return false; context.save(); context.translate(screenX + view.scale / 2, screenY + view.scale / 2); if (decoded.diagonal) { context.rotate(Math.PI / 2); context.scale(1, -1); } context.scale(decoded.hFlip ? -1 : 1, decoded.vFlip ? -1 : 1); context.drawImage(mapSource, sourceX, sourceY, resolved.tileset.tileWidth, resolved.tileset.tileHeight, -view.scale / 2, -view.scale / 2, view.scale, view.scale); context.restore(); return true; };
            if (tilemap.orientation === 'orthogonal') {
              if (!drawTile(x * view.scale, y * view.scale)) { context.fillStyle = `hsl(${decoded.gid * 47 % 360} 52% 62%)`; context.fillRect(x * view.scale, y * view.scale, view.scale, view.scale); }
            } else {
              const screenX = (x - y) * view.scale / 2 + logical.width * view.scale / 2;
              const screenY = (x + y) * view.scale / 4;
              if (!drawTile(screenX - view.scale / 2, screenY - view.scale / 2)) { context.fillStyle = `hsl(${decoded.gid * 47 % 360} 52% 62%)`; context.beginPath(); context.moveTo(screenX, screenY); context.lineTo(screenX + view.scale / 2, screenY + view.scale / 4); context.lineTo(screenX, screenY + view.scale / 2); context.lineTo(screenX - view.scale / 2, screenY + view.scale / 4); context.closePath(); context.fill(); }
            }
          }
        }
      }
    }

    if (preview.length) {
      const drawIndex = tool === 'eraser' ? 0 : pixelIndex;
      context.globalAlpha = 0.78;
      context.fillStyle = drawIndex === 0 ? '#ffffff80' : document.palette[drawIndex]?.color ?? '#ff00ff';
      for (const point of preview) if (point.x >= 0 && point.y >= 0 && point.x < logical.width && point.y < logical.height) {
        context.fillRect(point.x * view.scale, point.y * view.scale, view.scale, view.scale);
      }
    }

    if (selection.length) {
      context.globalAlpha = 1; context.strokeStyle = '#ffffff'; context.lineWidth = Math.max(1, view.scale / 8); context.setLineDash([Math.max(2, view.scale / 3), Math.max(2, view.scale / 3)]);
      context.lineDashOffset = -(Date.now() / 120) % 8;
      for (const point of selection) context.strokeRect(point.x * view.scale + 0.5, point.y * view.scale + 0.5, view.scale - 1, view.scale - 1);
      context.strokeStyle = '#4f3f68'; context.lineDashOffset += Math.max(2, view.scale / 3); for (const point of selection) context.strokeRect(point.x * view.scale + 0.5, point.y * view.scale + 0.5, view.scale - 1, view.scale - 1); context.setLineDash([]);
    }

    for (const playback of playbacks) {
      context.globalAlpha = 1;
      for (const operation of playback.operations) {
        if (operation.kind === 'pixel.cel.set' && sprite && operation.spriteId === sprite.id) {
          const targetCel = sprite.cels[operation.celId];
          if (!targetCel || targetCel.frameId !== activeFrameId) continue;
          const changes = Array.isArray(operation.changes) ? operation.changes : [];
          for (const change of changes) {
            if (![change.x, change.y, change.index].every(Number.isFinite)) continue;
            context.fillStyle = change.index === 0 ? '#ffffff80' : document.palette[change.index]?.color ?? playback.actor.color;
            context.fillRect(change.x * view.scale, change.y * view.scale, view.scale, view.scale);
          }
        } else if (operation.kind === 'pixel.tilemap.set' && tilemap && operation.mapId === tilemap.id) {
          const changes = Array.isArray(operation.changes) ? operation.changes : [];
          for (const change of changes) {
            if (![change.x, change.y, change.gid].every(Number.isFinite)) continue;
            context.fillStyle = change.gid === 0 ? '#ffffff80' : `hsl(${(change.gid * 47) % 360} 52% 62%)`;
            context.fillRect(change.x * view.scale, change.y * view.scale, view.scale, view.scale);
          }
        }
      }
    }

    if (view.scale >= 8 && (sprite || tilemap?.orientation === 'orthogonal')) {
      context.globalAlpha = 1; context.strokeStyle = 'rgba(45, 36, 59, .14)'; context.lineWidth = 1;
      context.beginPath();
      for (let x = 0; x <= logical.width; x += 1) { context.moveTo(x * view.scale + 0.5, 0); context.lineTo(x * view.scale + 0.5, logical.height * view.scale); }
      for (let y = 0; y <= logical.height; y += 1) { context.moveTo(0, y * view.scale + 0.5); context.lineTo(logical.width * view.scale, y * view.scale + 0.5); }
      context.stroke();
    }
    context.restore();
  }, [activeFrameId, document, logical, onionSkin, paletteCycling, paletteOffset, pixelIndex, playbacks, preview, selection, size, sprite, tilemap, tileset, tool, view, wrapPreview]);

  const toPixel = (event: ReactPointerEvent<HTMLCanvasElement>): PixelPoint => clientPointToPixel(
    event.clientX,
    event.clientY,
    event.currentTarget.getBoundingClientRect(),
    size,
    view,
  );

  const withSymmetry = (points: PixelPoint[]): PixelPoint[] => {
    if (!sprite || symmetry === 'none') return points;
    return points.flatMap((point) => {
      const variants = [point];
      if (symmetry === 'horizontal' || symmetry === 'both') variants.push({ x: sprite.width - 1 - point.x, y: point.y });
      if (symmetry === 'vertical' || symmetry === 'both') variants.push({ x: point.x, y: sprite.height - 1 - point.y });
      if (symmetry === 'both') variants.push({ x: sprite.width - 1 - point.x, y: sprite.height - 1 - point.y });
      return variants;
    });
  };

  const updatePreview = (from: PixelPoint, point: PixelPoint): void => {
    if (tool === 'select' || tool === 'lasso') setPreview(rectangleFill(from, point));
    else if (['line', 'rectangle', 'ellipse'].includes(tool)) setPreview(withSymmetry(frameChanges(tool, from, point)));
    else {
      const line = cursor ? bresenham(cursor.x, cursor.y, point.x, point.y) : [point];
      let points = line.flatMap((entry) => tool === 'stamp'
        ? [{ x: entry.x, y: entry.y }, { x: entry.x - 1, y: entry.y }, { x: entry.x + 1, y: entry.y }, { x: entry.x, y: entry.y - 1 }, { x: entry.x, y: entry.y + 1 }]
        : brushPoints(entry, brushSize));
      if (tool === 'dither') points = points.filter(bayerVisible);
      setPreview((current) => {
        const combined = [...current, ...withSymmetry(points)];
        return tool === 'pencil' && brushSize === 1 ? pixelPerfect(combined) : combined;
      });
    }
  };

  const onPointerDown = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPixel(event);
    if (tool === 'zoom') { setZoom(zoom * (event.shiftKey ? 0.5 : 2)); return; }
    if (tool === 'hand' || event.button === 1) { setStart(point); setCursor(point); return; }
    if (!sprite && !tilemap) return;
    if (tool === 'eyedropper' && sprite && activeFrameId) {
      const value = pixelAt(sprite, activeFrameId, point.x, point.y);
      setPixelIndex(value);
      const color = document.palette[value]?.color;
      if (color) useEditorStore.getState().setColor(color.slice(0, 7));
      return;
    }
    if (tool === 'wand' && sprite && activeFrameId) { setSelection(floodSelect(sprite, activeFrameId, point)); setPreview([]); return; }
    if (tool === 'select' || tool === 'lasso') { setStart(point); setCursor(point); setPreview([point]); return; }
    if (tool === 'text' && sprite && activeFrameId) {
      const text = window.prompt('Bitmap text'); if (!text) return; const points = bitmapTextPoints(text, point).filter((entry) => entry.x >= 0 && entry.y >= 0 && entry.x < sprite.width && entry.y < sprite.height); if (!points.length) return;
      const xs = points.map((entry) => entry.x); const ys = points.map((entry) => entry.y); const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 } });
      if (!lock.acquired) return; const layerId = editableSpriteLayer(sprite)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined;
      if (cel) await apply('Add bitmap text', [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: uniqueChanges(points, pixelIndex), expectedRevision: cel.revision }]); if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); return;
    }
    const bounds = sprite ? { width: sprite.width, height: sprite.height, kind: 'pixel' as const } : { width: tilemap!.width, height: tilemap!.height, kind: 'tile' as const };
    setLockPromise(window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: bounds.kind, assetId: sprite?.id ?? asset!.id, x: 0, y: 0, width: bounds.width, height: bounds.height } }));
    setStart(point); setCursor(point);
    if (tool === 'fill' && sprite && activeFrameId) setPreview(floodFill(sprite, activeFrameId, point, pixelIndex));
    else if (tool === 'replace' && sprite && activeFrameId) {
      const source = pixelAt(sprite, activeFrameId, point.x, point.y);
      const points: PixelPoint[] = [];
      for (let y = 0; y < sprite.height; y += 1) for (let x = 0; x < sprite.width; x += 1) if (pixelAt(sprite, activeFrameId, x, y) === source) points.push({ x, y });
      setPreview(points);
    } else updatePreview(point, point);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toPixel(event);
    if (!start) { setCursor(point); return; }
    if (tool === 'hand' || event.button === 1) {
      setPan((current) => ({ x: current.x + event.movementX, y: current.y + event.movementY }));
    } else updatePreview(start, point);
    setCursor(point);
  };

  const finish = async () => {
    const pendingLock = lockPromise;
    const points = preview.filter((point) => tilemap?.infinite || (point.x >= 0 && point.y >= 0 && point.x < logical.width && point.y < logical.height));
    setStart(undefined); setPreview([]);
    if (tool === 'select' || tool === 'lasso') { setSelection(points); return; }
    if (points.length === 0) { const emptyLock = await pendingLock; setLockPromise(undefined); if (emptyLock?.lockId) await window.aidraw.releaseHumanLock(emptyLock.lockId); return; }
    const lock = await pendingLock;
    setLockPromise(undefined);
    if (!lock?.acquired) return;
    if (sprite && activeFrameId) {
      const layerId = editableSpriteLayer(sprite)?.id;
      const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined;
      if (cel) {
        const changes = tool === 'lighten' || tool === 'darken'
          ? [...new Map(points.map((point) => [`${point.x},${point.y}`, { ...point, index: Math.max(1, Math.min(document.palette.length - 1, pixelAt(sprite, activeFrameId, point.x, point.y) + (tool === 'lighten' ? 1 : -1))) }])).values()]
          : uniqueChanges(points, tool === 'eraser' ? 0 : pixelIndex);
        await apply(`${tool === 'eraser' ? 'Erase' : 'Draw'} pixels`, [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes, expectedRevision: cel.revision }]);
      }
    } else if (tilemap) {
      const layerId = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked)?.id;
      const layer = layerId ? tilemap.layers[layerId] : undefined;
      const terrainTileset = tilemap.tilesetIds.map((id) => document.pixelAssets[id]).find((entry) => entry?.type === 'tileset');
      const wangSet = terrainTileset?.type === 'tileset' ? terrainTileset.wangSets[0] : undefined; const terrainColor = wangSet?.colors[0]?.id;
      const desired = terrainColor ? { top: terrainColor, topRight: terrainColor, right: terrainColor, bottomRight: terrainColor, bottom: terrainColor, bottomLeft: terrainColor, left: terrainColor, topLeft: terrainColor } : {};
      const terrainTile = wangSet ? selectWangTile(wangSet, desired) ?? wangSet.tiles.find((entry) => entry.wangId.includes(terrainColor ?? -1)) : undefined;
      const firstGid = terrainTileset?.type === 'tileset' ? terrainTileset.firstGid : 1;
      const gid = tool === 'eraser' ? 0 : tool === 'terrain' && terrainTile ? terrainTile.tileId + firstGid : firstGid + Math.max(1, pixelIndex) - 1;
      if (layerId && layer) await apply(tool === 'terrain' ? 'Paint Wang terrain' : 'Paint tiles', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes: points.map((point) => ({ ...point, gid })), expectedRevision: layer.revision }]);
    }
    if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId);
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey) setZoom(zoom * (event.deltaY > 0 ? 0.5 : 2));
    else setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
  };

  const addFrame = async (linked: boolean) => {
    if (!sprite) return;
    const timestamp = nowIso();
    const newFrameId = createId('frame');
    const frame = { id: newFrameId, revision: 0, name: `Frame ${sprite.frameIds.length + 1}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, durationMs: 100 };
    const cels = Object.values(sprite.layers).filter((layer) => layer.type === 'pixel').map((layer) => {
      const layerId = layer.id;
      const source = activeFrameId ? celFor(sprite, layerId, activeFrameId) : undefined;
      return {
        id: createId('cel'), revision: 0, name: `${sprite.layers[layerId].name} · ${frame.name}`, createdAt: timestamp, updatedAt: timestamp,
        createdBy: HUMAN_ACTOR.id, layerId, frameId: newFrameId, chunks: {}, linkedToCelId: linked ? source?.id : undefined,
      };
    });
    if (await apply(linked ? 'Add linked frame' : 'Add frame', [{ kind: 'pixel.frame.add', spriteId: sprite.id, frame, cels, expectedRevision: sprite.revision }])) setFrameId(newFrameId);
  };

  const editFrameDuration = async (id: string) => {
    if (!sprite) return; const current = sprite.frames[id]; const value = window.prompt('Frame duration in milliseconds', String(current.durationMs)); if (!value) return; const durationMs = Math.max(1, Math.min(60_000, Number(value))); if (!Number.isFinite(durationMs)) return;
    await apply('Change frame duration', [{ kind: 'pixel.frame.replace', spriteId: sprite.id, frame: { ...current, durationMs }, expectedRevision: current.revision }]);
  };

  const addTag = async () => {
    if (!sprite) return; const name = window.prompt('Animation tag name', `Animation ${sprite.tags.length + 1}`); if (!name) return; const next = structuredClone(sprite);
    next.tags.push({ id: createId('tag'), name, fromFrameId: next.frameIds[0], toFrameId: next.frameIds.at(-1)!, direction: pingPong ? 'ping-pong' : 'forward', color: '#31a6a0' });
    await apply('Add animation tag', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }]);
  };

  if (!asset) return <div className="empty-canvas">No pixel asset selected.</div>;
  if (asset.type === 'tileset' && !sprite) return <div className="empty-canvas"><Grid3X3 size={36} /><strong>Missing tileset pixels</strong><span>The linked source sprite is unavailable.</span></div>;

  return (
    <div className="canvas-container pixel-canvas-container" ref={containerRef}>
      <canvas
        ref={canvasRef}
        role="application"
        aria-label={`Pixel-art canvas for ${document.name}`}
        tabIndex={0}
        className={`drawing-canvas pixel-canvas tool-${tool}`}
        style={{ width: size.width, height: size.height }}
        onPointerDown={(event) => void onPointerDown(event)}
        onPointerMove={onPointerMove}
        onPointerUp={() => void finish()}
        onPointerCancel={() => void finish()}
        onPointerLeave={() => !start && setCursor(undefined)}
        onWheel={onWheel}
      />
      {tileset && <div className="tileset-canvas-label"><Grid3X3 size={14} /><span><strong>Tileset source</strong><small>{tileset.tileWidth} × {tileset.tileHeight}px cells · metadata in Layers</small></span></div>}
      <div className="pixel-floating-controls">
        {hasTimeline && <button className={onionSkin ? 'is-active' : ''} onClick={() => setOnionSkin((value) => !value)} title="Onion skin"><Eye size={14} /> Onion</button>}
        <button className={wrapPreview ? 'is-active' : ''} onClick={() => setWrapPreview((value) => !value)} title="Tile wrap preview"><Repeat2 size={14} /> Wrap</button>
        {sprite && <button className={symmetry !== 'none' ? 'is-active' : ''} onClick={() => setSymmetry((value) => value === 'none' ? 'horizontal' : value === 'horizontal' ? 'vertical' : value === 'vertical' ? 'both' : 'none')} title="Cycle symmetry: none, horizontal, vertical, both"><FlipHorizontal2 size={14} /> {symmetry === 'none' ? 'Sym' : symmetry[0].toUpperCase()}</button>}
        {sprite && <button className={paletteCycling ? 'is-active' : ''} onClick={() => { if (paletteCycling) setPaletteOffset(0); setPaletteCycling(!paletteCycling); }} title="Palette cycling preview"><Repeat2 size={14} /> Cycle</button>}
        {selection.length > 0 && <button onClick={() => setSelection([])} title="Clear selection">Clear</button>}
        <span>{cursor ? `${cursor.x}, ${cursor.y}` : '—, —'}</span>
      </div>
      {hasTimeline && sprite && (
        <div className="timeline">
          <div className="timeline-playback"><button onClick={() => setFrameId(sprite.frameIds[Math.max(0, sprite.frameIds.indexOf(activeFrameId ?? '') - 1)])}><ChevronLeft size={15} /></button><button className="play-button" onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button><button onClick={() => setFrameId(sprite.frameIds[Math.min(sprite.frameIds.length - 1, sprite.frameIds.indexOf(activeFrameId ?? '') + 1)])}><ChevronRight size={15} /></button><button className={pingPong ? 'is-active' : ''} title="Ping-pong playback" onClick={() => { setPingPong((value) => !value); setPlayDirection(1); }}><Repeat2 size={14} /></button></div>
          <div className="timeline-label"><strong>Animation</strong><small>{sprite.frameIds.length} frames · {sprite.tags.length} tags</small><button onClick={() => void addTag()}>+ Tag</button></div>
          <div className="frame-strip">
            {sprite.frameIds.map((id, index) => <button key={id} className={id === activeFrameId ? 'is-active' : ''} onClick={() => setFrameId(id)} onDoubleClick={() => void editFrameDuration(id)} title="Double-click to edit duration"><span className="frame-thumb"><Grid3X3 size={13} /></span><small>{index + 1}</small><em>{sprite.frames[id]?.durationMs ?? 100}ms</em></button>)}
            <button className="add-frame" title="Add frame (Alt: linked cel)" onClick={(event) => void addFrame(event.altKey)}>+</button>
          </div>
        </div>
      )}
    </div>
  );
}
