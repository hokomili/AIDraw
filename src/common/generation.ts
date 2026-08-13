import type { Id } from '@aidraw/core';

export type GenerationProvider = 'openai' | 'stability' | 'comfyui';
export type GenerationMode = 'create' | 'edit' | 'inpaint' | 'outpaint' | 'variation';

export const MAX_PROVIDER_CREDENTIAL_BYTES = 16 * 1024;

export interface GenerationProviderCredentialStatus {
  /** True only when the provider can use a stored credential now. */
  configured: boolean;
  /** Whether encrypted material exists, even if the OS backend is unavailable. */
  stored: boolean;
  /** Whether the operating-system credential backend can encrypt/decrypt now. */
  available: boolean;
  reason?: string;
}

export type GenerationProviderStatus = Record<GenerationProvider, GenerationProviderCredentialStatus>;

export interface GenerationRequest {
  documentId: Id;
  provider: GenerationProvider;
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  sourceAssetIds: Id[];
  maskAssetId?: Id;
  size: { width: number; height: number } | 'auto';
  aspectIntent?: 'canvas' | 'square' | 'portrait' | 'landscape';
  resultCount: number;
  seed?: number;
  providerOptions: Record<string, unknown>;
}
export interface GeneratedOutput {
  id: Id;
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg';
  data: string;
  width: number;
  height: number;
  seed?: number;
  providerMetadata?: Record<string, unknown>;
}

/** Fixed descending acceptance ladder; the first same-geometry encoding within policy wins. */
export const GENERATION_ACCEPTANCE_WEBP_QUALITIES = [100, 95, 90, 85, 80, 75, 70, 60, 50, 40, 30, 20, 10, 5, 1, 0] as const;

export interface GenerationAcceptanceNormalization {
  method: 'png-reencode' | 'webp-quality';
  sourceOutputId: Id;
  sourceMimeType: GeneratedOutput['mimeType'];
  acceptedMimeType: GeneratedOutput['mimeType'];
  sourceByteLength: number;
  acceptedByteLength: number;
  sourceSha256: string;
  acceptedSha256: string;
  width: number;
  height: number;
  /** Integer WebP quality from the fixed acceptance ladder; absent for lossless PNG re-encoding. */
  quality?: number;
}

export type GeneratedAcceptancePreparation =
  | {
      status: 'ready';
      mimeType: GeneratedOutput['mimeType'];
      data: string;
      width: number;
      height: number;
      normalization?: GenerationAcceptanceNormalization;
    }
  | {
      status: 'preview-only';
      reason: 'inline-geometry-limit' | 'encoded-byte-limit';
      message: string;
      guidance: string;
    };

export interface GenerationAcceptanceResult {
  accepted: boolean;
  message?: string;
  previewOnly?: boolean;
  normalization?: GenerationAcceptanceNormalization;
}

export interface GenerationJobResult {
  request: GenerationRequest;
  outputs: GeneratedOutput[];
  /** Frozen source/canvas preview captured before the paid request starts. */
  comparisonSource?: GeneratedOutput;
  acceptedOutputId?: Id;
  /** Describes an accepted derivative without changing the retained provider output. */
  acceptedNormalization?: GenerationAcceptanceNormalization;
}
