import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import {
  decodeTiledGid,
  decodeTilemapChunk,
  encodeTiledGid,
  capturePixelStamp,
  captureBitmapGlyph,
  captureTileStamp,
  bitmapTextCells,
  createEmptyBitmapFont,
  measureBitmapText,
  createPixelCelReader,
  cycledPaletteIndex,
  deleteBitmapFont,
  deleteBitmapFontGlyph,
  deletePixelAnimationTag,
  duplicatePixelFrame,
  ellipsePixels,
  editBitmapFontGlyph,
  floodPixelRegion,
  HUMAN_ACTOR,
  imageCollectionTilemapModeError,
  isImageCollectionTileset,
  createId,
  mapBitmapFontGlyphSheet,
  nowIso,
  orderedDitherIndex,
  planWangTerrainStroke,
  pixelAnimationFrames,
  pixelAnimationTagSpans,
  pixelCelForFrame,
  pixelRawCelForFrame,
  pixelPerfectStrokePoints,
  placePixelStamp,
  placeTileStamp,
  readPixel,
  readTileAt,
  replacePixelRegion,
  resolveBitmapFontId,
  reorderPixelFrame,
  renameBitmapFont,
  resolveTilesetForGid,
  tilesetHasLocalId,
  tilesetTileSourceAssetId,
  setPixelCelLinked,
  setPixelFrameCelsLinked,
  setPixelFramePaletteOverride,
  stepPaletteByLuminance,
  transformPixelStamp,
  transformTileStamp,
  upsertBitmapFontGlyph,
  upsertPixelAnimationTag,
  wrapPixelPoint,
  wrapPixelPoints,
  type CanvasOperation,
  type MapObject,
  type BitmapFont,
  type BitmapGlyphCapture,
  type PixelIndexRun,
  type PixelRegionResult,
  type PixelDocument,
  type PixelSprite,
  type PixelStamp,
  type PixelStampTransform,
  type TileStamp,
  type TilemapChunk,
} from '@aidraw/core';
import { ArrowLeft, ArrowRight, CaseUpper, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Dices, Eraser, Eye, FlipHorizontal2, FlipVertical2, Grid3X3, Link2, Move, Palette, Pause, Play, Repeat2, RotateCcw, RotateCw, Scaling, Scissors, SlidersHorizontal, Table2, Trash2, Unlink2 } from 'lucide-react';
import { useEditorStore } from '../store';
import { CelExposureGrid } from '../components/CelExposureGrid';
import { BitmapGlyphMapperDialog } from '../components/BitmapGlyphMapperDialog';
import { BitmapGlyphSheetMapperDialog } from '../components/BitmapGlyphSheetMapperDialog';
import {
  BitmapFontLibraryDialog,
  type BitmapFontGlyphDeleteRequest,
  type BitmapFontGlyphEditRequest,
  type BitmapFontRenameRequest,
} from '../components/BitmapFontLibraryDialog';
import { OnionSkinSettingsPanel } from '../components/OnionSkinSettingsPanel';
import { SpriteSymmetrySettingsPanel } from '../components/SpriteSymmetrySettingsPanel';
import { AnimationFrameTagMembership, AnimationTagStrip } from '../components/AnimationTagTimeline';
import {
  animationAdvisoryDirection,
  animationTagMembershipsForFrames,
  animationTagMembershipSummary,
  animationTagScopeMatches,
  resolveScopedAnimationTagId,
  type ScopedAnimationTagSelection,
} from '../animation-tag-timeline';
import { PlaybackLanes } from '../components/PlaybackLanes';
import { StampLibraryDialog } from '../components/StampLibraryDialog';
import { TileTransformPicker } from '../components/TileTransformPicker';
import { CurrentMapTileControl } from '../components/CurrentMapTileControl';
import { collectReplayMasks, replayPointKey, replayTileLayerKey } from '../replay';
import { EditorDialog, EntryDialog } from '../components/EditorDialog';
import { bresenham } from './geometry';
import { clientPointToIsometricTile, clientPointToOrthogonalTile, clientPointToPixel, clientPointToTilemapObjectAnchor } from './pixel-coordinates';
import { pixelSelectionBounds, transformPixelSelection, type PixelSelectionTransform } from '../../common/pixel-selection';
import { MAX_GRID_LASSO_VERTICES, appendGridLassoPoint, captureGridSelection, combineGridSelection, createGridLassoDraft, placeGridClipboard, rasterizeGridLasso, scaleGridSelection, transformGridSelection, type GridLassoDraft, type GridSelectionClipboard } from '../../common/grid-selection';
import type { PixelSelectionFragment } from '../../common/document-fragment';
import { planPixelSelectionPaste } from '../../common/pixel-selection-clipboard';
import { drawBoundedGridChecker } from '../../common/grid-checker';
import { deleteMapObjectPoint, insertMapObjectPoint, mapObjectAtPoint, mapObjectBounds, moveMapObjectPoint, nearestMapObjectSegment, transformMapObject } from '../../common/map-objects';
import { isometricCellRect, isometricObjectMatrix, isometricProjectionExtent, type IsometricCellRect } from '../../common/isometric-projection';
import { isometricMapTileArtworkEnvelope, isometricTileArtworkIntersects, isometricTileArtworkPlacement, type IsometricTileArtworkPlacement } from '../../common/isometric-tile-artwork';
import { drawMapObjectOverlay, mapObjectIntersectsRasterRegion } from '../../common/map-object-render';
import { tileObjectArtworkContainsPoint, tileObjectArtworkIntersects, tileObjectArtworkPlacement, tileObjectFallbackColor } from '../../common/tile-object-artwork';
import { orthogonalCellRect, orthogonalObjectMatrix, orthogonalProjectionExtent } from '../../common/orthogonal-projection';
import { orthogonalMapTileArtworkEnvelope, orthogonalTileArtworkIntersects, orthogonalTileArtworkPlacement, type OrthogonalTileArtworkPlacement } from '../../common/orthogonal-tile-artwork';
import { TILE_VARIANT_SEED_PROPERTY, chooseTileVariant, nextTileVariantSeed, tileVariantCandidates, tileVariantGroup } from '../../common/tile-variants';
import { isometricTileRenderCells } from '../../common/tile-render-order';
import { coveringRasterViewportRegion, createGridRasterRegionFilter, tilemapChunksIntersectingRegion, tilemapGridLineRange } from '../../common/tilemap-region';
import { onionSkinLayers } from '../../common/onion-skin';
import { effectiveSpriteSymmetry, expandSpriteSymmetry, withSpriteSymmetryAxes, withSpriteSymmetryMode } from '../../common/sprite-symmetry';
import { resolveRenderedTilesetTileSource, tileAnimationFrameAt, tilesetTileSourceRect } from '../../common/tile-animation';
import { parseBitmapFontJson } from '../../common/bitmap-font-interchange';
import { composedVisibleTilemapLayers, tilemapLayerScreenTranslation, type ComposedTilemapLayer } from '../../common/tilemap-layer-composition';
import { cancelPixelGesture, releasePendingPixelLocks } from '../../common/pixel-gesture';
import { BoundedResourceCache } from '../../common/bounded-resource-cache';
import { drawPixelSpriteRegion, pixelSpriteRegionPlan } from '../../common/pixel-sprite-render';
import { constrainTileTransformFlags, tileTransformFlagsAllowed } from '../../common/tile-transform-options';
import { EDITOR_DENSITY } from '../../common/editor-layout';
import { planTileObjectCreation, requireTileObjectPlacementTileset, requireWritableTileObject } from '../../common/tile-object-authoring';
import {
  attachedMapTileAuthoringTilesets,
  imageCollectionAuthoringTileIds,
  mapTileAuthoringPlansMatch,
  planMapTileAuthoringSelection,
  resolveCurrentMapTileDraftValue,
  selectScopedMapTileId,
  selectCurrentMapTileset,
  type CurrentMapTileDraft,
  type CurrentMapTileScope,
  type MapTileAuthoringPlan,
} from '../../common/map-tile-authoring';
import {
  planWangTerrainSelection,
  wangTerrainSelectionPlansMatch,
  type WangTerrainSelectionPlan,
} from '../../common/wang-terrain-authoring';
import { editableSpriteLayer, spriteRegionBitmap, visibleSpriteLayers, type SpriteRegionBitmap } from './pixel-bitmap';

interface PixelPoint { x: number; y: number }
interface PixelView { scale: number; offsetX: number; offsetY: number; logicalWidth: number; logicalHeight: number }
interface TagDraft { id?: string; name: string; fromFrameId: string; toFrameId: string; direction: 'forward' | 'reverse' | 'ping-pong'; color: string }
interface ScopedTagDraft { documentId: string; spriteId: string; draft: TagDraft }
interface MapObjectGesture { layerId: string; objectId: string; mode: 'move' | 'resize' | 'point'; pointIndex?: number; start: PixelPoint; current: PixelPoint; original: MapObject; lockPromise: Promise<{ acquired: boolean; lockId?: string }> }
type SelectionCombination = 'replace' | 'add' | 'subtract' | 'intersect';
type PixelSelectionCommand = 'copy' | 'cut' | 'paste' | 'delete' | 'clear' | 'select-all';
type LocalSelectionClipboard = { kind: 'tile'; sourceDocumentId: string; grid: GridSelectionClipboard<number> };

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

function previewMapObject(gesture: MapObjectGesture): MapObject {
  const delta = { x: gesture.current.x - gesture.start.x, y: gesture.current.y - gesture.start.y };
  if (gesture.mode !== 'point') return transformMapObject(gesture.original, gesture.mode, delta);
  if (gesture.original.type === 'tile') throw new Error('Tile objects do not expose polygon-point editing.');
  return moveMapObjectPoint(gesture.original, gesture.pointIndex ?? -1, delta);
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

function BitmapTextDialog({ fonts, selectedFontId, origin, spriteSize, paletteIndex, wrap, onSelectedFontChange, onManageFonts, onSubmit, onFontsReplace, onClose }: { fonts: BitmapFont[]; selectedFontId?: string; origin: PixelPoint; spriteSize: { width: number; height: number }; paletteIndex: number; wrap: boolean; onSelectedFontChange: (fontId: string) => void; onManageFonts: () => void; onSubmit: (request: BitmapTextRequest) => Promise<void>; onFontsReplace: (fonts: BitmapFont[]) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState('PIXEL'); const [letterSpacing, setLetterSpacing] = useState(0); const [lineSpacing, setLineSpacing] = useState(0); const [scale, setScale] = useState(1); const [align, setAlign] = useState<BitmapTextRequest['align']>('left'); const [busy, setBusy] = useState(false); const [importError, setImportError] = useState<string>(); const resolvedFontId = resolveBitmapFontId(fonts, selectedFontId); const font = fonts.find((entry) => entry.id === resolvedFontId);
  useEffect(() => { if (resolvedFontId && resolvedFontId !== selectedFontId) onSelectedFontChange(resolvedFontId); }, [onSelectedFontChange, resolvedFontId, selectedFontId]);
  const options = { x: origin.x, y: origin.y, letterSpacing, lineSpacing, scale, align }; const authoredPoints = font ? bitmapTextCells(font, text, options) : []; const points = wrap ? wrapPixelPoints(authoredPoints, spriteSize.width, spriteSize.height) : authoredPoints; const footprint = font ? measureBitmapText(font, text, options) : { width: 0, height: 0 }; const hasInk = authoredPoints.length > 0; const visible = points.some((point) => point.x >= 0 && point.y >= 0 && point.x < spriteSize.width && point.y < spriteSize.height); const local = points.length ? { minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)), maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)) } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const importFont = async (file: File) => {
    setImportError(undefined);
    try {
      if (file.size > 1024 * 1024) throw new Error('Bitmap font JSON is limited to 1 MiB.');
      const next = parseBitmapFontJson(await file.text(), fonts.map((entry) => entry.id));
      if (!(await onFontsReplace([...fonts, next]))) throw new Error('The bitmap font could not be added to this document.');
      onSelectedFontChange(next.id);
    } catch (error) { setImportError(error instanceof Error ? error.message : String(error)); }
  };
  return <EditorDialog title="Add bitmap text" description="Document-owned glyphs render identically in the editor, headless MCP, replay, and export." className="bitmap-text-dialog" onClose={onClose}>
    <div className="bitmap-text-body">
      <label className="dialog-field"><span>Text</span><textarea autoFocus rows={3} maxLength={2_000} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <div className="bitmap-font-row"><label className="dialog-field"><span>Bitmap font asset</span><select value={font?.id ?? ''} onChange={(event) => onSelectedFontChange(event.target.value)}>{fonts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button type="button" onClick={onManageFonts}>Manage fonts</button><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ version: 1, font }, null, 2))}>Copy font JSON</button><label className="bitmap-font-import">Import JSON<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importFont(file); }} /></label></div>
      {importError && <p className="entry-dialog-error" role="alert">{importError}</p>}
      <div className="bitmap-text-options"><label><span>Scale</span><input type="number" min="1" max="16" value={scale} onChange={(event) => setScale(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label><label><span>Letter gap</span><input type="number" min="0" max="32" value={letterSpacing} onChange={(event) => setLetterSpacing(Math.max(0, Math.min(32, Number(event.target.value) || 0)))} /></label><label><span>Line gap</span><input type="number" min="0" max="64" value={lineSpacing} onChange={(event) => setLineSpacing(Math.max(0, Math.min(64, Number(event.target.value) || 0)))} /></label><label><span>Anchor</span><select value={align} onChange={(event) => setAlign(event.target.value as BitmapTextRequest['align'])}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label></div>
      <div className="bitmap-glyph-preview"><svg viewBox={`${local.minX} ${local.minY} ${Math.max(1, local.maxX - local.minX + 1)} ${Math.max(1, local.maxY - local.minY + 1)}`} preserveAspectRatio="xMidYMid meet" aria-label="Bitmap text glyph preview">{points.slice(0, 20_000).map((point) => <rect key={`${point.x},${point.y}`} x={point.x} y={point.y} width="1" height="1" />)}</svg><span><strong>{footprint.width} × {footprint.height}px</strong><small>palette index {paletteIndex} · anchor {origin.x}, {origin.y}</small></span></div>
      {!hasInk ? <div className="entry-dialog-error">The selected font has no mapped ink for this text. Use Glyph or Glyph sheet to add characters.</div> : !visible && <div className="entry-dialog-error">The text falls completely outside the sprite.</div>}
    </div>
    <footer className="modal-footer"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary-modal-button" disabled={busy || !font || !text.trim() || !visible} onClick={async () => { if (!font) return; setBusy(true); try { await onSubmit({ text, fontId: font.id, letterSpacing, lineSpacing, scale, align }); } finally { setBusy(false); } }}>{busy ? 'Painting…' : 'Paint editable pixels'}</button></footer>
  </EditorDialog>;
}

export function PixelCanvas({ document }: { document: PixelDocument }) {
  const asset = document.pixelAssets[document.activeAssetId];
  const tileset = asset?.type === 'tileset' ? asset : undefined;
  const tilesetPreviewSourceId = tileset?.spriteAssetId;
  const sourceAsset = tilesetPreviewSourceId ? document.pixelAssets[tilesetPreviewSourceId] : undefined;
  const sprite = asset?.type === 'sprite' ? asset : sourceAsset?.type === 'sprite' ? sourceAsset : undefined;
  const tilemap = asset?.type === 'tilemap' ? asset : undefined;
  const tilemapModeError = tilemap ? imageCollectionTilemapModeError(document, tilemap) : undefined;
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
  const lassoDraftRef = useRef<GridLassoDraft | undefined>(undefined);
  const selectionCombination = useRef<SelectionCombination>('replace');
  const [selectionScaleOpen, setSelectionScaleOpen] = useState(false);
  const [glyphMapperOpen, setGlyphMapperOpen] = useState(false);
  const [glyphSheetMapperOpen, setGlyphSheetMapperOpen] = useState(false);
  const [fontLibraryOpen, setFontLibraryOpen] = useState(false);
  const [bitmapFontId, setBitmapFontId] = useState(document.bitmapFonts[0]?.id ?? '');
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
  const [onionSettingsOpen, setOnionSettingsOpen] = useState(false);
  const [symmetrySettingsOpen, setSymmetrySettingsOpen] = useState(false);
  const [wrapEditing, setWrapEditing] = useState(false);
  const [paletteCycling, setPaletteCycling] = useState(false);
  const [paletteOffset, setPaletteOffset] = useState(0);
  const [activePaletteCycleId, setActivePaletteCycleId] = useState<string>();
  const [terrainSetId, setTerrainSetId] = useState<string>();
  const [terrainColorId, setTerrainColorId] = useState<number>();
  const [terrainErase, setTerrainErase] = useState(false);
  const [terrainTilesetChoice, setTerrainTilesetChoice] = useState<CurrentMapTileScope>();
  const [tileTransforms, setTileTransforms] = useState({ hFlip: false, vFlip: false, diagonal: false });
  const [tileTransformPickerOpen, setTileTransformPickerOpen] = useState(false);
  const [currentMapTileChoice, setCurrentMapTileChoice] = useState<CurrentMapTileScope>();
  const [currentMapTileDraft, setCurrentMapTileDraft] = useState<CurrentMapTileDraft>();
  const mapTileGesturePlanRef = useRef<MapTileAuthoringPlan | undefined>(undefined);
  const wangTerrainGesturePlanRef = useRef<WangTerrainSelectionPlan | undefined>(undefined);
  const [tileObjectTilesetChoice, setTileObjectTilesetChoice] = useState<CurrentMapTileScope>();
  const [tileObjectTileDraft, setTileObjectTileDraft] = useState<CurrentMapTileDraft>();
  const [bitmapTextPoint, setBitmapTextPoint] = useState<PixelPoint>();
  const [durationFrameId, setDurationFrameId] = useState<string>();
  const [exposureGridOpen, setExposureGridOpen] = useState(false);
  const [tagDraftState, setTagDraftState] = useState<ScopedTagDraft>();
  const [selectedTagSelection, setSelectedTagSelection] = useState<ScopedAnimationTagSelection>();
  const setCanvasViewport = useEditorStore((state) => state.setCanvasViewport);
  const setCanvasAnimation = useEditorStore((state) => state.setCanvasAnimation);
  const onionSettings = useEditorStore((state) => state.onionSkinPreferences);
  const setOnionSkinPreferences = useEditorStore((state) => state.setOnionSkinPreferences);
  const symmetryPreferences = useEditorStore((state) => state.symmetryPreferences);
  const setSpriteSymmetryPreferences = useEditorStore((state) => state.setSpriteSymmetryPreferences);
  const onionSkin = onionSettings.enabled;
  const symmetry = useMemo(() => sprite
    ? effectiveSpriteSymmetry(symmetryPreferences, { documentId: document.id, spriteId: sprite.id, width: sprite.width, height: sprite.height })
    : { mode: 'none' as const, horizontalAxis: 0, verticalAxis: 0, source: 'centered-default' as const },
  [document.id, sprite, symmetryPreferences]);
  const tool = useEditorStore((state) => state.selectedTool);
  const setTool = useEditorStore((state) => state.setTool);
  const zoom = useEditorStore((state) => state.zoom);
  const setZoom = useEditorStore((state) => state.setZoom);
  const brushSize = useEditorStore((state) => state.brushSize);
  const pixelIndex = useEditorStore((state) => state.pixelIndex);
  const setPixelIndex = useEditorStore((state) => state.setPixelIndex);
  const ditherConfiguration = useEditorStore((state) => state.orderedDitherPreferences.current);
  const { matrixSize: ditherMatrixSize, coverage: ditherCoverage, phaseX: ditherPhaseX, phaseY: ditherPhaseY } = ditherConfiguration;
  const ditherMixIndex = Math.min(document.palette.length - 1, useEditorStore((state) => state.ditherMixIndex));
  const applyToActiveDocument = useEditorStore((state) => state.apply);
  const apply = useCallback((label: string, operations: CanvasOperation[]) => mountedRef.current ? applyToActiveDocument(label, operations, document.id) : Promise.resolve(false), [applyToActiveDocument, document.id]);
  const applyGuarded = useCallback((label: string, operations: CanvasOperation[], expectedDocumentRevision: number) => mountedRef.current ? applyToActiveDocument(label, operations, document.id, expectedDocumentRevision) : Promise.resolve(false), [applyToActiveDocument, document.id]);
  const currentBitmapFonts = useCallback((): BitmapFont[] => {
    const activeDocument = useEditorStore.getState().snapshot?.activeDocument;
    if (!activeDocument || activeDocument.id !== document.id || activeDocument.kind !== 'pixel') throw new Error('The active pixel document changed. Reopen Bitmap font assets and try again.');
    return activeDocument.bitmapFonts;
  }, [document.id]);
  const notify = useEditorStore((state) => state.notify);
  const selectedEntityId = useEditorStore((state) => state.selectedEntityId);
  const setSelectedEntity = useEditorStore((state) => state.setSelectedEntity);
  const setRightPanel = useEditorStore((state) => state.setRightPanel);
  const visibleMapLayers = useMemo(() => tilemap ? composedVisibleTilemapLayers(tilemap) : [], [tilemap]);
  const activeTileLayerEntry = useMemo(() => {
    const selectedLayer = visibleMapLayers.find((entry) => entry.layer.id === selectedEntityId && entry.layer.type === 'tile' && !entry.layer.locked);
    return selectedLayer ?? visibleMapLayers.find((entry) => entry.layer.type === 'tile' && !entry.layer.locked);
  }, [selectedEntityId, visibleMapLayers]);
  const activeObjectLayerEntry = useMemo(() => visibleMapLayers.find((entry) => entry.layer.id === selectedEntityId && entry.layer.type === 'object' && !entry.layer.locked), [selectedEntityId, visibleMapLayers]);
  const playbackMap = useEditorStore((state) => state.playbacks);
  const playbacks = Object.values(playbackMap).filter((entry) => entry.documentId === document.id);
  const activeFrameId = sprite?.frameIds.includes(frameId ?? '') ? frameId : sprite?.frameIds[0];
  const animationTagSpans = useMemo(() => sprite ? pixelAnimationTagSpans(sprite) : [], [sprite]);
  const selectedTagId = resolveScopedAnimationTagId(selectedTagSelection, document.id, sprite?.id, animationTagSpans.map((span) => span.tag.id));
  const tagDraftTargetExists = !tagDraftState?.draft.id || Boolean(sprite?.tags.some((tag) => tag.id === tagDraftState.draft.id));
  const tagDraft = animationTagScopeMatches(tagDraftState, document.id, sprite?.id) && tagDraftTargetExists ? tagDraftState?.draft : undefined;
  const activeFrameIndex = sprite?.frameIds.indexOf(activeFrameId ?? '') ?? -1;
  const animationTagMemberships = useMemo(() => animationTagMembershipsForFrames(animationTagSpans, sprite?.frameIds.length ?? 0), [animationTagSpans, sprite?.frameIds.length]);
  const selectedBitmapFontId = resolveBitmapFontId(document.bitmapFonts, bitmapFontId);
  const selectedGlyphCapture = useMemo<{ capture?: BitmapGlyphCapture; error?: string }>(() => {
    if (!glyphMapperOpen || !sprite || !activeFrameId || !selection.length) return {};
    try { return { capture: captureBitmapGlyph(selection, compositePixelReader(sprite, activeFrameId)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : 'The selected glyph could not be captured.' }; }
  }, [activeFrameId, glyphMapperOpen, selection, sprite]);
  const activePaletteOverride = sprite && activeFrameId ? sprite.paletteOverrides[activeFrameId] : undefined;
  const activeStamp = document.stamps.find((stamp) => stamp.id === activeStampId) ?? document.stamps[0];
  const placementStamp: PixelStamp = activeStamp ?? { id: 'builtin-plus', name: 'Built-in plus', width: 3, height: 3, anchorX: 1, anchorY: 1, cells: [{ x: 1, y: 1, index: pixelIndex }, { x: 0, y: 1, index: pixelIndex }, { x: 2, y: 1, index: pixelIndex }, { x: 1, y: 0, index: pixelIndex }, { x: 1, y: 2, index: pixelIndex }] };
  const activePaletteCycle = document.paletteCycles.find((cycle) => cycle.id === activePaletteCycleId) ?? document.paletteCycles[0];
  const attachedMapTilesets = useMemo(() => tilemap ? attachedMapTileAuthoringTilesets(document, tilemap) : [], [document, tilemap]);
  const atlasMapTilesets = attachedMapTilesets.filter((entry) => Boolean(entry.spriteAssetId));
  const finiteOrthogonalCollectionTilesets = attachedMapTilesets.filter((entry) => isImageCollectionTileset(entry) && tilemap?.orientation === 'orthogonal' && !tilemap.infinite);
  const authorableMapTileTilesets = [...atlasMapTilesets, ...finiteOrthogonalCollectionTilesets];
  const authorableTileObjectTilesets = attachedMapTilesets.filter((entry) => Boolean(entry.spriteAssetId) || finiteOrthogonalCollectionTilesets.some((collection) => collection.id === entry.id));
  const wangTerrainTilesets = [
    ...atlasMapTilesets,
    ...finiteOrthogonalCollectionTilesets.filter((entry) => entry.wangSets.length > 0),
  ];
  const currentMapTileTilesetId = tilemap && currentMapTileChoice?.documentId === document.id && currentMapTileChoice.mapId === tilemap.id
    ? currentMapTileChoice.tilesetId
    : atlasMapTilesets[0]?.id ?? finiteOrthogonalCollectionTilesets[0]?.id;
  const currentMapTileTileset = authorableMapTileTilesets.find((entry) => entry.id === currentMapTileTilesetId);
  const tileObjectTilesetId = tilemap && tileObjectTilesetChoice?.documentId === document.id && tileObjectTilesetChoice.mapId === tilemap.id ? tileObjectTilesetChoice.tilesetId : authorableTileObjectTilesets[0]?.id;
  const tileObjectTileset = authorableTileObjectTilesets.find((entry) => entry.id === tileObjectTilesetId);
  const terrainTilesetId = tilemap && terrainTilesetChoice?.documentId === document.id && terrainTilesetChoice.mapId === tilemap.id ? terrainTilesetChoice.tilesetId : wangTerrainTilesets[0]?.id;
  const selectedTerrainTileset = wangTerrainTilesets.find((entry) => entry.id === terrainTilesetId);
  const selectedTileId = Math.max(1, pixelIndex) - 1;
  const currentMapTileCollectionIds = currentMapTileTileset ? imageCollectionAuthoringTileIds(currentMapTileTileset) : [];
  const currentMapTileDefaultTileId = currentMapTileCollectionIds.length && !currentMapTileCollectionIds.includes(selectedTileId)
    ? currentMapTileCollectionIds[0]
    : selectedTileId;
  const currentMapTileDraftValue = tilemap && currentMapTileTilesetId
    ? resolveCurrentMapTileDraftValue(currentMapTileDraft, {
        documentId: document.id,
        mapId: tilemap.id,
        tilesetId: currentMapTileTilesetId,
      }, currentMapTileDefaultTileId)
    : String(currentMapTileDefaultTileId);
  const currentMapTileId = currentMapTileDraftValue.trim() ? Number(currentMapTileDraftValue) : Number.NaN;
  const tileObjectCollectionIds = tileObjectTileset ? imageCollectionAuthoringTileIds(tileObjectTileset) : [];
  const tileObjectDefaultTileId = tileObjectCollectionIds.length && !tileObjectCollectionIds.includes(selectedTileId) ? tileObjectCollectionIds[0] : selectedTileId;
  const tileObjectTileDraftValue = tilemap && tileObjectTileDraft?.documentId === document.id && tileObjectTileDraft.mapId === tilemap.id && tileObjectTileDraft.tilesetId === tileObjectTilesetId
    ? tileObjectTileDraft.value
    : String(tileObjectDefaultTileId);
  const tileObjectPlacementTileId = tileObjectTileDraftValue.trim() ? Number(tileObjectTileDraftValue) : Number.NaN;
  const terrainTileset = tool === 'tile-object'
    ? tileObjectTileset
    : tool === 'terrain'
      ? selectedTerrainTileset
      : currentMapTileTileset;
  const authoringTileId = tool === 'tile-object'
    ? tileObjectPlacementTileId
    : tool === 'terrain'
      ? selectedTileId
      : currentMapTileId;
  const validAuthoringTileId = Number.isSafeInteger(authoringTileId) && authoringTileId >= 0 ? authoringTileId : undefined;
  const terrainSet = terrainTileset?.type === 'tileset' ? terrainTileset.wangSets.find((set) => set.id === terrainSetId) ?? terrainTileset.wangSets[0] : undefined;
  const terrainColor = terrainSet?.colors.find((color) => color.id === terrainColorId) ?? terrainSet?.colors[0];
  const terrainSourceId = terrainTileset?.type === 'tileset' && validAuthoringTileId !== undefined
    ? tilesetTileSourceAssetId(terrainTileset, validAuthoringTileId)
    : undefined;
  const terrainSource = terrainSourceId ? document.pixelAssets[terrainSourceId] : undefined;
  const terrainSourceSprite = terrainSource?.type === 'sprite' ? terrainSource : undefined;
  const constrainedTileTransforms = constrainTileTransformFlags(tileTransforms, terrainTileset?.type === 'tileset' ? terrainTileset.transformations : undefined);
  const activeTileTransforms = tool === 'tile-object' ? { ...tileTransforms } : constrainedTileTransforms;
  const tileTransformCandidates = {
    hFlip: { ...activeTileTransforms, hFlip: !activeTileTransforms.hFlip },
    vFlip: { ...activeTileTransforms, vFlip: !activeTileTransforms.vFlip },
    diagonal: { ...activeTileTransforms, diagonal: !activeTileTransforms.diagonal },
  };
  const activeTileStamp = activeTileStampId === 'builtin-tile'
    ? undefined
    : document.tileStamps.find((stamp) => stamp.id === activeTileStampId) ?? document.tileStamps[0];
  const idleCurrentTileGid = terrainTileset?.type === 'tileset' && validAuthoringTileId !== undefined && tilesetHasLocalId(terrainTileset, validAuthoringTileId)
    ? encodeTiledGid(terrainTileset.firstGid + validAuthoringTileId, activeTileTransforms)
    : 0;
  const placementTileStamp: TileStamp = activeTileStamp ?? { id: 'builtin-tile', name: 'Current tile', width: 1, height: 1, anchorX: 0, anchorY: 0, cells: [{ x: 0, y: 0, gid: idleCurrentTileGid }] };
  const selectedVariantGroup = terrainTileset?.type === 'tileset' && validAuthoringTileId !== undefined && !isImageCollectionTileset(terrainTileset) ? tileVariantGroup(terrainTileset.tiles[validAuthoringTileId]) : undefined;
  const selectedVariantCandidates = terrainTileset?.type === 'tileset' && validAuthoringTileId !== undefined && !isImageCollectionTileset(terrainTileset) ? tileVariantCandidates(terrainTileset, validAuthoringTileId) : [];
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
      mapTileGesturePlanRef.current = undefined;
      wangTerrainGesturePlanRef.current = undefined;
      const pendingLocks = [lockPromiseRef.current, mapObjectGestureRef.current?.lockPromise].filter((value): value is Promise<{ acquired: boolean; lockId?: string }> => Boolean(value));
      void releasePendingPixelLocks(pendingLocks, (lockId) => window.aidraw.releaseHumanLock(lockId));
    };
  }, []);

  useEffect(() => {
    if (selectedBitmapFontId && selectedBitmapFontId !== bitmapFontId) setBitmapFontId(selectedBitmapFontId);
  }, [bitmapFontId, selectedBitmapFontId]);

  useEffect(() => {
    if (tilemap) { setClipboardAvailable(Boolean(localSelectionClipboard)); return; }
    let current = true;
    const refreshClipboardAvailability = () => {
      void window.aidraw.readPixelSelectionClipboard().then(
        (result) => { if (current) setClipboardAvailable(result.status === 'valid' || result.status === 'png'); },
        () => { if (current) setClipboardAvailable(false); },
      );
    };
    refreshClipboardAvailability();
    window.addEventListener('focus', refreshClipboardAvailability);
    return () => { current = false; window.removeEventListener('focus', refreshClipboardAvailability); };
  }, [document.id, sprite?.id, tilemap]);

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
      const direction = animationAdvisoryDirection(tag?.direction, pingPong); let nextDirection = direction === 'reverse' ? -1 : playDirection; let nextIndex = currentIndex < 0 ? (direction === 'reverse' ? playbackFrames.length - 1 : 0) : currentIndex + nextDirection;
      if (direction === 'ping-pong' && (nextIndex < 0 || nextIndex >= playbackFrames.length)) { nextDirection = nextDirection === 1 ? -1 : 1; setPlayDirection(nextDirection); nextIndex = currentIndex + nextDirection; }
      if (direction === 'forward') nextIndex = (Math.max(0, currentIndex) + 1) % playbackFrames.length;
      if (direction === 'reverse') nextIndex = (currentIndex <= 0 ? playbackFrames.length : currentIndex) - 1;
      setFrameId(playbackFrames[Math.max(0, Math.min(playbackFrames.length - 1, nextIndex))]);
    }, current?.durationMs ?? 100);
    return () => window.clearTimeout(timeout);
  }, [activeFrameId, pingPong, playDirection, playing, selectedTagId, sprite]);

  useEffect(() => {
    if (animationTagScopeMatches(selectedTagSelection, document.id, sprite?.id) && !selectedTagId) setSelectedTagSelection(undefined);
  }, [document.id, selectedTagId, selectedTagSelection, sprite?.id]);

  useEffect(() => {
    if (tagDraftState && (!animationTagScopeMatches(tagDraftState, document.id, sprite?.id) || !tagDraftTargetExists)) setTagDraftState(undefined);
  }, [document.id, sprite?.id, tagDraftState, tagDraftTargetExists]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height - (hasTimeline ? EDITOR_DENSITY.timelineHeight : 0)) }));
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

  const mapLayerTranslations = useMemo(() => new Map(visibleMapLayers.map((entry) => [
    entry.layer.id,
    tilemapLayerScreenTranslation(entry, pan, tilemap ? view.scale / tilemap.tileWidth : 1),
  ])), [pan, tilemap, view.scale, visibleMapLayers]);

  useEffect(() => {
    setCanvasViewport({ x: -view.offsetX / view.scale, y: -view.offsetY / view.scale, width: size.width / view.scale, height: size.height / view.scale });
  }, [setCanvasViewport, size.height, size.width, view.offsetX, view.offsetY, view.scale]);

  useEffect(() => {
    const activeTag = sprite?.tags.find((tag) => tag.id === selectedTagId);
    setCanvasAnimation(sprite ? { activeAssetId: sprite.id, activeFrameId, activeTagId: activeTag?.id, playing, onionSkin, direction: animationAdvisoryDirection(activeTag?.direction, pingPong) } : undefined);
  }, [activeFrameId, onionSkin, pingPong, playing, selectedTagId, setCanvasAnimation, sprite]);

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
    drawBoundedGridChecker(
      context,
      logical.width * view.scale,
      logical.height * view.scale,
      Math.max(4, view.scale),
      { x: -view.offsetX, y: -view.offsetY, width: size.width, height: size.height },
    );
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
    const rasterViewportRegionForLayer = (entry: ComposedTilemapLayer) => {
      const translation = mapLayerTranslations.get(entry.layer.id) ?? { x: 0, y: 0 };
      return translation.x === 0 && translation.y === 0 ? baseRasterViewportRegion! : coveringRasterViewportRegion({
        viewportWidth: size.width,
        viewportHeight: size.height,
        viewOffsetX: view.offsetX,
        viewOffsetY: view.offsetY,
        layerOffsetX: translation.x,
        layerOffsetY: translation.y,
        projectionScale: view.scale / tilemap!.tileWidth,
      });
    };
    const activeRasterViewportRegion = tilemap && activeTileLayerEntry ? rasterViewportRegionForLayer(activeTileLayerEntry) : baseRasterViewportRegion;
    const overlayGeometry = sprite
      ? { orientation: 'orthogonal' as const, rows: sprite.height, tileWidth: 1, tileHeight: 1 }
      : tilemap
        ? { orientation: tilemap.orientation, rows: tilemap.height, tileWidth: tilemap.tileWidth, tileHeight: tilemap.tileHeight }
        : undefined;
    const overlayRegionFilter = overlayGeometry && activeRasterViewportRegion
      ? createGridRasterRegionFilter(overlayGeometry, activeRasterViewportRegion)
      : undefined;
    const selectionStrokeWidth = Math.max(1, view.scale / 8);
    const overlayProjectionScale = sprite ? view.scale : tilemap ? view.scale / tilemap.tileWidth : 1;
    const selectionRegionFilter = overlayGeometry && activeRasterViewportRegion
      ? createGridRasterRegionFilter(overlayGeometry, activeRasterViewportRegion, Math.ceil((selectionStrokeWidth / 2 + 1) / overlayProjectionScale))
      : undefined;
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
      if (wrapEditing) {
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
      if (symmetry.mode !== 'none') {
        context.save();
        context.globalAlpha = 1;
        context.strokeStyle = '#ff5c93';
        context.lineWidth = 1.5;
        context.setLineDash([5, 3]);
        context.beginPath();
        if (symmetry.mode === 'horizontal' || symmetry.mode === 'both') {
          const x = (symmetry.horizontalAxis + 0.5) * view.scale;
          context.moveTo(x, 0); context.lineTo(x, sprite.height * view.scale);
        }
        if (symmetry.mode === 'vertical' || symmetry.mode === 'both') {
          const y = (symmetry.verticalAxis + 0.5) * view.scale;
          context.moveTo(0, y); context.lineTo(sprite.width * view.scale, y);
        }
        context.stroke();
        context.restore();
      }
    } else if (tilemap && !tilemapModeError) {
      const mapSources = new BoundedResourceCache<SpriteRegionBitmap>(MAX_MAP_TILE_SOURCE_CACHE_ENTRIES, MAX_MAP_TILE_SOURCE_CACHE_BYTES, (source) => { source.canvas.width = 1; source.canvas.height = 1; });
      const orthogonalArtworkEnvelope = tilemap.orientation === 'orthogonal' ? orthogonalMapTileArtworkEnvelope(document, tilemap) : undefined;
      const isometricArtworkEnvelope = tilemap.orientation === 'isometric' ? isometricMapTileArtworkEnvelope(document, tilemap) : undefined;
      const animatedLocalIds = new Map<string, number>();
      const animatedLocalId = (resolved: NonNullable<ReturnType<typeof resolveTilesetForGid>>) => {
        const key = `${resolved.tileset.id}\0${resolved.localId}`; const cached = animatedLocalIds.get(key); if (cached !== undefined) return cached;
        const sampled = tileAnimationFrameAt(resolved.tileset.tiles[resolved.localId]?.animation ?? [], tileAnimationTimeMs)?.tileId ?? resolved.localId; animatedLocalIds.set(key, sampled); return sampled;
      };
      try { for (const entry of visibleMapLayers) {
        const { layer } = entry;
        const { x: layerOffsetX, y: layerOffsetY } = mapLayerTranslations.get(layer.id) ?? { x: 0, y: 0 };
        context.save(); context.translate(layerOffsetX, layerOffsetY);
        if (layer.type === 'object') {
          context.globalAlpha = entry.opacity;
          const matrix = tilemap.orientation === 'isometric'
            ? isometricObjectMatrix(tilemap.height, tilemap.tileWidth, tilemap.tileHeight, view.scale, isometricCellHeight)
            : orthogonalObjectMatrix(tilemap.tileWidth, tilemap.tileHeight, view.scale, orthogonalCellHeight);
          const viewport = { x: -view.offsetX - layerOffsetX, y: -view.offsetY - layerOffsetY, width: size.width, height: size.height };
          const unitScale = tilemap.orientation === 'orthogonal' ? view.scale / tilemap.tileWidth : view.scale / Math.max(tilemap.tileWidth, tilemap.tileHeight);
          for (const source of layer.objects ?? []) {
            const object = mapObjectGesture?.layerId === layer.id && mapObjectGesture.objectId === source.id ? previewMapObject(mapObjectGesture) : source; const selected = selectedEntityId === object.id;
            if (object.type !== 'tile') {
              if (!mapObjectIntersectsRasterRegion(object, matrix, viewport, { selected, unitScale })) continue;
              context.save(); context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f); drawMapObjectOverlay(context, object, { selected, unitScale }); context.restore();
              continue;
            }
            const decoded = decodeTiledGid(object.gid);
            const resolved = resolveTilesetForGid(document, tilemap, decoded.gid);
            let renderedSource: ReturnType<typeof resolveRenderedTilesetTileSource> | undefined;
            try { renderedSource = resolved ? resolveRenderedTilesetTileSource(document, resolved.tileset, resolved.localId, tileAnimationTimeMs) : undefined; } catch { renderedSource = undefined; }
            const placement = tileObjectArtworkPlacement(object, tilemap.orientation, matrix, view.scale / tilemap.tileWidth, resolved?.tileset, renderedSource?.rect);
            if (!tileObjectArtworkIntersects(placement, viewport, selected ? 5 : 0)) continue;
            const sourcePlan = renderedSource ? pixelSpriteRegionPlan(renderedSource.sprite, renderedSource.rect) : undefined; const frameId = renderedSource?.sprite.frameIds[0];
            const mapSource = renderedSource && sourcePlan && frameId
              ? mapSources.acquire(`${renderedSource.sprite.id}\0${frameId}\0${renderedSource.rect.x},${renderedSource.rect.y},${renderedSource.rect.width},${renderedSource.rect.height}`, sourcePlan.render.width * sourcePlan.render.height * 4, () => spriteRegionBitmap(renderedSource.sprite, frameId, document.palette, renderedSource.rect))
              : undefined;
            try {
              context.save(); context.translate(placement.center.x, placement.center.y); context.transform(placement.transform.a, placement.transform.b, placement.transform.c, placement.transform.d, 0, 0);
              if (mapSource) { const sampled = mapSource.value; context.drawImage(sampled.canvas, sampled.sample.x, sampled.sample.y, sampled.sample.width, sampled.sample.height, -placement.width / 2, -placement.height / 2, placement.width, placement.height); }
              else { context.fillStyle = tileObjectFallbackColor(decoded.gid); context.fillRect(-placement.width / 2, -placement.height / 2, placement.width, placement.height); }
              context.restore();
            } finally { mapSource?.release(); }
            if (selected) {
              context.save(); context.strokeStyle = '#7454d8'; context.fillStyle = '#fff'; context.lineWidth = 2; context.setLineDash([]); context.beginPath(); context.moveTo(placement.corners[0].x, placement.corners[0].y); for (const corner of placement.corners.slice(1)) context.lineTo(corner.x, corner.y); context.closePath(); context.stroke(); context.fillRect(placement.resizeHandle.x - 4, placement.resizeHandle.y - 4, 8, 8); context.strokeRect(placement.resizeHandle.x - 4, placement.resizeHandle.y - 4, 8, 8); context.restore();
            }
          }
          context.restore(); continue;
        }
        if (layer.type !== 'tile' || !layer.chunks) { context.restore(); continue; }
        const hiddenCells = replayMasks.tileCells.get(replayTileLayerKey(tilemap.id, layer.id));
        const layerViewportRegion = rasterViewportRegionForLayer(entry);
        const candidateChunks = tilemapChunksIntersectingRegion(Object.values(layer.chunks), {
          orientation: tilemap.orientation,
          rows: tilemap.height,
          tileWidth: tilemap.tileWidth,
          tileHeight: tilemap.tileHeight,
          orthogonalArtworkEnvelope,
          isometricArtworkEnvelope,
        }, layerViewportRegion);
        context.globalAlpha = entry.opacity;
        const drawCell = (x: number, y: number, raw: number) => {
          const decoded = decodeTiledGid(raw); if (!decoded.gid || hiddenCells?.has(replayPointKey(x, y))) return;
          const resolved = resolveTilesetForGid(document, tilemap, decoded.gid);
          const visibleLocalId = resolved ? animatedLocalId(resolved) : undefined;
          const mapSourceAssetId = resolved && visibleLocalId !== undefined ? tilesetTileSourceAssetId(resolved.tileset, visibleLocalId) : undefined;
          const mapSourceAsset = mapSourceAssetId ? document.pixelAssets[mapSourceAssetId] : undefined;
          const sourceIsRenderable = mapSourceAsset?.type === 'sprite';
          const canonicalRect = tilemap.orientation === 'isometric'
            ? isometricCellRect(x, y, tilemap.height, tilemap.tileWidth, tilemap.tileHeight)
            : orthogonalCellRect(x, y, tilemap.tileWidth, tilemap.tileHeight);
          const canonicalPlacement = resolved && sourceIsRenderable
            ? tilemap.orientation === 'isometric'
              ? isometricTileArtworkPlacement(
                canonicalRect,
                tilemap.tileWidth,
                tilemap.tileHeight,
                { width: resolved.tileset.tileWidth, height: resolved.tileset.tileHeight },
                decoded,
                resolved.tileset.tileOffset,
              )
              : orthogonalTileArtworkPlacement(
                canonicalRect,
                tilemap.tileWidth,
                tilemap.tileHeight,
                { width: isImageCollectionTileset(resolved.tileset) ? mapSourceAsset.width : resolved.tileset.tileWidth, height: isImageCollectionTileset(resolved.tileset) ? mapSourceAsset.height : resolved.tileset.tileHeight },
                decoded,
                resolved.tileset.tileOffset,
              )
            : undefined;
          const canonicalIntersects = canonicalPlacement
            ? tilemap.orientation === 'isometric'
              ? isometricTileArtworkIntersects(canonicalPlacement.bounds, layerViewportRegion)
              : orthogonalTileArtworkIntersects(canonicalPlacement.bounds, layerViewportRegion)
            : canonicalRect.x + canonicalRect.width > layerViewportRegion.x
              && canonicalRect.y + canonicalRect.height > layerViewportRegion.y
              && canonicalRect.x < layerViewportRegion.x + layerViewportRegion.width
              && canonicalRect.y < layerViewportRegion.y + layerViewportRegion.height;
          if (!canonicalIntersects) return;
          const sourceRect = resolved && visibleLocalId !== undefined ? tilesetTileSourceRect(resolved.tileset, visibleLocalId, mapSourceAsset?.type === 'sprite' ? mapSourceAsset : undefined) : undefined;
          const sourcePlan = mapSourceAsset?.type === 'sprite' && sourceRect ? pixelSpriteRegionPlan(mapSourceAsset, sourceRect) : undefined; const frameId = mapSourceAsset?.type === 'sprite' ? mapSourceAsset.frameIds[0] : undefined;
          const mapSource = mapSourceAsset?.type === 'sprite' && sourceRect && sourcePlan && frameId
            ? mapSources.acquire(`${mapSourceAsset.id}\0${frameId}\0${sourceRect.x},${sourceRect.y},${sourceRect.width},${sourceRect.height}`, sourcePlan.render.width * sourcePlan.render.height * 4, () => spriteRegionBitmap(mapSourceAsset, frameId, document.palette, sourceRect))
            : undefined;
          const drawTile = (artworkPlacement?: OrthogonalTileArtworkPlacement | IsometricTileArtworkPlacement) => { if (!mapSource || !resolved || !sourceRect || !artworkPlacement) return false; const sampled = mapSource.value; context.save(); try { context.translate(artworkPlacement.centerX, artworkPlacement.centerY); context.transform(artworkPlacement.transform.a, artworkPlacement.transform.b, artworkPlacement.transform.c, artworkPlacement.transform.d, 0, 0); context.drawImage(sampled.canvas, sampled.sample.x, sampled.sample.y, sampled.sample.width, sampled.sample.height, -artworkPlacement.width / 2, -artworkPlacement.height / 2, artworkPlacement.width, artworkPlacement.height); } finally { context.restore(); } return true; };
          const visibleGid = resolved && visibleLocalId !== undefined ? resolved.tileset.firstGid + visibleLocalId : decoded.gid;
          try {
            if (tilemap.orientation === 'orthogonal') {
              const rect = gridCellRect({ x, y });
              const placement = resolved && sourceIsRenderable ? orthogonalTileArtworkPlacement(rect, tilemap.tileWidth, tilemap.tileHeight, { width: isImageCollectionTileset(resolved.tileset) ? mapSourceAsset.width : resolved.tileset.tileWidth, height: isImageCollectionTileset(resolved.tileset) ? mapSourceAsset.height : resolved.tileset.tileHeight }, decoded, resolved.tileset.tileOffset) : undefined;
              if (!drawTile(placement)) { context.fillStyle = `hsl(${visibleGid * 47 % 360} 52% 62%)`; context.fillRect(rect.x, rect.y, rect.width, rect.height); }
            } else {
              const rect = gridCellRect({ x, y });
              const placement = resolved && sourceIsRenderable ? isometricTileArtworkPlacement(rect, tilemap.tileWidth, tilemap.tileHeight, { width: resolved.tileset.tileWidth, height: resolved.tileset.tileHeight }, decoded, resolved.tileset.tileOffset) : undefined;
              if (!drawTile(placement)) { context.fillStyle = `hsl(${visibleGid * 47 % 360} 52% 62%)`; traceIsometricCell(context, rect); context.fill(); }
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

    const activeTileLayerTranslation = activeTileLayerEntry ? mapLayerTranslations.get(activeTileLayerEntry.layer.id) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    if (tilemap) { context.save(); context.translate(activeTileLayerTranslation.x, activeTileLayerTranslation.y); }
    if (preview.length || bulkPreview.length) {
      context.globalAlpha = 0.78;
      if (bulkPreview.length) {
        for (const run of bulkPreview) {
          const range = overlayRegionFilter?.runOffsets(run.x, run.y, run.length) ?? { start: 0, end: run.length };
          if (range.end <= range.start) continue;
          context.fillStyle = run.index === 0 ? '#ffffff80' : document.palette[run.index]?.color ?? '#ff00ff';
          context.fillRect((run.x + range.start) * view.scale, run.y * view.scale, (range.end - range.start) * view.scale, view.scale);
        }
      } else if (tool === 'stamp' && tileStampPreview.length) for (const point of tileStampPreview) {
        if (overlayRegionFilter && !overlayRegionFilter.cellIntersects(point.x, point.y)) continue;
        const gid = decodeTiledGid(point.gid).gid; context.fillStyle = gid === 0 ? '#ffffff80' : 'hsl(' + (gid * 47 % 360) + ' 52% 62%)';
        fillGridCell(point);
      } else if (tool === 'stamp' && stampPreview.length) for (const point of stampPreview) {
        if (overlayRegionFilter && !overlayRegionFilter.cellIntersects(point.x, point.y)) continue;
        context.fillStyle = point.index === 0 ? '#ffffff80' : document.palette[point.index]?.color ?? '#ff00ff';
        context.fillRect(point.x * view.scale, point.y * view.scale, view.scale, view.scale);
      } else if (tool === 'dither') {
        for (const point of preview) {
          if (!(sprite && wrapEditing) && (point.x < 0 || point.y < 0 || point.x >= logical.gridWidth || point.y >= logical.gridHeight)) continue;
          if (overlayRegionFilter && !overlayRegionFilter.cellIntersects(point.x, point.y)) continue;
          const sample = sprite && wrapEditing ? wrapPixelPoint(point, sprite.width, sprite.height) : point;
          const index = orderedDitherIndex(sample.x, sample.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize, ditherPhaseX, ditherPhaseY);
          context.fillStyle = index === 0 ? '#ffffff80' : (activePaletteOverride ?? document.palette)[index]?.color ?? '#ff00ff';
          context.fillRect(point.x * view.scale, point.y * view.scale, view.scale, view.scale);
        }
      } else {
        const drawIndex = tool === 'eraser' ? 0 : pixelIndex;
        context.fillStyle = drawIndex === 0 ? '#ffffff80' : document.palette[drawIndex]?.color ?? '#ff00ff';
        for (const point of preview) if (((sprite && wrapEditing) || (point.x >= 0 && point.y >= 0 && point.x < logical.gridWidth && point.y < logical.gridHeight)) && (!overlayRegionFilter || overlayRegionFilter.cellIntersects(point.x, point.y))) fillGridCell(point);
      }
    }

    if (tool === 'lasso' && lassoPath.length > 1) {
      context.globalAlpha = 1; context.strokeStyle = '#6e58c7'; context.lineWidth = Math.max(1, view.scale / 7); context.setLineDash([Math.max(2, view.scale / 2), Math.max(2, view.scale / 3)]); context.beginPath();
      const first = gridCellCenter(lassoPath[0]); context.moveTo(first.x, first.y); for (const point of lassoPath.slice(1)) { const center = gridCellCenter(point); context.lineTo(center.x, center.y); } context.closePath(); context.stroke(); context.setLineDash([]);
    }

    if (selection.length) {
      context.globalAlpha = 1; context.strokeStyle = '#ffffff'; context.lineWidth = selectionStrokeWidth; context.setLineDash([Math.max(2, view.scale / 3), Math.max(2, view.scale / 3)]);
      context.lineDashOffset = -(Date.now() / 120) % 8;
      const offset = selectionOffset ?? { x: 0, y: 0 };
      const selectedPoints: PixelPoint[] = [];
      for (const point of selection) {
        const selected = { x: point.x + offset.x, y: point.y + offset.y };
        if (!selectionRegionFilter || selectionRegionFilter.cellIntersects(selected.x, selected.y)) selectedPoints.push(selected);
      }
      for (const point of selectedPoints) strokeGridCell(point);
      context.strokeStyle = '#4f3f68'; context.lineDashOffset += Math.max(2, view.scale / 3); for (const point of selectedPoints) strokeGridCell(point); context.setLineDash([]);
    }
    if (tilemap) context.restore();

    for (const playback of playbacks) {
      context.globalAlpha = 1;
      for (const operation of playback.operations) {
        if (operation.kind === 'pixel.cel.set' && sprite && operation.spriteId === sprite.id) {
          const targetCel = sprite.cels[operation.celId];
          if (!targetCel || targetCel.frameId !== activeFrameId) continue;
          const changes = Array.isArray(operation.changes) ? operation.changes : [];
          for (const change of changes) {
            if (![change.x, change.y, change.index].every(Number.isFinite)) continue;
            if (overlayRegionFilter && !overlayRegionFilter.cellIntersects(change.x, change.y)) continue;
            context.fillStyle = change.index === 0 ? '#ffffff80' : document.palette[change.index]?.color ?? playback.actor.color;
            context.fillRect(change.x * view.scale, change.y * view.scale, view.scale, view.scale);
          }
        } else if (operation.kind === 'pixel.cel.region' && sprite && operation.spriteId === sprite.id) {
          const targetCel = sprite.cels[operation.celId];
          if (!targetCel || targetCel.frameId !== activeFrameId) continue;
          for (const run of operation.runs) {
            if (![run.x, run.y, run.length, run.index].every(Number.isFinite)) continue;
            const range = overlayRegionFilter?.runOffsets(run.x, run.y, run.length) ?? { start: 0, end: run.length };
            if (range.end <= range.start) continue;
            context.fillStyle = run.index === 0 ? '#ffffff80' : document.palette[run.index]?.color ?? playback.actor.color;
            context.fillRect((run.x + range.start) * view.scale, run.y * view.scale, (range.end - range.start) * view.scale, view.scale);
          }
        } else if (operation.kind === 'pixel.tilemap.set' && tilemap && operation.mapId === tilemap.id) {
          const replayEntry = visibleMapLayers.find((entry) => entry.layer.id === operation.layerId);
          if (!replayEntry) continue;
          const replayTranslation = mapLayerTranslations.get(operation.layerId) ?? { x: 0, y: 0 };
          const replayFilter = createGridRasterRegionFilter(overlayGeometry!, rasterViewportRegionForLayer(replayEntry));
          context.save(); context.translate(replayTranslation.x, replayTranslation.y);
          const changes = Array.isArray(operation.changes) ? operation.changes : [];
          for (const change of changes) {
            if (![change.x, change.y, change.gid].every(Number.isFinite)) continue;
            if (!replayFilter.cellIntersects(change.x, change.y)) continue;
            context.fillStyle = change.gid === 0 ? '#ffffff80' : `hsl(${(change.gid * 47) % 360} 52% 62%)`;
            fillGridCell(change);
          }
          context.restore();
        } else if (operation.kind === 'pixel.tilemap.region' && tilemap && operation.mapId === tilemap.id) {
          const replayEntry = visibleMapLayers.find((entry) => entry.layer.id === operation.layerId);
          if (!replayEntry) continue;
          const replayTranslation = mapLayerTranslations.get(operation.layerId) ?? { x: 0, y: 0 };
          const replayFilter = createGridRasterRegionFilter(overlayGeometry!, rasterViewportRegionForLayer(replayEntry));
          context.save(); context.translate(replayTranslation.x, replayTranslation.y);
          for (const run of operation.runs) {
            if (![run.x, run.y, run.length, run.gid].every(Number.isFinite)) continue;
            const range = replayFilter.runOffsets(run.x, run.y, run.length);
            if (range.end <= range.start) continue;
            context.fillStyle = run.gid === 0 ? '#ffffff80' : `hsl(${(run.gid * 47) % 360} 52% 62%)`;
            for (let offset = range.start; offset < range.end; offset += 1) fillGridCell({ x: run.x + offset, y: run.y });
          }
          context.restore();
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
  }, [activeFrameId, activePaletteCycle, activePaletteOverride, activeTileLayerEntry, bulkPreview, ditherCoverage, ditherMatrixSize, ditherMixIndex, ditherPhaseX, ditherPhaseY, document, lassoPath, logical, mapLayerTranslations, mapObjectGesture, onionSettings, onionSkin, paletteCycling, paletteOffset, pixelIndex, playbacks, preview, selectedEntityId, selection, selectionOffset, size, sprite, stampPreview, symmetry, tileAnimationTimeMs, tilemap, tilemapModeError, tileStampPreview, tileset, tool, view, visibleMapLayers, wrapEditing]);

  const toPixel = (event: ReactPointerEvent<HTMLCanvasElement>): PixelPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const translation = activeTileLayerEntry ? mapLayerTranslations.get(activeTileLayerEntry.layer.id) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    const layerView = { ...view, offsetX: view.offsetX + translation.x, offsetY: view.offsetY + translation.y };
    if (tilemap?.orientation === 'isometric') return clientPointToIsometricTile(event.clientX, event.clientY, bounds, size, layerView, tilemap.height, view.scale * tilemap.tileHeight / tilemap.tileWidth);
    if (tilemap?.orientation === 'orthogonal') return clientPointToOrthogonalTile(event.clientX, event.clientY, bounds, size, layerView, view.scale * tilemap.tileHeight / tilemap.tileWidth);
    return clientPointToPixel(event.clientX, event.clientY, bounds, size, view);
  };

  const toLayerMapObjectPoint = (event: ReactPointerEvent<HTMLCanvasElement>, entry: ComposedTilemapLayer): PixelPoint => {
    if (!tilemap) return { x: 0, y: 0 };
    const bounds = event.currentTarget.getBoundingClientRect();
    const translation = mapLayerTranslations.get(entry.layer.id) ?? { x: 0, y: 0 };
    return clientPointToTilemapObjectAnchor(event.clientX, event.clientY, bounds, size, view, {
      orientation: tilemap.orientation, mapHeight: tilemap.height, tileWidth: tilemap.tileWidth, tileHeight: tilemap.tileHeight, layerTranslation: translation,
    });
  };

  const toLayerRasterPoint = (event: ReactPointerEvent<HTMLCanvasElement>, entry: ComposedTilemapLayer): PixelPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const translation = mapLayerTranslations.get(entry.layer.id) ?? { x: 0, y: 0 };
    return {
      x: (event.clientX - bounds.left) * size.width / bounds.width - view.offsetX - translation.x,
      y: (event.clientY - bounds.top) * size.height / bounds.height - view.offsetY - translation.y,
    };
  };

  const withSymmetry = <T extends PixelPoint>(points: readonly T[]): T[] => expandSpriteSymmetry(points, symmetry);
  const saveSymmetryAxes = (horizontalAxis: number, verticalAxis: number): void => {
    if (!sprite) return;
    try {
      setSpriteSymmetryPreferences(withSpriteSymmetryAxes(symmetryPreferences, {
        documentId: document.id,
        spriteId: sprite.id,
        width: sprite.width,
        height: sprite.height,
        horizontalAxis,
        verticalAxis,
      }));
    } catch {
      notify('This sprite identity cannot be stored in the bounded local symmetry settings; centered axes remain active.', 'warning');
    }
  };

  const transformSelection = async (transform: PixelSelectionTransform, offset: PixelPoint = { x: 0, y: 0 }) => {
    if (!selection.length) return;
    if (tilemap) {
      const layer = activeTileLayerEntry?.layer;
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
      const layer = activeTileLayerEntry?.layer; const bounds = pixelSelectionBounds(selection);
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

  const copyLocalSelection = async (): Promise<boolean> => {
    if (!selection.length) { notify('Select pixels or tiles before copying.', 'warning'); return false; }
    if (tilemap) {
      const layer = activeTileLayerEntry?.layer;
      if (!layer || layer.type !== 'tile' || !layer.chunks) return false;
      localSelectionClipboard = { kind: 'tile', sourceDocumentId: document.id, grid: captureGridSelection(selection, (x, y) => readTileAt(layer.chunks!, x, y)) };
      setClipboardAvailable(true);
      notify(`Copied ${selection.length} selected tile${selection.length === 1 ? '' : 's'} to this project's tile clipboard.`, 'success'); return true;
    }
    if (!sprite || !activeFrameId) return false;
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined; if (!cel) return false;
    const activePalette = sprite.paletteOverrides[activeFrameId] ?? document.palette;
    const fragment: PixelSelectionFragment = {
      version: 1,
      kind: 'pixel-selection',
      sourceDocumentId: document.id,
      grid: captureGridSelection(selection, (x, y) => readPixel(cel, x, y)),
      palette: activePalette.map((entry) => entry.color),
    };
    try {
      await window.aidraw.writePixelSelectionClipboard(fragment);
      setClipboardAvailable(true);
      notify(`Copied ${selection.length} selected pixel${selection.length === 1 ? '' : 's'} as private indexed data plus a standard PNG.`, 'success');
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The indexed pixel selection and standard PNG could not be written to the system clipboard.', 'warning');
      return false;
    }
  };

  const pasteLocalSelection = async () => {
    if (tilemap) {
      const clipboard = localSelectionClipboard;
      if (!clipboard) { notify('This project has no copied tile selection.', 'warning'); return; }
      const origin = cursor ?? { x: clipboard.grid.originX, y: clipboard.grid.originY };
      if (clipboard.sourceDocumentId !== document.id) { notify('Tile selections keep project-local GIDs and can only be pasted inside their source project.', 'warning'); return; }
      const layer = activeTileLayerEntry?.layer; if (!layer || layer.type !== 'tile') return;
      const placed = placeGridClipboard(clipboard.grid, origin, tilemap.infinite ? undefined : { width: tilemap.width, height: tilemap.height }); const bounds = pixelSelectionBounds(placed.selection);
      if (!bounds) { notify('The pasted tile selection falls outside this finite map.', 'warning'); return; }
      const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'tile', assetId: tilemap.id, ...bounds } }); if (!lock.acquired) return;
      try {
        if (await apply('Paste tile selection', [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId: layer.id, changes: placed.changes.map((entry) => ({ x: entry.x, y: entry.y, gid: entry.value })), expectedRevision: layer.revision }])) setSelection(placed.selection);
        if (placed.dropped) notify(`${placed.dropped} pasted tile${placed.dropped === 1 ? '' : 's'} fell outside the finite map.`, 'warning');
      } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      return;
    }
    if (!sprite || !activeFrameId) return;
    const layerId = editableSpriteLayer(sprite, selectedEntityId)?.id; const cel = layerId ? celFor(sprite, layerId, activeFrameId) : undefined; if (!cel) return;
    let clipboard: Awaited<ReturnType<typeof window.aidraw.readPixelSelectionClipboard>>;
    try {
      clipboard = await window.aidraw.readPixelSelectionClipboard({
        documentId: document.id,
        expectedDocumentRevision: document.revision,
        spriteId: sprite.id,
        frameId: activeFrameId,
        celId: cel.id,
        origin: cursor ?? { x: 0, y: 0 },
      });
    }
    catch { notify('The system clipboard could not be read safely.', 'warning'); return; }
    let plan: ReturnType<typeof planPixelSelectionPaste>;
    const standardPng = clipboard.status === 'png';
    if (clipboard.status === 'valid') {
      try {
        plan = planPixelSelectionPaste({
          document,
          spriteId: sprite.id,
          frameId: activeFrameId,
          celId: cel.id,
          origin: cursor ?? { x: clipboard.fragment.grid.originX, y: clipboard.fragment.grid.originY },
        }, clipboard.fragment);
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The indexed pixel selection cannot be pasted.', 'warning');
        return;
      }
    } else if (clipboard.status === 'png' && clipboard.plan) {
      plan = clipboard.plan;
    } else {
      notify(clipboard.status === 'png' ? 'The standard PNG paste plan is unavailable.' : clipboard.message, 'warning');
      return;
    }
    const expectedPngDocumentRevision = standardPng ? plan.expectedDocumentRevision : undefined;
    if (standardPng && expectedPngDocumentRevision === undefined) { notify('The standard PNG paste plan is missing its document revision guard.', 'warning'); return; }
    const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: 'pixel', assetId: sprite.id, ...plan.bounds } }); if (!lock.acquired) return;
    try {
      let committed: boolean;
      if (standardPng) {
        if (expectedPngDocumentRevision === undefined) return;
        committed = await applyGuarded('Paste standard PNG selection', plan.operations, expectedPngDocumentRevision);
      } else committed = await apply('Paste pixel selection', plan.operations);
      if (committed) {
        setSelection(plan.selection);
        if (standardPng) notify('Pasted the standard PNG through the active frame palette; bitmap transparency became clear selected cells.', 'success');
      }
      if (plan.dropped) notify(`${plan.dropped} pasted pixel${plan.dropped === 1 ? '' : 's'} fell outside the sprite.`, 'warning');
    } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
  };

  const scaleSelection = async (scaleX: number, scaleY: number) => {
    if (!selection.length || (scaleX === 1 && scaleY === 1)) { setSelectionScaleOpen(false); return; }
    if (tilemap) {
      const layer = activeTileLayerEntry?.layer; if (!layer || layer.type !== 'tile' || !layer.chunks) return;
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
      const layer = activeTileLayerEntry?.layer;
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
      mapTileGesturePlanRef.current = undefined;
      wangTerrainGesturePlanRef.current = undefined;
      lassoDraftRef.current = undefined;
      setStart(undefined); setPreview([]); setBulkPreview([]); setLassoPath([]); setStampPreview([]); setTileStampPreview([]); setSelectionOffset(undefined); setLockPromise(undefined); setMapObjectGesture(undefined);
    }, pendingLocks, (lockId) => window.aidraw.releaseHumanLock(lockId));
  };

  const placeTileObject = async (event: ReactPointerEvent<HTMLCanvasElement>): Promise<void> => {
    if (!tilemap || event.button !== 0) return;
    const snapshot = useEditorStore.getState().snapshot;
    const liveDocument = snapshot?.activeDocument;
    if (!liveDocument || liveDocument.kind !== 'pixel' || liveDocument.id !== document.id) { notify('The active pixel document changed. Re-select the object layer and try again.', 'warning'); return; }
    const liveMap = liveDocument.pixelAssets[tilemap.id];
    if (!liveMap || liveMap.type !== 'tilemap' || liveMap.revision !== tilemap.revision) { notify('The map changed before tile-object placement. Re-observe the layer and try again.', 'warning'); return; }
    const liveEntry = composedVisibleTilemapLayers(liveMap).find((entry) => entry.layer.id === selectedEntityId && entry.layer.type === 'object');
    if (!liveEntry) { notify('Select one visible, unlocked object layer before placing a tile object. No other layer was chosen.', 'warning'); return; }
    if (!tileObjectTilesetId || !tileObjectTileset || tileObjectTileset.id !== tileObjectTilesetId) { notify('The selected tile-object tileset is no longer rendered. Re-observe the tileset and try again.', 'warning'); return; }
    let liveTileset: typeof tileObjectTileset;
    try { liveTileset = requireTileObjectPlacementTileset(liveDocument, liveMap, tileObjectTilesetId, tileObjectTileset.revision); }
    catch (error) { notify(`${error instanceof Error ? error.message : 'The selected tile-object tileset is no longer current.'} Re-observe its tile range and transform permissions, then try again.`, 'warning'); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    const layerTranslation = tilemapLayerScreenTranslation(liveEntry, pan, view.scale / liveMap.tileWidth);
    const point = clientPointToTilemapObjectAnchor(event.clientX, event.clientY, bounds, size, view, {
      orientation: liveMap.orientation, mapHeight: liveMap.height, tileWidth: liveMap.tileWidth, tileHeight: liveMap.tileHeight, layerTranslation,
    });
    let plan: ReturnType<typeof planTileObjectCreation>;
    try {
      plan = planTileObjectCreation(liveDocument, {
        mapId: liveMap.id,
        layerId: liveEntry.layer.id,
        tilesetId: tileObjectTilesetId,
        tileId: tileObjectPlacementTileId,
        transforms: activeTileTransforms,
        point,
        objectId: createId('map-tile-object'),
      });
    } catch (error) {
      notify(`${error instanceof Error ? error.message : 'The tile object could not be admitted.'} No map object was created.`, 'warning');
      return;
    }
    const lock = await window.aidraw.acquireHumanLock({ documentId: liveDocument.id, objectIds: [liveMap.id, liveTileset.id] });
    if (!lock.acquired) { notify(lock.reason ?? 'The complete map is busy. No tile object was created.', 'warning'); return; }
    try {
      const lockedDocument = useEditorStore.getState().snapshot?.activeDocument;
      if (!lockedDocument || lockedDocument.kind !== 'pixel' || lockedDocument.id !== liveDocument.id) { notify('The active document changed while tile-object placement waited for its lock. Nothing was submitted.', 'warning'); return; }
      const lockedMap = lockedDocument.pixelAssets[liveMap.id];
      if (!lockedMap || lockedMap.type !== 'tilemap' || lockedMap.revision !== plan.expectedRevision || !lockedMap.tilesetIds.includes(liveTileset.id)) { notify('The map changed while tile-object placement waited for its lock. Re-observe it and try again.', 'warning'); return; }
      if (plan.expectedDocumentRevision !== undefined && lockedDocument.revision !== plan.expectedDocumentRevision) { notify('The image-collection project changed while tile-object placement waited for its lock. Re-observe it and try again.', 'warning'); return; }
      try { requireTileObjectPlacementTileset(lockedDocument, lockedMap, liveTileset.id, liveTileset.revision); }
      catch (error) { notify(`${error instanceof Error ? error.message : 'The selected tileset changed while placement waited for its lock.'} Re-observe it and try again.`, 'warning'); return; }
      const operations: CanvasOperation[] = [{
        kind: 'pixel.asset.replace',
        asset: plan.asset,
        expectedRevision: plan.expectedRevision,
        ...(plan.expectedSpriteDependencies ? { expectedSpriteDependencies: plan.expectedSpriteDependencies } : {}),
      }];
      const committed = plan.expectedDocumentRevision === undefined
        ? await apply('Place tile object', operations)
        : await applyGuarded('Place tile object', operations, plan.expectedDocumentRevision);
      if (committed) {
        setSelectedEntity(plan.object.id); setRightPanel('layers'); setTool('select');
      }
    } finally {
      if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId);
    }
  };

  const observeMapTileGesturePlan = (): MapTileAuthoringPlan | undefined => {
    if (!tilemap || tool === 'eraser' || tool === 'terrain' || tool === 'tile-object' || tool === 'select' || (tool === 'stamp' && activeTileStamp)) return undefined;
    if (!currentMapTileTilesetId || !currentMapTileTileset) throw new Error('No exact attached tileset is selected for the Current tile choice.');
    const request = {
      mapId: tilemap.id,
      tilesetId: currentMapTileTilesetId,
      tileId: currentMapTileId,
      transforms: activeTileTransforms,
    };
    const observed = planMapTileAuthoringSelection(document, request);
    const liveDocument = useEditorStore.getState().snapshot?.activeDocument;
    if (!liveDocument || liveDocument.kind !== 'pixel' || liveDocument.id !== document.id) {
      throw new Error('The active pixel document changed before tile authoring.');
    }
    const current = planMapTileAuthoringSelection(liveDocument, request);
    if (!mapTileAuthoringPlansMatch(observed, current)) {
      throw new Error('The visible map, tileset, source sprite, or transform policy changed before tile authoring.');
    }
    return current;
  };

  const observeWangTerrainGesturePlan = (): WangTerrainSelectionPlan | undefined => {
    if (!tilemap || tool !== 'terrain') return undefined;
    if (!terrainTileset || !terrainSet || !terrainColor) throw new Error('Choose one exact attached tileset, Wang set, and Wang color before painting terrain.');
    const request = { mapId: tilemap.id, tilesetId: terrainTileset.id, wangSetId: terrainSet.id, colorId: terrainColor.id };
    const observed = planWangTerrainSelection(document, request);
    const liveDocument = useEditorStore.getState().snapshot?.activeDocument;
    if (!liveDocument || liveDocument.kind !== 'pixel' || liveDocument.id !== document.id) throw new Error('The active pixel document changed before Wang terrain authoring.');
    const current = planWangTerrainSelection(liveDocument, request);
    if (!wangTerrainSelectionPlansMatch(observed, current)) throw new Error('The visible map, Wang metadata, attached range, or collection source changed before terrain authoring.');
    return current;
  };

  const updatePreview = (from: PixelPoint, point: PixelPoint): void => {
    if (tool === 'select') setPreview(rectangleFill(from, point));
    else if (['line', 'rectangle', 'ellipse'].includes(tool)) setPreview(withSymmetry(frameChanges(tool, from, point)));
    else {
      const line = cursor ? bresenham(cursor.x, cursor.y, point.x, point.y) : [point];
      if (tool === 'stamp' && sprite) {
        const placed = withSymmetry(line.flatMap((entry) => placePixelStamp(placementStamp, entry.x, entry.y, wrapEditing ? undefined : { width: sprite.width, height: sprite.height }).changes));
        setStampPreview((current) => [...new Map([...current, ...placed].map((entry) => [`${entry.x},${entry.y}`, entry])).values()]);
        setPreview((current) => [...new Map([...current, ...placed].map((entry) => [`${entry.x},${entry.y}`, { x: entry.x, y: entry.y }])).values()]);
        return;
      }
      if (tool === 'stamp' && tilemap) {
        const bounds = tilemap.infinite ? undefined : { width: tilemap.width, height: tilemap.height };
        const gesturePlan = mapTileGesturePlanRef.current;
        const exactPlacementStamp = activeTileStamp ?? (gesturePlan
          ? { ...placementTileStamp, cells: [{ x: 0, y: 0, gid: gesturePlan.rawGid }] }
          : placementTileStamp);
        const placed = line.flatMap((entry) => placeTileStamp(exactPlacementStamp, entry.x, entry.y, bounds).changes);
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
    mapTileGesturePlanRef.current = undefined;
    wangTerrainGesturePlanRef.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPixel(event);
    const spritePoint = sprite && wrapEditing ? wrapPixelPoint(point, sprite.width, sprite.height) : point;
    if (tool === 'zoom') { setZoom(zoom * (event.shiftKey ? 0.5 : 2)); return; }
    if (tool === 'hand' || event.button === 1) { setStart(point); setCursor(point); return; }
    if (!sprite && !tilemap) return;
    if (tilemap && tool === 'tile-object') { await placeTileObject(event); return; }
    if (tilemap && tool === 'select') {
      const objectLayers = visibleMapLayers.filter((entry) => entry.layer.type === 'object' && !entry.layer.locked);
      let hit: { layer: typeof tilemap.layers[string]; object: MapObject; point: PixelPoint; rasterPoint: PixelPoint; tilePlacement?: ReturnType<typeof tileObjectArtworkPlacement> } | undefined;
      for (const entry of [...objectLayers].reverse()) {
        const layer = entry.layer; const mapPoint = toLayerMapObjectPoint(event, entry); const rasterPoint = toLayerRasterPoint(event, entry);
        const matrix = tilemap.orientation === 'isometric'
          ? isometricObjectMatrix(tilemap.height, tilemap.tileWidth, tilemap.tileHeight, view.scale, view.scale * tilemap.tileHeight / tilemap.tileWidth)
          : orthogonalObjectMatrix(tilemap.tileWidth, tilemap.tileHeight, view.scale, view.scale * tilemap.tileHeight / tilemap.tileWidth);
        const unitScale = tilemap.orientation === 'orthogonal' ? view.scale / tilemap.tileWidth : view.scale / Math.max(tilemap.tileWidth, tilemap.tileHeight); const tolerance = 9 / Math.max(0.001, unitScale);
        for (const candidate of [...(layer.objects ?? [])].reverse()) {
          if (candidate.type !== 'tile') {
            if (mapObjectAtPoint(candidate, mapPoint, tolerance)) { hit = { layer, object: candidate, point: mapPoint, rasterPoint }; break; }
            continue;
          }
          const resolved = resolveTilesetForGid(document, tilemap, decodeTiledGid(candidate.gid).gid);
          let renderedSource: ReturnType<typeof resolveRenderedTilesetTileSource> | undefined;
          try { renderedSource = resolved ? resolveRenderedTilesetTileSource(document, resolved.tileset, resolved.localId, tileAnimationTimeMs) : undefined; } catch { renderedSource = undefined; }
          const placement = tileObjectArtworkPlacement(candidate, tilemap.orientation, matrix, view.scale / tilemap.tileWidth, resolved?.tileset, renderedSource?.rect);
          if (tileObjectArtworkContainsPoint(placement, rasterPoint, 9)) { hit = { layer, object: candidate, point: mapPoint, rasterPoint, tilePlacement: placement }; break; }
        }
        if (hit) break;
      }
      if (hit) {
        const objectBounds = hit.object.type === 'tile' ? { x: hit.object.x - hit.object.width, y: hit.object.y - hit.object.height, width: hit.object.width * 2, height: hit.object.height * 2 } : mapObjectBounds(hit.object); const unitScale = tilemap.orientation === 'orthogonal' ? view.scale / tilemap.tileWidth : view.scale / Math.max(tilemap.tileWidth, tilemap.tileHeight); const handleThreshold = 9 / Math.max(0.001, unitScale); const pointIndex = selectedEntityId === hit.object.id && hit.object.type !== 'tile' && hit.object.points ? hit.object.points.findIndex((entry) => Math.hypot(hit.object.x + entry.x - hit.point.x, hit.object.y + entry.y - hit.point.y) <= handleThreshold) : -1; const atHandle = selectedEntityId === hit.object.id && (hit.object.type === 'tile' ? Boolean(hit.tilePlacement && Math.hypot(hit.rasterPoint.x - hit.tilePlacement.resizeHandle.x, hit.rasterPoint.y - hit.tilePlacement.resizeHandle.y) <= 9) : (hit.object.type === 'rectangle' || hit.object.type === 'ellipse') && Math.hypot(hit.point.x - (objectBounds.x + objectBounds.width), hit.point.y - (objectBounds.y + objectBounds.height)) <= handleThreshold);
        if (hit.object.type !== 'tile' && selectedEntityId === hit.object.id && pointIndex >= 0 && event.ctrlKey) { const minimum = hit.object.type === 'polygon' ? 3 : 2; if (!hit.object.points || hit.object.points.length <= minimum) return; const next = structuredClone(tilemap); const layer = next.layers[hit.layer.id]; if (layer.type === 'object') { const object = deleteMapObjectPoint(hit.object, pointIndex); layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry); void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [tilemap.id] }); try { if (lock.acquired) await apply('Delete map object point', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision }]); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })(); } return; }
        if (hit.object.type !== 'tile' && selectedEntityId === hit.object.id && pointIndex < 0 && event.altKey && hit.object.points) { const nearest = nearestMapObjectSegment(hit.object, hit.point); if (nearest && nearest.distance <= handleThreshold) { const next = structuredClone(tilemap); const layer = next.layers[hit.layer.id]; if (layer.type === 'object') { const object = insertMapObjectPoint(hit.object, nearest.segmentIndex, nearest.point); layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry); void (async () => { const lock = await window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [tilemap.id] }); try { if (lock.acquired) await apply('Insert map object point', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: tilemap.revision }]); } finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); } })(); } return; } }
        if (hit.object.type === 'tile') {
          try { requireWritableTileObject(tilemap, hit.layer.id, hit.object.id); }
          catch (error) { notify(`${error instanceof Error ? error.message : 'This tile object is not writable.'} Nothing was moved or resized.`, 'warning'); return; }
        }
        const region = { x: Math.floor(objectBounds.x / tilemap.tileWidth), y: Math.floor(objectBounds.y / tilemap.tileHeight), width: Math.max(1, Math.ceil(objectBounds.width / tilemap.tileWidth)), height: Math.max(1, Math.ceil(objectBounds.height / tilemap.tileHeight)) };
        setMapObjectGesture({ layerId: hit.layer.id, objectId: hit.object.id, mode: pointIndex >= 0 ? 'point' : atHandle ? 'resize' : 'move', pointIndex: pointIndex >= 0 ? pointIndex : undefined, start: hit.point, current: hit.point, original: structuredClone(hit.object), lockPromise: window.aidraw.acquireHumanLock({ documentId: document.id, objectIds: [tilemap.id], region: { kind: 'tile', assetId: tilemap.id, ...region } }) }); setSelectedEntity(hit.object.id); setSelection([]); setCursor(point); return;
      }
    }
    if (tool === 'eyedropper' && sprite && activeFrameId) {
      const value = pixelAt(sprite, activeFrameId, spritePoint.x, spritePoint.y);
      setPixelIndex(value);
      const color = document.palette[value]?.color;
      if (color) useEditorStore.getState().setColor(color.slice(0, 7));
      return;
    }
    const combination: SelectionCombination = event.shiftKey && event.altKey ? 'intersect' : event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'replace'; selectionCombination.current = combination;
    if (tool === 'wand' && sprite && activeFrameId) {
      if (spritePoint.x < 0 || spritePoint.y < 0 || spritePoint.x >= sprite.width || spritePoint.y >= sprite.height) return;
      const selected = floodPixelRegion({ width: sprite.width, height: sprite.height, start: spritePoint, read: compositePixelReader(sprite, activeFrameId) });
      if (!selected.ok) notify(pixelToolLimitMessage('Magic-wand selection', selected), 'warning');
      else setSelection((current) => combineGridSelection(current, pixelRegionPoints(selected.runs), combination));
      setPreview([]); setBulkPreview([]); return;
    }
    if (tool === 'select' && combination === 'replace' && selection.some((entry) => entry.x === point.x && entry.y === point.y)) { setStart(point); setCursor(point); setPreview([]); setSelectionOffset({ x: 0, y: 0 }); return; }
    if (tool === 'select' || tool === 'lasso') {
      let draft: GridLassoDraft | undefined;
      try { draft = tool === 'lasso' ? createGridLassoDraft(point) : undefined; }
      catch (error) { notify(`${error instanceof Error ? error.message : 'Grid lasso could not start.'} Selection was unchanged.`, 'warning'); return; }
      const path = draft?.points ?? [];
      lassoDraftRef.current = draft;
      setSelectionOffset(undefined); setStart(point); setCursor(point); setLassoPath(path); setPreview(tool === 'lasso' ? [] : [point]); return;
    }
    if (tool === 'text' && sprite && activeFrameId) {
      setBitmapTextPoint(spritePoint);
      return;
    }
    if (tilemap) {
      try {
        if (tool === 'terrain') wangTerrainGesturePlanRef.current = observeWangTerrainGesturePlan();
        else mapTileGesturePlanRef.current = observeMapTileGesturePlan();
      } catch (error) {
        notify(`${error instanceof Error ? error.message : 'The map authoring choice could not be admitted.'} Re-select the exact choice and try again. No map cell changed.`, 'warning');
        return;
      }
    }
    const bounds = sprite ? { width: sprite.width, height: sprite.height, kind: 'pixel' as const } : { width: tilemap!.width, height: tilemap!.height, kind: 'tile' as const };
    if ((tool === 'fill' || tool === 'replace') && sprite && activeFrameId) {
      if (spritePoint.x < 0 || spritePoint.y < 0 || spritePoint.x >= sprite.width || spritePoint.y >= sprite.height) return;
      const read = compositePixelReader(sprite, activeFrameId);
      const source = read(spritePoint.x, spritePoint.y);
      if (source === pixelIndex) { notify(tool === 'fill' ? 'This region already uses the selected palette index.' : 'The source and replacement palette indices are identical.', 'info'); return; }
      const result = tool === 'fill'
        ? floodPixelRegion({ width: sprite.width, height: sprite.height, start: spritePoint, read })
        : replacePixelRegion({ width: sprite.width, height: sprite.height, matchIndex: source, read });
      if (!result.ok) { notify(pixelToolLimitMessage(tool === 'fill' ? 'Pixel flood fill' : 'Pixel color replacement', result), 'warning'); return; }
      if (!result.runs.length) { notify('The pixel operation would not change any cells.', 'info'); return; }
      const pendingLock = window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: bounds.kind, assetId: sprite.id, x: 0, y: 0, width: bounds.width, height: bounds.height } });
      setLockPromise(pendingLock); setStart(spritePoint); setCursor(point); setPreview([]); setBulkPreview(result.runs.map((run) => ({ ...run, index: pixelIndex }))); setStampPreview([]); setTileStampPreview([]);
      return;
    }
    setLockPromise(window.aidraw.acquireHumanLock({ documentId: document.id, region: { kind: bounds.kind, assetId: sprite?.id ?? asset!.id, x: 0, y: 0, width: bounds.width, height: bounds.height } }));
    setStart(point); setCursor(point); setBulkPreview([]); setStampPreview([]); setTileStampPreview([]); updatePreview(point, point);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toPixel(event);
    if (mapObjectGesture && tilemap) { const entry = visibleMapLayers.find((candidate) => candidate.layer.id === mapObjectGesture.layerId); if (entry) setMapObjectGesture({ ...mapObjectGesture, current: toLayerMapObjectPoint(event, entry) }); setCursor(point); return; }
    if (!start) { setCursor(point); return; }
    if (tool === 'hand' || event.button === 1) {
      setPan((current) => ({ x: current.x + event.movementX, y: current.y + event.movementY }));
    } else if (selectionOffset && tool === 'select') setSelectionOffset({ x: point.x - start.x, y: point.y - start.y });
    else if (tool === 'lasso') {
      try {
        const current = lassoDraftRef.current;
        if (!current) return;
        const next = appendGridLassoPoint(current, point);
        if (!next) {
          notify(`Grid lasso is limited to ${MAX_GRID_LASSO_VERTICES.toLocaleString('en-US')} path vertices; selection was unchanged.`, 'warning');
          void cancelGesture();
          return;
        }
        lassoDraftRef.current = next;
        setLassoPath(next.points);
      } catch (error) {
        notify(`${error instanceof Error ? error.message : 'Grid lasso could not continue.'} Selection was unchanged.`, 'warning');
        void cancelGesture();
        return;
      }
    }
    else if (tool === 'fill' || tool === 'replace') { setCursor(point); return; }
    else updatePreview(start, point);
    setCursor(point);
  };

  const finish = async () => {
    const gestureEpoch = gestureEpochRef.current;
    if (mapObjectGesture && tilemap) {
      const gesture = mapObjectGesture; setMapObjectGesture(undefined); const lock = await gesture.lockPromise; if (gestureEpoch !== gestureEpochRef.current || !lock?.acquired) return;
      try {
        let sourceMap = tilemap;
        if (gesture.original.type === 'tile') {
          const liveDocument = useEditorStore.getState().snapshot?.activeDocument;
          if (!liveDocument || liveDocument.kind !== 'pixel' || liveDocument.id !== document.id) { notify('The active document changed while the tile-object gesture waited for its lock. Nothing was submitted.', 'warning'); return; }
          const liveMap = liveDocument.pixelAssets[tilemap.id];
          if (!liveMap || liveMap.type !== 'tilemap') { notify('The tile-object map no longer exists. Nothing was moved or resized.', 'warning'); return; }
          try { requireWritableTileObject(liveMap, gesture.layerId, gesture.objectId); }
          catch (error) { notify(`${error instanceof Error ? error.message : 'This tile object is not writable.'} Nothing was moved or resized.`, 'warning'); return; }
          if (liveMap.revision !== tilemap.revision) { notify('The tile-object map changed while the gesture waited for its lock. Nothing was moved or resized.', 'warning'); return; }
          sourceMap = liveMap;
        }
        const next = structuredClone(sourceMap); const layer = next.layers[gesture.layerId]; if (layer?.type !== 'object') return; const object = previewMapObject(gesture); layer.objects = (layer.objects ?? []).map((entry) => entry.id === object.id ? object : entry);
        await apply(gesture.mode === 'point' ? 'Move map object point' : gesture.mode === 'move' ? 'Move map object' : 'Resize map object', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sourceMap.revision }]);
      }
      finally { if (lock.lockId) await window.aidraw.releaseHumanLock(lock.lockId); }
      return;
    }
    if (!start && !selectionOffset && !lockPromise) return;
    const pendingLock = lockPromise;
    const pendingRuns = bulkPreview;
    const pendingMapTilePlan = mapTileGesturePlanRef.current;
    mapTileGesturePlanRef.current = undefined;
    const pendingWangTerrainPlan = wangTerrainGesturePlanRef.current;
    wangTerrainGesturePlanRef.current = undefined;
    const pendingLassoPath = lassoDraftRef.current?.points ?? [];
    if (tool === 'lasso' && pendingLassoPath.length === 0) return;
    const points = sprite && wrapEditing && tool !== 'select' && tool !== 'lasso'
      ? wrapPixelPoints(preview, sprite.width, sprite.height)
      : preview.filter((point) => tilemap?.infinite || (point.x >= 0 && point.y >= 0 && point.x < logical.gridWidth && point.y < logical.gridHeight));
    const placedStamp = sprite && wrapEditing ? wrapPixelPoints(stampPreview, sprite.width, sprite.height) : stampPreview; const placedTiles = tileStampPreview; setStart(undefined); setPreview([]); setBulkPreview([]); setLassoPath([]); setStampPreview([]); setTileStampPreview([]);
    lassoDraftRef.current = undefined;
    if (selectionOffset && tool === 'select') { const offset = selectionOffset; setSelectionOffset(undefined); if (offset.x || offset.y) await transformSelection('move', offset); return; }
    if (tool === 'select') { setSelection((current) => combineGridSelection(current, points, selectionCombination.current)); return; }
    if (tool === 'lasso') {
      try {
        const selected = rasterizeGridLasso(pendingLassoPath)
          .filter((point) => tilemap?.infinite || (point.x >= 0 && point.y >= 0 && point.x < logical.gridWidth && point.y < logical.gridHeight));
        setSelection((current) => combineGridSelection(current, selected, selectionCombination.current));
      } catch (error) {
        notify(`${error instanceof Error ? error.message : 'Grid lasso could not be evaluated.'} Selection was unchanged.`, 'warning');
      }
      return;
    }
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
            ? [...new Map(points.map((point) => [`${point.x},${point.y}`, { ...point, index: orderedDitherIndex(point.x, point.y, ditherMixIndex, pixelIndex, ditherCoverage, ditherMatrixSize, ditherPhaseX, ditherPhaseY) }])).values()]
            : tool === 'lighten' || tool === 'darken'
            ? [...new Map(points.map((point) => { const current = pixelAt(sprite, activeFrameId, point.x, point.y); return [`${point.x},${point.y}`, { ...point, index: stepPaletteByLuminance(activePaletteOverride ?? document.palette, current, tool === 'lighten' ? 'lighter' : 'darker') }] as const; })).values()]
            : uniqueChanges(points, tool === 'eraser' ? 0 : pixelIndex);
          await apply(`${tool === 'eraser' ? 'Erase' : 'Draw'} pixels`, [{ kind: 'pixel.cel.set', spriteId: sprite.id, celId: cel.id, changes, expectedRevision: cel.revision }]);
        }
      }
    } else if (tilemap) {
      const layer = activeTileLayerEntry?.layer;
      const layerId = layer?.type === 'tile' ? layer.id : undefined;
      if (layerId && layer?.type === 'tile' && layer.chunks) {
        if (tool === 'stamp' && placedTiles.length) {
          const operations: CanvasOperation[] = [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes: placedTiles, expectedRevision: layer.revision }];
          if (pendingMapTilePlan?.expectedDocumentRevision !== undefined) await applyGuarded('Place Current tile stamp', operations, pendingMapTilePlan.expectedDocumentRevision);
          else await apply(pendingMapTilePlan ? 'Place Current tile stamp' : 'Place reusable tile stamp', operations);
        } else if (tool === 'terrain' && pendingWangTerrainPlan) {
          const gestureTileset = pendingWangTerrainPlan.tileset;
          const gestureSet = pendingWangTerrainPlan.wangSet;
          const terrainTileAt = (x: number, y: number) => {
            const gid = decodeTiledGid(readTileAt(layer.chunks!, x, y)).gid;
            if (gid === 0) return undefined;
            const resolved = resolveTilesetForGid(document, tilemap, gid);
            if (!resolved || resolved.tileset.id !== gestureTileset.id) throw new Error(`Terrain stroke cell (${x}, ${y}) contains GID ${gid} outside tileset ${gestureTileset.id}.`);
            return resolved.localId;
          };
          const contains = (x: number, y: number) => tilemap.infinite || (x >= 0 && y >= 0 && x < tilemap.width && y < tilemap.height);
          let plan: ReturnType<typeof planWangTerrainStroke>;
          try {
            plan = planWangTerrainStroke(gestureSet, points, pendingWangTerrainPlan.colorId, terrainTileAt, { erase: terrainErase, contains });
          } catch (error) {
            notify(`${error instanceof Error ? error.message : 'The Wang terrain stroke could not be planned.'} No terrain tiles changed.`, 'warning');
            return;
          }
          if (plan.status === 'unmatched') {
            const examples = plan.unmatched.slice(0, 3).map((entry) => `(${entry.x}, ${entry.y}) [${entry.wangId.join(',')}]`).join('; ');
            const remainder = plan.unmatched.length > 3 ? `; +${plan.unmatched.length - 3} more` : '';
            notify(`Terrain stroke was not applied: ${plan.unmatched.length} in-map cell${plan.unmatched.length === 1 ? '' : 's'} need exact Wang mappings: ${examples}${remainder}. No terrain tiles changed; add those mappings to “${gestureSet.name}” and retry.`, 'warning');
            return;
          }
          const changes = plan.changes.map((change) => ({ x: change.x, y: change.y, gid: change.tileId + gestureTileset.firstGid }));
          if (!changes.length) notify('The terrain stroke already matches the selected terrain; no tiles changed.', 'info');
          else {
            const label = terrainErase ? 'Erase Wang terrain' : 'Paint Wang terrain';
            const operations: CanvasOperation[] = [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes, expectedRevision: layer.revision }];
            const committed = pendingWangTerrainPlan.expectedDocumentRevision === undefined
              ? await apply(label, operations)
              : await applyGuarded(label, operations, pendingWangTerrainPlan.expectedDocumentRevision);
            if (committed && plan.strokePointCount > 1) {
              notify(`${terrainErase ? 'Erased' : 'Painted'} ${plan.strokePointCount} terrain stroke cells with ${plan.repairChangeCount} neighboring repair${plan.repairChangeCount === 1 ? '' : 's'} in one undoable change.`, 'info');
            }
          }
        } else {
          if (tool !== 'eraser' && !pendingMapTilePlan) {
            notify('The Current tile choice was not retained for this gesture. No map cell changed; re-select the tile and try again.', 'warning');
            return;
          }
          const gestureTileset = pendingMapTilePlan?.tileset;
          const gestureVariantGroup = gestureTileset && !pendingMapTilePlan.imageCollection
            ? tileVariantGroup(gestureTileset.tiles[pendingMapTilePlan.tileId])
            : undefined;
          const changes = points.map((point) => ({
            ...point,
            gid: tool === 'eraser'
              ? 0
              : pendingMapTilePlan!.imageCollection
                ? pendingMapTilePlan!.rawGid
                : encodeTiledGid(
                    pendingMapTilePlan!.tileset.firstGid + chooseTileVariant(pendingMapTilePlan!.tileset, pendingMapTilePlan!.tileId, point.x, point.y, variantSeed),
                    pendingMapTilePlan!.transforms,
                  ),
          }));
          const operations: CanvasOperation[] = [{ kind: 'pixel.tilemap.set', mapId: tilemap.id, layerId, changes, expectedRevision: layer.revision }];
          const label = gestureVariantGroup ? `Paint ${gestureVariantGroup} variants` : 'Paint tiles';
          if (pendingMapTilePlan?.expectedDocumentRevision !== undefined) await applyGuarded(label, operations, pendingMapTilePlan.expectedDocumentRevision);
          else await apply(label, operations);
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
    const authoredPoints = withSymmetry(bitmapTextCells(font, request.text, { x: point.x, y: point.y, letterSpacing: request.letterSpacing, lineSpacing: request.lineSpacing, scale: request.scale, align: request.align }));
    const points = wrapEditing ? wrapPixelPoints(authoredPoints, sprite.width, sprite.height) : authoredPoints.filter((entry) => entry.x >= 0 && entry.y >= 0 && entry.x < sprite.width && entry.y < sprite.height);
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

  const createBitmapFont = async (request: { name: string; lineHeight: number }): Promise<boolean> => {
    const creation = createEmptyBitmapFont(currentBitmapFonts(), { id: createId('bitmap-font'), ...request });
    const applied = await apply('Create bitmap font', [{ kind: 'pixel.bitmap-fonts.replace', fonts: creation.fonts }]);
    if (applied) {
      setBitmapFontId(creation.font.id);
      notify(`Created empty bitmap font ${creation.font.name}. Map characters with Glyph or Glyph sheet before painting text.`, 'success');
    }
    return applied;
  };

  const removeBitmapFont = async (fontId: string): Promise<boolean> => {
    const deletion = deleteBitmapFont(currentBitmapFonts(), fontId);
    const applied = await apply('Delete bitmap font', [{ kind: 'pixel.bitmap-fonts.replace', fonts: deletion.fonts }]);
    if (applied) {
      setBitmapFontId(deletion.selectedFontId);
      notify(`Deleted bitmap font ${deletion.font.name}. Existing bitmap text remains rasterized in its cels.`, 'success');
    }
    return applied;
  };

  const renameSelectedBitmapFont = async (request: BitmapFontRenameRequest): Promise<boolean> => {
    const renamed = renameBitmapFont(currentBitmapFonts(), request.expectedFont, request.name);
    const applied = await apply('Rename bitmap font', [{ kind: 'pixel.bitmap-fonts.replace', fonts: renamed.fonts }]);
    if (applied) {
      setBitmapFontId(renamed.font.id);
      notify(`Renamed bitmap font to ${renamed.font.name}.`, 'success');
    }
    return applied;
  };

  const editSelectedBitmapGlyph = async (request: BitmapFontGlyphEditRequest): Promise<boolean> => {
    const edited = editBitmapFontGlyph(currentBitmapFonts(), request.expectedFont, request.character, request.glyph, request.lineHeight);
    const applied = await apply('Edit bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace', fonts: edited.fonts }]);
    if (applied) notify(`Updated ${request.character} in ${edited.font.name}.`, 'success');
    return applied;
  };

  const removeSelectedBitmapGlyph = async (request: BitmapFontGlyphDeleteRequest): Promise<boolean> => {
    const deleted = deleteBitmapFontGlyph(currentBitmapFonts(), request.expectedFont, request.character);
    const applied = await apply('Delete bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace', fonts: deleted.fonts }]);
    if (applied) notify(`Deleted ${request.character} from ${deleted.font.name}. Existing cel pixels remain unchanged.`, 'success');
    return applied;
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
    if (tagId && !tag) { notify('That animation tag is no longer available. Reopen the current sprite tag and try again.', 'warning'); return; }
    setTagDraftState({ documentId: document.id, spriteId: sprite.id, draft: tag ? structuredClone(tag) : { name: `Animation ${sprite.tags.length + 1}`, fromFrameId: activeFrameId ?? sprite.frameIds[0], toFrameId: sprite.frameIds.at(-1)!, direction: pingPong ? 'ping-pong' : 'forward', color: '#31a6a0' } });
  };

  const selectAnimationTag = (tagId?: string) => {
    if (!tagId) { setSelectedTagSelection(undefined); return; }
    const tag = sprite?.tags.find((entry) => entry.id === tagId);
    if (!sprite || !tag) return;
    setSelectedTagSelection({ documentId: document.id, spriteId: sprite.id, tagId });
    setPlayDirection(tag.direction === 'reverse' ? -1 : 1);
    setFrameId(tag.direction === 'reverse' ? tag.toFrameId : tag.fromFrameId);
  };

  const addTag = async () => {
    if (!sprite || !tagDraft?.name.trim()) return;
    if (!animationTagScopeMatches(tagDraftState, document.id, sprite.id)) return;
    if (tagDraft.id && !sprite.tags.some((tag) => tag.id === tagDraft.id)) { notify('That animation tag changed or was deleted. Reopen it before editing.', 'warning'); setTagDraftState(undefined); return; }
    const fromIndex = sprite.frameIds.indexOf(tagDraft.fromFrameId);
    const toIndex = sprite.frameIds.indexOf(tagDraft.toFrameId);
    if (fromIndex < 0 || toIndex < fromIndex) return;
    const tag = { ...tagDraft, id: tagDraft.id ?? createId('tag'), name: tagDraft.name.trim() };
    const next = upsertPixelAnimationTag(sprite, tag);
    if (await apply(tagDraft.id ? 'Edit animation tag' : 'Add animation tag', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }])) setTagDraftState(undefined);
  };

  const deleteTag = async (tagId: string) => {
    if (!sprite) return;
    if (!sprite.tags.some((tag) => tag.id === tagId)) { notify('That animation tag changed or was deleted. Reopen the current sprite before deleting.', 'warning'); setTagDraftState(undefined); return; }
    const next = deletePixelAnimationTag(sprite, tagId);
    if (await apply('Delete animation tag', [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: sprite.revision }])) { if (selectedTagId === tagId) setSelectedTagSelection(undefined); setTagDraftState(undefined); }
  };

  useEffect(() => {
    const onSelectionCommand = (event: Event) => {
      const command = (event as CustomEvent<PixelSelectionCommand>).detail;
      if (command === 'copy') void copyLocalSelection();
      else if (command === 'cut') void (async () => { if (await copyLocalSelection()) await deleteSelection(); })();
      else if (command === 'paste') void pasteLocalSelection();
      else if (command === 'delete') void deleteSelection();
      else if (command === 'clear') { lassoDraftRef.current = undefined; setSelection([]); setSelectionOffset(undefined); setLassoPath([]); }
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
  if (asset.type === 'tileset' && isImageCollectionTileset(asset)) return <div className="empty-canvas"><Grid3X3 size={36} /><strong>Image collection tileset</strong><span>{Object.keys(asset.tiles).length} sparse PNG tile(s) · {asset.columns} display column(s). Per-tile artwork is read-only here; use this tileset from a finite orthogonal map.</span></div>;
  if (asset.type === 'tileset' && !sprite) return <div className="empty-canvas"><Grid3X3 size={36} /><strong>Missing tileset pixels</strong><span>The linked source sprite is unavailable.</span></div>;
  if (tilemapModeError) return <div className="empty-canvas"><Grid3X3 size={36} /><strong>Unsupported image-collection map mode</strong><span>{tilemapModeError}</span></div>;
  const durationFrame = durationFrameId && sprite ? sprite.frames[durationFrameId] : undefined;
  const durationFrameNumber = durationFrameId && sprite ? sprite.frameIds.indexOf(durationFrameId) + 1 : undefined;
  const tagFromIndex = tagDraft && sprite ? sprite.frameIds.indexOf(tagDraft.fromFrameId) : -1;
  const tagToIndex = tagDraft && sprite ? sprite.frameIds.indexOf(tagDraft.toFrameId) : -1;
  const tagDraftOrder = tagDraft?.id && sprite ? sprite.tags.findIndex((tag) => tag.id === tagDraft.id) : -1;
  const tagError = !tagDraft?.name.trim() ? 'Enter a tag name.' : tagFromIndex < 0 || tagToIndex < tagFromIndex ? 'The end frame must be at or after the start frame.' : undefined;
  const activeFrameLinked = Boolean(sprite && activeFrameId && Object.values(sprite.cels).some((cel) => cel.frameId === activeFrameId && cel.linkedToCelId));

  return (
    <div className="canvas-container pixel-canvas-container" ref={containerRef}>
      <canvas
        id="aidraw-canvas"
        ref={canvasRef}
        role="application"
        aria-label={`Pixel-art canvas for ${document.name}`}
        aria-describedby="aidraw-canvas-keyboard-help"
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
        <button className={fontLibraryOpen ? 'is-active' : ''} aria-expanded={fontLibraryOpen} onClick={() => { setFontLibraryOpen(true); setGlyphMapperOpen(false); setGlyphSheetMapperOpen(false); setBitmapTextPoint(undefined); }} title="Manage document-owned bitmap fonts and mapped glyphs"><CaseUpper size={EDITOR_DENSITY.secondaryIcon} /> Fonts</button>
        {hasTimeline && <button className={onionSkin ? 'is-active' : ''} onClick={() => setOnionSkinPreferences({ ...onionSettings, enabled: !onionSkin })} title="Onion skin"><Eye size={14} /> Onion</button>}
        {hasTimeline && <button className={onionSettingsOpen ? 'is-active' : ''} aria-expanded={onionSettingsOpen} aria-controls="onion-skin-settings" onClick={() => { setOnionSettingsOpen((open) => !open); setExposureGridOpen(false); }} title="Configure bounded onion skin frames, tint, and opacity"><SlidersHorizontal size={13} /> Onion setup</button>}
        {sprite && <button className={wrapEditing ? 'is-active' : ''} aria-pressed={wrapEditing} onClick={() => setWrapEditing((value) => !value)} title="Preview and edit through repeated copies across opposite sprite edges"><Repeat2 size={14} /> Wrap edit</button>}
        {sprite && <label className="symmetry-mode-control"><FlipHorizontal2 size={14} /><span>Symmetry</span><select aria-label="Sprite symmetry mode" value={symmetry.mode} onChange={(event) => setSpriteSymmetryPreferences(withSpriteSymmetryMode(symmetryPreferences, event.target.value as typeof symmetry.mode))}><option value="none">None</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option><option value="both">Both</option></select></label>}
        {sprite && <button className={symmetrySettingsOpen ? 'is-active' : ''} aria-expanded={symmetrySettingsOpen} aria-controls="sprite-symmetry-settings" onClick={() => { setSymmetrySettingsOpen((open) => !open); setOnionSettingsOpen(false); }} title="Set exact half-pixel symmetry axes for this sprite"><SlidersHorizontal size={13} /> Symmetry setup</button>}
        {sprite && <button className={paletteCycling ? 'is-active' : ''} onClick={() => { if (paletteCycling) setPaletteOffset(0); setPaletteCycling(!paletteCycling); }} title="Palette cycling preview"><Repeat2 size={14} /> Cycle</button>}
        {paletteCycling && document.paletteCycles.length > 0 && <select aria-label="Active palette cycle" value={activePaletteCycle?.id} onChange={(event) => { setActivePaletteCycleId(event.target.value); setPaletteOffset(0); }} title="Named palette cycle">{document.paletteCycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}</select>}
        {tool === 'terrain' && <><select aria-label="Wang terrain tileset" value={terrainTileset?.id ?? ''} onChange={(event) => { if (!tilemap) return; setTerrainTilesetChoice({ documentId: document.id, mapId: tilemap.id, tilesetId: event.target.value }); setTerrainSetId(undefined); setTerrainColorId(undefined); }}><option value="" disabled>Terrain tileset</option>{wangTerrainTilesets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>{terrainTileset?.type === 'tileset' && <><select aria-label="Active Wang set" value={terrainSet?.id ?? ''} onChange={(event) => { setTerrainSetId(event.target.value); setTerrainColorId(undefined); }}><option value="" disabled>Wang set</option>{terrainTileset.wangSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select><select aria-label="Active Wang color" value={terrainColor?.id ?? ''} onChange={(event) => setTerrainColorId(Number(event.target.value))}><option value="" disabled>Terrain color</option>{terrainSet?.colors.map((color) => <option key={color.id} value={color.id}>{color.name}</option>)}</select><button className={terrainErase ? 'is-active' : ''} onClick={() => setTerrainErase((value) => !value)} title="Toggle terrain erase and neighbor repair"><Eraser size={13} /> {terrainErase ? 'Erase' : 'Paint'}</button></>}</>}
        {tilemap && tool !== 'terrain' && tool !== 'tile-object' && <CurrentMapTileControl
          document={document}
          map={tilemap}
          tilesets={authorableMapTileTilesets}
          tilesetId={currentMapTileTileset?.id}
          tileIdDraft={currentMapTileDraftValue}
          onTilesetChange={(tilesetId) => {
            const next = authorableMapTileTilesets.find((entry) => entry.id === tilesetId);
            if (!next) return;
            const update = selectCurrentMapTileset({ documentId: document.id, mapId: tilemap.id }, next, selectedTileId);
            setCurrentMapTileChoice(update.choice);
            setCurrentMapTileDraft(update.draft);
            if (update.nextPixelIndex !== undefined) setPixelIndex(update.nextPixelIndex);
          }}
          onTileIdDraftChange={(value) => {
            if (!currentMapTileTileset) return;
            const update = selectScopedMapTileId({ documentId: document.id, mapId: tilemap.id, tilesetId: currentMapTileTileset.id }, currentMapTileTileset, value);
            setCurrentMapTileDraft(update.draft);
            if (update.nextPixelIndex !== undefined) setPixelIndex(update.nextPixelIndex);
          }}
        />}
        {tool === 'tile-object' && tilemap && <>
          <select aria-label="Tile object tileset" value={tileObjectTileset?.id ?? ''} onChange={(event) => { const tilesetId = event.target.value; setTileObjectTilesetChoice({ documentId: document.id, mapId: tilemap.id, tilesetId }); setTileObjectTileDraft(undefined); }} title="Exact attached atlas or finite-orthogonal image-collection tileset for the new tile object"><option value="" disabled>Attached tileset</option>{authorableTileObjectTilesets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
          <label className="tile-object-tile-control"><span>Tile ID</span>{tileObjectTileset && isImageCollectionTileset(tileObjectTileset)
            ? <select aria-label="Tile object local tile ID" value={tileObjectTileDraftValue} onChange={(event) => { const update = selectScopedMapTileId({ documentId: document.id, mapId: tilemap.id, tilesetId: tileObjectTileset.id }, tileObjectTileset, event.target.value); setTileObjectTileDraft(update.draft); if (update.nextPixelIndex !== undefined) setPixelIndex(update.nextPixelIndex); }}>{tileObjectCollectionIds.map((id) => <option key={id} value={id}>{id}</option>)}</select>
            : <input aria-label="Tile object local tile ID" type="number" min={0} max={Math.max(0, (tileObjectTileset?.columns ?? 1) * (tileObjectTileset?.rows ?? 1) - 1)} step={1} value={tileObjectTileDraftValue} onChange={(event) => { if (!tileObjectTileset) return; const update = selectScopedMapTileId({ documentId: document.id, mapId: tilemap.id, tilesetId: tileObjectTileset.id }, tileObjectTileset, event.target.value); setTileObjectTileDraft(update.draft); if (update.nextPixelIndex !== undefined) setPixelIndex(update.nextPixelIndex); }} />}</label>
          <span title="Exact destination object layer">{activeObjectLayerEntry ? activeObjectLayerEntry.layer.name : 'Select object layer'}</span>
        </>}
        {tilemap && tool !== 'terrain' && terrainTileset?.type === 'tileset' && <>
          <button className={activeTileTransforms.hFlip ? 'is-active' : ''} disabled={!tileTransformFlagsAllowed(tileTransformCandidates.hFlip, terrainTileset.transformations)} onClick={() => setTileTransforms(tileTransformCandidates.hFlip)} title="Toggle the horizontal flag when the resulting transform is permitted"><FlipHorizontal2 size={13} /> Tile H</button>
          <button className={activeTileTransforms.vFlip ? 'is-active' : ''} disabled={!tileTransformFlagsAllowed(tileTransformCandidates.vFlip, terrainTileset.transformations)} onClick={() => setTileTransforms(tileTransformCandidates.vFlip)} title="Toggle the vertical flag when the resulting transform is permitted"><FlipVertical2 size={13} /> Tile V</button>
          <button className={activeTileTransforms.diagonal ? 'is-active' : ''} disabled={!tileTransformFlagsAllowed(tileTransformCandidates.diagonal, terrainTileset.transformations)} onClick={() => setTileTransforms(tileTransformCandidates.diagonal)} title="Toggle Tiled's diagonal-first flag when the resulting transform is permitted"><RotateCw size={13} /> Tile D</button>
          <button className={tileTransformPickerOpen ? 'is-active' : ''} aria-expanded={tileTransformPickerOpen} aria-controls="tile-transform-picker" onClick={() => setTileTransformPickerOpen((open) => !open)} title="Preview and choose all permitted tile transform combinations"><Grid3X3 size={13} /> Transforms</button>
        </>}
        {tilemap && tool !== 'terrain' && selectedVariantGroup && <div className="variant-seed-control" title={`${selectedVariantCount} weighted tiles in “${selectedVariantGroup}”`}><span>{selectedVariantGroup} · {selectedVariantCount}</span><label><span>Seed</span><input aria-label="Random tile variant seed" type="number" defaultValue={variantSeed} key={`${tilemap.id}:${variantSeed}`} onBlur={(event) => changeVariantSeed(Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(Number(event.target.value) || 0))), 'Change tile variant seed')} /></label><button type="button" onClick={() => changeVariantSeed(nextTileVariantSeed(variantSeed), 'Start new tile-variant stroke seed')} title="Persist a new deterministic seed for subsequent variant strokes; existing painted tiles do not change"><Dices size={11} /> New stroke</button></div>}
        {tool === 'stamp' && (sprite || tilemap) && <>
          {sprite ? <select aria-label="Active reusable stamp" value={activeStamp?.id ?? 'builtin-plus'} onChange={(event) => setActiveStampId(event.target.value === 'builtin-plus' ? undefined : event.target.value)} title="Reusable stamp library"><option value="builtin-plus">Built-in plus</option>{document.stamps.map((stamp) => <option key={stamp.id} value={stamp.id}>{stamp.name}</option>)}</select> : <select aria-label="Active reusable tile stamp" value={activeTileStamp?.id ?? 'builtin-tile'} onChange={(event) => setActiveTileStampId(event.target.value)} title="Reusable tile stamp library"><option value="builtin-tile">Current tile</option>{document.tileStamps.map((stamp) => <option key={stamp.id} value={stamp.id}>{stamp.name}</option>)}</select>}
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
          <button onClick={() => void copyLocalSelection()} title="Copy exact indexed selection (Ctrl+C)"><Copy size={13} /> Copy</button>
          <button onClick={() => void (async () => { if (await copyLocalSelection()) await deleteSelection(); })()} title="Cut exact indexed selection (Ctrl+X)"><Scissors size={13} /> Cut</button>
          <button onClick={() => void transformSelection('flip-horizontal')} title="Flip selected pixels horizontally"><FlipHorizontal2 size={13} /> H</button>
          <button onClick={() => void transformSelection('flip-vertical')} title="Flip selected pixels vertically"><FlipVertical2 size={13} /> V</button>
          <button onClick={() => void transformSelection('rotate-clockwise')} title="Rotate selected cells 90° clockwise"><RotateCw size={13} /> CW</button>
          <button onClick={() => void transformSelection('rotate-counterclockwise')} title="Rotate selected cells 90° counterclockwise"><RotateCcw size={13} /> CCW</button>
          <button onClick={() => setSelectionScaleOpen(true)} title="Scale selected cells by independent integer factors"><Scaling size={13} /> Scale</button>
          {sprite && <button onClick={() => { setGlyphMapperOpen(true); setGlyphSheetMapperOpen(false); }} title="Map selected nonzero indexed cells to a reusable bitmap-font character"><CaseUpper size={EDITOR_DENSITY.secondaryIcon} /> Glyph</button>}
          {sprite && <button onClick={() => { setGlyphSheetMapperOpen(true); setGlyphMapperOpen(false); }} title="Divide the indexed selection into uniform row-major bitmap-font glyph cells"><Table2 size={EDITOR_DENSITY.secondaryIcon} /> Glyph sheet</button>}
          <button onClick={() => void deleteSelection()} title="Delete selected pixels"><Trash2 size={13} /></button>
          <button onClick={() => { setSelection([]); setSelectionOffset(undefined); }} title="Clear selection">Clear</button>
        </>}
        {clipboardAvailable && <button onClick={() => void pasteLocalSelection()} title={tilemap ? 'Paste the project-local tile selection at the cursor (Ctrl+V)' : 'Paste the private indexed selection or standard PNG at the cursor (Ctrl+V)'}><ClipboardPaste size={13} /> Paste</button>}
        <span>{cursor ? `${cursor.x}, ${cursor.y}` : '—, —'}</span>
      </div>
      {tileTransformPickerOpen && tilemap && tool !== 'terrain' && terrainTileset?.type === 'tileset' && validAuthoringTileId !== undefined && <TileTransformPicker
        document={document}
        sprite={terrainSourceSprite}
        tileset={terrainTileset}
        tileId={validAuthoringTileId}
        value={activeTileTransforms}
        onChange={setTileTransforms}
        onClose={() => setTileTransformPickerOpen(false)}
      />}
      {symmetrySettingsOpen && sprite && <SpriteSymmetrySettingsPanel
        mode={symmetry.mode}
        horizontalAxis={symmetry.horizontalAxis}
        verticalAxis={symmetry.verticalAxis}
        width={sprite.width}
        height={sprite.height}
        source={symmetry.source}
        onModeChange={(mode) => setSpriteSymmetryPreferences(withSpriteSymmetryMode(symmetryPreferences, mode))}
        onAxesChange={saveSymmetryAxes}
        onClose={() => setSymmetrySettingsOpen(false)}
      />}
      {hasTimeline && sprite && (
        <section className="timeline" aria-label="Sprite animation timeline">
          <div className="timeline-playback">
            <button aria-label="Previous frame" onClick={() => setFrameId(sprite.frameIds[Math.max(0, sprite.frameIds.indexOf(activeFrameId ?? '') - 1)])}><ChevronLeft size={15} /></button>
            <button aria-label={playing ? 'Pause animation' : 'Play animation'} className="play-button" onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
            <button aria-label="Next frame" onClick={() => setFrameId(sprite.frameIds[Math.min(sprite.frameIds.length - 1, sprite.frameIds.indexOf(activeFrameId ?? '') + 1)])}><ChevronRight size={15} /></button>
            <button aria-label="Toggle ping-pong playback" aria-pressed={pingPong} className={pingPong ? 'is-active' : ''} title="Ping-pong playback" onClick={() => { setPingPong((value) => !value); setPlayDirection(1); }}><Repeat2 size={14} /></button>
          </div>
          <div className="timeline-label"><strong>Animation</strong><small>{sprite.frameIds.length} frames · {sprite.tags.length} tags</small><button onClick={() => openTagDialog()}>+ Tag</button></div>
          <div className="timeline-frame-actions">
            <button aria-label="Move active frame left" onClick={() => void moveFrame(-1)} disabled={sprite.frameIds.indexOf(activeFrameId ?? '') <= 0} title="Move active frame left"><ArrowLeft size={12} /></button>
            <button aria-label="Move active frame right" onClick={() => void moveFrame(1)} disabled={sprite.frameIds.indexOf(activeFrameId ?? '') >= sprite.frameIds.length - 1} title="Move active frame right"><ArrowRight size={12} /></button>
            <button aria-label="Duplicate active frame" onClick={() => void duplicateFrame()} title="Duplicate active frame"><Copy size={12} /></button>
            <button aria-label={activeFrameLinked ? 'Unlink active frame cels' : 'Link active frame cels to previous frame'} className={activeFrameLinked ? 'is-active' : ''} onClick={() => void toggleCelLink()} title={activeFrameLinked ? 'Unlink active frame cels' : 'Link active frame cels to previous frame'}>{activeFrameLinked ? <Unlink2 size={12} /> : <Link2 size={12} />}</button>
            <button aria-label="Toggle cel exposure grid" aria-expanded={exposureGridOpen} className={exposureGridOpen ? 'is-active' : ''} onClick={() => { setExposureGridOpen((open) => !open); setOnionSettingsOpen(false); }} title="Open layer-by-frame cel exposure grid"><Table2 size={12} /></button>
            <button aria-label={activePaletteOverride ? 'Use document palette' : 'Create per-frame palette override'} aria-pressed={Boolean(activePaletteOverride)} className={activePaletteOverride ? 'is-active' : ''} onClick={() => void togglePaletteOverride()} title={activePaletteOverride ? 'Use document palette' : 'Create per-frame palette override'}><Palette size={12} /></button>
            {activePaletteOverride?.[pixelIndex] && <input aria-label="Active frame palette color" type="color" value={activePaletteOverride[pixelIndex].color.slice(0, 7)} onChange={(event) => void changeOverrideColor(event.target.value)} />}
            <button aria-label="Delete active frame" onClick={() => void deleteFrame()} disabled={sprite.frameIds.length <= 1} title="Delete active frame"><Trash2 size={12} /></button>
          </div>
          {animationTagSpans.length > 0 && <AnimationTagStrip spans={animationTagSpans} activeFrameIndex={activeFrameIndex} selectedTagId={selectedTagId} onSelect={selectAnimationTag} onEdit={openTagDialog} />}
          <div className="frame-strip">
            {sprite.frameIds.map((id, index) => {
              const membership = animationTagMemberships[index];
              const membershipSummary = animationTagMembershipSummary(membership);
              return <button key={id} aria-label={`Frame ${index + 1}, ${sprite.frames[id]?.durationMs ?? 100} milliseconds. ${membershipSummary}`} aria-current={id === activeFrameId ? 'true' : undefined} className={id === activeFrameId ? 'is-active' : ''} onClick={() => setFrameId(id)} onDoubleClick={() => setDurationFrameId(id)} title={`${membershipSummary} Double-click to edit duration.`}><span className="frame-thumb"><Grid3X3 size={13} /></span><AnimationFrameTagMembership membership={membership} /><small>{index + 1}</small><em>{sprite.frames[id]?.durationMs ?? 100}ms</em></button>;
            })}
            <button aria-label="Add frame" className="add-frame" title="Add frame (Alt: linked cel)" onClick={(event) => void addFrame(event.altKey)}>+</button>
          </div>
        </section>
      )}
      {exposureGridOpen && sprite && activeFrameId && <CelExposureGrid key={`${sprite.id}:${sprite.revision}:${activeFrameId}:${selectedEntityId ?? ''}`} sprite={sprite} activeFrameId={activeFrameId} activeLayerId={selectedEntityId} onSelect={(nextFrameId, layerId) => { setFrameId(nextFrameId); setSelectedEntity(layerId); }} onToggleLink={(layerId, nextFrameId) => void toggleCelExposureLink(layerId, nextFrameId)} onClose={() => setExposureGridOpen(false)} />}
      {onionSettingsOpen && hasTimeline && sprite && <OnionSkinSettingsPanel settings={onionSettings} onChange={(settings) => setOnionSkinPreferences({ ...settings, enabled: onionSkin })} onClose={() => setOnionSettingsOpen(false)} />}
      {fontLibraryOpen && <BitmapFontLibraryDialog
        fonts={document.bitmapFonts}
        selectedFontId={selectedBitmapFontId}
        onSelectedFontChange={setBitmapFontId}
        onCreate={createBitmapFont}
        onDelete={removeBitmapFont}
        onRename={renameSelectedBitmapFont}
        onEditGlyph={editSelectedBitmapGlyph}
        onDeleteGlyph={removeSelectedBitmapGlyph}
        onClose={() => setFontLibraryOpen(false)}
      />}
      {glyphMapperOpen && sprite && <BitmapGlyphMapperDialog
        fonts={document.bitmapFonts}
        capture={selectedGlyphCapture.capture}
        captureError={selectedGlyphCapture.error}
        selectedFontId={selectedBitmapFontId}
        onSelectedFontChange={setBitmapFontId}
        onManageFonts={() => { setGlyphMapperOpen(false); setFontLibraryOpen(true); }}
        onSubmit={async ({ fontId, character, advance, lineHeight }) => {
          const font = document.bitmapFonts.find((entry) => entry.id === fontId);
          const capture = selectedGlyphCapture.capture;
          if (!font || !capture) return false;
          const mapped = upsertBitmapFontGlyph(font, character, { ...capture.glyph, advance }, lineHeight);
          const applied = await apply('Map bitmap font glyph', [{ kind: 'pixel.bitmap-fonts.replace', fonts: document.bitmapFonts.map((entry) => entry.id === fontId ? mapped : entry) }]);
          if (applied) { notify(`Mapped ${character} in ${font.name}. Use the Text tool to paint it as editable indexed pixels.`, 'success'); setGlyphMapperOpen(false); }
          return applied;
        }}
        onClose={() => setGlyphMapperOpen(false)}
      />}
      {glyphSheetMapperOpen && sprite && activeFrameId && <BitmapGlyphSheetMapperDialog
        fonts={document.bitmapFonts}
        points={selection}
        readIndex={compositePixelReader(sprite, activeFrameId)}
        selectedFontId={selectedBitmapFontId}
        onSelectedFontChange={setBitmapFontId}
        onManageFonts={() => { setGlyphSheetMapperOpen(false); setFontLibraryOpen(true); }}
        onSubmit={async ({ fontId, characters, columns, advance, lineHeight }) => {
          const font = document.bitmapFonts.find((entry) => entry.id === fontId);
          if (!font) return false;
          const mapping = mapBitmapFontGlyphSheet(font, selection, compositePixelReader(sprite, activeFrameId), characters, columns, advance, lineHeight);
          const applied = await apply('Map bitmap font glyph sheet', [{ kind: 'pixel.bitmap-fonts.replace', fonts: document.bitmapFonts.map((entry) => entry.id === fontId ? mapping.font : entry) }]);
          if (applied) {
            notify(`Mapped ${mapping.characterCount} glyphs in ${font.name}: ${mapping.newGlyphCount} new, ${mapping.replacedGlyphCount} replaced, ${mapping.blankGlyphCount} blank. Use the Text tool to paint them as editable indexed pixels.`, 'success');
            setGlyphSheetMapperOpen(false);
          }
          return applied;
        }}
        onClose={() => setGlyphSheetMapperOpen(false)}
      />}
      {bitmapTextPoint && sprite && <BitmapTextDialog fonts={document.bitmapFonts} selectedFontId={selectedBitmapFontId} origin={bitmapTextPoint} spriteSize={{ width: sprite.width, height: sprite.height }} paletteIndex={pixelIndex} wrap={wrapEditing} onSelectedFontChange={setBitmapFontId} onManageFonts={() => { setBitmapTextPoint(undefined); setFontLibraryOpen(true); }} onSubmit={addBitmapText} onFontsReplace={(fonts) => apply('Replace bitmap font library', [{ kind: 'pixel.bitmap-fonts.replace', fonts }])} onClose={() => setBitmapTextPoint(undefined)} />}
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
          const applied = await applyToActiveDocument(
            `Import reusable ${plan.kind} stamp library`,
            plan.operations,
            plan.expectedDocumentId,
            plan.expectedDocumentRevision,
          );
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
      {tagDraft && sprite && <EditorDialog title={tagDraft.id && tagDraftOrder >= 0 ? `Edit animation tag ${tagDraftOrder + 1} of ${sprite.tags.length}` : 'Add animation tag'} description={tagDraft.id ? 'Edit this exact independent tag; overlapping ranges and duplicate names remain separate.' : 'Name one independent exact frame range and choose how tagged playback traverses it.'} onClose={() => setTagDraftState(undefined)} className="animation-tag-dialog">
        <form onSubmit={(event) => { event.preventDefault(); if (!tagError) void addTag(); }}>
          <div className="entry-dialog-body tag-dialog-grid">
            <label className="dialog-field tag-name-field"><span>Name</span><input autoFocus maxLength={120} value={tagDraft.name} onChange={(event) => setTagDraftState({ documentId: document.id, spriteId: sprite.id, draft: { ...tagDraft, name: event.target.value } })} aria-invalid={!tagDraft.name.trim()} /></label>
            <label className="dialog-field"><span>Start frame</span><select value={tagDraft.fromFrameId} onChange={(event) => setTagDraftState({ documentId: document.id, spriteId: sprite.id, draft: { ...tagDraft, fromFrameId: event.target.value } })}>{sprite.frameIds.map((id, index) => <option key={id} value={id}>Frame {index + 1}</option>)}</select></label>
            <label className="dialog-field"><span>End frame</span><select value={tagDraft.toFrameId} onChange={(event) => setTagDraftState({ documentId: document.id, spriteId: sprite.id, draft: { ...tagDraft, toFrameId: event.target.value } })}>{sprite.frameIds.map((id, index) => <option key={id} value={id}>Frame {index + 1}</option>)}</select></label>
            <label className="dialog-field"><span>Direction</span><select value={tagDraft.direction} onChange={(event) => setTagDraftState({ documentId: document.id, spriteId: sprite.id, draft: { ...tagDraft, direction: event.target.value as TagDraft['direction'] } })}><option value="forward">Forward</option><option value="reverse">Reverse</option><option value="ping-pong">Ping-pong</option></select></label>
            <label className="dialog-field"><span>Label color</span><input type="color" value={tagDraft.color} onChange={(event) => setTagDraftState({ documentId: document.id, spriteId: sprite.id, draft: { ...tagDraft, color: event.target.value } })} /></label>
            <div className="entry-dialog-preview tag-range-preview"><strong>Tagged range</strong><span>{tagError ?? `${tagToIndex - tagFromIndex + 1} frames · ${tagDraft.direction}`}</span></div>
            {tagError && <p className="entry-dialog-error" role="alert">{tagError}</p>}
          </div>
          <footer className="modal-footer">{tagDraft.id && <button type="button" className="danger-modal-button" onClick={() => void deleteTag(tagDraft.id!)}>Delete tag</button>}<button type="button" className="secondary-modal-button" onClick={() => setTagDraftState(undefined)}>Cancel</button><button type="submit" className="primary-modal-button" disabled={Boolean(tagError)}>{tagDraft.id ? 'Save tag' : 'Add tag'}</button></footer>
        </form>
      </EditorDialog>}
    </div>
  );
}
