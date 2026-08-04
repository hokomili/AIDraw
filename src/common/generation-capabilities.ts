import type { AIDrawDocument } from '@aidraw/core';
import type { GenerationMode, GenerationProvider, GenerationRequest } from './generation';

export const GENERATION_PROVIDER_MODES: Record<GenerationProvider, readonly GenerationMode[]> = {
  openai: ['create', 'edit', 'inpaint', 'outpaint', 'variation'],
  stability: ['create', 'inpaint', 'outpaint'],
  comfyui: ['create', 'edit', 'inpaint', 'outpaint', 'variation'],
};

export function generationModeSupported(provider: GenerationProvider, mode: GenerationMode): boolean {
  return GENERATION_PROVIDER_MODES[provider].includes(mode);
}

export function generationRequestError(document: AIDrawDocument | undefined, request: GenerationRequest): string | undefined {
  if (!document || document.id !== request.documentId) return 'Target document is not open.';
  if (!generationModeSupported(request.provider, request.mode)) return `${request.provider === 'stability' ? 'Stability' : request.provider} does not support ${request.mode}; no request will be approximated.`;
  if (!request.prompt.trim()) return 'Prompt is required.';
  if (request.prompt.length > 32_000) return 'Prompt is limited to 32,000 characters.';
  if (!Number.isInteger(request.resultCount) || request.resultCount < 1 || request.resultCount > 4) return 'Result count must be an integer between 1 and 4.';
  if (request.seed !== undefined && !Number.isSafeInteger(request.seed)) return 'Seed must be a safe integer.';
  if (request.size !== 'auto' && (!Number.isInteger(request.size.width) || !Number.isInteger(request.size.height) || request.size.width < 1 || request.size.height < 1 || request.size.width > 8_192 || request.size.height > 8_192)) return 'Generation dimensions must be integer pixels from 1 to 8,192.';
  if (request.sourceAssetIds.length > 16 || new Set(request.sourceAssetIds).size !== request.sourceAssetIds.length) return 'Choose at most 16 unique source images.';
  if (request.mode === 'create' && request.sourceAssetIds.length) return 'Create mode does not consume source images; switch to an edit mode instead.';
  if (request.mode !== 'create' && request.sourceAssetIds.length === 0) return `${request.mode} requires a source image.`;
  if ((request.provider === 'stability' || request.provider === 'comfyui') && request.sourceAssetIds.length > 1) return `${request.provider === 'stability' ? 'Stability' : 'This ComfyUI workflow adapter'} accepts exactly one source image for ${request.mode}.`;
  for (const assetId of request.sourceAssetIds) { const asset = document.assets[assetId]; if (!asset?.data || !asset.mimeType.startsWith('image/')) return `Source asset ${assetId} is not an embedded image.`; }
  if (request.mode === 'inpaint' && !request.maskAssetId) return 'Inpaint requires a mask.';
  if (request.maskAssetId) { const mask = document.assets[request.maskAssetId]; if (!mask?.data || !mask.mimeType.startsWith('image/')) return `Mask asset ${request.maskAssetId} is not an embedded image.`; if (!['edit', 'inpaint', 'outpaint'].includes(request.mode)) return `${request.mode} does not consume a mask.`; }
  if (request.provider === 'openai' && request.negativePrompt) return 'OpenAI gpt-image-2 does not expose a separate negative-prompt field; remove it instead of silently approximating it.';
  if (request.provider === 'openai' && request.seed !== undefined) return 'OpenAI gpt-image-2 does not expose a deterministic seed; remove it instead of silently ignoring it.';
  if (request.provider === 'openai' && request.mode === 'outpaint') {
    if (request.sourceAssetIds.length !== 1) return 'OpenAI outpaint requires exactly one source image.';
    if (request.maskAssetId) return 'OpenAI outpaint creates its own transparent expansion mask; remove the explicit mask or use inpaint.';
    if (request.size === 'auto') return 'OpenAI outpaint requires an explicit output size so AIDraw can construct a same-size padded source and alpha mask.';
  }
  if (request.provider === 'stability') {
    if (request.seed !== undefined && (request.seed < 0 || request.seed + request.resultCount - 1 > 4_294_967_294)) return 'Stability seed range, including one increment per requested result, must stay between 0 and 4,294,967,294.';
    const stylePreset = request.providerOptions.stylePreset;
    if (stylePreset !== undefined && (typeof stylePreset !== 'string' || !stylePreset.trim())) return 'Stability style preset must be a non-empty string.';
    if (request.mode === 'outpaint') {
      if (request.maskAssetId) return 'Stability outpaint uses directional expansion values rather than a mask.';
      if (request.negativePrompt) return 'Stability outpaint does not expose a negative prompt; remove it instead of silently sending an unsupported field.';
      const directions = ['left', 'right', 'up', 'down'].map((name) => request.providerOptions[name]);
      if (directions.some((value) => value !== undefined && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2_000))) return 'Stability outpaint directions must be integer pixels from 0 to 2,000.';
      if (!directions.some((value) => Number(value) > 0)) return 'Stability outpaint requires at least one non-zero left, right, up, or down expansion.';
      const creativity = request.providerOptions.creativity;
      if (creativity !== undefined && (typeof creativity !== 'number' || !Number.isFinite(creativity) || creativity < 0 || creativity > 1)) return 'Stability outpaint creativity must be from 0 to 1.';
    }
  }
  if (request.provider === 'comfyui') {
    const endpoint = request.providerOptions.endpoint; if (endpoint !== undefined && (typeof endpoint !== 'string' || !/^https?:\/\/[^\s]+$/i.test(endpoint))) return 'ComfyUI endpoint must be an HTTP(S) URL.';
    const workflow = request.providerOptions.workflow; if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return 'Choose an API-format ComfyUI workflow.';
    const mappings = request.providerOptions.mappings;
    if (mappings !== undefined) {
      if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) return 'ComfyUI workflow mappings must be a node/input-name object.';
      const allowed = new Set(['promptNodeId', 'promptNodeIdInput', 'negativePromptNodeId', 'negativePromptNodeIdInput', 'sourceNodeId', 'sourceNodeIdInput', 'maskNodeId', 'maskNodeIdInput', 'seedNodeId', 'seedNodeIdInput', 'widthNodeId', 'widthNodeIdInput', 'heightNodeId', 'heightNodeIdInput', 'batchSizeNodeId', 'batchSizeNodeIdInput']);
      for (const [key, value] of Object.entries(mappings)) if (!allowed.has(key) || typeof value !== 'string' || !value.trim() || value.length > 200) return `ComfyUI workflow mapping ${key} is unsupported or invalid.`;
    }
  }
  return undefined;
}

export function validateGenerationRequest(document: AIDrawDocument | undefined, request: GenerationRequest): void {
  const error = generationRequestError(document, request); if (error) throw new Error(error);
}
