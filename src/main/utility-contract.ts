import type { AIDrawDocument, PaletteEntry } from '@aidraw/core';
import type { ExportFormat, ExportOptions } from '../common/contracts';
import type { QuantizeImageOptions } from './quantize-image';
import type { SpriteSheetSliceOptions } from '../common/sprite-sheet';
import type { ObservationRequest } from './capture-observation';
import type { GeneratedOutput, GenerationRequest } from '../common/generation';

export interface QuantizeUtilityRequest {
  id: string;
  kind: 'quantize-image';
  encodedBase64: string;
  width: number;
  height: number;
  palette: PaletteEntry[];
  options: QuantizeImageOptions;
}

export interface ExportUtilityRequest {
  id: string;
  kind: 'export-document';
  document: AIDrawDocument;
  format: ExportFormat;
  options: ExportOptions;
}

export interface ImportUtilityRequest {
  id: string;
  kind: 'import-document';
  filePath: string;
  pixelMode: boolean;
  spriteSheet?: {
    options: SpriteSheetSliceOptions;
    name: string;
    mimeType: string;
    expectedSha256: string;
  };
}

export interface ObservationUtilityRequest {
  id: string;
  kind: 'capture-observation';
  document: AIDrawDocument;
  request: ObservationRequest;
  maxPixels: number;
}

export interface GenerationUtilityRequest {
  id: string;
  kind: 'generation-run';
  jobId: string;
  document: AIDrawDocument;
  request: GenerationRequest;
  credential?: string;
}

export interface UtilityCancelRequest {
  id: string;
  kind: 'utility-cancel';
}

export interface SerializedExportArtifact {
  dataBase64: string;
  mimeType: string;
  extension: string;
  report: { warnings: string[]; rasterized: string[] };
  companion?: { dataBase64: string; extension: string; mimeType: string; name?: string };
  companions?: Array<{ dataBase64: string; extension: string; mimeType: string; name: string }>;
}

export type UtilityRequest = QuantizeUtilityRequest | ExportUtilityRequest | ImportUtilityRequest | ObservationUtilityRequest | GenerationUtilityRequest;

export type UtilityResponse =
  | { id: string; ok: true; kind: 'quantize-image'; changes: Array<{ x: number; y: number; index: number }> }
  | { id: string; ok: true; kind: 'export-document'; artifact: SerializedExportArtifact }
  | { id: string; ok: true; kind: 'import-document'; documents: AIDrawDocument[]; warnings: string[] }
  | { id: string; ok: true; kind: 'capture-observation'; result: Record<string, unknown> }
  | { id: string; ok: true; kind: 'generation-run'; outputs: GeneratedOutput[] }
  | { id: string; ok: true; kind: 'generation-progress'; progress: number; message: string }
  | { id: string; ok: false; error: { code: string; message: string } };
