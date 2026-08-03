import type { Id } from '@aidraw/core';

export type GenerationProvider = 'openai' | 'stability' | 'comfyui';
export type GenerationMode = 'create' | 'edit' | 'inpaint' | 'outpaint' | 'variation';

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

export interface GenerationJobResult {
  request: GenerationRequest;
  outputs: GeneratedOutput[];
}
