export type Id = string;

export type ActorKind = 'human' | 'agent' | 'system';

export interface Actor {
  id: Id;
  kind: ActorKind;
  name: string;
  color: string;
  client?: {
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    taskId?: string;
  };
}

export interface EntityBase {
  id: Id;
  revision: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Id;
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion';

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
}

export interface PointSample {
  x: number;
  y: number;
  pressure: number;
  time?: number;
}

export interface ColorStop {
  offset: number;
  color: string;
  opacity?: number;
}

export type PaintStyle =
  | { kind: 'none' }
  | { kind: 'solid'; color: string }
  | {
      kind: 'linear-gradient' | 'radial-gradient';
      stops: ColorStop[];
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

export interface StrokeStyle {
  paint: PaintStyle;
  width: number;
  opacity: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  dash: number[];
}

export interface ObjectBase extends EntityBase {
  layerId: Id;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  transform: Transform;
  /** Non-destructive Gaussian blur applied to the rendered object in pixels. */
  blur?: number;
  /** Ordered non-destructive color and blur adjustments applied after the object's own paint. */
  filters?: ImageFilter[];
  maskObjectId?: Id;
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
}

export interface VectorStrokeObject extends ObjectBase {
  type: 'vector-stroke';
  points: PointSample[];
  brush: {
    size: number;
    thinning: number;
    smoothing: number;
    streamline: number;
    simulatePressure: boolean;
    color: string;
  };
  pathData?: string;
}

export interface PathObject extends ObjectBase {
  type: 'path';
  pathData: string;
  closed: boolean;
  fill: PaintStyle;
  stroke: StrokeStyle;
  fillRule: 'nonzero' | 'evenodd';
}

export interface ShapeObject extends ObjectBase {
  type: 'shape';
  shape: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'star';
  width: number;
  height: number;
  sides?: number;
  innerRadius?: number;
  fill: PaintStyle;
  stroke: StrokeStyle;
  cornerRadius?: number;
}

export interface TextStyleRange {
  start: number;
  end: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  color: string;
  letterSpacing: number;
  underline?: boolean;
}

export interface TextObject extends ObjectBase {
  type: 'text';
  text: string;
  width: number;
  height: number;
  align: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;
  ranges: TextStyleRange[];
}

export interface ImageFilter {
  type: 'brightness' | 'contrast' | 'saturation' | 'hue' | 'blur';
  value: number;
}

export interface ImageObject extends ObjectBase {
  type: 'image';
  assetId: Id;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
  crop?: { x: number; y: number; width: number; height: number };
  filters: ImageFilter[];
}

export interface GroupObject extends ObjectBase {
  type: 'group';
  childIds: Id[];
}

export type IllustrationObject =
  | VectorStrokeObject
  | PathObject
  | ShapeObject
  | TextObject
  | ImageObject
  | GroupObject;

export interface RasterStroke {
  id: Id;
  actorId: Id;
  points: PointSample[];
  color: string;
  size: number;
  opacity: number;
  hardness: number;
  flow: number;
  mode: 'paint' | 'erase';
  preset: 'hard-round' | 'soft-round' | 'pencil' | 'marker' | 'airbrush' | 'eraser' | 'watercolor' | 'custom';
  brushPresetId?: Id;
  dynamics?: RasterBrushDynamics;
}

export type RasterBrushTip = 'round' | 'flat' | 'chalk' | 'watercolor';

export interface RasterBrushDynamics {
  tip: RasterBrushTip;
  spacing: number;
  stabilization: number;
  scatter: number;
  sizeJitter: number;
  opacityJitter: number;
  angle: number;
  roundness: number;
  wetness: number;
  granulation: number;
  seed: number;
}

export interface RasterBrushPreset {
  id: Id;
  name: string;
  size: number;
  opacity: number;
  hardness: number;
  flow: number;
  dynamics: Omit<RasterBrushDynamics, 'seed'>;
}

export interface LayerBase extends EntityBase {
  parentId?: Id;
  /** Import-authored semantic retained for a compatible interchange re-export. */
  interchangeRole?: 'pdf-extracted-text';
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  maskLayerId?: Id;
  /** Ordered adjustments applied to the isolated layer or layer-group composite. */
  filters?: ImageFilter[];
}

export interface GroupLayer extends LayerBase {
  type: 'group';
  childIds: Id[];
}

export interface VectorLayer extends LayerBase {
  type: 'vector';
  objectIds: Id[];
}

export interface PaintLayer extends LayerBase {
  type: 'paint';
  tileSize: 256;
  tileAssetIds: Record<string, Id>;
  /** Derived sparse-raster cache. Editable strokes remain the source of truth. */
  tileCache?: {
    version: 1;
    strokeCount: number;
    strokesSha256: string;
  };
  strokes: RasterStroke[];
}

export type IllustrationLayer = GroupLayer | VectorLayer | PaintLayer;

export interface Artboard {
  width: number;
  height: number;
  background: string | null;
  colorSpace: 'srgb';
  dpi: number;
}

export interface IllustrationGuide {
  id: Id;
  orientation: 'horizontal' | 'vertical';
  position: number;
  color: string;
  locked: boolean;
}

export interface IllustrationSnapSettings {
  artboard: boolean;
  objects: boolean;
  guides: boolean;
  grid: boolean;
  pixel: boolean;
  gridSize: number;
  tolerance: number;
}

export type IllustrationAnimationPlayback = 'once' | 'loop' | 'ping-pong';
export type IllustrationKeyframeEasing = 'linear' | 'hold' | 'ease-in-out';

/**
 * A durable object pose on the illustration timeline. Keyframes intentionally
 * store a complete pose so headless clients and the renderer resolve the same
 * result without depending on transient editor state.
 */
export interface IllustrationKeyframe extends EntityBase {
  objectId: Id;
  timeMs: number;
  transform: Transform;
  opacity: number;
  visible: boolean;
  easing: IllustrationKeyframeEasing;
}

export interface IllustrationAnimation {
  durationMs: number;
  framesPerSecond: number;
  playback: IllustrationAnimationPlayback;
  keyframeIds: Id[];
  keyframes: Record<Id, IllustrationKeyframe>;
}

export interface PaletteEntry {
  id: Id;
  name: string;
  color: string;
}

export interface PaletteCycle {
  id: Id;
  name: string;
  fromIndex: number;
  toIndex: number;
  direction: 'forward' | 'reverse';
  stepMs: number;
}

export interface PixelStampCell {
  x: number;
  y: number;
  index: number;
}

export interface PixelStamp {
  id: Id;
  name: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  cells: PixelStampCell[];
}

export interface TileStampCell {
  x: number;
  y: number;
  gid: number;
}

export interface TileStamp {
  id: Id;
  name: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  cells: TileStampCell[];
}

export interface BitmapGlyph {
  width: number;
  advance: number;
  rows: string[];
}

export interface BitmapFont {
  id: Id;
  name: string;
  lineHeight: number;
  glyphs: Record<string, BitmapGlyph>;
}

export interface PixelChunk {
  x: number;
  y: number;
  width: 32;
  height: 32;
  data: string;
}

export interface PixelLayer extends EntityBase {
  type: 'pixel' | 'group';
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  parentId?: Id;
  childIds?: Id[];
}

export interface PixelFrame extends EntityBase {
  durationMs: number;
}

export interface PixelCel extends EntityBase {
  layerId: Id;
  frameId: Id;
  chunks: Record<string, PixelChunk>;
  linkedToCelId?: Id;
}

export interface AnimationTag {
  id: Id;
  name: string;
  fromFrameId: Id;
  toFrameId: Id;
  direction: 'forward' | 'reverse' | 'ping-pong';
  color: string;
}

export interface PixelSprite extends EntityBase {
  type: 'sprite';
  width: number;
  height: number;
  layerIds: Id[];
  layers: Record<Id, PixelLayer>;
  frameIds: Id[];
  frames: Record<Id, PixelFrame>;
  cels: Record<Id, PixelCel>;
  tags: AnimationTag[];
  paletteOverrides: Record<Id, PaletteEntry[]>;
}

export interface CollisionShape {
  id: Id;
  type: 'rectangle' | 'ellipse' | 'polygon' | 'polyline';
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: Array<{ x: number; y: number }>;
  properties: Record<string, string | number | boolean>;
}

export interface TileDefinition {
  id: number;
  sourceX: number;
  sourceY: number;
  probability: number;
  animation: Array<{ tileId: number; durationMs: number }>;
  collisions: CollisionShape[];
  properties: Record<string, string | number | boolean>;
}

export interface WangColor {
  id: number;
  name: string;
  color: string;
  tileId: number;
  probability: number;
}

export interface WangTile {
  tileId: number;
  wangId: [number, number, number, number, number, number, number, number];
}

export interface WangSet {
  id: Id;
  name: string;
  type: 'corner' | 'edge' | 'mixed';
  colors: WangColor[];
  tiles: WangTile[];
}

export interface PixelTileset extends EntityBase {
  type: 'tileset';
  /** The global ID assigned by a containing Tiled map. Standalone tilesets default to 1. */
  firstGid: number;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  /** Tiled-compatible drawing translation in map-axis pixels. Positive Y points down. */
  tileOffset: {
    x: number;
    y: number;
  };
  columns: number;
  rows: number;
  spriteAssetId: Id;
  tiles: Record<number, TileDefinition>;
  wangSets: WangSet[];
  transformations: {
    hFlip: boolean;
    vFlip: boolean;
    rotate: boolean;
  };
}

export interface TilemapChunk {
  x: number;
  y: number;
  width: 32;
  height: 32;
  data: string;
}

export interface TilemapLayer extends EntityBase {
  type: 'tile' | 'object' | 'group';
  visible: boolean;
  locked: boolean;
  opacity: number;
  parentId?: Id;
  childIds?: Id[];
  chunks?: Record<string, TilemapChunk>;
  objects?: CollisionShape[];
  parallaxX: number;
  parallaxY: number;
}

export interface PixelTilemap extends EntityBase {
  type: 'tilemap';
  orientation: 'orthogonal' | 'isometric';
  infinite: boolean;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tilesetIds: Id[];
  layerIds: Id[];
  layers: Record<Id, TilemapLayer>;
  properties: Record<string, string | number | boolean>;
}

export type PixelAsset = PixelSprite | PixelTileset | PixelTilemap;

export interface LinkedAsset {
  id: Id;
  name: string;
  mode: 'embedded' | 'linked';
  relativePath?: string;
  sha256?: string;
  cachedPreviewAssetId?: Id;
}

export interface DocumentAsset {
  id: Id;
  name: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  source: 'imported' | 'generated' | 'embedded' | 'rendered';
  data?: string;
}

export interface Provenance {
  id: Id;
  assetId: Id;
  provider: 'openai' | 'stability' | 'comfyui' | 'external';
  modelOrWorkflow: string;
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  sourceAssetIds: Id[];
  maskAssetId?: Id;
  createdAt: string;
  conversion?: Record<string, unknown>;
}

export interface ActivityEntry {
  id: Id;
  transactionId: Id;
  actor: Actor;
  label: string;
  timestamp: string;
  status: 'committed' | 'partial' | 'undone' | 'failed' | 'cancelled';
  operationCount: number;
  details?: string;
}

export interface DocumentBase {
  schemaVersion: 2;
  id: Id;
  revision: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
  dirty: boolean;
  assets: Record<Id, DocumentAsset>;
  activity: ActivityEntry[];
  provenance: Provenance[];
}

export interface IllustrationDocument extends DocumentBase {
  kind: 'illustration';
  artboard: Artboard;
  layerIds: Id[];
  layers: Record<Id, IllustrationLayer>;
  objects: Record<Id, IllustrationObject>;
  brushPresets: RasterBrushPreset[];
  guides: IllustrationGuide[];
  snapSettings: IllustrationSnapSettings;
  animation: IllustrationAnimation;
}

export interface PixelDocument extends DocumentBase {
  kind: 'pixel';
  scope: 'standalone' | 'project';
  standaloneType?: 'sprite' | 'tilemap';
  palette: PaletteEntry[];
  paletteCycles: PaletteCycle[];
  stamps: PixelStamp[];
  tileStamps: TileStamp[];
  bitmapFonts: BitmapFont[];
  assetIds: Id[];
  pixelAssets: Record<Id, PixelAsset>;
  activeAssetId: Id;
  linkedAssets: LinkedAsset[];
  conversionDefaults: {
    resample: 'area';
    paletteMetric: 'oklab';
    dithering: 'none' | 'bayer-4x4' | 'floyd-steinberg';
    alphaThreshold: number;
  };
}

export type AIDrawDocument = IllustrationDocument | PixelDocument;

export type JobKind = 'playback' | 'approval' | 'generation' | 'import' | 'export' | 'save' | 'batch';
export type JobStatus =
  | 'queued'
  | 'waiting-for-user'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AsyncJob<T = unknown> {
  id: Id;
  kind: JobKind;
  status: JobStatus;
  actor: Actor;
  createdAt: string;
  updatedAt: string;
  progress: number;
  message: string;
  result?: T;
  error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
  approval?: {
    title: string;
    description: string;
    expiresAt: string;
    options: Array<'allow-once' | 'allow-session' | 'allow-always' | 'deny'>;
    review?: {
      action: string;
      target?: string;
      trustFolder?: string;
      overwritePaths?: string[];
      fields: Array<{ label: string; value: string; tone?: 'default' | 'warning' | 'paid' }>;
      previews?: Array<{
        role: 'source' | 'mask';
        assetId: Id;
        name: string;
        mimeType: string;
        width: number;
        height: number;
        dataUrl: string;
      }>;
    };
  };
}

export const HUMAN_ACTOR: Actor = {
  id: 'human',
  kind: 'human',
  name: 'You',
  color: '#ff5d8f',
};

export const IDENTITY_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  skewX: 0,
  skewY: 0,
};
