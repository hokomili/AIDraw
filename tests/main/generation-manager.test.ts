import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelDocument } from '@aidraw/core';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { GenerationRequest } from '../../src/common/generation';
import { runGenerationProvider } from '../../src/main/generation-provider-runner';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket; vi.restoreAllMocks(); });

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;
  static instances: FakeWebSocket[] = [];
  private readonly listeners = new Map<string, Array<{ callback: (event: { data?: string }) => void; once: boolean }>>();
  constructor(readonly url: string) { FakeWebSocket.latest = this; FakeWebSocket.instances.push(this); queueMicrotask(() => this.emit('open', {})); }
  addEventListener(type: string, callback: (event: { data?: string }) => void, options?: { once?: boolean }) { const entries = this.listeners.get(type) ?? []; entries.push({ callback, once: options?.once === true }); this.listeners.set(type, entries); }
  close() { /* test transport */ }
  emit(type: string, event: { data?: string }) { const entries = this.listeners.get(type) ?? []; this.listeners.set(type, entries.filter((entry) => !entry.once)); for (const entry of entries) entry.callback(event); }
}

describe('isolated generation provider failure handling', () => {
  const document = createPixelDocument('sprite');
  const request: GenerationRequest = { documentId: document.id, provider: 'stability', mode: 'create', prompt: 'A tiny locomotive', sourceAssetIds: [], size: 'auto', aspectIntent: 'square', resultCount: 3, seed: 7, providerOptions: {} };
  const canvas = createCanvas(2, 2); canvas.getContext('2d').fillRect(0, 0, 2, 2); const outputBytes = canvas.toBuffer('image/png'); const outputData = outputBytes.toString('base64');
  const maskCanvas = createCanvas(2, 2); const maskContext = maskCanvas.getContext('2d'); maskContext.fillStyle = '#fff'; maskContext.fillRect(0, 0, 2, 2); maskContext.clearRect(0, 0, 1, 1); const maskBytes = maskCanvas.toBuffer('image/png'); const maskData = maskBytes.toString('base64');
  const call = (input = request, signal = new AbortController().signal, onProgress?: (progress: number, message: string) => void) => runGenerationProvider({ jobId: 'provider-test', document, request: input, credential: input.provider === 'comfyui' ? undefined : `${input.provider}-key` }, { signal, onProgress });
  const installSources = () => { document.assets.source = { id: 'source', name: 'Source', mimeType: 'image/png', byteLength: outputBytes.byteLength, sha256: 'a'.repeat(64), source: 'imported', data: outputData }; document.assets.mask = { id: 'mask', name: 'Mask', mimeType: 'image/png', byteLength: maskBytes.byteLength, sha256: 'b'.repeat(64), source: 'imported', data: maskData }; };

  it('retains already-paid results and stops without retrying after a later ambiguous failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(Uint8Array.from(outputBytes), { status: 200, headers: { 'content-type': 'image/png' } })).mockResolvedValueOnce(new Response('rate limited', { status: 429 })); globalThis.fetch = fetchMock;
    const outputs = await call(); expect(outputs).toHaveLength(1); expect(outputs[0]).toMatchObject({ seed: 7, width: 2, height: 2, providerMetadata: { completedResults: 1, requestedResults: 3 } }); expect(String(outputs[0].providerMetadata?.partialFailure)).toContain('429'); expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = fetchMock.mock.calls[0][1]?.body as FormData; expect(firstBody.get('prompt')).toBe(request.prompt); expect(firstBody.get('seed')).toBe('7'); expect(firstBody.get('aspect_ratio')).toBe('1:1');
  });

  it('surfaces a first-request rate limit and never retries it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })); globalThis.fetch = fetchMock;
    await expect(call({ ...request, resultCount: 2 })).rejects.toMatchObject({ status: 429 }); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on cancellation', async () => {
    const controller = new AbortController(); const fetchMock = vi.fn().mockImplementation(async (_url, init: RequestInit) => { controller.abort(); throw init.signal?.reason ?? new DOMException('Aborted', 'AbortError'); }); globalThis.fetch = fetchMock;
    await expect(call(request, controller.signal)).rejects.toBeTruthy(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps an OpenAI create request to gpt-image-2 and decodes its result', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ created: 1, output_format: 'png', data: [{ b64_json: outputData }] }), { status: 200, headers: { 'content-type': 'application/json' } })); globalThis.fetch = fetchMock;
    const openaiRequest: GenerationRequest = { ...request, provider: 'openai', resultCount: 2, mode: 'create', seed: undefined, providerOptions: { quality: 'high' } };
    const outputs = await call(openaiRequest); expect(outputs).toEqual([expect.objectContaining({ mimeType: 'image/png', width: 2, height: 2 })]); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/images/generations'); const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)); expect(body).toMatchObject({ model: 'gpt-image-2', prompt: request.prompt, n: 2, size: 'auto', quality: 'high', output_format: 'png' });
  });

  it('sends OpenAI edit sources and mask once and never retries an ambiguous server error', async () => {
    installSources();
    const editRequest: GenerationRequest = { ...request, provider: 'openai', mode: 'inpaint', sourceAssetIds: ['source'], maskAssetId: 'mask', resultCount: 1, seed: undefined };
    const successFetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ output_format: 'png', data: [{ b64_json: outputData }] }), { status: 200, headers: { 'content-type': 'application/json' } })); globalThis.fetch = successFetch; await expect(call(editRequest)).resolves.toHaveLength(1); const apiCalls = successFetch.mock.calls.filter((entry) => String(entry[0]).startsWith('https://api.openai.com/')); expect(apiCalls).toHaveLength(1); expect(String(apiCalls[0][0])).toContain('/images/edits'); const form = apiCalls[0][1]?.body as FormData; expect([...form.keys()]).toEqual(expect.arrayContaining(['image[]', 'mask', 'prompt'])); expect(form.getAll('image[]')).toHaveLength(1);
    const failureFetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'ambiguous upstream failure', type: 'server_error' } }), { status: 500, headers: { 'content-type': 'application/json' } })); globalThis.fetch = failureFetch; await expect(call({ ...editRequest, mode: 'create', sourceAssetIds: [], maskAssetId: undefined })).rejects.toBeTruthy(); expect(failureFetch).toHaveBeenCalledTimes(1);
  });

  it('maps OpenAI variations and constructs a padded same-size alpha mask for outpaint', async () => {
    installSources(); const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ output_format: 'png', data: [{ b64_json: outputData }] }), { status: 200, headers: { 'content-type': 'application/json' } })); globalThis.fetch = fetchMock;
    const variation: GenerationRequest = { ...request, provider: 'openai', mode: 'variation', sourceAssetIds: ['source'], resultCount: 1, seed: undefined };
    await expect(call(variation)).resolves.toHaveLength(1); let apiCalls = fetchMock.mock.calls.filter((entry) => String(entry[0]).startsWith('https://api.openai.com/')); const variationForm = apiCalls[0][1]?.body as FormData; expect(variationForm.getAll('image[]')).toHaveLength(1); expect(variationForm.get('mask')).toBeNull();
    const outpaint: GenerationRequest = { ...variation, mode: 'outpaint', size: { width: 1024, height: 1024 } };
    await expect(call(outpaint)).resolves.toHaveLength(1); apiCalls = fetchMock.mock.calls.filter((entry) => String(entry[0]).startsWith('https://api.openai.com/')); const outpaintForm = apiCalls[1][1]?.body as FormData; const sourceFile = outpaintForm.getAll('image[]')[0] as File; const maskFile = outpaintForm.get('mask') as File; const [sourceImage, maskImage] = await Promise.all([loadImage(Buffer.from(await sourceFile.arrayBuffer())), loadImage(Buffer.from(await maskFile.arrayBuffer()))]);
    expect([sourceImage.width, sourceImage.height, maskImage.width, maskImage.height]).toEqual([1024, 1024, 1024, 1024]); expect(outpaintForm.get('size')).toBe('1024x1024');
  });

  it('never retries OpenAI rate limits and propagates request cancellation', async () => {
    const openaiRequest: GenerationRequest = { ...request, provider: 'openai', mode: 'create', resultCount: 1, seed: undefined };
    const rateLimit = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } })); globalThis.fetch = rateLimit;
    await expect(call(openaiRequest)).rejects.toBeTruthy(); expect(rateLimit).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); const cancelled = vi.fn().mockImplementation(async (_url, init: RequestInit) => { controller.abort(); throw init.signal?.reason ?? new DOMException('Aborted', 'AbortError'); }); globalThis.fetch = cancelled;
    await expect(call(openaiRequest, controller.signal)).rejects.toBeTruthy(); expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid OpenAI inpaint masks before making a paid request', async () => {
    installSources(); document.assets.mask.data = outputData; document.assets.mask.byteLength = outputBytes.byteLength; globalThis.fetch = vi.fn();
    const invalid: GenerationRequest = { ...request, provider: 'openai', mode: 'inpaint', sourceAssetIds: ['source'], maskAssetId: 'mask', resultCount: 1, seed: undefined };
    await expect(call(invalid)).rejects.toThrow(/alpha channel/); expect(globalThis.fetch).not.toHaveBeenCalled();
    const different = createCanvas(1, 1); different.getContext('2d').clearRect(0, 0, 1, 1); document.assets.mask.data = different.toBuffer('image/png').toString('base64');
    await expect(call(invalid)).rejects.toThrow(/same dimensions/); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps Stability inpaint and directional outpaint bodies to the documented endpoints', async () => {
    installSources();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(Uint8Array.from(outputBytes), { status: 200, headers: { 'content-type': 'image/png' } })); globalThis.fetch = fetchMock;
    const inpaint: GenerationRequest = { ...request, mode: 'inpaint', sourceAssetIds: ['source'], maskAssetId: 'mask', resultCount: 1, negativePrompt: 'fog', providerOptions: { stylePreset: 'pixel-art' } };
    await expect(call(inpaint)).resolves.toHaveLength(1); expect(String(fetchMock.mock.calls[0][0])).toContain('/edit/inpaint'); const inpaintBody = fetchMock.mock.calls[0][1]?.body as FormData; expect([...inpaintBody.keys()]).toEqual(expect.arrayContaining(['image', 'mask', 'negative_prompt', 'style_preset'])); expect(inpaintBody.get('aspect_ratio')).toBeNull();
    const outpaint: GenerationRequest = { ...request, mode: 'outpaint', sourceAssetIds: ['source'], maskAssetId: undefined, negativePrompt: undefined, resultCount: 1, providerOptions: { left: 64, right: 128, up: 0, down: 32, creativity: 0.65 } };
    await expect(call(outpaint)).resolves.toHaveLength(1); expect(String(fetchMock.mock.calls[1][0])).toContain('/edit/outpaint'); const outpaintBody = fetchMock.mock.calls[1][1]?.body as FormData; expect(Object.fromEntries(['left', 'right', 'up', 'down', 'creativity'].map((key) => [key, outpaintBody.get(key)]))).toEqual({ left: '64', right: '128', up: '0', down: '32', creativity: '0.65' }); expect(outpaintBody.get('mask')).toBeNull(); expect(outpaintBody.get('aspect_ratio')).toBeNull();
  });

  it('rejects malformed provider image bytes before they enter a job result', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
    await expect(call({ ...request, resultCount: 1 })).rejects.toThrow(/unreadable image/);
  });

  it('maps a ComfyUI workflow, relays progress, and retrieves one exact output', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket; let submitted: Record<string, any> | undefined; const progress = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/prompt')) { submitted = JSON.parse(String(init?.body)); setTimeout(() => { FakeWebSocket.latest?.emit('message', { data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 1, max: 2 } }) }); FakeWebSocket.latest?.emit('message', { data: JSON.stringify({ type: 'executing', data: { prompt_id: 'prompt-1', node: null } }) }); }, 0); return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      if (target.endsWith('/history/prompt-1')) return new Response(JSON.stringify({ 'prompt-1': { outputs: { '9': { images: [{ filename: 'result.png', subfolder: 'final', type: 'output' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.includes('/view?')) return new Response(Uint8Array.from(outputBytes), { status: 200, headers: { 'content-type': 'image/png' } });
      throw new Error(`Unexpected ComfyUI URL: ${target}`);
    }); globalThis.fetch = fetchMock;
    const comfyRequest: GenerationRequest = { ...request, provider: 'comfyui', mode: 'create', resultCount: 1, size: { width: 128, height: 64 }, providerOptions: { endpoint: 'http://127.0.0.1:8188', workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'KSampler', inputs: { seed: 0 } }, '3': { class_type: 'EmptyLatentImage', inputs: { width: 32, height: 32, batch_size: 1 } } } } };
    const outputs = await call(comfyRequest, undefined, progress); expect(outputs).toEqual([expect.objectContaining({ mimeType: 'image/png', width: 2, height: 2, seed: 7, providerMetadata: { filename: 'result.png', promptId: 'prompt-1' } })]); expect(progress).toHaveBeenCalledWith(0.5, 'ComfyUI is rendering…'); expect(submitted?.client_id).toBeTruthy(); expect(submitted?.prompt['1'].inputs.text).toBe(request.prompt); expect(submitted?.prompt['2'].inputs.seed).toBe(7); expect(submitted?.prompt['3'].inputs).toMatchObject({ width: 128, height: 64 }); expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reconnects after a ComfyUI WebSocket drop and recovers through bounded history polling', async () => {
    FakeWebSocket.instances = []; globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket; let historyCalls = 0; const progress = vi.fn();
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/prompt')) { setTimeout(() => FakeWebSocket.instances[0]?.emit('close', {}), 0); return new Response(JSON.stringify({ prompt_id: 'reconnect-prompt' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      if (target.endsWith('/history/reconnect-prompt')) { historyCalls += 1; return new Response(JSON.stringify(historyCalls < 3 ? {} : { 'reconnect-prompt': { outputs: { '9': { images: [{ filename: 'reconnected.png' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      if (target.includes('/view?')) return new Response(Uint8Array.from(outputBytes), { status: 200, headers: { 'content-type': 'image/png' } });
      throw new Error(`Unexpected URL ${target}`);
    });
    const comfyRequest: GenerationRequest = { ...request, provider: 'comfyui', mode: 'create', resultCount: 1, providerOptions: { workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'KSampler', inputs: { seed: 0 } } } } };
    await expect(call(comfyRequest, undefined, progress)).resolves.toEqual([expect.objectContaining({ providerMetadata: { filename: 'reconnected.png', promptId: 'reconnect-prompt' } })]);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2); expect(progress).toHaveBeenCalledWith(0.08, expect.stringMatching(/Reconnected/));
  });

  it('retrieves multiple ComfyUI outputs and rejects malformed history', async () => {
    FakeWebSocket.instances = []; globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const comfyRequest: GenerationRequest = { ...request, provider: 'comfyui', mode: 'create', resultCount: 2, providerOptions: { workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'KSampler', inputs: { seed: 0 } }, '3': { class_type: 'EmptyLatentImage', inputs: { batch_size: 1 } } } } };
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => { const target = String(url); if (target.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'multi' }), { status: 200, headers: { 'content-type': 'application/json' } }); if (target.endsWith('/history/multi')) return new Response(JSON.stringify({ multi: { outputs: { '9': { images: [{ filename: 'one.png' }, { filename: 'two.png' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } }); if (target.includes('/view?')) return new Response(Uint8Array.from(outputBytes), { status: 200, headers: { 'content-type': 'image/png' } }); throw new Error(`Unexpected URL ${target}`); });
    await expect(call(comfyRequest)).resolves.toHaveLength(2);
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => String(url).endsWith('/prompt') ? new Response(JSON.stringify({ prompt_id: 'bad-history' }), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(call({ ...comfyRequest, resultCount: 1 })).rejects.toThrow(/malformed output history/);
  });

  it('removes a cancelled ComfyUI prompt and interrupts only when that prompt is running', async () => {
    FakeWebSocket.instances = []; globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket; const controller = new AbortController(); const calls: Array<{ target: string; method: string }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url); const method = init?.method ?? 'GET'; calls.push({ target, method });
      if (target.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'cancel-me' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.endsWith('/history/cancel-me')) { controller.abort(); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }
      if (target.endsWith('/queue') && method === 'GET') return new Response(JSON.stringify({ queue_running: [[1, 'cancel-me', {}]] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.endsWith('/queue') && method === 'POST' || target.endsWith('/interrupt')) return new Response('{}', { status: 200 });
      throw new Error(`Unexpected URL ${target}`);
    });
    const comfyRequest: GenerationRequest = { ...request, provider: 'comfyui', mode: 'create', resultCount: 1, providerOptions: { workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'KSampler', inputs: { seed: 0 } } } } };
    await expect(call(comfyRequest, controller.signal)).rejects.toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining([{ target: expect.stringMatching(/\/queue$/), method: 'POST' }, { target: expect.stringMatching(/\/interrupt$/), method: 'POST' }]));
  });
});
