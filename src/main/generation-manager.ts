import { createHash } from 'node:crypto';
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
  type PaletteEntry,
  type Provenance,
} from '@aidraw/core';
import type { GeneratedOutput, GenerationJobResult, GenerationRequest } from '../common/generation';
import { validateGenerationRequest } from '../common/generation-capabilities';
import { DocumentService } from './document-service';
import { ProviderCredentialStore } from './provider-credentials';
import { quantizeToPalette } from './quantize';
import { renderDocument } from './render-document';
import { runGenerationProvider, type GenerationProviderRunner } from './generation-provider-runner';

type ComparisonRenderer = (document: Parameters<typeof renderDocument>[0]) => Promise<{ data: string; width: number; height: number }>;
type GenerationQuantizer = (encoded: Buffer, width: number, height: number, palette: PaletteEntry[], alphaThreshold: number, dithering: 'none' | 'bayer-4x4' | 'floyd-steinberg') => Promise<Array<{ x: number; y: number; index: number }>>;

const renderComparisonDirect: ComparisonRenderer = async (document) => {
  const canvas = await renderDocument(document);
  return { data: canvas.toBuffer('image/png').toString('base64'), width: canvas.width, height: canvas.height };
};
const quantizeGeneratedDirect: GenerationQuantizer = async (encoded, width, height, palette, alphaThreshold, dithering) => quantizeToPalette(encoded, width, height, palette, alphaThreshold, dithering);

function mimeFromFormat(format: string | undefined): GeneratedOutput['mimeType'] {
  return format === 'webp' ? 'image/webp' : format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
}

function dimensions(data: string): { width: number; height: number } {
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  if (image.isEmpty()) throw new Error('A provider returned an unreadable image.');
  return image.getSize();
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
    private readonly providerRunner: GenerationProviderRunner = runGenerationProvider,
    private readonly comparisonRenderer: ComparisonRenderer = renderComparisonDirect,
    private readonly quantizeGenerated: GenerationQuantizer = quantizeGeneratedDirect,
  ) {}

  async startHuman(request: GenerationRequest): Promise<{ jobId: string }> {
    this.validateRequest(request);
    const comparisonSource = await this.captureComparisonSource(request);
    const timestamp = nowIso();
    const job: AsyncJob<GenerationJobResult> = {
      id: createId('job'), kind: 'generation', status: 'queued', actor: HUMAN_ACTOR, createdAt: timestamp, updatedAt: timestamp,
      progress: 0, message: `Queued ${request.provider} generation.`, result: { request: structuredClone(request), outputs: [], comparisonSource },
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
    const comparisonSource = await this.captureComparisonSource(request);
    await this.run({ ...job, result: { request: structuredClone(request), outputs: [], comparisonSource } } as AsyncJob<GenerationJobResult>, request);
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
      const outpaintWidth = result.request.mode === 'outpaint' ? Math.max(document.artboard.width, output.width) : document.artboard.width;
      const outpaintHeight = result.request.mode === 'outpaint' ? Math.max(document.artboard.height, output.height) : document.artboard.height;
      const expanded = outpaintWidth > document.artboard.width || outpaintHeight > document.artboard.height;
      let outpaintOffsetX = 0; let outpaintOffsetY = 0;
      if (expanded) {
        const widthGrowth = outpaintWidth - document.artboard.width; const heightGrowth = outpaintHeight - document.artboard.height;
        const requestedLeft = Number(result.request.providerOptions.left); const requestedUp = Number(result.request.providerOptions.up);
        outpaintOffsetX = Number.isInteger(requestedLeft) ? Math.max(0, Math.min(widthGrowth, requestedLeft)) : Math.floor(widthGrowth / 2);
        outpaintOffsetY = Number.isInteger(requestedUp) ? Math.max(0, Math.min(heightGrowth, requestedUp)) : Math.floor(heightGrowth / 2);
        operations.push({ kind: 'illustration.artboard.translate', artboard: { ...document.artboard, width: outpaintWidth, height: outpaintHeight }, offsetX: outpaintOffsetX, offsetY: outpaintOffsetY, expectedRevision: document.revision });
        provenance.conversion = { outpaint: { previousWidth: document.artboard.width, previousHeight: document.artboard.height, width: outpaintWidth, height: outpaintHeight, offsetX: outpaintOffsetX, offsetY: outpaintOffsetY } };
      }
      const timestamp = nowIso();
      const layer: IllustrationLayer = { id: createId('layer'), revision: 0, name: 'Generated result', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', type: 'vector', objectIds: [] };
      const scale = expanded ? 1 : Math.min(1, document.artboard.width / output.width, document.artboard.height / output.height);
      const object: ImageObject = {
        id: createId('object'), revision: 0, name: 'Generated image', createdAt: timestamp, updatedAt: timestamp, createdBy: job.actor.id,
        layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: {
          ...IDENTITY_TRANSFORM, x: expanded ? 0 : (document.artboard.width - output.width * scale) / 2, y: expanded ? 0 : (document.artboard.height - output.height * scale) / 2, scaleX: scale, scaleY: scale,
        }, type: 'image', assetId: asset.id, width: output.width, height: output.height, sourceWidth: output.width, sourceHeight: output.height, filters: [],
      };
      operations.push({ kind: 'illustration.layer.add', layer }, { kind: 'illustration.object.add', object });
    } else {
      const active = document.pixelAssets[document.activeAssetId]; const source = active?.type === 'sprite' ? active : active?.type === 'tileset' ? document.pixelAssets[active.spriteAssetId] : undefined;
      if (source?.type === 'sprite') {
        const sprite = structuredClone(source); const timestamp = nowIso(); const layer: PixelLayer = { id: createId('layer'), revision: 0, name: 'Generated result', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, type: 'pixel', visible: true, locked: false, opacity: 1, blendMode: 'normal' }; sprite.layers[layer.id] = layer; sprite.layerIds.push(layer.id);
        for (const [index, frameId] of sprite.frameIds.entries()) { const celId = createId('cel'); sprite.cels[celId] = { id: celId, revision: 0, name: `${layer.name} · ${sprite.frames[frameId].name}`, createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: layer.id, frameId, chunks: {} }; if (index === 0) writePixels(sprite.cels[celId], await this.quantizeGenerated(bytes, sprite.width, sprite.height, document.palette, document.conversionDefaults.alphaThreshold, document.conversionDefaults.dithering)); }
        operations.push({ kind: 'pixel.asset.replace', asset: sprite, expectedRevision: source.revision }); provenance.conversion = { resample: document.conversionDefaults.resample, paletteMetric: document.conversionDefaults.paletteMetric, dithering: document.conversionDefaults.dithering, alphaThreshold: document.conversionDefaults.alphaThreshold, width: sprite.width, height: sprite.height };
      } else {
        const sprite = createPixelSprite('Generated result', output.width, output.height); writePixels(Object.values(sprite.cels)[0], await this.quantizeGenerated(bytes, sprite.width, sprite.height, document.palette, document.conversionDefaults.alphaThreshold, document.conversionDefaults.dithering)); operations.push({ kind: 'pixel.asset.add', asset: sprite }, { kind: 'pixel.active-asset.set', assetId: sprite.id }); provenance.conversion = { resample: document.conversionDefaults.resample, paletteMetric: document.conversionDefaults.paletteMetric, dithering: document.conversionDefaults.dithering, alphaThreshold: document.conversionDefaults.alphaThreshold, width: sprite.width, height: sprite.height };
      }
    }

    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('accept-generation'), documentId: document.id, actor: HUMAN_ACTOR,
      label: document.kind === 'pixel' ? 'Accept generated image into palette' : 'Accept generated image', createdAt: nowIso(), operations,
      playback: { mode: 'instant', speed: 1 },
    };
    const response = await this.documents.apply(transaction, { trustedProvenance: true });
    if (response.status !== 'committed') return { accepted: false, message: response.message };
    this.documents.upsertJob({ ...job, updatedAt: nowIso(), message: 'Generated result accepted as a new editable layer/cel.', result: { ...result, acceptedOutputId: outputId } });
    return { accepted: true };
  }

  reject(jobId: string, outputId: string): { rejected: boolean; message?: string } {
    const job = this.documents.getJob(jobId) as AsyncJob<GenerationJobResult> | undefined;
    const result = job?.result;
    if (!job || job.status !== 'completed' || !result?.outputs.some((entry) => entry.id === outputId)) return { rejected: false, message: 'Generated result is not available.' };
    if (result.acceptedOutputId === outputId) return { rejected: false, message: 'An accepted result remains part of document provenance and cannot be discarded from this job.' };
    const outputs = result.outputs.filter((entry) => entry.id !== outputId);
    this.documents.upsertJob({ ...job, updatedAt: nowIso(), message: outputs.length ? `${outputs.length} result${outputs.length === 1 ? '' : 's'} remain to compare.` : 'All unaccepted results were rejected.', result: { ...result, outputs } });
    return { rejected: true };
  }

  private async run(job: AsyncJob<GenerationJobResult>, request: GenerationRequest): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    this.documents.upsertJob({ ...job, status: 'running', updatedAt: nowIso(), progress: 0.05, message: `Sending one ${request.provider} request${request.resultCount > 1 ? ` for ${request.resultCount} results` : ''}…` });
    try {
      const document = this.documents.getDocument(request.documentId);
      if (!document) throw new Error('Target document is no longer open.');
      const credential = request.provider === 'comfyui' ? undefined : await this.credentials.get(request.provider);
      const outputs = await this.providerRunner(
        { jobId: job.id, document: structuredClone(document), request: structuredClone(request), credential },
        {
          signal: controller.signal,
          onProgress: (progress, message) => {
            const current = this.documents.getJob(job.id);
            if (current?.status === 'running') this.documents.upsertJob({ ...current, progress, updatedAt: nowIso(), message });
          },
        },
      );
      if (controller.signal.aborted) return;
      if (!outputs.length) throw new Error(`${request.provider} completed without usable image results; AIDraw did not retry the potentially chargeable request.`);
      this.documents.upsertJob({
        ...job, status: 'completed', updatedAt: nowIso(), progress: 1,
        message: outputs.length === request.resultCount ? `${outputs.length} result${outputs.length === 1 ? '' : 's'} ready to compare.` : `${outputs.length} of ${request.resultCount} requested results are available; AIDraw did not retry the potentially chargeable remainder.`, result: { request: structuredClone(request), outputs, comparisonSource: job.result?.comparisonSource },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.documents.upsertJob({ ...job, status: 'failed', updatedAt: nowIso(), progress: 0, message: 'Generation failed without an automatic retry.', error: jobError(error), result: { request: structuredClone(request), outputs: [], comparisonSource: job.result?.comparisonSource } });
    } finally {
      this.abortControllers.delete(job.id);
    }
  }

  private async captureComparisonSource(request: GenerationRequest): Promise<GeneratedOutput> {
    const document = this.documents.getDocument(request.documentId);
    if (!document) throw new Error('Target document is not open.');
    const source = request.sourceAssetIds.map((id) => document.assets[id]).find((asset) => asset?.data && asset.mimeType.startsWith('image/'));
    if (source?.data) {
      const size = dimensions(source.data);
      return { id: createId('comparison-source'), mimeType: mimeFromFormat(source.mimeType.split('/')[1]), data: source.data, ...size };
    }
    const rendered = await this.comparisonRenderer(structuredClone(document));
    return { id: createId('comparison-source'), mimeType: 'image/png', ...rendered };
  }

  private validateRequest(request: GenerationRequest): void {
    validateGenerationRequest(this.documents.getDocument(request.documentId), request);
  }
}
