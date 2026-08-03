import { createHash, randomUUID } from 'node:crypto';
import OpenAI, { toFile } from 'openai';
import { nativeImage } from 'electron';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  createId,
  createPixelSprite,
  nowIso,
  writePixels,
  type AsyncJob,
  type CanvasOperation,
  type CanvasTransaction,
  type DocumentAsset,
  type ImageObject,
  type IllustrationLayer,
  type PixelLayer,
  type Provenance,
} from '@aidraw/core';
import type { GeneratedOutput, GenerationJobResult, GenerationRequest } from '../common/generation';
import { DocumentService } from './document-service';
import { ProviderCredentialStore } from './provider-credentials';
import { quantizeToPalette } from './quantize';

function mimeFromFormat(format: string | undefined): GeneratedOutput['mimeType'] {
  return format === 'webp' ? 'image/webp' : format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
}

function extension(mimeType: string): string {
  return mimeType === 'image/webp' ? 'webp' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
}

function dimensions(data: string): { width: number; height: number } {
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  if (image.isEmpty()) throw new Error('A provider returned an unreadable image.');
  return image.getSize();
}

function normalizeSize(size: GenerationRequest['size'], aspect?: GenerationRequest['aspectIntent']): 'auto' | '1024x1024' | '1536x1024' | '1024x1536' {
  if (size === 'auto') return 'auto';
  if (size.width === 1024 && size.height === 1024) return '1024x1024'; if (size.width === 1536 && size.height === 1024) return '1536x1024'; if (size.width === 1024 && size.height === 1536) return '1024x1536';
  if (aspect === 'square') return '1024x1024'; if (aspect === 'portrait') return '1024x1536'; if (aspect === 'landscape') return '1536x1024'; return size.width === size.height ? '1024x1024' : size.width > size.height ? '1536x1024' : '1024x1536';
}

function jobError(error: unknown): AsyncJob['error'] {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : undefined;
  return {
    code: status === 429 ? 'rate_limit' : status === 403 ? 'moderation_or_permission' : status === 401 ? 'invalid_credential' : 'provider_error',
    message,
    retryable: status === 429 || (status !== undefined && status >= 500),
  };
}

export class GenerationManager {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly documents: DocumentService,
    private readonly credentials: ProviderCredentialStore,
  ) {}

  async startHuman(request: GenerationRequest): Promise<{ jobId: string }> {
    this.validateRequest(request);
    const timestamp = nowIso();
    const job: AsyncJob<GenerationJobResult> = {
      id: createId('job'), kind: 'generation', status: 'queued', actor: HUMAN_ACTOR, createdAt: timestamp, updatedAt: timestamp,
      progress: 0, message: `Queued ${request.provider} generation.`, result: { request: structuredClone(request), outputs: [] },
    };
    this.documents.upsertJob(job);
    void this.run(job, request);
    return { jobId: job.id };
  }

  async runApproved(job: AsyncJob): Promise<void> {
    if (job.kind !== 'generation' || job.status !== 'queued') return;
    const result = job.result as { documentId?: string; request?: Partial<GenerationRequest> } | undefined;
    if (!result?.request) {
      this.documents.upsertJob({ ...job, status: 'failed', updatedAt: nowIso(), message: 'The approved generation request was missing.', error: { code: 'invalid_request', message: 'Missing request', retryable: false } });
      return;
    }
    const request = { ...result.request, documentId: result.request.documentId ?? result.documentId } as GenerationRequest;
    this.validateRequest(request);
    await this.run(job as AsyncJob<GenerationJobResult>, request);
  }

  cancel(jobId: string): AsyncJob | undefined {
    this.abortControllers.get(jobId)?.abort();
    const job = this.documents.getJob(jobId);
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    const cancelled = { ...job, status: 'cancelled' as const, updatedAt: nowIso(), message: 'Generation cancelled.' };
    this.documents.upsertJob(cancelled);
    return cancelled;
  }

  async accept(jobId: string, outputId: string): Promise<{ accepted: boolean; message?: string }> {
    const job = this.documents.getJob(jobId) as AsyncJob<GenerationJobResult> | undefined;
    const result = job?.result;
    const output = result?.outputs?.find((entry) => entry.id === outputId);
    if (!job || job.status !== 'completed' || !result || !output) return { accepted: false, message: 'Generated result is not available.' };
    const document = this.documents.getDocument(result.request.documentId);
    if (!document) return { accepted: false, message: 'Target document is no longer open.' };
    const bytes = Buffer.from(output.data, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset: DocumentAsset = {
      id: createId('asset'), name: `Generated ${result.request.provider} image`, mimeType: output.mimeType, byteLength: bytes.byteLength,
      sha256, source: 'generated', data: output.data,
    };
    const modelOrWorkflow = result.request.provider === 'openai'
      ? 'gpt-image-2'
      : result.request.provider === 'stability'
        ? String(result.request.providerOptions.model ?? 'stable-image-core')
        : createHash('sha256').update(JSON.stringify(result.request.providerOptions.workflow ?? {})).digest('hex');
    const provenance: Provenance = {
      id: createId('provenance'), assetId: asset.id, provider: result.request.provider, modelOrWorkflow,
      prompt: result.request.prompt, negativePrompt: result.request.negativePrompt, seed: output.seed ?? result.request.seed,
      sourceAssetIds: result.request.sourceAssetIds, maskAssetId: result.request.maskAssetId, createdAt: nowIso(),
    };
    const operations: CanvasOperation[] = [{ kind: 'asset.add', asset }, { kind: 'provenance.add', provenance }];

    if (document.kind === 'illustration') {
      const timestamp = nowIso();
      const layer: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'Generated result', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'vector', objectIds: [] };
      const scale = Math.min(1, document.artboard.width / output.width, document.artboard.height / output.height);
      const object: ImageObject = {
        id: createId('object'), revision: 0, name: 'Generated image', createdAt: timestamp, updatedAt: timestamp, createdBy: job.actor.id,
        layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: {
          ...IDENTITY_TRANSFORM, x: (document.artboard.width - output.width * scale) / 2, y: (document.artboard.height - output.height * scale) / 2, scaleX: scale, scaleY: scale,
        }, type: 'image', assetId: asset.id, width: output.width, height: output.height, filters: [],
      };
      operations.push({ kind: 'illustration.layer.add', layer }, { kind: 'illustration.object.add', object });
    } else {
      const active = document.pixelAssets[document.activeAssetId]; const source = active?.type === 'sprite' ? active : active?.type === 'tileset' ? document.pixelAssets[active.spriteAssetId] : undefined;
      if (source?.type === 'sprite') {
        const sprite = structuredClone(source); const timestamp = nowIso(); const layer: PixelLayer = { id: createId('layer'), revision: 0, name: 'Generated result', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type: 'pixel', visible: true, locked: false, opacity: 1, blendMode: 'normal' }; sprite.layers[layer.id] = layer; sprite.layerIds.push(layer.id);
        for (const [index, frameId] of sprite.frameIds.entries()) { const celId = createId('cel'); sprite.cels[celId] = { id: celId, revision: 0, name: `${layer.name} · ${sprite.frames[frameId].name}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, frameId, chunks: {} }; if (index === 0) writePixels(sprite.cels[celId], quantizeToPalette(bytes, sprite.width, sprite.height, document.palette, document.conversionDefaults.alphaThreshold, document.conversionDefaults.dithering)); }
        operations.push({ kind: 'pixel.asset.replace', asset: sprite, expectedRevision: source.revision }); provenance.conversion = { resample: document.conversionDefaults.resample, paletteMetric: document.conversionDefaults.paletteMetric, dithering: document.conversionDefaults.dithering, alphaThreshold: document.conversionDefaults.alphaThreshold, width: sprite.width, height: sprite.height };
      } else {
        const sprite = createPixelSprite('Generated result', output.width, output.height); writePixels(Object.values(sprite.cels)[0], quantizeToPalette(bytes, sprite.width, sprite.height, document.palette, document.conversionDefaults.alphaThreshold, document.conversionDefaults.dithering)); operations.push({ kind: 'pixel.asset.add', asset: sprite }, { kind: 'pixel.active-asset.set', assetId: sprite.id }); provenance.conversion = { resample: document.conversionDefaults.resample, paletteMetric: document.conversionDefaults.paletteMetric, dithering: document.conversionDefaults.dithering, alphaThreshold: document.conversionDefaults.alphaThreshold, width: sprite.width, height: sprite.height };
      }
    }

    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('accept-generation'), documentId: document.id, actor: HUMAN_ACTOR,
      label: document.kind === 'pixel' ? 'Accept generated image into palette' : 'Accept generated image', createdAt: nowIso(), operations,
      playback: { mode: 'instant', speed: 1 },
    };
    const response = await this.documents.apply(transaction, { trustedProvenance: true });
    if (response.status !== 'committed') return { accepted: false, message: response.message };
    this.documents.upsertJob({ ...job, updatedAt: nowIso(), message: 'Generated result accepted as a new editable layer/cel.', result: { ...result, acceptedOutputId: outputId } as GenerationJobResult });
    return { accepted: true };
  }

  private async run(job: AsyncJob<GenerationJobResult>, request: GenerationRequest): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    this.documents.upsertJob({ ...job, status: 'running', updatedAt: nowIso(), progress: 0.05, message: `Sending one ${request.provider} request${request.resultCount > 1 ? ` for ${request.resultCount} results` : ''}…` });
    try {
      const outputs = request.provider === 'openai'
        ? await this.openAI(request, controller.signal)
        : request.provider === 'stability'
          ? await this.stability(request, controller.signal)
          : await this.comfyUI(job.id, request, controller.signal);
      if (controller.signal.aborted) return;
      this.documents.upsertJob({
        ...job, status: 'completed', updatedAt: nowIso(), progress: 1,
        message: `${outputs.length} result${outputs.length === 1 ? '' : 's'} ready to compare.`, result: { request: structuredClone(request), outputs },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.documents.upsertJob({ ...job, status: 'failed', updatedAt: nowIso(), progress: 0, message: 'Generation failed without an automatic retry.', error: jobError(error), result: { request: structuredClone(request), outputs: [] } });
    } finally {
      this.abortControllers.delete(job.id);
    }
  }

  private async openAI(request: GenerationRequest, signal: AbortSignal): Promise<GeneratedOutput[]> {
    const apiKey = await this.credentials.get('openai');
    if (!apiKey) throw new Error('Add an OpenAI API key in Generation settings.');
    if (request.negativePrompt) throw new Error('OpenAI gpt-image-2 does not expose a separate negative-prompt field; remove it instead of silently approximating it.');
    const client = new OpenAI({ apiKey });
    const common = { model: 'gpt-image-2' as const, prompt: request.prompt, n: request.resultCount, size: normalizeSize(request.size, request.aspectIntent), output_format: 'png' as const, quality: (request.providerOptions.quality as 'low' | 'medium' | 'high' | 'auto' | undefined) ?? 'auto' };
    const document = this.documents.getDocument(request.documentId);
    if (!document) throw new Error('Target document is no longer open.');
    const response = request.mode === 'create'
      ? await client.images.generate(common, { signal })
      : await client.images.edit({
          ...common,
          image: await Promise.all(request.sourceAssetIds.map(async (id) => {
            const asset = document.assets[id];
            if (!asset?.data) throw new Error(`Source asset ${id} is unavailable.`);
            return toFile(Buffer.from(asset.data, 'base64'), `${asset.name}.${extension(asset.mimeType)}`, { type: asset.mimeType });
          })),
          mask: request.maskAssetId && document.assets[request.maskAssetId]?.data
            ? await toFile(Buffer.from(document.assets[request.maskAssetId].data!, 'base64'), 'mask.png', { type: 'image/png' })
            : undefined,
        }, { signal });
    const mimeType = mimeFromFormat(response.output_format);
    return (response.data ?? []).flatMap((entry) => entry.b64_json ? [{ id: createId('result'), mimeType, data: entry.b64_json, ...dimensions(entry.b64_json) }] : []);
  }

  private async stability(request: GenerationRequest, signal: AbortSignal): Promise<GeneratedOutput[]> {
    const apiKey = await this.credentials.get('stability');
    if (!apiKey) throw new Error('Add a Stability API key in Generation settings.');
    if (!['create', 'inpaint', 'outpaint'].includes(request.mode)) throw new Error(`Stability adapter does not support ${request.mode}; no approximation was sent.`);
    const document = this.documents.getDocument(request.documentId);
    if (!document) throw new Error('Target document is no longer open.');
    const endpoint = request.mode === 'create' ? 'generate/core' : `edit/${request.mode}`;
    const results: GeneratedOutput[] = [];
    for (let index = 0; index < request.resultCount; index += 1) {
      const form = new FormData();
      form.append('prompt', request.prompt);
      if (request.negativePrompt) form.append('negative_prompt', request.negativePrompt);
      if (request.seed !== undefined) form.append('seed', String(request.seed + index));
      form.append('output_format', 'png');
      if (request.aspectIntent && request.aspectIntent !== 'canvas') form.append('aspect_ratio', request.aspectIntent === 'square' ? '1:1' : request.aspectIntent === 'portrait' ? '2:3' : '3:2');
      if (request.mode !== 'create') {
        const source = document.assets[request.sourceAssetIds[0]];
        if (!source?.data) throw new Error('Stability edit requires one source image.');
        form.append('image', new Blob([Buffer.from(source.data, 'base64')], { type: source.mimeType }), `${source.name}.${extension(source.mimeType)}`);
        const mask = request.maskAssetId ? document.assets[request.maskAssetId] : undefined;
        if (mask?.data) form.append('mask', new Blob([Buffer.from(mask.data, 'base64')], { type: mask.mimeType }), 'mask.png');
      }
      const response = await fetch(`https://api.stability.ai/v2beta/stable-image/${endpoint}`, {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, accept: 'image/*', 'stability-client-id': 'AIDraw' }, body: form, signal,
      });
      if (!response.ok) throw Object.assign(new Error(`Stability returned ${response.status}: ${await response.text()}`), { status: response.status });
      const bytes = Buffer.from(await response.arrayBuffer());
      const data = bytes.toString('base64');
      results.push({ id: createId('result'), mimeType: mimeFromFormat(response.headers.get('content-type')?.split('/')[1]), data, ...dimensions(data), seed: request.seed === undefined ? undefined : request.seed + index });
    }
    return results;
  }

  private async comfyUI(jobId: string, request: GenerationRequest, signal: AbortSignal): Promise<GeneratedOutput[]> {
    const endpoint = String(request.providerOptions.endpoint ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
    const workflow = structuredClone(request.providerOptions.workflow) as Record<string, { inputs?: Record<string, unknown> }> | undefined;
    if (!workflow || typeof workflow !== 'object') throw new Error('Choose an API-format ComfyUI workflow.');
    const mappings = (request.providerOptions.mappings ?? {}) as Record<string, string>;
    const entries = Object.entries(workflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>); const byClass = (pattern: RegExp) => entries.filter(([, node]) => pattern.test(node.class_type ?? ''));
    const assign = (mappingName: string, fallbackInput: string, value: unknown, fallbackNodeId?: string): boolean => { const nodeId = mappings[mappingName] ?? fallbackNodeId; if (!nodeId || !workflow[nodeId]?.inputs) return false; workflow[nodeId].inputs![mappings[`${mappingName}Input`] ?? fallbackInput] = value; return true; };
    const textNodes = byClass(/CLIPTextEncode/i); if (!assign('promptNodeId', 'text', request.prompt, textNodes[0]?.[0])) throw new Error('ComfyUI workflow has no mapped prompt input.');
    if (request.negativePrompt && !assign('negativePromptNodeId', 'text', request.negativePrompt, textNodes[1]?.[0])) throw new Error('ComfyUI workflow has no mapped negative-prompt input.');
    const sampler = byClass(/KSampler|RandomNoise/i)[0]?.[0]; if (request.seed !== undefined && !assign('seedNodeId', workflow[sampler]?.inputs?.noise_seed !== undefined ? 'noise_seed' : 'seed', request.seed, sampler)) throw new Error('ComfyUI workflow has no mapped seed input.');
    const latent = byClass(/EmptyLatentImage|EmptySD3LatentImage/i)[0]?.[0]; if (request.size !== 'auto') { assign('widthNodeId', 'width', request.size.width, latent); assign('heightNodeId', 'height', request.size.height, latent); }
    if (request.resultCount > 1 && !assign('batchSizeNodeId', 'batch_size', request.resultCount, latent)) throw new Error('ComfyUI result counts above one require a mapped batch-size node.');
    const document = this.documents.getDocument(request.documentId); if (!document) throw new Error('Target document is no longer open.'); const loadNodes = byClass(/LoadImage/i);
    const upload = async (assetId: string, label: string): Promise<string> => { const asset = document.assets[assetId]; if (!asset?.data) throw new Error(`${label} asset ${assetId} is unavailable.`); const form = new FormData(); form.append('image', new Blob([Buffer.from(asset.data, 'base64')], { type: asset.mimeType }), `${asset.name}.${extension(asset.mimeType)}`); form.append('type', 'input'); form.append('overwrite', 'true'); const response = await fetch(`${endpoint}/upload/image`, { method: 'POST', body: form, signal }); if (!response.ok) throw new Error(`ComfyUI rejected the ${label.toLowerCase()} upload: ${await response.text()}`); const uploaded = await response.json() as { name?: string; subfolder?: string }; if (!uploaded.name) throw new Error(`ComfyUI did not return a filename for the ${label.toLowerCase()}.`); return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name; };
    if (request.mode !== 'create') { const sourceName = await upload(request.sourceAssetIds[0], 'Source'); if (!assign('sourceNodeId', 'image', sourceName, loadNodes[0]?.[0])) throw new Error(`ComfyUI workflow does not expose a source-image node for ${request.mode}.`); }
    if (request.maskAssetId) { const maskName = await upload(request.maskAssetId, 'Mask'); if (!assign('maskNodeId', 'image', maskName, loadNodes[1]?.[0])) throw new Error('ComfyUI workflow does not expose a mapped mask-image node.'); }
    const clientId = randomUUID();
    const websocketUrl = `${endpoint.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
    const socket = new WebSocket(websocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to ComfyUI WebSocket.')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not connect to ComfyUI WebSocket.')); }, { once: true });
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    });
    const queued = await fetch(`${endpoint}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }), signal });
    if (!queued.ok) throw new Error(`ComfyUI rejected the workflow: ${await queued.text()}`);
    const queuedJson = await queued.json() as { prompt_id?: string; error?: string; node_errors?: unknown };
    if (!queuedJson.prompt_id) throw new Error(queuedJson.error ?? `ComfyUI workflow validation failed: ${JSON.stringify(queuedJson.node_errors)}`);
    const promptId = queuedJson.prompt_id;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ComfyUI generation timed out.')), 10 * 60_000);
      const abort = () => { socket.close(); clearTimeout(timeout); reject(new Error('Cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data) as { type?: string; data?: { prompt_id?: string; value?: number; max?: number; node?: string | null } };
        if (message.data?.prompt_id && message.data.prompt_id !== promptId) return;
        if (message.type === 'progress' && message.data?.max) {
          const job = this.documents.getJob(jobId);
          if (job) this.documents.upsertJob({ ...job, progress: 0.1 + 0.8 * ((message.data.value ?? 0) / message.data.max), updatedAt: nowIso(), message: 'ComfyUI is rendering…' });
        }
        if (message.type === 'executing' && message.data?.prompt_id === promptId && message.data.node === null) {
          clearTimeout(timeout); signal.removeEventListener('abort', abort); socket.close(); resolve();
        }
        if (message.type === 'execution_error') { clearTimeout(timeout); reject(new Error(`ComfyUI execution failed: ${event.data}`)); }
      });
    });
    const historyResponse = await fetch(`${endpoint}/history/${encodeURIComponent(promptId)}`, { signal });
    if (!historyResponse.ok) throw new Error('Could not retrieve ComfyUI output history.');
    const history = await historyResponse.json() as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> }>;
    const descriptors = Object.values(history[promptId]?.outputs ?? {}).flatMap((output) => output.images ?? []);
    const outputs: GeneratedOutput[] = [];
    for (const descriptor of descriptors.slice(0, request.resultCount)) {
      const query = new URLSearchParams({ filename: descriptor.filename, subfolder: descriptor.subfolder ?? '', type: descriptor.type ?? 'output' });
      const response = await fetch(`${endpoint}/view?${query}`, { signal });
      if (!response.ok) throw new Error(`Could not retrieve ComfyUI output ${descriptor.filename}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const data = bytes.toString('base64');
      outputs.push({ id: createId('result'), mimeType: mimeFromFormat(response.headers.get('content-type')?.split('/')[1] ?? descriptor.filename.split('.').at(-1)), data, ...dimensions(data), seed: request.seed, providerMetadata: { filename: descriptor.filename, promptId } });
    }
    if (outputs.length === 0) throw new Error('ComfyUI completed without image outputs.');
    return outputs;
  }

  private validateRequest(request: GenerationRequest): void {
    if (!this.documents.getDocument(request.documentId)) throw new Error('Target document is not open.');
    if (!request.prompt.trim()) throw new Error('Prompt is required.');
    if (request.resultCount < 1 || request.resultCount > 4) throw new Error('Result count must be between 1 and 4.');
    if (request.mode !== 'create' && request.sourceAssetIds.length === 0) throw new Error(`${request.mode} requires a source image.`);
    if (request.mode === 'inpaint' && !request.maskAssetId) throw new Error('Inpaint requires a mask.');
  }
}
