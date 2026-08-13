import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import {
  decodeTiledGid,
  decodeTilemapChunk,
  encodeTiledGid,
  capturePixelStamp,
  captureTileStamp,
  bitmapTextCells,
  measureBitmapText,
  createPixelCelReader,
  cycledPaletteIndex,
  deletePixelAnimationTag,
  duplicatePixelFrame,
  ellipsePixels,
  floodPixelRegion,
  HUMAN_ACTOR,
  createId,
  nowIso,
  orderedDitherIndex,
  paintWangTerrain,
  pixelAnimationFrames,
  pixelCelForFrame,
  pixelRawCelForFrame,
  pixelPerfectStrokePoints,
  placePixelStamp,
  placeTileStamp,
  readPixel,
  readTileAt,
  replacePixelRegion,
  reorderPixelFrame,
  resolveTilesetForGid,
  setPixelCelLinked,
  setPixelFrameCelsLinked,
  setPixelFramePaletteOverride,
  stepPaletteByLuminance,
  tiledTileTransformMatrix,
  transformPixelStamp,
  transformTileStamp,
  upsertPixelAnimationTag,
  type CanvasOperation,
  type CollisionShape,
  type BitmapFont,
  type PixelIndexRun,
  type PixelRegionResult,
  type PixelDocument,
  type PixelSprite,
  type PixelStamp,
  type PixelStampTransform,
  type TileStamp,
  type TilemapChunk,
} from '@aidraw/core';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Dices, Eraser, Eye, FlipHorizontal2, FlipVertical2, Grid3X3, Link2, Move, Palette, Pause, Play, Repeat2, RotateCcw, RotateCw, Scaling, Scissors, SlidersHorizontal, Table2, Trash2, Unlink2 } from 'lucide-react';
import { useEditorStore } from '../store';
import { CelExposureGrid } from '../components/CelExposureGrid';
import { OnionSkinSettingsPanel } from '../components/OnionSkinSettingsPanel';
import { PlaybackLanes } from '../components/PlaybackLanes';
import { StampLibraryDialog } from '../components/StampLibraryDialog';
import { collectReplayMasks, replayPointKey, replayTileLayerKey } from '../replay';
import { EditorDialog, EntryDialog } from '../components/EditorDialog';
import { bresenham } from './geometry';
import { clientPointToIsometricCoordinate, clientPointToIsometricTile, clientPointToOrthogonalCoordinate, clientPointToOrthogonalTile, clientPointToPixel } from './pixel-coordinates';
import { pixelSelectionBounds, transformPixelSelection, type PixelSelectionTransform } from '../../common/pixel-selection';
import { captureGridSelection, combineGridSelection, placeGridClipboard, rasterizeGridLasso, scaleGridSelection, transformGridSelection, type GridSelectionClipboard } from '../../common/grid-selection';
import { deleteMapObjectPoint, insertMapObjectPoint, mapObjectAtPoint, mapObjectBounds, moveMapObjectPoint, nearestMapObjectSegment, transformMapObject } from '../../common/map-objects';
import { isometricCellRect, isometricCoordinateDeltaFromScreen, isometricObjectMatrix, isometricProjectionExtent, type IsometricCellRect } from '../../common/isometric-projection';
import { drawMapObjectOverlay } from '../../common/map-object-render';
import { orthogonalCellRect, orthogonalCoordinateDeltaFromScreen, orthogonalObjectMatrix, orthogonalProjectionExtent } from '../../common/orthogonal-projection';
import { TILE_VARIANT_SEED_PROPERTY, chooseTileVariant, nextTileVariantSeed, tileVariantCandidates, tileVariantGroup } from '../../common/tile-variants';
import { isometricTileRenderCells } from '../../common/tile-render-order';
import { coveringRasterViewportRegion, tilemapChunksIntersectingRegion, tilemapGridLineRange } from '../../common/tilemap-region';
import { DEFAULT_ONION_SKIN_SETTINGS, onionSkinLayers, type OnionSkinSettings } from '../../common/onion-skin';
import { tileAnimationFrameAt, tilesetTileSourceRect } from '../../common/tile-animation';
import { parseBitmapFontJson } from '../../common/bitmap-font-interchange';
import { cancelPixelGesture, releasePendingPixelLocks } from '../../common/pixel-gesture';
import { BoundedResourceCache } from '../../common/bounded-resource-cache';
import { drawPixelSpriteRegion, pixelSpriteRegionPlan } from '../../common/pixel-sprite-render';
import { editableSpriteLayer, spriteRegionBitmap, visibleSpriteLayers, type SpriteRegionBitmap } from './pixel-bitmap';

interface PixelPoint { x: number; y: number }
interface PixelView { scale: number; offsetX: number; offsetY: number; logicalWidth: number; logicalHeight: number }
interface TagDraft { id?: string; name: string; fromFrameId: string; toFrameId: string; direction: 'forward' | 'reverse' | 'ping-pong'; color: string }
interface MapObjectGesture { layerId: string; objectId: string; mode: 'move' | 'resize' | 'point'; pointIndex?: number; start: PixelPoint; current: PixelPoint; original: CollisionShape; lockPromise: Promise<{ acquired: boolean; lockId?: string }> }
type SelectionCombination = 'replace' | 'add' | 'subtract' | 'intersect';
type PixelSelectionCommand = 'copy' | 'cut' | 'paste' | 'delete' | 'clear' | 'select-all';
type LocalSelectionClipboard =
  | { kind: 'pixel'; sourceDocumentId: string; grid: GridSelectionClipboard<number>; palette: string[] }
  | { kind: 'tile'; sourceDocumentId: string; grid: GridSelectionClipboard<number> };

let localSelectionClipboard: LocalSelectionClipboard | undefined;
const MIN_TILE_ANIMATION_TICK_MS = 16;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;
const MAX_MAP_TILE_SOURCE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_MAP_TILE_SOURCE_CACHE_ENTRIES = 1_024;

function parseIntegerScale(value: string): { x: number; y: number } | undefined {
  const match = value.trim().match(/^(\d+)(?:\s*(?:x|×|,)\s*(\d+))?$/i); if (!match) return undefined;
  const x = Number(match[1]); const y = Number(match[2] ?? match[1]);
  return Number.isInteger(x) && Number.isInteger(y) && x >= 1 && x <= 64 && y >= 1 && y <= 64 ? { x, y } : undefined;
}

function previewMapObject(gesture: MapObjectGesture): CollisionShape {
  const delta = { x: gesture.current.x - gesture.start.x, y: gesture.current.y - gesture.start.y };
  return gesture.mode === 'point' ? moveMapObjectPoint(gesture.original, gesture.pointIndex ?? -1, delta) : transformMapObject(gesture.original, gesture.mode, delta);
}

const celFor = pixelCelForFrame;

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

function compositePixelReader(sprite: PixelSprite, frameId: string): (x: number, y: number) => number {
  const readers = [...visibleSpriteLayers(sprite)].reverse().flatMap(({ layer }) => {
    if (layer.type !== 'pixel') return [];
    const cel = celFor(sprite, layer.id, frameId);
    return cel ? [createPixelCelReader(cel)] : [];
  });
  return (x, y) => {
    for (const read of readers) {
      const value = read(x, y);
      if (value !== 0) return value;
    }
    return 0;
  };
}

function pixelRegionPoints(runs: Array<{ x: number; y: number; length: number }>): PixelPoint[] {
  return runs.flatMap((run) => Array.from({ length: run.length }, (_, offset) => ({ x: run.x + offset, y: run.y })));
}

function pixelToolLimitMessage(action: string, result: Extract<PixelRegionResult, { ok: false }>): string {
  const limit = result.limit === 1_000_000 ? 'one million' : result.limit.toLocaleString('en-US');
  return `${action} is limited to ${limit} ${result.reason === 'cells' ? 'cells' : 'row runs'}; nothing was changed.`;
}

function drawChecker(context: CanvasRenderingContext2D, width: number, height: number, cell = 8): void {
  context.fillStyle = '#f5f1eb'; context.fillRect(0, 0, width, height);
  context.fillStyle = '#e5e0d9';
  for (let y = 0; y < height; y += cell) for (let x = 0; x < width; x += cell) if ((x / cell + y / cell) % 2 === 0) context.fillRect(x, y, cell, cell);
}

function traceIsometricCell(context: CanvasRenderingContext2D, rect: IsometricCellRect): void {
  context.beginPath();
  context.moveTo(rect.x + rect.width / 2, rect.y);
  context.lineTo(rect.x + rect.width, rect.y + rect.height / 2);
  context.lineTo(rect.x + rect.width / 2, rect.y + rect.height);
  context.lineTo(rect.x, rect.y + rect.height / 2);
  context.closePath();
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

function rectangleFill(start: PixelPoint, end: PixelPoint): PixelPoint[] {
  const result: PixelPoint[] = [];
  for (let y = Math.min(start.y, end.y); y <= Math.max(start.y, end.y); y += 1) for (let x = Math.min(start.x, end.x); x <= Math.max(start.x, end.x); x += 1) result.push({ x, y });
  return result;
}

interface BitmapTextRequest { text: string; fontId: string; letterSpacing: number; lineSpacing: number; scale: number; align: 'left' | 'center' | 'right' }

function BitmapTextDialog({ fonts, origin, spriteSize, paletteIndex, onSubmit, onFontsReplace, onClose }: { fonts: BitmapFont[]; origin: PixelPoint; spriteSize: { width: number; height: number }; paletteIndex: number; onSubmit: (request: BitmapTextRequest) => Promise<void>; onFontsReplace: (fonts: BitmapFont[]) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState('PIXEL'); const [fontId, setFontId] = useState(fonts[0]?.id ?? ''); const [letterSpacing, setLetterSpacing] = useState(0); const [lineSpacing, setLineSpacing] = useState(0); const [scale, setScale] = useState(1); const [align, setAlign] = useState<BitmapTextRequest['align']>('left'); const [busy, setBusy] = useState(false); const [importError, setImportError] = useState<string>(); const font = fonts.find((entry) => entry.id === fontId) ?? fonts[0];
  const options = { x: origin.x, y: origin.y, letterSpacing, lineSpacing, scale, align }; const points = font ? bitmapTextCells(font, text, options) : []; const footprint = font ? measureBitmapText(font, text, options) : { width: 0, height: 0 }; const visible = points.some((point) => point.x >= 0 && point.y >= 0 && point.x < spriteSize.width && point.y < spriteSize.height); const local = points.length ? { minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)), maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)) } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const importFont = async (file: File) => {
    setImportError(undefined);
    try {
      if (file.size > 1024 * 1024) throw new Error('Bitmap font JSON is limited to 1 MiB.');
      const next = parseBitmapFontJson(await file.text(), fonts.map((entry) => entry.id));
      if (!(await onFontsReplace([...fonts, next]))) throw new Error('The bitmap font could not be added to this document.');
      setFontId(next.id);
    } catch (error) { setImportError(error instanceof Error ? error.message : String(error)); }
  };
  return <EditorDialog title="Add bitmap text" description="Document-owned glyphs render identically in the editor, headless MCP, replay, and export." className="bitmap-text-dialog" onClose={onClose}>
    <div className="bitmap-text-body">
      <label className="dialog-field"><span>Text</span><textarea autoFocus rows={3} maxLength={2_000} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <div className="bitmap-font-row"><label className="dialog-field"><span>Bitmap font asset</span><select value={font?.id ?? ''} onChange={(event) => setFontId(event.target.value)}>{fonts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ version: 1, font }, null, 2))}>Copy font JSON</button><label className="bitmap-font-import">Import JSON<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importFont(file); }} /></label></div>
      {importError && <p className="entry-dialog-error" role="alert">{importError}</p>}
      <div className="bitmap-text-options"><label><span>Scale</span><input type="number" min="1" max="16" value={scale} onChange={(event) => setScale(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label><label><span>Letter gap</span><input type="number" min="0" max="32" value={letterSpacing} onChange={(event) => setLetterSpacing(Math.max(0, Math.min(32, Number(event.target.value) || 0)))} /></label><label><span>Line gap</span><input type="number" min="0" max="64" value={lineSpacing} onChange={(event) => setLineSpacing(Math.max(0, Math.min(64, Number(event.target.value) || 0)))} /></label><label><span>Anchor</span><select value={align} onChange={(event) => setAlign(event.target.value as BitmapTextRequest['align'])}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label></div>
      <div className="bitmap-glyph-preview"><svg viewBox={`${local.minX} ${local.minY} ${Math.max(1, local.maxX - local.minX + 1)} ${Math.max(1, local.maxY - local.minY + 1)}`} preserveAspectRatio="xMidYMid meet" aria-label="Bitmap text glyph preview">{points.slice(0, 20_000).map((point) => <rect key={`${point.x},${point.y}`} x={point.x} y={point.y} width="1" height="1" />)}</svg><span><strong>{footprint.width} × {footprint.height}px</strong><small>palette index {paletteIndex} · anchor {origin.x}, {origin.y}</small></span></div>
      {!visible && <div className="entry-dialog-error">The text falls completely outside the sprite.</div>}
    </div>
    <footer className="modal-footer"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary-modal-button" disabled={busy || !font || !text.trim() || !visible} onClick={async () => { if (!font) return; setBusy(true); try { await onSubmit({ text, fontId: font.id, letterSpacing, lineSpacing, scale, align }); } finally { setBusy(false); } }}>{busy ? 'Painting…' : 'Paint editable pixels'}</button></footer>
  </EditorDialog>;
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
  const [bulkPreview, setBulkPreview] = useState<PixelIndexRun[]>([]);
  const [selection, setSelection] = useState<PixelPoint[]>([]);
  const [selectionOffset, setSelectionOffset] = useState<PixelPoint>();
  const [lassoPath, setLassoPath] = useState<PixelPoint[]>([]);
  const selectionCombination = useRef<SelectionCombination>('replace');
  const [selectionScaleOpen, setSelectionScaleOpen] = useState(false);
  const [clipboardAvailable, setClipboardAvailable] = useState(Boolean(localSelectionClipboard));
  const [mapObjectGesture, setMapObjectGesture] = useState<MapObjectGesture>();
  const mapObjectGestureRef = useRef<MapObjectGesture | undefined>(undefined);
  const [stampPreview, setStampPreview] = useState<Array<PixelPoint & { index: number }>>([]);
  const [activeStampId, setActiveStampId] = useState<string>();
  const [stampCaptureOpen, setStampCaptureOpen] = useState(false);
  const [stampLibraryOpen, setStampLibraryOpen] = useState(false);
  const [tileStampPreview, setTileStampPreview] = useState<Array<PixelPoint & { gid: number }>>([]);
  const [activeTileStampId, setActiveTileStampId] = useState<string>();
  const [lockPromise, setLockPromise] = useState<Promise<{ acquired: boolean; lockId?: string }>>();
  const lockPromiseRef = useRef<Promise<{ acquired: boolean; lockId?: string }> | undefined>(undefined);
  const gestureEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const [frameId, setFrameId] = useState(sprite?.frameIds[0]);
  const [tileAnimationTimeMs, setTileAnimationTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pingPong, setPingPong] = useState(false);
  const [playDirection, setPlayDirection] = useState<1 | -1>(1);
  const [onionSkin, setOnionSkin] = useState(true);
  const [onionSettings, setOnionSettings] = useState<OnionSkinSettings>(() => ({ ...DEFAULT_ONION_SKIN_SETTINGS }));
  const [onionSettingsOpen, setOnionSettingsOpen] = useState(false);
  const [wrapPreview, setWrapPreview] = useState(false);
  const [symmetry, setSymmetry] = useState<'none' | 'horizontal' | 'vertical' | 'both'>('none');
  const [paletteCycling, setPaletteCycling] = useState(false);
  const [paletteOffset, setPaletteOffset] = useState(0);
  const [activePaletteCycleId, setActivePaletteCycleId] = useState<string>();
  const [terrainSetId, setTerrainSetId] = useState<string>();
  const [terrainColorId, setTerrainColorId] = useState<number>();
  const [terrainErase, setTerrainErase] = useState(false);
  const [tileTransforms, setTileTransforms] = useState({ hFlip: false, vFlip: false, diagonal: false });
  const [bitmapTextPoint, setBitmapTextPoint] = useState<PixelPoint>();
  const [durationFrameId, setDurationFrameId] = useState<string>();
  const [exposureGridOpen, setExposureGridOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState<TagDraft>();
  const [selectedTagId, setSelectedTagId] = useState<string>();
  const setCanvasViewport = useEditorStore((state) => state.setCanvasViewport);
  const setCanvasAnimation = useEditorStore((state) => state.setCanvasAnimation);
  const tool = useEditorStore((state) => state.selectedTool);
  const zoom = useEditorStore((state) => state.zoom);
  const setZoom = useEditorStore((state) => state.setZoom);
  const brushSize = useEditorStore((state) => state.brushSize);
  const pixelIndex = useEditorStore((state) => state.pixelIndex);
  const setPixelIndex = useEditorStore((state) => state.setPixelIndex);
  const ditherMatrixSize = useEditorStore((state) => state.ditherMatrixSize);
  const ditherCoverage = useEditorStore((state) => state.ditherCoverage);
  const ditherMixIndex = Math.min(document.palette.length - 1, useEditorStore((state) => state.ditherMixIndex));
  const applyToActiveDocument = useEditorStore((state) => state.apply);
  const apply = useCallback((label: string, operations: CanvasOperation[]) => mountedRef.current ? applyToActiveDocument(label, operations, document.id) : Promise.resolve(false), [applyToActiveDocument, document.id]);
  const notify = useEditorStore((state) => state.notify);
  const selectedEntityId = useEditorStore((state) => state.selectedEntityId);
  const setSelectedEntity = useEditorStore((state) => state.setSelectedEntity);
  const playbackMap = useEditorStore((state) => state.playbacks);
  const playbacks = Object.values(playbackMap).filter((entry) => entry.documentId === document.id);
  const activeFrameId = sprite?.frameIds.includes(frameId ?? '') ? frameId : sprite?.frameIds[0];
  const activePaletteOverride = sprite && activeFrameId ? sprite.paletteOverrides[activeFrameId] : undefined;
  const activeStamp = document.stamps.find((stamp) => stamp.id === activeStampId) ?? document.stamps[0];
  const placementStamp: PixelStamp = activeStamp ?? { id: 'builtin-plus', name: 'Built-in plus', width: 3, height: 3, anchorX: 1, anchorY: 1, cells: [{ x: 1, y: 1, index: pixelIndex }, { x: 0, y: 1, index: pixelIndex }, { x: 2, y: 1, index: pixelIndex }, { x: 1, y: 0, index: pixelIndex }, { x: 1, y: 2, index: pixelIndex }] };
  const activePaletteCycle = document.paletteCycles.find((cycle) => cycle.id === activePaletteCycleId) ?? document.paletteCycles[0];
  const terrainTileset = tilemap?.tilesetIds.map((id) => document.pixelAssets[id]).find((entry) => entry?.type === 'tileset');
  const terrainSet = terrainTileset?.type === 'tileset' ? terrainTileset.wangSets.find((set) => set.id === terrainSetId) ?? terrainTileset.wangSets[0] : undefined;
  const terrainColor = terrainSet?.colors.find((color) => color.id === terrainColorId) ?? terrainSet?.colors[0];
  const activeTileStamp = document.tileStamps.find((stamp) => stamp.id === activeTileStampId) ?? document.tileStamps[0];
  const placementTileStamp: TileStamp = activeTileStamp ?? { id: 'builtin-tile', name: 'Current tile', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: encodeTiledGid((terrainTileset?.type === 'tileset' ? terrainTileset.firstGid : 1) + Math.max(1, pixelIndex) - 1, tileTransforms) }] };
  const selectedTileId = Math.max(1, pixelIndex) - 1;
  const selectedVariantGroup = terrainTileset?.type === 'tileset' ? tileVariantGroup(terrainTileset.tiles[selectedTileId]) : undefined;
  const selectedVariantCandidates = terrainTileset?.type === 'tileset' ? tileVariantCandidates(terrainTileset, selectedTileId) : [];
  const selectedVariantCount = selectedVariantCandidates.length;
  const variantSeed = tilemap ? Math.trunc(Number(tilemap.properties[TILE_VARIANT_SEED_PROPERTY]) || 0) : 0;
  const hasTimeline = Boolean(sprite && !tileset);
  const mapTileAnimations = useMemo(() => tilemap?.tilesetIds.flatMap((id) => {
    const candidate = document.pixelAssets[id];
    return candidate?.type === 'tileset' ? Object.values(candidate.tiles).flatMap((tile) => tile.animation.length ? [tile.animation] : []) : [];
  }) ?? [], [document.pixelAssets, tilemap]);

  useEffect(() => {
    mapObjectGestureRef.current = mapObjectGesture;
    lockPromiseRef.current = lockPromise;
  }, [lockPromise, mapObjectGesture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pendingLocks = [lockPromiseRef.current, mapObjectGestureRef.current?.lockPromise].filter((value): value is Promise<{ acquired: boolean; lockId?: string }> => Boolean(value));
      void releasePendingPixelLocks(pendingLocks, (lockId) => window.aidraw.releaseHumanLock(lockId));
    };
  }, []);

  useEffect(() => {
    if (!paletteCycling || document.palette.length <= 2) return;
    const length = activePaletteCycle ? activePaletteCycle.toIndex - activePaletteCycle.fromIndex + 1 : document.palette.length - 1;
    const timer = window.setInterval(() => setPaletteOffset((value) => (value + 1) % length), activePaletteCycle?.stepMs ?? 180);
    return () => window.clearInterval(timer);
  }, [activePaletteCycle, document.palette.length, paletteCycling]);

  useEffect(() => {
    setTileAnimationTimeMs(0);
    if (!tilemap || !mapTileAnimations.length) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let epoch = window.performance.now();
    let timeout: number | undefined;
    const clearTimer = () => { if (timeout !== undefined) window.clearTimeout(timeout); timeout = undefined; };
    const tick = () => {
      clearTimer();
      if (reducedMotion?.matches) { setTileAnimationTimeMs(0); return; }
      const elapsedMs = Math.max(0, Math.floor(window.performance.now() - epoch));
      setTileAnimationTimeMs(elapsedMs);
      const nextBoundaryMs = mapTileAnimations.reduce((minimum, animation) => Math.min(minimum, tileAnimationFrameAt(animation, elapsedMs)?.remainingMs ?? MAX_BROWSER_TIMEOUT_MS), MAX_BROWSER_TIMEOUT_MS);
      timeout = window.setTimeout(tick, Math.max(MIN_TILE_ANIMATION_TICK_MS, Math.min(MAX_BROWSER_TIMEOUT_MS, nextBoundaryMs)));
    };
    const restart = () => { clearTimer(); epoch = window.performance.now(); tick(); };
    restart();
    reducedMotion?.addEventListener('change', restart);
    return () => { clearTimer(); reducedMotion?.removeEventListener('change', restart); };
  }, [mapTileAnimations, tilemap]);

  useEffect(() => {
    if (!playing || !sprite || sprite.frameIds.length < 2) return;
    const tag = sprite.tags.find((entry) => entry.id === selectedTagId);
    const playbackFrames = pixelAnimationFrames(sprite, selectedTagId); if (playbackFrames.length < 2) return;
    const currentIndex = playbackFrames.indexOf(activeFrameId ?? playbackFrames[0]);
    const current = sprite.frames[playbackFrames[Math.max(0, currentIndex)]];
    const timeout = window.setTimeout(() => {
      const direction = tag?.direction ?? (pingPong ? 'ping-pong' : 'forward'); let nextDirection = direction === 'reverse' ? -1 : playDirection; let nextIndex = currentIndex < 0 ? (direction === 'reverse' ? playbackFrames.length - 1 : 0) : currentIndex + nextDirection;
      if (direction === 'ping-pong' && (nextIndex < 0 || nextIndex >= playbackFrames.length)) { nextDirection = nextDirection === 1 ? -1 : 1; setPlayDirection(nextDirection); nextIndex = currentIndex + nextDirection; }
      if (direction === 'forward') nextIndex = (Math.max(0, currentIndex) + 1) % playbackFrames.length;
      if (direction === 'reverse') nextIndex = (currentIndex <= 0 ? playbackFrames.length : currentIndex) - 1;
      setFrameId(playbackFrames[Math.max(0, Math.min(playbackFrames.length - 1, nextIndex))]);
    }, current?.durationMs ?? 100);
    return () => window.clearTimeout(timeout);
  }, [activeFrameId, pingPong, playDirection, playing, selectedTagId, sprite]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height - (hasTimeline ? 122 : 0)) }));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [hasTimeline]);

  const logical = useMemo(() => {
    if (sprite) return { width: sprite.width, height: sprite.height, gridWidth: sprite.width, gridHeight: sprite.height, unitX: 1, unitY: 1 };
    if (tilemap) {
      if (tilemap.orientation === 'isometric') {
        const extent = isometricProjectionExtent(tilemap.width, tilemap.height, 1, tilemap.tileHeight / tilemap.tileWidth);
        return { width: extent.width, height: extent.height, gridWidth: tilemap.width, gridHeight: tilemap.height, unitX: tilemap.tileWidth, unitY: tilemap.tileHeight };
      }
      const extent = orthogonalProjectionExtent(tilemap.width, tilemap.height, 1, tilemap.tileHeight / tilemap.tileWidth);
      return { width: extent.width, height: extent.height, gridWidth: tilemap.width, gridHeight: tilemap.height, unitX: tilemap.tileWidth, unitY: tilemap.tileHeight };
    }
    return { width: 1, height: 1, gridWidth: 1, gridHeight: 1, unitX: 1, unitY: 1 };
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
    setCanvasViewport({ x: -view.offsetX / view.scale, y: -view.offsetY / view.scale, width: size.width / view.scale, height: size.height / view.scale });
  }, [setCanvasViewport, size.height, size.width, view.offsetX, view.offsetY, view.scale]);

  useEffect(() => {
    const activeTag = sprite?.tags.find((tag) => tag.id === selectedTagId) ?? sprite?.tags.find((tag) => {
      const frameIndex = sprite.frameIds.indexOf(activeFrameId ?? '');
      return frameIndex >= sprite.frameIds.indexOf(tag.fromFrameId) && frameIndex <= sprite.frameIds.indexOf(tag.toFrameId);
    });
    setCanvasAnimation(sprite ? { activeAssetId: sprite.id, activeFrameId, activeTagId: activeTag?.id, playing, onionSkin, direction: activeTag?.direction ?? (pingPong ? 'ping-pong' : playDirection < 0 ? 'reverse' : 'forward') } : undefined);
  }, [activeFrameId, onionSkin, pingPong, playDirection, playing, selectedTagId, setCanvasAnimation, sprite]);

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
    const isometricCellHeight = tilemap?.orientation === 'isometric' ? view.scale * tilemap.tileHeight / tilemap.tileWidth : view.scale;
    const orthogonalCellHeight = tilemap?.orientation === 'orthogonal' ? view.scale * tilemap.tileHeight / tilemap.tileWidth : view.scale;
    const baseRasterViewportRegion = sprite || tilemap ? coveringRasterViewportRegion({
      viewportWidth: size.width,
      viewportHeight: size.height,
      viewOffsetX: view.offsetX,
      viewOffsetY: view.offsetY,
      layerOffsetX: 0,
      layerOffsetY: 0,
      projectionScale: sprite ? view.scale : view.scale / tilemap!.tileWidth,
    }) : undefined;
    const gridCellRect = (point: PixelPoint): IsometricCellRect => tilemap?.orientation === 'isometric'
      ? isometricCellRect(point.x, point.y, tilemap.height, view.scale, isometricCellHeight)
      : tilemap?.orientation === 'orthogonal'
        ? orthogonalCellRect(point.x, point.y, view.scale, orthogonalCellHeight)
        : { x: point.x * view.scale, y: point.y * view.scale, width: view.scale, height: view.scale };
    const fillGridCell = (point: PixelPoint): void => {
      const rect = gridCellRect(point);
      if (tilemap?.orientation === 'isometric') { traceIsometricCell(context, rect); context.fill(); }
      else context.fillRect(rect.x, rect.y, rect.width, rect.height);
    };
    const strokeGridCell = (point: PixelPoint): void => {
      const rect = gridCellRect(point);
      if (tilemap?.orientation === 'isometric') { traceIsometricCell(context, rect); context.stroke(); }
      else context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    };
    const gridCellCenter = (point: PixelPoint): PixelPoint => {
      const rect = gridCellRect(point);
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };

    if (sprite && activeFrameId) {
      const paletteColor = (index: number) => {
        if (!index) return document.palette[0]?.color ?? '#00000000';
        const cycled = paletteCycling && document.palette.length > 1
          ? activePaletteCycle ? cycledPaletteIndex(index, activePaletteCycle, paletteOffset) : 1 + ((index - 1 + paletteOffset) % (document.palette.length - 1))
          : index;
        return (sprite.paletteOverrides[activeFrameId] ?? document.palette)[cycled]?.color ?? '#ff00ff';
      };
      const drawFrame = (targetFrame: string, alpha: number, tint?: string, source = baseRasterViewportRegion!) => {
        context.save();
        try {
          context.translate(source.x * view.scale, source.y * view.scale); context.scale(view.scale, view.scale);
          drawPixelSpriteRegion(context, sprite, targetFrame, document.palette, source, {
            invalidChunk: 'skip',
            opacityMultiplier: alpha,
            colorForIndex: (index) => tint ?? paletteColor(index),
            skipPixel: (cel, x, y) => replayMasks.celPixels.get(cel.id)?.has(replayPointKey(x, y)) ?? false,
          });
        } finally { context.restore(); }
      };
      if (onionSkin && sprite.frameIds.length > 1) {
        for (const onionLayer of onionSkinLayers(sprite.frameIds, activeFrameId, onionSettings)) drawFrame(onionLayer.frameId, onionLayer.opacity, onionLayer.tint);
      }
      drawFrame(activeFrameId, 1);
      if (wrapPreview) {
        context.globalAlpha = 0.25;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const offsetX = Number(dx) * sprite.width; const offsetY = Number(dy) * sprite.height;
          const source = baseRasterViewportRegion!;
          context.save(); context.translate(offsetX * view.scale, offsetY * view.scale);
          const shiftedSource = { ...source, x: source.x - offsetX, y: source.y - offsetY };
          try { drawFrame(activeFrameId, 1, undefined, shiftedSource); } finally { context.restore(); }
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
      const mapSources = new BoundedResourceCache<SpriteRegionBitmap>(MAX_MAP_TILE_SOURCE_CACHE_ENTRIES, MAX_MAP_TILE_SOURCE_CACHE_BYTES, (source) => { source.canvas.width = 1; source.canvas.height = 1; });
      const animatedLocalIds = new Map<string, number>();
      const animatedLocalId = (resolved: NonNullable<ReturnType<typeof resolveTilesetForGid>>) => {
        const key = `${resolved.tileset.id}\0${resolved.localId}`; const cached = animatedLocalIds.get(key); if (cached !== undefined) return cached;
        const sampled = tileAnimationFrameAt(resolved.tileset.tiles[resolved.localId]?.animation ?? [], tileAnimationTimeMs)?.tileId ?? resolved.localId; animatedLocalIds.set(key, sampled); return sampled;
      };
      const visibleLayers: Array<{ layer: typeof tilemap.layers[string]; opacity: number }> = []; const visit = (id: string, opacity = 1) => { const layer = tilemap.layers[id]; if (!layer?.visible) return; const combined = opacity * layer.opacity; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId, combined); else visibleLayers.push({ layer, opacity: combined }); }; for (const id of tilemap.layerIds) visit(id);
      try { for (const entry of visibleLayers) {
        const { layer } = entry;
        const layerOffsetX = pan.x * (layer.parallaxX - 1); const layerOffsetY = pan.y * (layer.parallaxY - 1);
        context.save(); context.translate(layerOffsetX, layerOffsetY);
        if (layer.type === 'object') {
          context.globalAlpha = entry.opacity;
          for (const source of layer.objects ?? []) {
            const object = mapObjectGesture?.layerId === layer.id && mapObjectGesture.objectId === source.id ? previewMapObject(mapObjectGesture) : source; const selected = selectedEntityId === object.id; const unitScale = tilemap.orientation === 'orthogonal' ? view.scale / tilemap.tileWidth : view.scale / Math.max(tilemap.tileWidth, tilemap.tileHeight);
            context.save();
            if (tilemap.orientation === 'isometric') {
              const matrix = isometricObjectMatrix(tilemap.height, tilemap.tileWidth, tilemap.tileHeight, view.scale, isometricCellHeight);
              context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
            } else {
              const matrix = orthogonalObjectMatrix(tilemap.tileWidth, tilemap.tileHeight, view.scale, orthogonalCellHeight);
              context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
            }
            drawMapObjectOverlay(context, object, { selected, unitScale });
            context.restore();
          }
          context.restore(); continue;
        }
        if (layer.type !== 'tile' || !layer.chunks) { context.restore(); continue; }
        const hiddenCells = replayMasks.tileCells.get(replayTileLayerKey(tilemap.id, layer.id));
        const layerViewportRegion = layerOffsetX === 0 && layerOffsetY === 0 ? baseRasterViewportRegion! : coveringRasterViewportRegion({
          viewportWidth: size.width,
          viewportHeight: size.height,
          viewOffsetX: view.offsetX,
          viewOffsetY: view.offsetY,
          layerOffsetX,
          layerOffsetY,
          projectionScale: view.scale / tilemap.tileWidth,
        });
        const candidateChunks = tilemapChunksIntersectingRegion(Object.values(layer.chunks), {
          orientation: tilemap.orientation,
          rows: tilemap.height,
          tileWidth: tilemap.tileWidth,
          tileHeight: tilemap.tileHeight,
        }, layerViewportRegion);
        context.globalAlpha = entry.opacity;
        const drawCell = (x: number, y: number, raw: number) => {
          const decoded = decodeTiledGid(raw); if (!decoded.gid || hiddenCells?.has(replayPointKey(x, y))) return;
          const resolved = resolveTilesetForGid(document, tilemap, decoded.gid); const mapSourceAsset = resolved ? document.pixelAssets[resolved.tileset.spriteAssetId] : undefined;
          const visibleLocalId = resolved ? animatedLocalId(resolved) : undefined;
          const sourceRect = resolved && visibleLocalId !== undefined ? tilesetTileSourceRect(resolved.tileset, visibleLocalId) : undefined;
          const sourcePlan = mapSourceAsset?.type === 'sprite' && sourceRect ? pixelSpriteRegionPlan(mapSourceAsset, sourceRect) : undefined; const frameId = mapSourceAsset?.type === 'sprite' ? mapSourceAsset.frameIds[0] : undefined;
          const mapSource = mapSourceAsset?.type === 'sprite' && sourceRect && sourcePlan && frameId
            ? mapSources.acquire(`${mapSourceAsset.id}\0${frameId}\0${sourceRect.x},${sourceRect.y},${sourceRect.width},${sourceRect.height}`, sourcePlan.render.width * sourcePlan.render.height * 4, () => spriteRegionBitmap(mapSourceAsset, frameId, document.palette, sourceRect))
            : undefined;
          const drawTile = (rect: IsometricCellRect) => { if (!mapSource || !resolved || !sourceRect) return false; const transform = tiledTileTransformMatrix(decoded); const sampled = mapSource.value; context.save(); try { context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2); context.transform(transform.a, transform.b, transform.c, transform.d, 0, 0); context.drawImage(sampled.canvas, sampled.sample.x, sampled.sample.y, sampled.sample.width, sampled.sample.height, -rect.width / 2, -rect.height / 2, rect.width, rect.height); } finally { context.restore(); } return true; };
          const visibleGid = resolved && visibleLocalId !== undefined ? resolved.tileset.firstGid + visibleLocalId : decoded.gid;
          try {
            if (tilemap.orientation === 'orthogonal') {
              const rect = gridCellRect({ x, y });
              if (!drawTile(rect)) { context.fillStyle = `hsl(${visibleGid * 47 % 360} 52% 62%)`; context.fillRect(rect.x, rect.y, rect.width, rect.height); }
            } else {
              const rect = gridCellRect({ x, y });
              if (!drawTile(rect)) { context.fillStyle = `hsl(${visibleGid * 47 % 360} 52% 62%)`; traceIsometricCell(context, rect); context.fill(); }
            }
          } finally { mapSource?.release(); }
        };
        if (tilemap.orientation === 'isometric') for (const cell of isometricTileRenderCells(candidateChunks, safeDecodeTilemapChunk)) drawCell(cell.x, cell.y, cell.raw);
        else for (const chunk of candidateChunks) {
          const values = safeDecodeTilemapChunk(chunk); if (!values) continue;
          for (let localY = 0; localY < 32; localY += 1) for (let localX = 0; localX < 32; localX += 1) drawCell(chunk.x + localX, chunk.y + localY, values[localY * 32 + localX] ?? 0);
        }
        context.restore();
      } } finally { mapSources.clear(); }
    }

    if (preview.length || bulkPreview.length) {
      context.globalAlpha = 0.78;
      if (bulkPreview.length) {
        for (const run of bulkPreview) {
          context.fillStyle = run.index === 0 ? '#ffffff80' : document.palette[run.index]?.color ?? '#ff00ff';
          context.fillRect(run.x * view.scale, run.y * view.scale, run.length * view.scale, view.scale);
        }
      } else if (tool === 'stamp' && tileStampPreview.length) for (const point of tileStampPreview) {
        const gid = decodeTiledGid(point.gid).gid; context.fillStyle = gid === 0 ? '#ffffff80' : 'hsl(' + (gid * 47 % 360) + ' 52% 62%)';
        fillGridCell(point);
      } else if (tool === 'stamp' && stampPreview.length) for (const point of stampPreview) {
        context.fillStyle = point.index === 0 ? '#ffffff80' : document.palette[point.index]?.color ?? '#ff00ff';
        context.fillRect(point.x * view.scale, point.y * view.scale, view.scale, view.scale);
      } else if (tool === 'dither') {
        for (const point of preview) {
          if (point.x < 0 || point.y < 0 || point.x >= logical.gridWidth || point.y >= logical.gridHeight) continue;
          const index = orderedDitherIndex(point.x, point.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize);
          context.fillStyle = index === 0 ? '#ffffff80' : (activePaletteOverride ?? document.palette)[index]?.color ?? '#ff00ff';
          context.fillRect(point.x * view.scale, point.y * view.scale, view.scale, view.scale);
        }
      } else {
        const drawIndex = tool === 'eraser' ? 0 : pixelIndex;
        context.fillStyle = drawIndex === 0 ? '#ffffff80' : document.palette[drawIndex]?.color ?? '#ff00ff';
        for (const point of preview) if (point.x >= 0 && point.y >= 0 && point.x < logical.gridWidth && point.y < logical.gridHeight) fillGridCell(point);
      }
    }

    if (tool === 'lasso' && lassoPath.length > 1) {
      context.globalAlpha = 1; context.strokeStyle = '#6e58c7'; context.lineWidth = Math.max(1, view.scale / 7); context.setLineDash([Math.max(2, view.scale / 2), Math.max(2, view.scale / 3)]); context.beginPath();
      const first = gridCellCenter(lassoPath[0]); context.moveTo(first.x, first.y); for (const point of lassoPath.slice(1)) { const center = gridCellCenter(point); context.lineTo(center.x, center.y); } context.closePath(); context.stroke(); context.setLineDash([]);
    }

    if (selection.length) {
      context.globalAlpha = 1; context.strokeStyle = '#ffffff'; context.lineWidth = Math.max(1, view.scale / 8); context.setLineDash([Math.max(2, view.scale / 3), Math.max(2, view.scale / 3)]);
      context.lineDashOffset = -(Date.now() / 120) % 8;
      const offset = selectionOffset ?? { x: 0, y: 0 };
      const selectedPoints = selection.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
      for (const point of selectedPoints) strokeGridCell(point);
      context.strokeStyle = '#4f3f68'; context.lineDashOffset += Math.max(2, view.scale / 3); for (const point of selectedPoints) strokeGridCell(point); context.setLineDash([]);
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
        } else if (operation.kind === 'pixel.cel.region' && sprite && operation.spriteId === sprite.id) {
          const targetCel = sprite.cels[operation.celId];
          if (!targetCel || targetCel.frameId !== activeFrameId) continue;
          for (const run of operation.runs) {
            if (![run.x, run.y, run.length, run.index].every(Number.isFinite)) continue;
            context.fillStyle = run.index === 0 ? '#ffffff80' : document.palette[run.index]?.color ?? playback.actor.color;
            context.fillRect(run.x * view.scale, run.y * view.scale, run.length * view.scale, view.scale);
          }
        } else if (operation.kind === 'pixel.tilemap.set' && tilemap && operation.mapId === tilemap.id) {
          const changes = Array.isArray(operation.changes) ? operation.changes : [];
          for (const change of changes) {
            if (![change.x, change.y, change.gid].every(Number.isFinite)) continue;
            context.fillStyle = change.gid === 0 ? '#ffffff80' : `hsl(${(change.gid * 47) % 360} 52% 62%)`;
            fillGridCell(change);
          }
        } else if (operation.kind === 'pixel.tilemap.region' && tilemap && operation.mapId === tilemap.id) {
          for (const run of operation.runs) {
            if (![run.x, run.y, run.length, run.gid].every(Number.isFinite)) continue;
            context.fillStyle = run.gid === 0 ? '#ffffff80' : `hsl(${(run.gid * 47) % 360} 52% 62%)`;
            for (let offset = 0; offset < run.length; offset += 1) fillGridCell({ x: run.x + offset, y: run.y });
          }
        }
      }
    }

    if (view.scale >= 8 && (sprite || tilemap?.orientation === 'orthogonal')) {
      context.globalAlpha = 1; context.strokeStyle = 'rgba(45, 36, 59, .14)'; context.lineWidth = 1;
      context.beginPath();
      const columnWidth = view.scale;
      const rowHeight = tilemap?.orientation === 'orthogonal' ? orthogonalCellHeight : view.scale;
      const columnCount = tilemap?.orientation === 'orthogonal' ? tilemap.width : logical.gridWidth;
      const rowCount = tilemap?.orientation === 'orthogonal' ? tilemap.height : logical.gridHeight;
      const gridRange = tilemap?.orientation === 'orthogonal' && baseRasterViewportRegion ? tilemapGridLineRange(baseRasterViewportRegion, { columns: tilemap.width, rows: tilemap.height, tileWidth: tilemap.tileWidth, tileHeight: tilemap.tileHeight }) : { columnStart: 0, columnEnd: columnCount, rowStart: 0, rowEnd: rowCount };
      for (let x = gridRange.columnStart; x <= gridRange.columnEnd; x += 1) { context.moveTo(x * columnWidth + 0.5, 0); context.lineTo(x * columnWidth + 0.5, rowCount * rowHeight); }
      for (let y = gridRange.rowStart; y <= gridRange.rowEnd; y += 1) { context.moveTo(0, y * rowHeight + 0.5); context.lineTo(columnCount * columnWidth, y * rowHeight + 0.5); }
      context.stroke();
    }
    context.restore();
  }, [activeFrameId, activePaletteCycle, activePaletteOverride, bulkPreview, ditherCoverage, ditherMatrixSize, ditherMixIndex, document, lassoPath, logical, mapObjectGesture, onionSettings, onionSkin, paletteCycling, paletteOffset, pan.x, pan.y, pixelIndex, playbacks, preview, selectedEntityId, selection, selectionOffset, size, sprite, stampPreview, tileAnimationTimeMs, tilemap, tileStampPreview, tileset, tool, view, wrapPreview]);

  const toPixel = (event: ReactPointerEvent<HTMLCanvasElement>): PixelPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (tilemap?.orientation === 'isometric') return clientPointToIsometricTile(event.clientX, event.clientY, bounds, size, view, tilemap.height, view.scale * tilemap.tileHeight / tilemap.tileWidth);
    if (tilemap?.orientation === 'orthogonal') return clientPointToOrthogonalTile(event.clientX, event.clientY, bounds, size, view, view.scale * tilemap.tileHeight / tilemap.tileWidth);
    return clientPointToPixel(event.clientX, event.clientY, bounds, size, view);
  };

  const toMapObjectPoint = (event: ReactPointerEvent<HTMLCanvasElement>): PixelPoint => {
    const bounds = event.currentTarget.getBoundingClientRect(); if (!tilemap) return { x: 0, y: 0 };
    if (tilemap.orientation === 'isometric') { const point = clientPointToIsometricCoordinate(event.clientX, event.clientY, bounds, size, view, tilemap.height, view.scale * tilemap.tileHeight / tilemap.tileWidth); return { x: point.x * tilemap.tileWidth, y: point.y * tilemap.tileHeight }; }
    const point = clientPointToOrthogonalCoordinate(event.clientX, event.clientY, bounds, size, view, view.scale * tilemap.tileHeight / tilemap.tileWidth);
    return { x: point.x * tilemap.tileWidth, y: point.y * tilemap.tileHeight };
  };

  const toLayerMapObjectPoint = (event: ReactPointerEvent<HTMLCanvasElement>, layer: NonNullable<typeof tilemap>['layers'][string]): PixelPoint => {
    const point = toMapObjectPoint(event); if (!tilemap) return point;
    if (tilemap.orientation === 'isometric') { const delta = isometricCoordinateDeltaFromScreen(pan.x * (layer.parallaxX - 1), pan.y * (layer.parallaxY - 1), view.scale, view.scale * tilemap.tileHeight / tilemap.tileWidth); return { x: point.x - delta.x * tilemap.tileWidth, y: point.y - delta.y * tilemap.tileHeight }; }
    const delta = orthogonalCoordinateDeltaFromScreen(pan.x * (layer.parallaxX - 1), pan.y * (layer.parallaxY - 1), view.scale, view.scale * tilemap.tileHeight / tilemap.tileWidth);
    return { x: point.x - delta.x * tilemap.tileWidth, y: point.y - delta.y * tilemap.tileHeight };
  };

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

  const transformSelection = async (transform: PixelSelectionTransform, offset: PixelPoint = { x: 0, y: 0 }) => {
    if (!selection.length) return;
    if (tilemap) {
      const layer = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'tile' || !layer.chunks) return;
      const result = transformGridSelection(selection, (x, y) => readTileAt(layer.chunks!, x, y), transform, tilemap.infinite ? undefined : { width: tilemap.width, height: tilemap.height }, offset, 0);
      const bounds = pixelSelectionBounds([...selection, ...result.selection]); if (!bounds) return;
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'tile', assetId: tilemap.id, ...bounds } }); if (!lock.acquired) return;
      try {
        if (await apply(transform.replaceAll('-', ' ') + ' tile selection', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId: layer.id, changes: result.changes.map((entry) => ({ x: entry.x, y: entry.y, gid: entry.value })), expectedRevision: layer.revision }])) {
          setSelection(result.selection); if (result.dropped) notify(result.dropped + ' selected tile' + (result.dropped === 1 ? '' : 's') + ' fell outside the finite map and was clipped.', 'warning');
        }
      } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      return;
    }
    if (!sprite || !activeFrameId) return;
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined;
    if (!cel) return;
    const result = transformPixelSelection(selection, (x, y) => readPixel(cel, x, y), transform, { width: sprite.width, height: sprite.height }, offset);
    const destination = result.destinationBounds; const source = result.sourceBounds;
    const left = Math.min(source.x, destination?.x ?? source.x); const top = Math.min(source.y, destination?.y ?? source.y); const right = Math.max(source.x + source.width, destination ? destination.x + destination.width : source.x + source.width); const bottom = Math.max(source.y + source.height, destination ? destination.y + destination.height : source.y + source.height);
    const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, x: left, y: top, width: right - left, height: bottom - top } });
    if (!lock.acquired) return;
    try {
      if (await apply(`${transform.replaceAll('-', ' ')} selection`, [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: result.changes, expectedRevision: cel.revision }])) {
        setSelection(result.selection);
        if (result.dropped) notify(`${result.dropped} selected pixel${result.dropped === 1 ? '' : 's'} fell outside the sprite and were clipped.`, 'warning');
      }
    } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
  };

  const changeVariantSeed = (seed: number, label: string) => {
    if (!tilemap || seed === variantSeed) return;
    const map = structuredClone(tilemap);
    map.properties[TILE_VARIANT_SEED_PROPERTY] = seed;
    void apply(label, [{ kind: 'pixel.asset.replace', asset: map, expectedRevision: tilemap.revision }]);
  };

  const deleteSelection = async () => {
    if (!selection.length) return;
    if (tilemap) {
      const layer = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked); const bounds = pixelSelectionBounds(selection);
      if (!layer || layer.type !== 'tile' || !bounds) return;
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'tile', assetId: tilemap.id, ...bounds } }); if (!lock.acquired) return;
      try { if (await apply('Delete selected tiles', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId: layer.id, changes: selection.map((point) => ({ ...point, gid: 0 })), expectedRevision: layer.revision }])) setSelection([]); }
      finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      return;
    }
    if (!sprite || !activeFrameId) return;
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined; const bounds = pixelSelectionBounds(selection);
    if (!cel || !bounds) return;
    const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, ...bounds } });
    if (!lock.acquired) return;
    try { if (await apply('Delete selected pixels', [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: uniqueChanges(selection, 0), expectedRevision: cel.revision }])) setSelection([]); }
    finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
  };

  const copyLocalSelection = (): boolean => {
    if (!selection.length) { notify('Select pixels or tiles before copying.', 'warning'); return false; }
    if (tilemap) {
      const layer = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'tile' || !layer.chunks) return false;
      localSelectionClipboard = { kind: 'tile', sourceDocumentId: document.id, grid: captureGridSelection(selection, (x, y) => readTileAt(layer.chunks!, x, y)) };
      setClipboardAvailable(true);
      notify(`Copied ${selection.length} selected tile${selection.length === 1 ? '' : 's'} to the AIDraw clipboard.`, 'success'); return true;
    }
    if (!sprite || !activeFrameId) return false;
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined; if (!cel) return false;
    const activePalette = sprite.paletteOverrides?.[activeFrameId] ?? document.palette;
    localSelectionClipboard = { kind: 'pixel', sourceDocumentId: document.id, grid: captureGridSelection(selection, (x, y) => readPixel(cel, x, y)), palette: activePalette.map((entry) => entry.color) };
    setClipboardAvailable(true);
    notify(`Copied ${selection.length} selected pixel${selection.length === 1 ? '' : 's'} to the AIDraw clipboard.`, 'success'); return true;
  };

  const pasteLocalSelection = async () => {
    const clipboard = localSelectionClipboard; if (!clipboard) { notify('The AIDraw pixel-selection clipboard is empty.', 'warning'); return; }
    const origin = cursor ?? { x: clipboard.grid.originX, y: clipboard.grid.originY };
    if (tilemap) {
      if (clipboard.kind !== 'tile') { notify('Pixel selections cannot be pasted into a tilemap.', 'warning'); return; }
      if (clipboard.sourceDocumentId !== document.id) { notify('Tile selections keep project-local GIDs and can only be pasted inside their source project.', 'warning'); return; }
      const layer = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked); if (!layer || layer.type !== 'tile') return;
      const placed = placeGridClipboard(clipboard.grid, origin, tilemap.infinite ? undefined : { width: tilemap.width, height: tilemap.height }); const bounds = pixelSelectionBounds(placed.selection);
      if (!bounds) { notify('The pasted tile selection falls outside this finite map.', 'warning'); return; }
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'tile', assetId: tilemap.id, ...bounds } }); if (!lock.acquired) return;
      try {
        if (await apply('Paste tile selection', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId: layer.id, changes: placed.changes.map((entry) => ({ x: entry.x, y: entry.y, gid: entry.value })), expectedRevision: layer.revision }])) setSelection(placed.selection);
        if (placed.dropped) notify(`${placed.dropped} pasted tile${placed.dropped === 1 ? '' : 's'} fell outside the finite map.`, 'warning');
      } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      return;
    }
    if (!sprite || !activeFrameId || clipboard.kind !== 'pixel') { notify('Tile selections cannot be pasted into a sprite.', 'warning'); return; }
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined; if (!cel) return;
    const placed = placeGridClipboard(clipboard.grid, origin, { width: sprite.width, height: sprite.height }); const bounds = pixelSelectionBounds(placed.selection);
    if (!bounds) { notify('The pasted pixel selection falls outside this sprite.', 'warning'); return; }
    const palette = structuredClone(document.palette); const remap = new Map<number, number>([[0, 0]]);
    for (const entry of placed.changes) {
      if (remap.has(entry.value)) continue;
      if (clipboard.sourceDocumentId === document.id && entry.value < palette.length) { remap.set(entry.value, entry.value); continue; }
      const color = clipboard.palette[entry.value]; if (!color) { remap.set(entry.value, 0); continue; }
      let target = palette.findIndex((candidate) => candidate.color.toLocaleLowerCase() === color.toLocaleLowerCase());
      if (target < 0) { if (palette.length >= 256) { notify('The destination palette is full; remove a color before pasting this selection.', 'warning'); return; } target = palette.length; palette.push({ id: createId('palette'), name: `Pasted ${target}`, color }); }
      remap.set(entry.value, target);
    }
    const operations: CanvasOperation[] = [];
    if (palette.length !== document.palette.length) operations.push({ kind: 'pixel.palette.replace', palette });
    operations.push({ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: placed.changes.map((entry) => ({ x: entry.x, y: entry.y, index: remap.get(entry.value) ?? 0 })), expectedRevision: cel.revision });
    const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, ...bounds } }); if (!lock.acquired) return;
    try {
      if (await apply('Paste pixel selection', operations)) setSelection(placed.selection);
      if (placed.dropped) notify(`${placed.dropped} pasted pixel${placed.dropped === 1 ? '' : 's'} fell outside the sprite.`, 'warning');
    } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
  };

  const scaleSelection = async (scaleX: number, scaleY: number) => {
    if (!selection.length || (scaleX === 1 && scaleY === 1)) { setSelectionScaleOpen(false); return; }
    if (tilemap) {
      const layer = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked); if (!layer || layer.type !== 'tile' || !layer.chunks) return;
      const result = scaleGridSelection(selection, (x, y) => readTileAt(layer.chunks!, x, y), scaleX, scaleY, tilemap.infinite ? undefined : { width: tilemap.width, height: tilemap.height }, 0); const bounds = pixelSelectionBounds([...selection, ...result.selection]); if (!bounds) return;
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'tile', assetId: tilemap.id, ...bounds } }); if (!lock.acquired) return;
      try { if (await apply(`Scale tile selection ${scaleX}×${scaleY}`, [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId: layer.id, changes: result.changes.map((entry) => ({ x: entry.x, y: entry.y, gid: entry.value })), expectedRevision: layer.revision }])) { setSelection(result.selection); setSelectionScaleOpen(false); } }
      finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      if (result.dropped) notify(`${result.dropped} scaled tile${result.dropped === 1 ? '' : 's'} fell outside the finite map.`, 'warning'); return;
    }
    if (!sprite || !activeFrameId) return; const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined; if (!cel) return;
    const result = scaleGridSelection(selection, (x, y) => readPixel(cel, x, y), scaleX, scaleY, { width: sprite.width, height: sprite.height }, 0); const bounds = pixelSelectionBounds([...selection, ...result.selection]); if (!bounds) return;
    const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, ...bounds } }); if (!lock.acquired) return;
    try { if (await apply(`Scale pixel selection ${scaleX}×${scaleY}`, [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: result.changes.map((entry) => ({ x: entry.x, y: entry.y, index: entry.value })), expectedRevision: cel.revision }])) { setSelection(result.selection); setSelectionScaleOpen(false); } }
    finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
    if (result.dropped) notify(`${result.dropped} scaled pixel${result.dropped === 1 ? '' : 's'} fell outside the sprite.`, 'warning');
  };

  const captureSelectionAsStamp = async (name: string) => {
    if (!selection.length) return;
    if (tilemap) {
      const layer = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked);
      if (!layer || layer.type !== 'tile' || !layer.chunks) return;
      const stamp = captureTileStamp(createId('tile-stamp'), name, selection, (x, y) => readTileAt(layer.chunks!, x, y));
      if (await apply('Save reusable tile stamp', [{ kind: 'pixel.tile-stamps.replace', stamps: [...document.tileStamps, stamp] }])) { setActiveTileStampId(stamp.id); setStampCaptureOpen(false); }
      return;
    }
    if (!sprite || !activeFrameId) return;
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined;
    if (!cel) return;
    const stamp = capturePixelStamp(createId('stamp'), name, selection, (x, y) => readPixel(cel, x, y));
    if (await apply('Save reusable pixel stamp', [{ kind: 'pixel.stamps.replace', stamps: [...document.stamps, stamp] }])) { setActiveStampId(stamp.id); setStampCaptureOpen(false); }
  };

  const transformActiveStamp = async (transform: PixelStampTransform) => {
    if (tilemap && activeTileStamp) {
      const stamps = document.tileStamps.map((stamp) => stamp.id === activeTileStamp.id ? transformTileStamp(stamp, transform) : stamp);
      await apply(transform.replaceAll('-', ' ') + ' tile stamp', [{ kind: 'pixel.tile-stamps.replace', stamps }]); return;
    }
    if (!activeStamp) return;
    const stamps = document.stamps.map((stamp) => stamp.id === activeStamp.id ? transformPixelStamp(stamp, transform) : stamp);
    await apply(`${transform.replaceAll('-', ' ')} stamp`, [{ kind: 'pixel.stamps.replace', stamps }]);
  };

  const deleteActiveStamp = async () => {
    if (tilemap && activeTileStamp) {
      const stamps = document.tileStamps.filter((stamp) => stamp.id !== activeTileStamp.id);
      if (await apply('Delete reusable tile stamp', [{ kind: 'pixel.tile-stamps.replace', stamps }])) setActiveTileStampId(stamps[0]?.id);
      return;
    }
    if (!activeStamp) return;
    const stamps = document.stamps.filter((stamp) => stamp.id !== activeStamp.id);
    if (await apply('Delete reusable pixel stamp', [{ kind: 'pixel.stamps.replace', stamps }])) setActiveStampId(stamps[0]?.id);
  };

  const cancelGesture = (): Promise<void> => {
    const pendingLocks = [lockPromise, mapObjectGesture?.lockPromise].filter((value): value is Promise<{ acquired: boolean; lockId?: string }> => Boolean(value));
    return cancelPixelGesture(() => {
      gestureEpochRef.current += 1;
      lockPromiseRef.current = undefined; mapObjectGestureRef.current = undefined;
      setStart(undefined); setPreview([]); setBulkPreview([]); setLassoPath([]); setStampPreview([]); setTileStampPreview([]); setSelectionOffset(undefined); setLockPromise(undefined); setMapObjectGesture(undefined);
    }, pendingLocks, (lockId) => window.aidraw.releaseHumanLock(lockId));
  };

  const updatePreview = (from: PixelPoint, point: PixelPoint): void => {
    if (tool === 'select') setPreview(rectangleFill(from, point));
    else if (['line', 'rectangle', 'ellipse'].includes(tool)) setPreview(withSymmetry(frameChanges(tool, from, point)));
    else {
      const line = cursor ? bresenham(cursor.x, cursor.y, point.x, point.y) : [point];
      if (tool === 'stamp' && sprite) {
        const placed = line.flatMap((entry) => placePixelStamp(placementStamp, entry.x, entry.y, { width: sprite.width, height: sprite.height }).changes);
        setStampPreview((current) => [...new Map([...current, ...placed].map((entry) => [`${entry.x},${entry.y}`, entry])).values()]);
        setPreview((current) => [...new Map([...current, ...placed].map((entry) => [`${entry.x},${entry.y}`, { x: entry.x, y: entry.y }])).values()]);
        return;
      }
      if (tool === 'stamp' && tilemap) {
        const bounds = tilemap.infinite ? undefined : { width: tilemap.width, height: tilemap.height };
        const placed = line.flatMap((entry) => placeTileStamp(placementTileStamp, entry.x, entry.y, bounds).changes);
        setTileStampPreview((current) => [...new Map([...current, ...placed].map((entry) => [entry.x + ',' + entry.y, entry])).values()]);
        setPreview((current) => [...new Map([...current, ...placed].map((entry) => [entry.x + ',' + entry.y, { x: entry.x, y: entry.y }])).values()]);
        return;
      }
      const points = line.flatMap((entry) => brushPoints(entry, brushSize));
      setPreview((current) => {
        const symmetric = withSymmetry(points); const constrained = tool === 'dither' && selection.length ? symmetric.filter((point) => selection.some((selected) => selected.x === point.x && selected.y === point.y)) : symmetric;
        const combined = [...current, ...constrained];
        return tool === 'pencil' && brushSize === 1 ? pixelPerfectStrokePoints(combined) : combined;
      });
    }
  };

  const onPointerDown = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPixel(event);
    if (tool === 'zoom') { setZoom(zoom * (event.shiftKey ? 0.5 : 2)); return; }
    if (tool === 'hand' || event.button === 1) { setStart(point); setCursor(point); return; }
    if (!sprite && !tilemap) return;
    if (tilemap && tool === 'select') {
      const objectLayers: typeof tilemap.layers[string][] = []; const visit = (id: string) => { const layer = tilemap.layers[id]; if (!layer?.visible) return; if (layer.type === 'group') for (const childId of layer.childIds ?? []) visit(childId); else if (layer.type === 'object' && !layer.locked) objectLayers.push(layer); }; for (const id of tilemap.layerIds) visit(id);
      let hit: { layer: typeof tilemap.layers[string]; object: CollisionShape; point: PixelPoint } | undefined; for (const layer of [...objectLayers].reverse()) { const mapPoint = toLayerMapObjectPoint(event, layer); const unitScale = tilemap.orientation === 'orthogonal' ? view.scale / tilemap.tileWidth : view.scale / Math.max(tilemap.tileWidth, tilemap.tileHeight); const tolerance = 9 / Math.max(0.001, unitScale); const object = [...(layer.objects ?? [])].reverse().find((entry) => mapObjectAtPoint(entry, mapPoint, tolerance)); if (object) { hit = { layer, object, point: mapPoint }; break; } }
      if (hit) {
        const objectBounds = mapObjectBounds(hit.object); const unitScale = tilemap.orientation === 'orthogonal' ? view.scale / tilemap.tileWidth : view.scale / Math.max(tilemap.tileWidth, tilemap.tileHeight); const handleThreshold = 9 / Math.max(0.001, unitScale); const pointIndex = selectedEntityId === hit.object.id && hit.object.points ? hit.object.points.findIndex((entry) => Math.hypot(hit.object.x + entry.x - hit.point.x, hit.object.y + entry.y - hit.point.y) <= handleThreshold) : -1; const atHandle = selectedEntityId === hit.object.id && (hit.object.type === 'rectangle' || hit.object.type === 'ellipse') && Math.hypot(hit.point.x - (objectBounds.x + objectBounds.width), hit.point.y - (objectBounds.y + objectBounds.height)) <= handleThreshold;
        if (selectedEntityId === hit.object.id && pointIndex >= 0 && event.ctrlKey) { const minimum = hit.object.type === 'polygon' ? 3 : 2; if (!hit.object.points || hit.object.points.length <= minimum) return; const next = structuredClone(tilemap); const layer = next.layers[hit.layer.id]; if (layer.type === 'object') { const object = deleteMapObjectPoint(hit.object, pointIndex); layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry); void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [tilemap.id] }); try { if (lock.acquired) await apply('Delete map object point', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision }]); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })(); } return; }
        if (selectedEntityId === hit.object.id && pointIndex < 0 && event.altKey && hit.object.points) { const nearest = nearestMapObjectSegment(hit.object, hit.point); if (nearest && nearest.distance <= handleThreshold) { const next = structuredClone(tilemap); const layer = next.layers[hit.layer.id]; if (layer.type === 'object') { const object = insertMapObjectPoint(hit.object, nearest.segmentIndex, nearest.point); layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry); void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [tilemap.id] }); try { if (lock.acquired) await apply('Insert map object point', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision }]); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })(); } return; } }
        const region = { x: Math.floor(objectBounds.x / tilemap.tileWidth), y: Math.floor(objectBounds.y / tilemap.tileHeight), width: Math.max(1, Math.ceil(objectBounds.width / tilemap.tileWidth)), height: Math.max(1, Math.ceil(objectBounds.height / tilemap.tileHeight)) };
        setMapObjectGesture({ layerId: hit.layer.id, objectId: hit.object.id, mode: pointIndex >= 0 ? 'point' : atHandle ? 'resize' : 'move', pointIndex: pointIndex >= 0 ? pointIndex : undefined, start: hit.point, current: hit.point, original: structuredClone(hit.object), lockPromise: window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [tilemap.id], region: { kind: 'tile', assetId: tilemap.id, ...region } }) }); setSelectedEntity(hit.object.id); setSelection([]); setCursor(point); return;
      }
    }
    if (tool === 'eyedropper' && sprite && activeFrameId) {
      const value = pixelAt(sprite, activeFrameId, point.x, point.y);
      setPixelIndex(value);
      const color = document.palette[value]?.color;
      if (color) useEditorStore.getState().setColor(color.slice(0, 7));
      return;
    }
    const combination: SelectionCombination = event.shiftKey && event.altKey ? 'intersect' : event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'replace'; selectionCombination.current = combination;
    if (tool === 'wand' && sprite && activeFrameId) {
      if (point.x < 0 || point.y < 0 || point.x >= sprite.width || point.y >= sprite.height) return;
      const selected = floodPixelRegion({ width: sprite.width, height: sprite.height, start: point, read: compositePixelReader(sprite, activeFrameId) });
      if (!selected.ok) notify(pixelToolLimitMessage('Magic-wand selection', selected), 'warning');
      else setSelection((current) => combineGridSelection(current, pixelRegionPoints(selected.runs), combination));
      setPreview([]); setBulkPreview([]); return;
    }
    if (tool === 'select' && combination === 'replace' && selection.some((entry) => entry.x === point.x && entry.y === point.y)) { setStart(point); setCursor(point); setPreview([]); setSelectionOffset({ x: 0, y: 0 }); return; }
    if (tool === 'select' || tool === 'lasso') { setSelectionOffset(undefined); setStart(point); setCursor(point); setLassoPath(tool === 'lasso' ? [point] : []); setPreview([point]); return; }
    if (tool === 'text' && sprite && activeFrameId) {
      setBitmapTextPoint(point);
      return;
    }
    const bounds = sprite ? { width: sprite.width, height: sprite.height, kind: 'pixel' as const } : { width: tilemap!.width, height: tilemap!.height, kind: 'tile' as const };
    if ((tool === 'fill' || tool === 'replace') && sprite && activeFrameId) {
      if (point.x < 0 || point.y < 0 || point.x >= sprite.width || point.y >= sprite.height) return;
      const read = compositePixelReader(sprite, activeFrameId);
      const source = read(point.x, point.y);
      if (source === pixelIndex) { notify(tool === 'fill' ? 'This region already uses the selected palette index.' : 'The source and replacement palette indices are identical.', 'info'); return; }
      const result = tool === 'fill'
        ? floodPixelRegion({ width: sprite.width, height: sprite.height, start: point, read })
        : replacePixelRegion({ width: sprite.width, height: sprite.height, matchIndex: source, read });
      if (!result.ok) { notify(pixelToolLimitMessage(tool === 'fill' ? 'Pixel flood fill' : 'Pixel color replacement', result), 'warning'); return; }
      if (!result.runs.length) { notify('The pixel operation would not change any cells.', 'info'); return; }
      const pendingLock = window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: bounds.kind, assetId: sprite.id, x: 0, y: 0, width: bounds.width, height: bounds.height } });
      setLockPromise(pendingLock); setStart(point); setCursor(point); setPreview([]); setBulkPreview(result.runs.map((run) => ({ ...run, index: pixelIndex }))); setStampPreview([]); setTileStampPreview([]);
      return;
    }
    setLockPromise(window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: bounds.kind, assetId: sprite?.id ?? asset!.id, x: 0, y: 0, width: bounds.width, height: bounds.height } }));
    setStart(point); setCursor(point); setBulkPreview([]); setStampPreview([]); setTileStampPreview([]); updatePreview(point, point);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toPixel(event);
    if (mapObjectGesture && tilemap) { setMapObjectGesture({ ...mapObjectGesture, current: toLayerMapObjectPoint(event, tilemap.layers[mapObjectGesture.layerId]) }); setCursor(point); return; }
    if (!start) { setCursor(point); return; }
    if (tool === 'hand' || event.button === 1) {
      setPan((current) => ({ x: current.x + event.movementX, y: current.y + event.movementY }));
    } else if (selectionOffset && tool === 'select') setSelectionOffset({ x: point.x - start.x, y: point.y - start.y });
    else if (tool === 'lasso') setLassoPath((current) => { const last = current.at(-1); const next = last?.x === point.x && last.y === point.y ? current : [...current, point]; setPreview(rasterizeGridLasso(next)); return next; });
    else if (tool === 'fill' || tool === 'replace') { setCursor(point); return; }
    else updatePreview(start, point);
    setCursor(point);
  };

  const finish = async () => {
    const gestureEpoch = gestureEpochRef.current;
    if (mapObjectGesture && tilemap) {
      const gesture = mapObjectGesture; setMapObjectGesture(undefined); const lock = await gesture.lockPromise; if (gestureEpoch !== gestureEpochRef.current || !lock?.acquired) return;
      try { const next = structuredClone(tilemap); const layer = next.layers[gesture.layerId]; if (layer?.type !== 'object') return; const object = previewMapObject(gesture); layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry); await apply(gesture.mode === 'point' ? 'Move map object point' : gesture.mode === 'move' ? 'Move map object' : 'Resize map object', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision }]); }
      finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      return;
    }
    const pendingLock = lockPromise;
    const pendingRuns = bulkPreview;
    const points = preview.filter((point) => tilemap?.infinite || (point.x >= 0 && point.y >= 0 && point.x < logical.gridWidth && point.y < logical.gridHeight));
    const placedStamp = stampPreview; const placedTiles = tileStampPreview; setStart(undefined); setPreview([]); setBulkPreview([]); setLassoPath([]); setStampPreview([]); setTileStampPreview([]);
    if (selectionOffset && tool === 'select') { const offset = selectionOffset; setSelectionOffset(undefined); if (offset.x || offset.y) await transformSelection('move', offset); return; }
    if (tool === 'select' || tool === 'lasso') { setSelection((current) => combineGridSelection(current, points, selectionCombination.current)); return; }
    if (points.length === 0 && pendingRuns.length === 0) { const emptyLock = await pendingLock; setLockPromise(undefined); if (gestureEpoch !== gestureEpochRef.current) return; if (emptyLock?.lockId) await window.aidraw.releaseHumanLock(emptyLock.lockId); return; }
    const lock = await pendingLock;
    setLockPromise(undefined);
    if (gestureEpoch !== gestureEpochRef.current || !lock?.acquired) return;
    try { if (sprite && activeFrameId) {
      const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id;
      const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined;
      if (cel) {
        if (pendingRuns.length) await apply(tool === 'fill' ? 'Fill pixels' : 'Replace pixel color', [{ kind: 'pixel.cel.region', spriteId: sprite.id, celId: cel.id, runs: pendingRuns, expectedRevision: cel.revision }]);
        else {
          const changes = tool === 'stamp'
            ? [...new Map(placedStamp.map((entry) => [`${entry.x},${entry.y}`, entry])).values()]
            : tool === 'dither'
            ? [...new Map(points.map((point) => [`${point.x},${point.y}`, { ...point, index: orderedDitherIndex(point.x, point.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize) }])).values()]
            : tool === 'lighten' || tool === 'darken'
            ? [...new Map(points.map((point) => { const current = pixelAt(sprite, activeFrameId, point.x, point.y); return [`${point.x},${point.y}`, { ...point, index: stepPaletteByLuminance(activePaletteOverride ?? document.palette, current, tool === 'lighten' ? 'lighter' : 'darker') }] as const; })).values()]
            : uniqueChanges(points, tool === 'eraser' ? 0 : pixelIndex);
          await apply(`${tool === 'eraser' ? 'Erase' : 'Draw'} pixels`, [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes, expectedRevision: cel.revision }]);
        }
      }
    } else if (tilemap) {
      const layerId = Object.values(tilemap.layers).find((entry) => entry.type === 'tile' && entry.visible && !entry.locked)?.id;
      const layer = layerId ? tilemap.layers[layerId] : undefined;
      const firstGid = terrainTileset?.type === 'tileset' ? terrainTileset.firstGid : 1;
      if (layerId && layer?.type === 'tile' && layer.chunks) {
        if (tool === 'stamp' && placedTiles.length) {
          await apply('Place reusable tile stamp', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes: placedTiles, expectedRevision: layer.revision }]);
        } else if (tool === 'terrain' && terrainTileset?.type === 'tileset' && terrainSet && terrainColor) {
          const pending = new Map<string, number>(); let unmatched = 0;
          const localTileAt = (x: number, y: number) => {
            const queued = pending.get(x + ',' + y); if (queued !== undefined) return queued;
            const decoded = decodeTiledGid(readTileAt(layer.chunks!, x, y)); return decoded.gid >= firstGid ? decoded.gid - firstGid : undefined;
          };
          for (const point of points) {
            const painted = paintWangTerrain(terrainSet, point.x, point.y, terrainColor.id, localTileAt, terrainErase);
            unmatched += painted.unmatched.length;
            for (const change of painted.changes) if (tilemap.infinite || (change.x >= 0 && change.y >= 0 && change.x < tilemap.width && change.y < tilemap.height)) pending.set(change.x + ',' + change.y, change.tileId);
          }
          const changes = [...pending.entries()].map(([key, tileId]) => { const [x, y] = key.split(',').map(Number); return { x, y, gid: tileId + firstGid }; });
          if (changes.length) await apply(terrainErase ? 'Erase Wang terrain' : 'Paint Wang terrain', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes, expectedRevision: layer.revision }]);
          if (unmatched) notify(unmatched + ' terrain neighbor' + (unmatched === 1 ? '' : 's') + ' had no exact Wang tile mapping.', 'warning');
        } else {
          const changes = points.map((point) => ({ ...point, gid: tool === 'eraser' ? 0 : encodeTiledGid(firstGid + (terrainTileset?.type === 'tileset' ? chooseTileVariant(terrainTileset, selectedTileId, point.x, point.y, variantSeed) : selectedTileId), tileTransforms) }));
          await apply(selectedVariantGroup ? `Paint ${selectedVariantGroup} variants` : 'Paint tiles', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes, expectedRevision: layer.revision }]);
        }
      }
    } } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
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

  const duplicateFrame = async () => {
    if (!sprite || !activeFrameId) return;
    const duplicate = duplicatePixelFrame(sprite, activeFrameId, { actorId: HUMAN_ACTOR.id, timestamp: nowIso() });
    if (await apply('Duplicate frame', [{ kind: 'pixel.frame.add', spriteId: sprite.id, ...duplicate, expectedRevision: sprite.revision }])) setFrameId(duplicate.frame.id);
  };

  const deleteFrame = async () => {
    if (!sprite || !activeFrameId || sprite.frameIds.length <= 1) return;
    const index = sprite.frameIds.indexOf(activeFrameId); const nextFrame = sprite.frameIds[index + 1] ?? sprite.frameIds[index - 1];
    if (await apply('Delete frame', [{ kind: 'pixel.frame.delete', spriteId: sprite.id, frameId: activeFrameId, expectedRevision: sprite.revision }])) setFrameId(nextFrame);
  };

  const moveFrame = async (direction: -1 | 1) => {
    if (!sprite || !activeFrameId) return;
    const index = sprite.frameIds.indexOf(activeFrameId); const target = index + direction; if (target < 0 || target >= sprite.frameIds.length) return;
    const next = reorderPixelFrame(sprite, activeFrameId, direction);
    await apply(direction < 0 ? 'Move frame left' : 'Move frame right', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }]);
  };

  const toggleCelLink = async () => {
    if (!sprite || !activeFrameId) return;
    const frameIndex = sprite.frameIds.indexOf(activeFrameId); const rawCels = Object.values(sprite.cels).filter((cel) => cel.frameId === activeFrameId); const linked = rawCels.some((cel) => Boolean(cel.linkedToCelId));
    if (!linked && frameIndex <= 0) { notify('The first frame has no previous cels to link.', 'warning'); return; }
    const next = setPixelFrameCelsLinked(sprite, activeFrameId, !linked);
    await apply(linked ? 'Unlink frame cels' : 'Link frame cels', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }]);
  };

  const toggleCelExposureLink = async (layerId: string, targetFrameId: string) => {
    if (!sprite) return;
    const layer = sprite.layers[layerId]; const raw = pixelRawCelForFrame(sprite, layerId, targetFrameId); const linked = Boolean(raw?.linkedToCelId);
    if (!layer || layer.type !== 'pixel' || !raw) { notify('That cel exposure is unavailable.', 'warning'); return; }
    if (layer.locked) { notify('Unlock the pixel layer before changing its cel exposure.', 'warning'); return; }
    if (!linked && sprite.frameIds.indexOf(targetFrameId) <= 0) { notify('The first frame has no previous cel to link.', 'warning'); return; }
    const next = setPixelCelLinked(sprite, layerId, targetFrameId, !linked);
    if (await apply(linked ? `Unlink ${layer.name} cel` : `Link ${layer.name} cel`, [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }])) { setFrameId(targetFrameId); setSelectedEntity(layerId); }
  };

  const togglePaletteOverride = async () => {
    if (!sprite || !activeFrameId) return;
    const next = setPixelFramePaletteOverride(sprite, activeFrameId, sprite.paletteOverrides[activeFrameId] ? undefined : document.palette);
    await apply(next.paletteOverrides[activeFrameId] ? 'Enable frame palette' : 'Use document palette', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }]);
  };

  const changeOverrideColor = async (color: string) => {
    if (!sprite || !activeFrameId || !sprite.paletteOverrides[activeFrameId]?.[pixelIndex]) return;
    const palette = structuredClone(sprite.paletteOverrides[activeFrameId]); palette[pixelIndex].color = color;
    const next = setPixelFramePaletteOverride(sprite, activeFrameId, palette);
    await apply('Edit frame palette color', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }]);
  };

  const addBitmapText = async (request: BitmapTextRequest) => {
    const point = bitmapTextPoint;
    const frame = activeFrameId;
    const font = document.bitmapFonts.find((entry) => entry.id === request.fontId);
    if (!sprite || !point || !frame || !request.text.trim() || !font) return;
    const points = bitmapTextCells(font, request.text, { x: point.x, y: point.y, letterSpacing: request.letterSpacing, lineSpacing: request.lineSpacing, scale: request.scale, align: request.align }).filter((entry) => entry.x >= 0 && entry.y >= 0 && entry.x < sprite.width && entry.y < sprite.height);
    if (!points.length) return;
    const xs = points.map((entry) => entry.x); const ys = points.map((entry) => entry.y);
    const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 } });
    if (!lock.acquired) return;
    try {
      const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id;
      const cel = layerId ? celFor(sprite, layerId, frame) : undefined;
      if (cel && await apply('Add bitmap text', [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes: uniqueChanges(points, pixelIndex), expectedRevision: cel.revision }])) setBitmapTextPoint(undefined);
    } finally {
      if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId);
    }
  };

  const changeFrameDuration = async (value: string) => {
    if (!sprite || !durationFrameId) return;
    const current = sprite.frames[durationFrameId];
    const durationMs = Number(value);
    if (!current || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 60_000) return;
    if (await apply('Change frame duration', [{ kind: 'pixel.frame.replace', spriteId: sprite.id, frame: { ...current, durationMs }, expectedRevision: current.revision }])) setDurationFrameId(undefined);
  };

  const openTagDialog = (tagId?: string) => {
    if (!sprite) return;
    const tag = tagId ? sprite.tags.find((entry) => entry.id === tagId) : undefined;
    setTagDraft(tag ? structuredClone(tag) : { name: `Animation ${sprite.tags.length + 1}`, fromFrameId: activeFrameId ?? sprite.frameIds[0], toFrameId: sprite.frameIds.at(-1)!, direction: pingPong ? 'ping-pong' : 'forward', color: '#31a6a0' });
  };

  const addTag = async () => {
    if (!sprite || !tagDraft?.name.trim()) return;
    const fromIndex = sprite.frameIds.indexOf(tagDraft.fromFrameId);
    const toIndex = sprite.frameIds.indexOf(tagDraft.toFrameId);
    if (fromIndex < 0 || toIndex < fromIndex) return;
    const tag = { ...tagDraft, id: tagDraft.id ?? createId('tag'), name: tagDraft.name.trim() };
    const next = upsertPixelAnimationTag(sprite, tag);
    if (await apply(tagDraft.id ? 'Edit animation tag' : 'Add animation tag', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }])) setTagDraft(undefined);
  };

  const deleteTag = async (tagId: string) => {
    if (!sprite) return; const next = deletePixelAnimationTag(sprite, tagId);
    if (await apply('Delete animation tag', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }])) { if (selectedTagId === tagId) setSelectedTagId(undefined); setTagDraft(undefined); }
  };

  useEffect(() => {
    const onSelectionCommand = (event: Event) => {
      const command = (event as CustomEvent<PixelSelectionCommand>).detail;
      if (command === 'copy') copyLocalSelection();
      else if (command === 'cut') { if (copyLocalSelection()) void deleteSelection(); }
      else if (command === 'paste') void pasteLocalSelection();
      else if (command === 'delete') void deleteSelection();
      else if (command === 'clear') { setSelection([]); setSelectionOffset(undefined); setLassoPath([]); }
      else if (command === 'select-all') {
        if (tilemap?.infinite) { notify('Select All is not finite on an infinite map; drag a bounded selection instead.', 'warning'); return; }
        const width = sprite?.width ?? tilemap?.width ?? 0; const height = sprite?.height ?? tilemap?.height ?? 0;
        if (width * height > 1_000_000) { notify('Select All is limited to one million cells.', 'warning'); return; }
        setSelection(Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width) })));
      }
    };
    window.addEventListener('aidraw:pixel-selection-command', onSelectionCommand);
    return () => window.removeEventListener('aidraw:pixel-selection-command', onSelectionCommand);
  });

  if (!asset) return <div className="empty-canvas">No pixel asset selected.</div>;
  if (asset.type === 'tileset' && !sprite) return <div className="empty-canvas"><Grid3X3 size={36} /><strong>Missing tileset pixels</strong><span>The linked source sprite is unavailable.</span></div>;
  const durationFrame = durationFrameId && sprite ? sprite.frames[durationFrameId] : undefined;
  const durationFrameNumber = durationFrameId && sprite ? sprite.frameIds.indexOf(durationFrameId) + 1 : undefined;
  const tagFromIndex = tagDraft && sprite ? sprite.frameIds.indexOf(tagDraft.fromFrameId) : -1;
  const tagToIndex = tagDraft && sprite ? sprite.frameIds.indexOf(tagDraft.toFrameId) : -1;
  const tagError = !tagDraft?.name.trim() ? 'Enter a tag name.' : tagFromIndex < 0 || tagToIndex < tagFromIndex ? 'The end frame must be at or after the start frame.' : undefined;
  const activeFrameLinked = Boolean(sprite && activeFrameId && Object.values(sprite.cels).some((cel) => cel.frameId === activeFrameId && cel.linkedToCelId));

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
        onPointerCancel={() => void cancelGesture()}
        onPointerLeave={() => !start && setCursor(undefined)}
        onKeyDown={(event) => { if (event.key === 'Escape' && (start || mapObjectGesture || lockPromise || selectionOffset)) { event.preventDefault(); event.stopPropagation(); void cancelGesture(); } }}
        onWheel={onWheel}
      />
      <PlaybackLanes playbacks={playbacks} />
      {tileset && <div className="tileset-canvas-label"><Grid3X3 size={14} /><span><strong>Tileset source</strong><small>{tileset.tileWidth} × {tileset.tileHeight}px cells · metadata in Layers</small></span></div>}
      <div className="pixel-floating-controls">
        {hasTimeline && <button className={onionSkin ? 'is-active' : ''} onClick={() => setOnionSkin((value) => !value)} title="Onion skin"><Eye size={14} /> Onion</button>}
        {hasTimeline && <button className={onionSettingsOpen ? 'is-active' : ''} aria-expanded={onionSettingsOpen} aria-controls="onion-skin-settings" onClick={() => { setOnionSettingsOpen((open) => !open); setExposureGridOpen(false); }} title="Configure bounded onion skin frames, tint, and opacity"><SlidersHorizontal size={13} /> Onion setup</button>}
        <button className={wrapPreview ? 'is-active' : ''} onClick={() => setWrapPreview((value) => !value)} title="Tile wrap preview"><Repeat2 size={14} /> Wrap</button>
        {sprite && <button className={symmetry !== 'none' ? 'is-active' : ''} onClick={() => setSymmetry((value) => value === 'none' ? 'horizontal' : value === 'horizontal' ? 'vertical' : value === 'vertical' ? 'both' : 'none')} title="Cycle symmetry: none, horizontal, vertical, both"><FlipHorizontal2 size={14} /> {symmetry === 'none' ? 'Sym' : symmetry[0].toUpperCase()}</button>}
        {sprite && <button className={paletteCycling ? 'is-active' : ''} onClick={() => { if (paletteCycling) setPaletteOffset(0); setPaletteCycling(!paletteCycling); }} title="Palette cycling preview"><Repeat2 size={14} /> Cycle</button>}
        {paletteCycling && document.paletteCycles.length > 0 && <select aria-label="Active palette cycle" value={activePaletteCycle?.id} onChange={(event) => { setActivePaletteCycleId(event.target.value); setPaletteOffset(0); }} title="Named palette cycle">{document.paletteCycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}</select>}
        {tool === 'terrain' && terrainTileset?.type === 'tileset' && <><select aria-label="Active Wang set" value={terrainSet?.id ?? ''} onChange={(event) => { setTerrainSetId(event.target.value); setTerrainColorId(undefined); }}><option value="" disabled>Wang set</option>{terrainTileset.wangSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select><select aria-label="Active Wang color" value={terrainColor?.id ?? ''} onChange={(event) => setTerrainColorId(Number(event.target.value))}><option value="" disabled>Terrain color</option>{terrainSet?.colors.map((color) => <option key={color.id} value={color.id}>{color.name}</option>)}</select><button className={terrainErase ? 'is-active' : ''} onClick={() => setTerrainErase((value) => !value)} title="Toggle terrain erase and neighbor repair"><Eraser size={13} /> {terrainErase ? 'Erase' : 'Paint'}</button></>}
        {tilemap && tool !== 'terrain' && terrainTileset?.type === 'tileset' && <><button className={tileTransforms.hFlip ? 'is-active' : ''} disabled={!terrainTileset.transformations.hFlip} onClick={() => setTileTransforms((value) => ({ ...value, hFlip: !value.hFlip }))} title="Paint horizontally flipped tiles"><FlipHorizontal2 size={13} /> Tile H</button><button className={tileTransforms.vFlip ? 'is-active' : ''} disabled={!terrainTileset.transformations.vFlip} onClick={() => setTileTransforms((value) => ({ ...value, vFlip: !value.vFlip }))} title="Paint vertically flipped tiles"><FlipVertical2 size={13} /> Tile V</button><button className={tileTransforms.diagonal ? 'is-active' : ''} disabled={!terrainTileset.transformations.rotate} onClick={() => setTileTransforms((value) => ({ ...value, diagonal: !value.diagonal }))} title="Paint diagonally transformed tiles"><RotateCw size={13} /> Tile 90°</button></>}
        {tilemap && tool !== 'terrain' && selectedVariantGroup && <div className="variant-seed-control" title={`${selectedVariantCount} weighted tiles in “${selectedVariantGroup}”`}><span>{selectedVariantGroup} · {selectedVariantCount}</span><label><span>Seed</span><input aria-label="Random tile variant seed" type="number" defaultValue={variantSeed} key={`${tilemap.id}:${variantSeed}`} onBlur={(event) => changeVariantSeed(Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(Number(event.target.value) || 0))), 'Change tile variant seed')} /></label><button type="button" onClick={() => changeVariantSeed(nextTileVariantSeed(variantSeed), 'Start new tile-variant stroke seed')} title="Persist a new deterministic seed for subsequent variant strokes; existing painted tiles do not change"><Dices size={11} /> New stroke</button></div>}
        {tool === 'stamp' && (sprite || tilemap) && <>
          {sprite ? <select aria-label="Active reusable stamp" value={activeStamp?.id ?? 'builtin-plus'} onChange={(event) => setActiveStampId(event.target.value === 'builtin-plus' ? undefined : event.target.value)} title="Reusable stamp library"><option value="builtin-plus">Built-in plus</option>{document.stamps.map((stamp) => <option key={stamp.id} value={stamp.id}>{stamp.name}</option>)}</select> : <select aria-label="Active reusable tile stamp" value={activeTileStamp?.id ?? 'builtin-tile'} onChange={(event) => setActiveTileStampId(event.target.value === 'builtin-tile' ? undefined : event.target.value)} title="Reusable tile stamp library"><option value="builtin-tile">Current tile</option>{document.tileStamps.map((stamp) => <option key={stamp.id} value={stamp.id}>{stamp.name}</option>)}</select>}
          <button disabled={!selection.length} onClick={() => setStampCaptureOpen(true)} title="Capture the current selection as a reusable stamp"><Copy size={13} /> Capture</button>
          <button onClick={() => { setStampCaptureOpen(false); setStampLibraryOpen(true); }} title="Copy or import a bounded reusable stamp library as AIDraw JSON"><ClipboardPaste size={13} /> Library JSON</button>
          <button disabled={sprite ? !activeStamp : !activeTileStamp} onClick={() => void transformActiveStamp('flip-horizontal')} title="Flip saved stamp horizontally"><FlipHorizontal2 size={13} /></button>
          <button disabled={sprite ? !activeStamp : !activeTileStamp} onClick={() => void transformActiveStamp('flip-vertical')} title="Flip saved stamp vertically"><FlipVertical2 size={13} /></button>
          <button disabled={sprite ? !activeStamp : !activeTileStamp} onClick={() => void transformActiveStamp('rotate-clockwise')} title="Rotate saved stamp 90° clockwise"><RotateCw size={13} /></button>
          <button disabled={sprite ? !activeStamp : !activeTileStamp} onClick={() => void transformActiveStamp('rotate-counterclockwise')} title="Rotate saved stamp 90° counterclockwise"><RotateCcw size={13} /></button>
          <button disabled={sprite ? !activeStamp : !activeTileStamp} onClick={() => void deleteActiveStamp()} title="Delete saved stamp"><Trash2 size={13} /></button>
        </>}
        {selection.length > 0 && <>
          <button onClick={() => notify('With Select active, drag from inside the marching ants to move this indexed content.', 'info')} title="Drag inside the selection to move it"><Move size={13} /> Move</button>
          <button onClick={() => copyLocalSelection()} title="Copy exact indexed selection (Ctrl+C)"><Copy size={13} /> Copy</button>
          <button onClick={() => { if (copyLocalSelection()) void deleteSelection(); }} title="Cut exact indexed selection (Ctrl+X)"><Scissors size={13} /> Cut</button>
          <button onClick={() => void transformSelection('flip-horizontal')} title="Flip selected pixels horizontally"><FlipHorizontal2 size={13} /> H</button>
          <button onClick={() => void transformSelection('flip-vertical')} title="Flip selected pixels vertically"><FlipVertical2 size={13} /> V</button>
          <button onClick={() => void transformSelection('rotate-clockwise')} title="Rotate selected cells 90° clockwise"><RotateCw size={13} /> CW</button>
          <button onClick={() => void transformSelection('rotate-counterclockwise')} title="Rotate selected cells 90° counterclockwise"><RotateCcw size={13} /> CCW</button>
          <button onClick={() => setSelectionScaleOpen(true)} title="Scale selected cells by independent integer factors"><Scaling size={13} /> Scale</button>
          <button onClick={() => void deleteSelection()} title="Delete selected pixels"><Trash2 size={13} /></button>
          <button onClick={() => { setSelection([]); setSelectionOffset(undefined); }} title="Clear selection">Clear</button>
        </>}
        {clipboardAvailable && <button onClick={() => void pasteLocalSelection()} title="Paste the AIDraw pixel selection at the cursor (Ctrl+V)"><ClipboardPaste size={13} /> Paste</button>}
        <span>{cursor ? `${cursor.x}, ${cursor.y}` : '—, —'}</span>
      </div>
      {hasTimeline && sprite && (
        <div className="timeline">
          <div className="timeline-playback"><button onClick={() => setFrameId(sprite.frameIds[Math.max(0, sprite.frameIds.indexOf(activeFrameId ?? '') - 1)])}><ChevronLeft size={15} /></button><button className="play-button" onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button><button onClick={() => setFrameId(sprite.frameIds[Math.min(sprite.frameIds.length - 1, sprite.frameIds.indexOf(activeFrameId ?? '') + 1)])}><ChevronRight size={15} /></button><button className={pingPong ? 'is-active' : ''} title="Ping-pong playback" onClick={() => { setPingPong((value) => !value); setPlayDirection(1); }}><Repeat2 size={14} /></button></div>
          <div className="timeline-label"><strong>Animation</strong><small>{sprite.frameIds.length} frames · {sprite.tags.length} tags</small><button onClick={() => openTagDialog()}>+ Tag</button></div>
          <div className="timeline-frame-actions">
            <button onClick={() => void moveFrame(-1)} disabled={sprite.frameIds.indexOf(activeFrameId ?? '') <= 0} title="Move active frame left"><ArrowLeft size={12} /></button>
            <button onClick={() => void moveFrame(1)} disabled={sprite.frameIds.indexOf(activeFrameId ?? '') >= sprite.frameIds.length - 1} title="Move active frame right"><ArrowRight size={12} /></button>
            <button onClick={() => void duplicateFrame()} title="Duplicate active frame"><Copy size={12} /></button>
            <button className={activeFrameLinked ? 'is-active' : ''} onClick={() => void toggleCelLink()} title={activeFrameLinked ? 'Unlink active frame cels' : 'Link active frame cels to previous frame'}>{activeFrameLinked ? <Unlink2 size={12} /> : <Link2 size={12} />}</button>
            <button className={exposureGridOpen ? 'is-active' : ''} onClick={() => { setExposureGridOpen((open) => !open); setOnionSettingsOpen(false); }} title="Open layer-by-frame cel exposure grid"><Table2 size={12} /></button>
            <button className={activePaletteOverride ? 'is-active' : ''} onClick={() => void togglePaletteOverride()} title={activePaletteOverride ? 'Use document palette' : 'Create per-frame palette override'}><Palette size={12} /></button>
            {activePaletteOverride?.[pixelIndex] && <input aria-label="Active frame palette color" type="color" value={activePaletteOverride[pixelIndex].color.slice(0, 7)} onChange={(event) => void changeOverrideColor(event.target.value)} />}
            <button onClick={() => void deleteFrame()} disabled={sprite.frameIds.length <= 1} title="Delete active frame"><Trash2 size={12} /></button>
          </div>
          {sprite.tags.length > 0 && <div className="timeline-tags">{sprite.tags.map((tag) => <button key={tag.id} className={selectedTagId === tag.id ? 'is-active' : ''} style={{ '--tag-color': tag.color } as CSSProperties} onClick={() => { const active = selectedTagId === tag.id ? undefined : tag.id; setSelectedTagId(active); setPlayDirection(tag.direction === 'reverse' ? -1 : 1); if (active) setFrameId(tag.direction === 'reverse' ? tag.toFrameId : tag.fromFrameId); }} onDoubleClick={() => openTagDialog(tag.id)} title="Click to preview this range; double-click to edit">{tag.name}</button>)}</div>}
          <div className="frame-strip">
            {sprite.frameIds.map((id, index) => <button key={id} className={id === activeFrameId ? 'is-active' : ''} onClick={() => setFrameId(id)} onDoubleClick={() => setDurationFrameId(id)} title="Double-click to edit duration"><span className="frame-thumb"><Grid3X3 size={13} /></span><small>{index + 1}</small><em>{sprite.frames[id]?.durationMs ?? 100}ms</em></button>)}
            <button className="add-frame" title="Add frame (Alt: linked cel)" onClick={(event) => void addFrame(event.altKey)}>+</button>
          </div>
        </div>
      )}
      {exposureGridOpen && sprite && activeFrameId && <CelExposureGrid key={`${sprite.id}:${sprite.revision}:${activeFrameId}:${selectedEntityId ?? ''}`} sprite={sprite} activeFrameId={activeFrameId} activeLayerId={selectedEntityId} onSelect={(nextFrameId, layerId) => { setFrameId(nextFrameId); setSelectedEntity(layerId); }} onToggleLink={(layerId, nextFrameId) => void toggleCelExposureLink(layerId, nextFrameId)} onClose={() => setExposureGridOpen(false)} />}
      {onionSettingsOpen && hasTimeline && sprite && <OnionSkinSettingsPanel settings={onionSettings} onChange={setOnionSettings} onClose={() => setOnionSettingsOpen(false)} />}
      {bitmapTextPoint && sprite && <BitmapTextDialog fonts={document.bitmapFonts} origin={bitmapTextPoint} spriteSize={{ width: sprite.width, height: sprite.height }} paletteIndex={pixelIndex} onSubmit={addBitmapText} onFontsReplace={(fonts) => apply('Replace bitmap font library', [{ kind: 'pixel.bitmap-fonts.replace', fonts }])} onClose={() => setBitmapTextPoint(undefined)} />}
      {stampCaptureOpen && (sprite || tilemap) && <EntryDialog
        title="Save reusable stamp"
        description={sprite ? "The current selection is captured with exact palette indices, including transparent cells and its center anchor." : "The current map selection is captured with exact 32-bit GIDs, transformations, empty cells, and its center anchor."}
        label="Stamp name"
        initialValue={`Stamp ${(sprite ? document.stamps : document.tileStamps).length + 1}`}
        submitLabel="Save stamp"
        maxLength={120}
        validate={(value) => !value.trim() ? 'Enter a stamp name.' : (sprite ? document.stamps : document.tileStamps).some((stamp) => stamp.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase()) ? 'Use a unique stamp name.' : undefined}
        preview={() => { const bounds = pixelSelectionBounds(selection); return <><strong>Indexed footprint</strong><span>{bounds ? `${bounds.width} × ${bounds.height}${sprite ? 'px' : ' tiles'} · ${selection.length} selected cells` : 'Selection unavailable'}</span></>; }}
        onSubmit={captureSelectionAsStamp}
        onClose={() => setStampCaptureOpen(false)}
      />}
      {stampLibraryOpen && (sprite || tilemap) && <StampLibraryDialog
        document={document}
        map={tilemap}
        onApply={async (plan) => {
          const applied = await apply(`Import reusable ${plan.kind} stamp library`, plan.operations);
          if (applied) {
            const activeId = plan.importedIds.at(-1);
            if (plan.kind === 'pixel') setActiveStampId(activeId);
            else setActiveTileStampId(activeId);
          }
          return applied;
        }}
        onClose={() => setStampLibraryOpen(false)}
      />}
      {selectionScaleOpen && <EntryDialog
        title="Integer-scale selection"
        description="Nearest-neighbor integer scaling preserves every palette index or tile GID. Enter one factor for uniform scaling, or independent X × Y factors."
        label="Scale (X × Y)"
        initialValue="2 × 2"
        submitLabel="Scale selection"
        maxLength={12}
        validate={(value) => parseIntegerScale(value) ? undefined : 'Use whole-number factors from 1 through 64, for example 3 or 2 × 4.'}
        preview={(value) => { const scale = parseIntegerScale(value); const bounds = pixelSelectionBounds(selection); return <><strong>Nearest-neighbor result</strong><span>{scale && bounds ? `${bounds.width * scale.x} × ${bounds.height * scale.y}${sprite ? 'px' : ' tiles'} · up to ${selection.length * scale.x * scale.y} selected cells` : 'Enter a valid scale'}</span></>; }}
        onSubmit={async (value) => { const scale = parseIntegerScale(value); if (scale) await scaleSelection(scale.x, scale.y); }}
        onClose={() => setSelectionScaleOpen(false)}
      />}
      {durationFrame && <EntryDialog
        title={`Frame ${durationFrameNumber} duration`}
        description="Frame timing is stored in milliseconds and is preserved by animated export."
        label="Duration (milliseconds)"
        type="number"
        min={1}
        max={60_000}
        initialValue={String(durationFrame.durationMs)}
        submitLabel="Set duration"
        validate={(value) => { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 60_000 ? undefined : 'Use a whole number from 1 to 60,000.'; }}
        preview={(value) => { const number = Number(value); return <><strong>Playback rate</strong><span>{Number.isFinite(number) && number > 0 ? `${(1_000 / number).toFixed(2)} frames/second` : '—'}</span></>; }}
        onSubmit={changeFrameDuration}
        onClose={() => setDurationFrameId(undefined)}
      />}
      {tagDraft && sprite && <EditorDialog title={tagDraft.id ? 'Edit animation tag' : 'Add animation tag'} description="Name an exact frame range and choose how tagged playback traverses it." onClose={() => setTagDraft(undefined)} className="animation-tag-dialog">
        <form onSubmit={(event) => { event.preventDefault(); if (!tagError) void addTag(); }}>
          <div className="entry-dialog-body tag-dialog-grid">
            <label className="dialog-field tag-name-field"><span>Name</span><input autoFocus maxLength={120} value={tagDraft.name} onChange={(event) => setTagDraft({ ...tagDraft, name: event.target.value })} aria-invalid={!tagDraft.name.trim()} /></label>
            <label className="dialog-field"><span>Start frame</span><select value={tagDraft.fromFrameId} onChange={(event) => setTagDraft({ ...tagDraft, fromFrameId: event.target.value })}>{sprite.frameIds.map((id, index) => <option key={id} value={id}>Frame {index + 1}</option>)}</select></label>
            <label className="dialog-field"><span>End frame</span><select value={tagDraft.toFrameId} onChange={(event) => setTagDraft({ ...tagDraft, toFrameId: event.target.value })}>{sprite.frameIds.map((id, index) => <option key={id} value={id}>Frame {index + 1}</option>)}</select></label>
            <label className="dialog-field"><span>Direction</span><select value={tagDraft.direction} onChange={(event) => setTagDraft({ ...tagDraft, direction: event.target.value as TagDraft['direction'] })}><option value="forward">Forward</option><option value="reverse">Reverse</option><option value="ping-pong">Ping-pong</option></select></label>
            <label className="dialog-field"><span>Label color</span><input type="color" value={tagDraft.color} onChange={(event) => setTagDraft({ ...tagDraft, color: event.target.value })} /></label>
            <div className="entry-dialog-preview tag-range-preview"><strong>Tagged range</strong><span>{tagError ?? `${tagToIndex - tagFromIndex + 1} frames · ${tagDraft.direction}`}</span></div>
            {tagError && <p className="entry-dialog-error" role="alert">{tagError}</p>}
          </div>
          <footer className="modal-footer">{tagDraft.id && <button type="button" className="danger-modal-button" onClick={() => void deleteTag(tagDraft.id!)}>Delete tag</button>}<button type="button" className="secondary-modal-button" onClick={() => setTagDraft(undefined)}>Cancel</button><button type="submit" className="primary-modal-button" disabled={Boolean(tagError)}>{tagDraft.id ? 'Save tag' : 'Add tag'}</button></footer>
        </form>
      </EditorDialog>}
    </div>
  );
}
