import { describe, expect, it } from 'vitest';
import { createPixelDocument } from '@aidraw/core';
import { GENERATION_PROVIDER_MODES, generationRequestError, validateGenerationRequest } from '../../src/common/generation-capabilities';
import type { GenerationRequest } from '../../src/common/generation';

describe('generation provider capabilities', () => {
  const document = createPixelDocument('sprite');
  const request = (override: Partial<GenerationRequest> = {}): GenerationRequest => ({ documentId: document.id, provider: 'openai', mode: 'create', prompt: 'A tiny castle', sourceAssetIds: [], size: 'auto', resultCount: 1, providerOptions: {}, ...override });

  it('rejects unsupported or silently ignored provider inputs before a paid request', () => {
    expect(GENERATION_PROVIDER_MODES.stability).toEqual(['create', 'inpaint', 'outpaint']);
    expect(generationRequestError(document, request({ provider: 'stability', mode: 'variation', sourceAssetIds: ['missing'] }))).toMatch(/does not support variation/);
    expect(generationRequestError(document, request({ sourceAssetIds: ['ignored'] }))).toMatch(/does not consume source/);
    expect(generationRequestError(document, request({ negativePrompt: 'blur' }))).toMatch(/does not expose/);
    expect(generationRequestError(document, request({ provider: 'comfyui', providerOptions: { endpoint: 'file:///bad', workflow: {} } }))).toMatch(/HTTP/);
  });

  it('validates embedded sources, masks, counts, and dimensions', () => {
    const asset = { id: 'source', name: 'Source', mimeType: 'image/png', byteLength: 1, sha256: '0'.repeat(64), source: 'embedded' as const, data: 'AA==' }; document.assets[asset.id] = asset;
    expect(() => validateGenerationRequest(document, request({ mode: 'edit', sourceAssetIds: [asset.id] }))).not.toThrow();
    expect(generationRequestError(document, request({ mode: 'inpaint', sourceAssetIds: [asset.id] }))).toBe('Inpaint requires a mask.');
    expect(generationRequestError(document, request({ mode: 'edit', sourceAssetIds: ['missing'] }))).toMatch(/not an embedded image/);
    expect(generationRequestError(document, request({ resultCount: 1.5 }))).toMatch(/integer/);
    expect(generationRequestError(document, request({ size: { width: 0, height: 1024 } }))).toMatch(/1 to 8,192/);
  });

  it('validates provider-specific seeds and Stability outpaint parameters instead of ignoring them', () => {
    const asset = { id: 'outpaint-source', name: 'Source', mimeType: 'image/png', byteLength: 1, sha256: '1'.repeat(64), source: 'embedded' as const, data: 'AA==' }; document.assets[asset.id] = asset;
    expect(generationRequestError(document, request({ seed: 7 }))).toMatch(/does not expose a deterministic seed/);
    const base = request({ provider: 'stability', mode: 'outpaint', sourceAssetIds: [asset.id], providerOptions: {} });
    expect(generationRequestError(document, base)).toMatch(/at least one non-zero/);
    expect(generationRequestError(document, { ...base, providerOptions: { left: 2_001 } })).toMatch(/0 to 2,000/);
    expect(generationRequestError(document, { ...base, providerOptions: { left: 32, creativity: 1.1 } })).toMatch(/creativity/);
    expect(generationRequestError(document, { ...base, providerOptions: { left: 32, creativity: 0.5 } })).toBeUndefined();
  });

  it('requires enough geometry to construct a real OpenAI outpaint request', () => {
    const source = document.assets['outpaint-source'];
    expect(generationRequestError(document, request({ mode: 'outpaint', sourceAssetIds: [source.id] }))).toMatch(/explicit output size/);
    expect(generationRequestError(document, request({ mode: 'outpaint', sourceAssetIds: [source.id], size: { width: 1024, height: 1024 } }))).toBeUndefined();
    expect(generationRequestError(document, request({ mode: 'outpaint', sourceAssetIds: [source.id], maskAssetId: source.id, size: { width: 1024, height: 1024 } }))).toMatch(/creates its own transparent expansion mask/);
  });

  it('accepts only bounded known ComfyUI node/input mappings', () => {
    const base = request({ provider: 'comfyui', providerOptions: { workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }, endpoint: 'http://127.0.0.1:8188', mappings: { promptNodeId: '6', promptNodeIdInput: 'text' } } });
    expect(generationRequestError(document, base)).toBeUndefined();
    expect(generationRequestError(document, { ...base, providerOptions: { ...base.providerOptions, mappings: { surpriseNode: '6' } } })).toMatch(/unsupported or invalid/);
    expect(generationRequestError(document, { ...base, providerOptions: { ...base.providerOptions, mappings: { promptNodeId: 6 } } })).toMatch(/unsupported or invalid/);
  });
});
