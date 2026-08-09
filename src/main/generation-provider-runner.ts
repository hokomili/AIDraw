import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import OpenAI, { toFile } from 'openai';
import { createId, type AIDrawDocument } from '@aidraw/core';
import type { GeneratedOutput, GenerationRequest } from '../common/generation';
import { validateGenerationRequest } from '../common/generation-capabilities';
import { MAX_GENERATED_OUTPUT_BYTES, MAX_GENERATED_OUTPUT_PIXELS, MAX_GENERATED_OUTPUT_SIDE } from './utility-contract';

export interface GenerationProviderInput {
  jobId: string;
  document: AIDrawDocument;
  request: GenerationRequest;
  credential?: string;
}

export interface GenerationProviderControl {
  signal: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

export type GenerationProviderRunner = (input: GenerationProviderInput, control: GenerationProviderControl) => Promise<GeneratedOutput[]>;

function mimeFromFormat(format: string | undefined): GeneratedOutput['mimeType'] {
  return format === 'webp' ? 'image/webp' : format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
}

function extension(mimeType: string): string {
  return mimeType === 'image/webp' ? 'webp' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
}

async function imageOutput(bytes: Buffer, mimeType: GeneratedOutput['mimeType'], details: Partial<GeneratedOutput> = {}): Promise<GeneratedOutput> {
  if (!bytes.length || bytes.byteLength > MAX_GENERATED_OUTPUT_BYTES) throw new Error(`A provider returned an image outside AIDraw's ${MAX_GENERATED_OUTPUT_BYTES / 1024 / 1024} MiB result limit.`);
  let image: Awaited<ReturnType<typeof loadImage>>;
  try { image = await loadImage(bytes); } catch { throw new Error('A provider returned an unreadable image.'); }
  const pixels = image.width * image.height;
  if (image.width < 1 || image.height < 1 || image.width > MAX_GENERATED_OUTPUT_SIDE || image.height > MAX_GENERATED_OUTPUT_SIDE || !Number.isSafeInteger(pixels) || pixels > MAX_GENERATED_OUTPUT_PIXELS) throw new Error('A provider returned an image outside AIDraw\'s decoded dimension limits.');
  return { id: details.id ?? createId('result'), mimeType, data: bytes.toString('base64'), width: image.width, height: image.height, seed: details.seed, providerMetadata: details.providerMetadata };
}

function normalizeSize(size: GenerationRequest['size'], aspect?: GenerationRequest['aspectIntent']): 'auto' | '1024x1024' | '1536x1024' | '1024x1536' {
  if (size === 'auto') return 'auto';
  if (size.width === 1024 && size.height === 1024) return '1024x1024';
  if (size.width === 1536 && size.height === 1024) return '1536x1024';
  if (size.width === 1024 && size.height === 1536) return '1024x1536';
  if (aspect === 'square') return '1024x1024';
  if (aspect === 'portrait') return '1024x1536';
  if (aspect === 'landscape') return '1536x1024';
  return size.width === size.height ? '1024x1024' : size.width > size.height ? '1536x1024' : '1024x1536';
}

type OpenAIUpload = Awaited<ReturnType<typeof toFile>>;

async function openAIUpload(document: AIDrawDocument, assetId: string): Promise<OpenAIUpload> {
  const asset = document.assets[assetId];
  if (!asset?.data) throw new Error(`Source asset ${assetId} is unavailable.`);
  return toFile(Buffer.from(asset.data, 'base64'), `${asset.name}.${extension(asset.mimeType)}`, { type: asset.mimeType });
}

async function normalizedOpenAIMask(document: AIDrawDocument, sourceAssetId: string, maskAssetId: string): Promise<{ source: OpenAIUpload; mask: OpenAIUpload }> {
  const sourceAsset = document.assets[sourceAssetId]; const maskAsset = document.assets[maskAssetId];
  if (!sourceAsset?.data || !maskAsset?.data) throw new Error('OpenAI inpaint requires embedded source and mask images.');
  const [sourceImage, maskImage] = await Promise.all([loadImage(Buffer.from(sourceAsset.data, 'base64')), loadImage(Buffer.from(maskAsset.data, 'base64'))]);
  if (sourceImage.width !== maskImage.width || sourceImage.height !== maskImage.height) throw new Error('OpenAI inpaint source and mask must have the same dimensions.');
  const sourceCanvas = createCanvas(sourceImage.width, sourceImage.height); sourceCanvas.getContext('2d').drawImage(sourceImage, 0, 0);
  const maskCanvas = createCanvas(maskImage.width, maskImage.height); const maskContext = maskCanvas.getContext('2d'); maskContext.drawImage(maskImage, 0, 0);
  const pixels = maskContext.getImageData(0, 0, maskImage.width, maskImage.height).data; let hasTransparentPixel = false;
  for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] < 255) { hasTransparentPixel = true; break; }
  if (!hasTransparentPixel) throw new Error('OpenAI inpaint mask must contain an alpha channel with at least one transparent pixel.');
  return {
    source: await toFile(sourceCanvas.toBuffer('image/png'), 'source.png', { type: 'image/png' }),
    mask: await toFile(maskCanvas.toBuffer('image/png'), 'mask.png', { type: 'image/png' }),
  };
}

async function openAIOutpaintInputs(document: AIDrawDocument, request: GenerationRequest): Promise<{ source: OpenAIUpload; mask: OpenAIUpload }> {
  if (request.size === 'auto') throw new Error('OpenAI outpaint requires an explicit output size.');
  const normalized = normalizeSize(request.size, request.aspectIntent);
  if (normalized === 'auto') throw new Error('OpenAI outpaint requires an explicit output size.');
  const [width, height] = normalized.split('x').map(Number); const sourceAsset = document.assets[request.sourceAssetIds[0]];
  if (!sourceAsset?.data) throw new Error('OpenAI outpaint requires one embedded source image.');
  const sourceImage = await loadImage(Buffer.from(sourceAsset.data, 'base64'));
  if (sourceImage.width > width || sourceImage.height > height) throw new Error(`OpenAI outpaint source ${sourceImage.width}×${sourceImage.height} does not fit the normalized ${width}×${height} output.`);
  const x = Math.floor((width - sourceImage.width) / 2); const y = Math.floor((height - sourceImage.height) / 2);
  const sourceCanvas = createCanvas(width, height); sourceCanvas.getContext('2d').drawImage(sourceImage, x, y);
  const maskCanvas = createCanvas(width, height); const maskContext = maskCanvas.getContext('2d'); maskContext.fillStyle = '#fff'; maskContext.fillRect(x, y, sourceImage.width, sourceImage.height);
  return {
    source: await toFile(sourceCanvas.toBuffer('image/png'), 'outpaint-source.png', { type: 'image/png' }),
    mask: await toFile(maskCanvas.toBuffer('image/png'), 'outpaint-mask.png', { type: 'image/png' }),
  };
}

async function runOpenAI(input: GenerationProviderInput, control: GenerationProviderControl): Promise<GeneratedOutput[]> {
  const { document, request, credential } = input;
  if (!credential) throw new Error('Add an OpenAI API key in Generation settings.');
  if (request.negativePrompt) throw new Error('OpenAI gpt-image-2 does not expose a separate negative-prompt field; remove it instead of silently approximating it.');
  const client = new OpenAI({ apiKey: credential, maxRetries: 0, timeout: 120_000 });
  const common = { model: 'gpt-image-2' as const, prompt: request.prompt, n: request.resultCount, size: normalizeSize(request.size, request.aspectIntent), output_format: 'png' as const, quality: (request.providerOptions.quality as 'low' | 'medium' | 'high' | 'auto' | undefined) ?? 'auto' };
  let editImages: OpenAIUpload[] = []; let editMask: OpenAIUpload | undefined;
  if (request.mode !== 'create') {
    if (request.mode === 'outpaint') {
      const prepared = await openAIOutpaintInputs(document, request); editImages = [prepared.source]; editMask = prepared.mask;
    } else if (request.maskAssetId) {
      const prepared = await normalizedOpenAIMask(document, request.sourceAssetIds[0], request.maskAssetId); editImages = [prepared.source, ...await Promise.all(request.sourceAssetIds.slice(1).map((id) => openAIUpload(document, id)))]; editMask = prepared.mask;
    } else editImages = await Promise.all(request.sourceAssetIds.map((id) => openAIUpload(document, id)));
  }
  const response = request.mode === 'create'
    ? await client.images.generate(common, { signal: control.signal })
    : await client.images.edit({ ...common, image: editImages, mask: editMask }, { signal: control.signal });
  const mimeType = mimeFromFormat(response.output_format);
  return Promise.all((response.data ?? []).flatMap((entry) => entry.b64_json ? [imageOutput(Buffer.from(entry.b64_json, 'base64'), mimeType)] : []));
}

async function runStability(input: GenerationProviderInput, control: GenerationProviderControl): Promise<GeneratedOutput[]> {
  const { document, request, credential } = input;
  if (!credential) throw new Error('Add a Stability API key in Generation settings.');
  if (!['create', 'inpaint', 'outpaint'].includes(request.mode)) throw new Error(`Stability adapter does not support ${request.mode}; no approximation was sent.`);
  const endpoint = request.mode === 'create' ? 'generate/core' : `edit/${request.mode}`;
  const results: GeneratedOutput[] = [];
  for (let index = 0; index < request.resultCount; index += 1) {
    try {
      const form = new FormData();
      form.append('prompt', request.prompt);
      if (request.negativePrompt) form.append('negative_prompt', request.negativePrompt);
      if (request.seed !== undefined) form.append('seed', String(request.seed + index));
      form.append('output_format', 'png');
      if (request.providerOptions.stylePreset) form.append('style_preset', String(request.providerOptions.stylePreset));
      if (request.mode === 'create' && request.aspectIntent && request.aspectIntent !== 'canvas') form.append('aspect_ratio', request.aspectIntent === 'square' ? '1:1' : request.aspectIntent === 'portrait' ? '2:3' : '3:2');
      if (request.mode !== 'create') {
        const source = document.assets[request.sourceAssetIds[0]];
        if (!source?.data) throw new Error('Stability edit requires one source image.');
        form.append('image', new Blob([Buffer.from(source.data, 'base64')], { type: source.mimeType }), `${source.name}.${extension(source.mimeType)}`);
        const mask = request.maskAssetId ? document.assets[request.maskAssetId] : undefined;
        if (mask?.data) form.append('mask', new Blob([Buffer.from(mask.data, 'base64')], { type: mask.mimeType }), 'mask.png');
        if (request.mode === 'outpaint') {
          for (const direction of ['left', 'right', 'up', 'down'] as const) form.append(direction, String(request.providerOptions[direction] ?? 0));
          if (request.providerOptions.creativity !== undefined) form.append('creativity', String(request.providerOptions.creativity));
        }
      }
      const response = await fetch(`https://api.stability.ai/v2beta/stable-image/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, accept: 'image/*', 'stability-client-id': 'AIDraw' }, body: form, signal: control.signal });
      if (!response.ok) throw Object.assign(new Error(`Stability returned ${response.status}: ${await response.text()}`), { status: response.status });
      const output = await imageOutput(Buffer.from(await response.arrayBuffer()), mimeFromFormat(response.headers.get('content-type')?.split('/')[1]), { seed: request.seed === undefined ? undefined : request.seed + index });
      results.push(output);
    } catch (error) {
      if (!results.length || control.signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      results[results.length - 1].providerMetadata = { ...(results[results.length - 1].providerMetadata ?? {}), partialFailure: detail, completedResults: results.length, requestedResults: request.resultCount };
      break;
    }
  }
  return results;
}

type ComfyHistoryEntry = { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>; status?: { completed?: boolean; status_str?: string; messages?: unknown } };

async function connectComfySocket(endpoint: string, clientId: string, signal: AbortSignal, timeoutMs = 10_000): Promise<WebSocket> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const socket = new WebSocket(`${endpoint.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
  return new Promise<WebSocket>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to ComfyUI WebSocket.')); }, timeoutMs);
    const abort = () => { clearTimeout(timeout); socket.close(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    socket.addEventListener('open', () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); reject(new Error('Could not connect to ComfyUI WebSocket.')); }, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

function queueContainsPrompt(value: unknown, promptId: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => Array.isArray(entry) ? entry.some((part) => part === promptId) : Boolean(entry && typeof entry === 'object' && (entry as { prompt_id?: unknown }).prompt_id === promptId));
}

async function cancelComfyPrompt(endpoint: string, promptId: string): Promise<void> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    let running = false;
    try {
      const queue = await fetch(`${endpoint}/queue`, { signal: controller.signal });
      if (queue.ok) { const state = await queue.json() as { queue_running?: unknown }; running = queueContainsPrompt(state.queue_running, promptId); }
    } catch { /* Cancellation remains best effort when queue inspection is unavailable. */ }
    try { await fetch(`${endpoint}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }), signal: controller.signal }); } catch { /* Best effort. */ }
    if (running) try { await fetch(`${endpoint}/interrupt`, { method: 'POST', signal: controller.signal }); } catch { /* Best effort. */ }
  } finally { clearTimeout(timeout); }
}

function waitForComfyWake(signal: AbortSignal, timeoutMs: number, subscribe: (wake: () => void) => () => void): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timeout); unsubscribe(); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const unsubscribe = subscribe(() => { finish(); resolve(); });
    const timeout = setTimeout(() => { finish(); resolve(); }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function waitForComfyHistory(
  endpoint: string,
  clientId: string,
  promptId: string,
  initialSocket: WebSocket | undefined,
  control: GenerationProviderControl,
): Promise<ComfyHistoryEntry> {
  const deadline = Date.now() + 10 * 60_000;
  let socket = initialSocket; let disconnected = !socket; let reconnectAttempts = 0; let executionError: Error | undefined; let wakeListeners = new Set<() => void>();
  const wake = () => { for (const listener of wakeListeners) listener(); wakeListeners = new Set(); };
  const attach = (value: WebSocket) => {
    disconnected = false;
    value.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: { type?: string; data?: { prompt_id?: string; value?: number; max?: number; node?: string | null; exception_message?: string } };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      if (message.data?.prompt_id && message.data.prompt_id !== promptId) return;
      if (message.type === 'progress' && message.data?.max) control.onProgress?.(0.1 + 0.8 * ((message.data.value ?? 0) / message.data.max), 'ComfyUI is rendering…');
      if (message.type === 'execution_error') executionError = new Error(`ComfyUI execution failed: ${message.data?.exception_message ?? event.data}`);
      if (message.type === 'execution_interrupted') executionError = new Error('ComfyUI execution was interrupted.');
      if ((message.type === 'executing' && message.data?.prompt_id === promptId && message.data.node === null) || message.type === 'execution_success' || executionError) wake();
    });
    value.addEventListener('close', () => { disconnected = true; wake(); }, { once: true });
    value.addEventListener('error', () => { disconnected = true; wake(); }, { once: true });
  };
  if (socket) attach(socket);
  if (socket) await waitForComfyWake(control.signal, 0, (listener) => { wakeListeners.add(listener); return () => wakeListeners.delete(listener); });

  try {
    while (Date.now() < deadline) {
      if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (executionError) throw executionError;
      try {
        const response = await fetch(`${endpoint}/history/${encodeURIComponent(promptId)}`, { signal: control.signal });
        if (response.ok) {
          const history = await response.json() as Record<string, ComfyHistoryEntry>;
          if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('ComfyUI returned malformed output history.');
          const entry = history[promptId];
          if (entry) {
            const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
            if (images.length) return entry;
            if (entry.status?.completed) {
              if (entry.status.status_str && !['success', 'completed'].includes(entry.status.status_str)) throw new Error(`ComfyUI generation failed: ${entry.status.status_str}.`);
              return entry;
            }
          }
        } else if (response.status >= 500) control.onProgress?.(0.08, `ComfyUI history is temporarily unavailable (${response.status}); retrying…`);
      } catch (error) {
        if (control.signal.aborted) throw error;
        if (error instanceof SyntaxError || error instanceof Error && /malformed output history/.test(error.message)) throw error;
      }
      if (disconnected && reconnectAttempts < 2) {
        reconnectAttempts += 1;
        try {
          socket = await connectComfySocket(endpoint, clientId, control.signal, 2_000); attach(socket);
          control.onProgress?.(0.08, 'Reconnected to ComfyUI; verifying output history…');
          continue;
        } catch (error) {
          if (control.signal.aborted) throw error;
          control.onProgress?.(0.08, 'ComfyUI live progress is unavailable; polling output history…');
        }
      }
      await waitForComfyWake(control.signal, 1_000, (listener) => { wakeListeners.add(listener); return () => wakeListeners.delete(listener); });
    }
    throw new Error('ComfyUI generation timed out.');
  } finally { socket?.close(); }
}

async function runComfyUI(input: GenerationProviderInput, control: GenerationProviderControl): Promise<GeneratedOutput[]> {
  const { document, request } = input;
  const endpoint = String(request.providerOptions.endpoint ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
  const workflow = structuredClone(request.providerOptions.workflow) as Record<string, { inputs?: Record<string, unknown> }> | undefined;
  if (!workflow || typeof workflow !== 'object') throw new Error('Choose an API-format ComfyUI workflow.');
  const mappings = (request.providerOptions.mappings ?? {}) as Record<string, string>;
  const entries = Object.entries(workflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>);
  const byClass = (pattern: RegExp) => entries.filter(([, node]) => pattern.test(node.class_type ?? ''));
  const assign = (mappingName: string, fallbackInput: string, value: unknown, fallbackNodeId?: string): boolean => { const nodeId = mappings[mappingName] ?? fallbackNodeId; if (!nodeId || !workflow[nodeId]?.inputs) return false; workflow[nodeId].inputs![mappings[`${mappingName}Input`] ?? fallbackInput] = value; return true; };
  const textNodes = byClass(/CLIPTextEncode/i);
  if (!assign('promptNodeId', 'text', request.prompt, textNodes[0]?.[0])) throw new Error('ComfyUI workflow has no mapped prompt input.');
  if (request.negativePrompt && !assign('negativePromptNodeId', 'text', request.negativePrompt, textNodes[1]?.[0])) throw new Error('ComfyUI workflow has no mapped negative-prompt input.');
  const sampler = byClass(/KSampler|RandomNoise/i)[0]?.[0];
  if (request.seed !== undefined && !assign('seedNodeId', workflow[sampler]?.inputs?.noise_seed !== undefined ? 'noise_seed' : 'seed', request.seed, sampler)) throw new Error('ComfyUI workflow has no mapped seed input.');
  const latent = byClass(/EmptyLatentImage|EmptySD3LatentImage/i)[0]?.[0];
  if (request.size !== 'auto') { assign('widthNodeId', 'width', request.size.width, latent); assign('heightNodeId', 'height', request.size.height, latent); }
  if (request.resultCount > 1 && !assign('batchSizeNodeId', 'batch_size', request.resultCount, latent)) throw new Error('ComfyUI result counts above one require a mapped batch-size node.');
  const loadNodes = byClass(/LoadImage/i);
  const upload = async (assetId: string, label: string): Promise<string> => {
    const asset = document.assets[assetId];
    if (!asset?.data) throw new Error(`${label} asset ${assetId} is unavailable.`);
    const form = new FormData(); form.append('image', new Blob([Buffer.from(asset.data, 'base64')], { type: asset.mimeType }), `${asset.name}.${extension(asset.mimeType)}`); form.append('type', 'input'); form.append('overwrite', 'true');
    const response = await fetch(`${endpoint}/upload/image`, { method: 'POST', body: form, signal: control.signal });
    if (!response.ok) throw new Error(`ComfyUI rejected the ${label.toLowerCase()} upload: ${await response.text()}`);
    const uploaded = await response.json() as { name?: string; subfolder?: string };
    if (!uploaded.name) throw new Error(`ComfyUI did not return a filename for the ${label.toLowerCase()}.`);
    return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  };
  if (request.mode !== 'create') { const sourceName = await upload(request.sourceAssetIds[0], 'Source'); if (!assign('sourceNodeId', 'image', sourceName, loadNodes[0]?.[0])) throw new Error(`ComfyUI workflow does not expose a source-image node for ${request.mode}.`); }
  if (request.maskAssetId) { const maskName = await upload(request.maskAssetId, 'Mask'); if (!assign('maskNodeId', 'image', maskName, loadNodes[1]?.[0])) throw new Error('ComfyUI workflow does not expose a mapped mask-image node.'); }
  const clientId = randomUUID();
  let socket: WebSocket | undefined;
  try { socket = await connectComfySocket(endpoint, clientId, control.signal); }
  catch (error) { if (control.signal.aborted) throw error; control.onProgress?.(0.05, 'ComfyUI live progress is unavailable; using output-history polling…'); }
  const queued = await fetch(`${endpoint}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }), signal: control.signal });
  if (!queued.ok) throw new Error(`ComfyUI rejected the workflow: ${await queued.text()}`);
  const queuedJson = await queued.json() as { prompt_id?: string; error?: string; node_errors?: unknown };
  if (!queuedJson.prompt_id) throw new Error(queuedJson.error ?? `ComfyUI workflow validation failed: ${JSON.stringify(queuedJson.node_errors)}`);
  const promptId = queuedJson.prompt_id;
  let history: ComfyHistoryEntry;
  try { history = await waitForComfyHistory(endpoint, clientId, promptId, socket, control); }
  catch (error) { if (control.signal.aborted || error instanceof Error && /timed out/i.test(error.message)) await cancelComfyPrompt(endpoint, promptId); throw error; }
  const descriptors = Object.values(history.outputs ?? {}).flatMap((output) => output.images ?? []);
  const outputs: GeneratedOutput[] = [];
  for (const descriptor of descriptors.slice(0, request.resultCount)) {
    const query = new URLSearchParams({ filename: descriptor.filename, subfolder: descriptor.subfolder ?? '', type: descriptor.type ?? 'output' });
    const response = await fetch(`${endpoint}/view?${query}`, { signal: control.signal });
    if (!response.ok) throw new Error(`Could not retrieve ComfyUI output ${descriptor.filename}.`);
    outputs.push(await imageOutput(Buffer.from(await response.arrayBuffer()), mimeFromFormat(response.headers.get('content-type')?.split('/')[1] ?? descriptor.filename.split('.').at(-1)), { seed: request.seed, providerMetadata: { filename: descriptor.filename, promptId } }));
  }
  if (!outputs.length) throw new Error('ComfyUI completed without image outputs.');
  return outputs;
}

export const runGenerationProvider: GenerationProviderRunner = async (input, control) => {
  validateGenerationRequest(input.document, input.request);
  if (input.request.provider === 'openai') return runOpenAI(input, control);
  if (input.request.provider === 'stability') return runStability(input, control);
  return runComfyUI(input, control);
};
