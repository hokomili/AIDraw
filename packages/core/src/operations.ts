import type {
  Actor,
  DocumentAsset,
  Id,
  IllustrationDocument,
  IllustrationLayer,
  IllustrationObject,
  LinkedAsset,
  PaletteEntry,
  PixelCel,
  PixelFrame,
  PixelAsset,
  PixelDocument,
  PaletteCycle,
  PixelStamp,
  TileStamp,
  Provenance,
  RasterStroke,
  RasterBrushPreset,
  BitmapFont,
  IllustrationGuide,
  IllustrationKeyframe,
  IllustrationSnapSettings,
} from './model';

export interface PixelIndexRun {
  x: number;
  y: number;
  length: number;
  index: number;
}

export interface TileGidRun {
  x: number;
  y: number;
  length: number;
  gid: number;
}

export interface PixelSpriteDependencyGuard {
  spriteId: Id;
  expectedRevision: number;
  width: number;
  height: number;
}

export type CanvasOperation =
  | { kind: 'document.rename'; name: string }
  | { kind: 'illustration.artboard.replace'; artboard: IllustrationDocument['artboard']; expectedRevision?: number }
  | { kind: 'illustration.artboard.translate'; artboard: IllustrationDocument['artboard']; offsetX: number; offsetY: number; expectedRevision?: number }
  | { kind: 'illustration.layer.add'; layer: IllustrationLayer; index?: number }
  | { kind: 'illustration.layer.replace'; layer: IllustrationLayer; expectedRevision?: number }
  | { kind: 'illustration.layer.move'; layerId: Id; parentId?: Id; index?: number; expectedRevision?: number }
  | { kind: 'illustration.layer.delete'; layerId: Id; expectedRevision?: number }
  | { kind: 'illustration.object.add'; object: IllustrationObject; index?: number; parentGroupId?: Id; groupIndex?: number }
  | { kind: 'illustration.object.replace'; object: IllustrationObject; expectedRevision?: number }
  | { kind: 'illustration.object.move'; objectId: Id; layerId: Id; index?: number; parentGroupId?: Id; groupIndex?: number; expectedRevision?: number }
  | { kind: 'illustration.object.delete'; objectId: Id; expectedRevision?: number }
  | { kind: 'illustration.paint.stroke'; layerId: Id; stroke: RasterStroke; expectedRevision?: number }
  | { kind: 'illustration.brush-presets.replace'; presets: RasterBrushPreset[] }
  | { kind: 'illustration.guides.replace'; guides: IllustrationGuide[]; expectedRevision?: number }
  | { kind: 'illustration.snap-settings.replace'; settings: IllustrationSnapSettings; expectedRevision?: number }
  | { kind: 'illustration.animation.settings.replace'; settings: Pick<IllustrationDocument['animation'], 'durationMs' | 'framesPerSecond' | 'playback'>; expectedRevision?: number }
  | { kind: 'illustration.animation.keyframe.upsert'; keyframe: IllustrationKeyframe; index?: number; expectedRevision?: number }
  | { kind: 'illustration.animation.keyframe.delete'; keyframeId: Id; expectedRevision?: number }
  | { kind: 'asset.add'; asset: DocumentAsset }
  | { kind: 'asset.delete'; assetId: Id }
  | { kind: 'provenance.add'; provenance: Provenance; index?: number }
  | { kind: 'provenance.delete'; provenanceId: Id }
  | { kind: 'pixel.palette.replace'; palette: PaletteEntry[] }
  | { kind: 'pixel.palette.reorder'; entryIds: Id[]; expectedRevision?: number }
  | { kind: 'pixel.palette-cycles.replace'; cycles: PaletteCycle[] }
  | { kind: 'pixel.stamps.replace'; stamps: PixelStamp[] }
  | { kind: 'pixel.tile-stamps.replace'; stamps: TileStamp[] }
  | { kind: 'pixel.bitmap-fonts.replace'; fonts: BitmapFont[] }
  | { kind: 'pixel.conversion.replace'; conversionDefaults: PixelDocument['conversionDefaults'] }
  | { kind: 'pixel.links.replace'; linkedAssets: LinkedAsset[]; expectedRevision?: number }
  | { kind: 'pixel.active-asset.set'; assetId: Id }
  | { kind: 'pixel.frame.add'; spriteId: Id; frame: PixelFrame; cels: PixelCel[]; index?: number; expectedRevision?: number }
  | { kind: 'pixel.frame.replace'; spriteId: Id; frame: PixelFrame; expectedRevision?: number }
  | { kind: 'pixel.frame.delete'; spriteId: Id; frameId: Id; expectedRevision?: number }
  | { kind: 'pixel.asset.add'; asset: PixelAsset; index?: number }
  | { kind: 'pixel.asset.replace'; asset: PixelAsset; expectedRevision?: number; expectedSpriteDependencies?: PixelSpriteDependencyGuard[] }
  | { kind: 'pixel.asset.delete'; assetId: Id; expectedRevision?: number }
  | {
      kind: 'pixel.cel.set';
      spriteId: Id;
      celId: Id;
      changes: Array<{ x: number; y: number; index: number }>;
      expectedRevision?: number;
    }
  | {
      kind: 'pixel.cel.region';
      spriteId: Id;
      celId: Id;
      runs: PixelIndexRun[];
      expectedRevision?: number;
      conversion?: {
        sourceAssetId: Id;
        resample: 'area';
        paletteMetric: 'oklab';
        dithering: 'none' | 'bayer-4x4' | 'floyd-steinberg';
        alphaThreshold: number;
        width: number;
        height: number;
      };
    }
  | {
      kind: 'pixel.tilemap.set';
      mapId: Id;
      layerId: Id;
      changes: Array<{ x: number; y: number; gid: number }>;
      expectedRevision?: number;
    }
  | {
      kind: 'pixel.tilemap.region';
      mapId: Id;
      layerId: Id;
      runs: TileGidRun[];
      expectedRevision?: number;
    };

export interface CanvasTransaction {
  id: Id;
  clientOperationId: string;
  documentId: Id;
  expectedDocumentRevision?: number;
  actor: Actor;
  label: string;
  createdAt: string;
  operations: CanvasOperation[];
  playback?: {
    mode: 'animated' | 'instant';
    speed: number;
  };
}

export interface TransactionConflict {
  operationIndex: number;
  entityId?: Id;
  expectedRevision?: number;
  actualRevision?: number;
  message: string;
  retryable: boolean;
}

export class TransactionConflictError extends Error {
  constructor(public readonly conflict: TransactionConflict) {
    super(conflict.message);
    this.name = 'TransactionConflictError';
  }
}
