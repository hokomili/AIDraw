import type {
  Actor,
  DocumentAsset,
  Id,
  IllustrationLayer,
  IllustrationObject,
  LinkedAsset,
  PaletteEntry,
  PixelCel,
  PixelFrame,
  PixelAsset,
  PixelDocument,
  Provenance,
  RasterStroke,
} from './model';

export type CanvasOperation =
  | { kind: 'document.rename'; name: string }
  | { kind: 'illustration.layer.add'; layer: IllustrationLayer; index?: number }
  | { kind: 'illustration.layer.replace'; layer: IllustrationLayer; expectedRevision?: number }
  | { kind: 'illustration.layer.move'; layerId: Id; parentId?: Id; index?: number; expectedRevision?: number }
  | { kind: 'illustration.layer.delete'; layerId: Id; expectedRevision?: number }
  | { kind: 'illustration.object.add'; object: IllustrationObject; index?: number; parentGroupId?: Id; groupIndex?: number }
  | { kind: 'illustration.object.replace'; object: IllustrationObject; expectedRevision?: number }
  | { kind: 'illustration.object.move'; objectId: Id; layerId: Id; index?: number; parentGroupId?: Id; groupIndex?: number; expectedRevision?: number }
  | { kind: 'illustration.object.delete'; objectId: Id; expectedRevision?: number }
  | { kind: 'illustration.paint.stroke'; layerId: Id; stroke: RasterStroke; expectedRevision?: number }
  | { kind: 'asset.add'; asset: DocumentAsset }
  | { kind: 'asset.delete'; assetId: Id }
  | { kind: 'provenance.add'; provenance: Provenance }
  | { kind: 'provenance.delete'; provenanceId: Id }
  | { kind: 'pixel.palette.replace'; palette: PaletteEntry[] }
  | { kind: 'pixel.conversion.replace'; conversionDefaults: PixelDocument['conversionDefaults'] }
  | { kind: 'pixel.links.replace'; linkedAssets: LinkedAsset[] }
  | { kind: 'pixel.active-asset.set'; assetId: Id }
  | { kind: 'pixel.frame.add'; spriteId: Id; frame: PixelFrame; cels: PixelCel[]; index?: number; expectedRevision?: number }
  | { kind: 'pixel.frame.replace'; spriteId: Id; frame: PixelFrame; expectedRevision?: number }
  | { kind: 'pixel.frame.delete'; spriteId: Id; frameId: Id; expectedRevision?: number }
  | { kind: 'pixel.asset.add'; asset: PixelAsset; index?: number }
  | { kind: 'pixel.asset.replace'; asset: PixelAsset; expectedRevision?: number }
  | { kind: 'pixel.asset.delete'; assetId: Id; expectedRevision?: number }
  | {
      kind: 'pixel.cel.set';
      spriteId: Id;
      celId: Id;
      changes: Array<{ x: number; y: number; index: number }>;
      expectedRevision?: number;
    }
  | {
      kind: 'pixel.tilemap.set';
      mapId: Id;
      layerId: Id;
      changes: Array<{ x: number; y: number; gid: number }>;
      expectedRevision?: number;
    };

export interface CanvasTransaction {
  id: Id;
  clientOperationId: string;
  documentId: Id;
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
