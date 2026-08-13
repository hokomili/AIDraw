import { isAbsolute, join } from 'node:path';
import { createId, type AIDrawDocument, type PaletteEntry } from '@aidraw/core';
import type { ExportFormat, ExportOptions } from '../common/contracts';
import type { ExportArtifact } from './export-document';
import type { QuantizeImageOptions } from './quantize-image';
import {
  assertExportUtilityResponse,
  assertNormalizeGenerationAcceptanceInput,
  assertNormalizeGenerationAcceptanceUtilityResponse,
  assertGenerationUtilityResponse,
  assertInspectSpriteSheetUtilityResponse,
  isBoundedUtilityErrorResponse,
  isGenerationProgressUtilityResponse,
  assertObservationUtilityResponse,
  assertQuantizeUtilityResponse,
  assertQuantizeUtilityParameters,
  assertValidateImageUtilityResponse,
  MAX_IMAGE_VALIDATION_UTILITY_SOURCE_BYTES,
  validateImportUtilityResponse,
  MAX_QUANTIZE_UTILITY_SOURCE_BYTES,
  type ExportUtilityRequest,
  type InspectSpriteSheetUtilityRequest,
  type QuantizeUtilityRequest,
  type UtilityCancelRequest,
  type UtilityContainmentProbeRequest,
  type UtilityRequest,
  type UtilityResponse,
  type ValidateImageUtilityRequest,
} from './utility-contract';
import {
  displayImageDimensions,
  inspectEmbeddedDocumentImageAssets,
  inspectImageHeader,
  MAX_INLINE_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_PIXELS,
  type ExpectedDecodedImage,
} from './transaction-policy';
import type { SpriteSheetSliceOptions } from '../common/sprite-sheet';
import type { ObservationRequest } from './capture-observation';
import type { GeneratedAcceptancePreparation, GeneratedOutput, GenerationRequest } from '../common/generation';
import type { InterchangeFidelityEntry } from '../common/interchange-fidelity';
import {
  FND09_OBSERVATION_CODEC_E2E_MAX_PIXELS,
  FND09_OBSERVATION_CODEC_E2E_REQUEST,
  isFnd09ObservationCodecE2eEnabled,
} from './utility-observation-codec-e2e-contract';
import {
  FND09_QUANTIZATION_RESULT_E2E_HEIGHT,
  FND09_QUANTIZATION_RESULT_E2E_OPTIONS,
  FND09_QUANTIZATION_RESULT_E2E_PALETTE,
  FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64,
  FND09_QUANTIZATION_RESULT_E2E_WIDTH,
  isFnd09QuantizationResultE2eEnabled,
  type Fnd09QuantizationResultFault,
} from './utility-quantization-result-e2e-contract';
import {
  isFnd09ExportResultE2eEnabled,
  type Fnd09ExportResultFault,
} from './utility-export-result-e2e-contract';
import {
  isFnd09ImportResultE2eEnabled,
  type Fnd09ImportResultFault,
} from './utility-import-result-e2e-contract';
import {
  FND09_GENERATION_RESULT_E2E_PROMPT,
  FND09_GENERATION_RESULT_E2E_SEED,
  isFnd09GenerationResultE2eEnabled,
  type Fnd09GenerationResultFixture,
} from './utility-generation-result-e2e-contract';

export interface UtilityProcessLike {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
  readonly pid?: number;
}

export type UtilityFork = () => UtilityProcessLike | Promise<UtilityProcessLike>;

/** One active request is separate; this is the maximum retained waiting queue per supervisor lane. */
export const MAX_QUEUED_UTILITY_TASKS = 32;

export class UtilityBackpressureError extends Error {
  readonly code = 'utility_queue_full';
  readonly retryable = true;

  constructor() {
    super(`Utility queue reached the ${MAX_QUEUED_UTILITY_TASKS}-task waiting limit. Retry after current work completes.`);
    this.name = 'UtilityBackpressureError';
  }
}

interface PendingTask {
  request: UtilityRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
  onProgress?: (progress: number, message: string) => void;
  resolve: (response: Extract<UtilityResponse, { ok: true }>) => void;
  reject: (error: Error) => void;
}

function abortError(message = 'Utility task was cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function electronUtilityFork(): Promise<UtilityProcessLike> {
  const electron = await import('electron');
  return electron.utilityProcess.fork(join(__dirname, 'utility-worker.js'), [], {
    serviceName: 'AIDraw Raster Utility',
    stdio: 'ignore',
  });
}

/**
 * Single-lane supervised worker for CPU-heavy raster work. Keeping one task in
 * flight makes cancellation deterministic: killing a wedged process cannot
 * discard unrelated jobs, and the next queued task starts in a fresh worker.
 */
export class RasterUtilitySupervisor {
  private worker?: UtilityProcessLike;
  private starting?: Promise<UtilityProcessLike>;
  private current?: PendingTask;
  private cancelling?: { worker: UtilityProcessLike; taskId: string; timer: NodeJS.Timeout };
  private readonly queue: PendingTask[] = [];
  private stopped = false;

  constructor(private readonly fork: UtilityFork = electronUtilityFork) {}

  validateImage(
    encoded: Buffer,
    expected: ExpectedDecodedImage,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    try {
      if (encoded.byteLength > MAX_IMAGE_VALIDATION_UTILITY_SOURCE_BYTES) throw new Error('Image validation utility source exceeds the native binary-entry limit.');
      const header = inspectImageHeader(encoded);
      const display = displayImageDimensions(header);
      if (expected.mimeType !== header.mimeType || expected.width !== display.width || expected.height !== display.height) {
        throw new Error('Image validation utility request disagrees with its source header.');
      }
      if (display.width > MAX_INLINE_IMAGE_DIMENSION || display.height > MAX_INLINE_IMAGE_DIMENSION || display.width * display.height > MAX_INLINE_IMAGE_PIXELS) {
        throw new Error('Image validation utility source exceeds the image safety limit.');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const request: ValidateImageUtilityRequest = {
      id: createId('utility'),
      kind: 'validate-image',
      encodedBase64: encoded.toString('base64'),
      mimeType: expected.mimeType,
      width: expected.width,
      height: expected.height,
    };
    return this.enqueue(request, control).then((response) => {
      if (response.kind !== 'validate-image') throw new Error('Raster utility returned the wrong image-validation result kind.');
    });
  }

  quantizeImage(
    encoded: Buffer,
    width: number,
    height: number,
    palette: PaletteEntry[],
    options: QuantizeImageOptions,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Array<{ x: number; y: number; index: number }>> {
    try {
      if (encoded.byteLength > MAX_QUANTIZE_UTILITY_SOURCE_BYTES) throw new Error('Encoded image exceeds the utility input limit.');
      assertQuantizeUtilityParameters({ width, height, palette, options });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const request: QuantizeUtilityRequest = {
      id: createId('utility'),
      kind: 'quantize-image',
      encodedBase64: encoded.toString('base64'),
      width,
      height,
      palette: structuredClone(palette),
      options: structuredClone(options),
    };
    return this.enqueue(request, control).then((response) => {
      if (response.kind !== 'quantize-image') throw new Error('Raster utility returned the wrong result kind.');
      return response.changes;
    });
  }

  /** Exercise only the fixed isolated packaged-QA quantization result boundary. */
  runE2eQuantizationResultProbe(
    fault: Fnd09QuantizationResultFault,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Array<{ x: number; y: number; index: number }>> {
    if (!isFnd09QuantizationResultE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT,
    })) {
      return Promise.reject(new Error('The quantization-result probe is unavailable outside isolated packaged QA.'));
    }
    const request: QuantizeUtilityRequest = {
      id: createId('utility'),
      kind: 'quantize-image',
      encodedBase64: FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64,
      width: FND09_QUANTIZATION_RESULT_E2E_WIDTH,
      height: FND09_QUANTIZATION_RESULT_E2E_HEIGHT,
      palette: structuredClone(FND09_QUANTIZATION_RESULT_E2E_PALETTE),
      options: structuredClone(FND09_QUANTIZATION_RESULT_E2E_OPTIONS),
      e2eResultFault: fault,
    };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 15_000 }).then((response) => {
      if (response.kind !== 'quantize-image') throw new Error('Raster utility returned the wrong quantization-result probe kind.');
      return response.changes;
    });
  }

  exportDocument(
    document: AIDrawDocument,
    format: ExportFormat,
    options: ExportOptions = {},
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ExportArtifact> {
    const request: ExportUtilityRequest = { id: createId('utility'), kind: 'export-document', document: structuredClone(document), format, options: structuredClone(options) };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 300_000 }).then((response) => {
      if (response.kind !== 'export-document') throw new Error('Raster utility returned the wrong result kind.');
      const artifact = response.artifact;
      return {
        data: Buffer.from(artifact.dataBase64, 'base64'),
        mimeType: artifact.mimeType,
        extension: artifact.extension,
        report: artifact.report,
        companion: artifact.companion ? { data: Buffer.from(artifact.companion.dataBase64, 'base64'), extension: artifact.companion.extension, mimeType: artifact.companion.mimeType, name: artifact.companion.name } : undefined,
        companions: artifact.companions?.map((companion) => ({ data: Buffer.from(companion.dataBase64, 'base64'), extension: companion.extension, mimeType: companion.mimeType, name: companion.name })),
      };
    });
  }

  /** Exercise only the fixed isolated packaged-QA export artifact boundary. */
  runE2eExportResultProbe(
    document: AIDrawDocument,
    fault: Fnd09ExportResultFault,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ExportArtifact> {
    if (!isFnd09ExportResultE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_EXPORT_RESULT,
    })) {
      return Promise.reject(new Error('The export-result probe is unavailable outside isolated packaged QA.'));
    }
    const request: ExportUtilityRequest = {
      id: createId('utility'),
      kind: 'export-document',
      document: structuredClone(document),
      format: 'sprite-sheet',
      options: { scale: 1 },
      e2eArtifactFault: fault,
    };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 15_000 }).then((response) => {
      if (response.kind !== 'export-document') throw new Error('Raster utility returned the wrong export-result probe kind.');
      const artifact = response.artifact;
      return {
        data: Buffer.from(artifact.dataBase64, 'base64'),
        mimeType: artifact.mimeType,
        extension: artifact.extension,
        report: artifact.report,
        companion: artifact.companion ? { data: Buffer.from(artifact.companion.dataBase64, 'base64'), extension: artifact.companion.extension, mimeType: artifact.companion.mimeType, name: artifact.companion.name } : undefined,
        companions: artifact.companions?.map((companion) => ({ data: Buffer.from(companion.dataBase64, 'base64'), extension: companion.extension, mimeType: companion.mimeType, name: companion.name })),
      };
    });
  }

  importDocument(
    filePath: string,
    pixelMode: boolean,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[]; fidelity?: InterchangeFidelityEntry[] }> {
    const request: Extract<UtilityRequest, { kind: 'import-document' }> = { id: createId('utility'), kind: 'import-document', filePath, pixelMode };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 300_000 }).then(async (response) => {
      if (response.kind !== 'import-document') throw new Error('Raster utility returned the wrong result kind.');
      await this.validateImportedDocumentImages(response.documents, control);
      return { documents: response.documents, warnings: response.warnings, ...(response.fidelity === undefined ? {} : { fidelity: response.fidelity }) };
    });
  }

  /** Exercise only the fixed isolated packaged-QA imported-result boundary. */
  runE2eImportResultProbe(
    filePath: string,
    fault: Fnd09ImportResultFault,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[]; fidelity?: InterchangeFidelityEntry[] }> {
    if (!isFnd09ImportResultE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_IMPORT_RESULT,
    })) {
      return Promise.reject(new Error('The import-result probe is unavailable outside isolated packaged QA.'));
    }
    const request: Extract<UtilityRequest, { kind: 'import-document' }> = {
      id: createId('utility'),
      kind: 'import-document',
      filePath,
      pixelMode: false,
      e2eResultFault: fault,
    };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 15_000 }).then(async (response) => {
      if (response.kind !== 'import-document') throw new Error('Raster utility returned the wrong import-result probe kind.');
      await this.validateImportedDocumentImages(response.documents, control);
      return { documents: response.documents, warnings: response.warnings, ...(response.fidelity === undefined ? {} : { fidelity: response.fidelity }) };
    });
  }

  importSpriteSheet(
    filePath: string,
    metadata: { options: SpriteSheetSliceOptions; name: string; mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'; expectedSha256?: string },
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[]; fidelity?: InterchangeFidelityEntry[] }> {
    const request: Extract<UtilityRequest, { kind: 'import-document' }> = { id: createId('utility'), kind: 'import-document', filePath, pixelMode: true, spriteSheet: structuredClone(metadata) };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 300_000 }).then(async (response) => {
      if (response.kind !== 'import-document') throw new Error('Raster utility returned the wrong result kind.');
      await this.validateImportedDocumentImages(response.documents, control);
      return { documents: response.documents, warnings: response.warnings, ...(response.fidelity === undefined ? {} : { fidelity: response.fidelity }) };
    });
  }

  inspectSpriteSheet(
    filePath: string,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ sha256: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; previewPng: Buffer }> {
    if (!filePath || filePath.length > 32_768 || filePath.includes('\0') || !isAbsolute(filePath)) {
      return Promise.reject(new Error('Sprite-sheet inspection requires one absolute approved path.'));
    }
    const request: InspectSpriteSheetUtilityRequest = { id: createId('utility'), kind: 'inspect-sprite-sheet', filePath };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 120_000 }).then((response) => {
      if (response.kind !== 'inspect-sprite-sheet') throw new Error('Raster utility returned the wrong sprite-sheet inspection result kind.');
      return {
        sha256: response.sha256,
        mimeType: response.mimeType,
        width: response.width,
        height: response.height,
        previewPng: Buffer.from(response.previewDataBase64, 'base64'),
      };
    });
  }

  private async validateImportedDocumentImages(
    documents: AIDrawDocument[],
    control: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    const validated = new Set<string>();
    for (const document of documents) {
      const images = inspectEmbeddedDocumentImageAssets(document, {
        maxBytes: MAX_IMAGE_VALIDATION_UTILITY_SOURCE_BYTES,
        limitLabel: '128 MiB',
        labelPrefix: 'Raster utility imported asset',
      });
      for (const image of images) {
        const identity = `${image.asset.sha256.toLowerCase()}:${image.expected.mimeType}:${image.expected.width}x${image.expected.height}`;
        if (validated.has(identity)) continue;
        validated.add(identity);
        try {
          await this.validateImage(image.bytes, image.expected, {
            signal: control.signal,
            timeoutMs: Math.min(control.timeoutMs ?? 120_000, 120_000),
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          throw new Error(`Raster utility returned an imported image that could not be decoded safely: ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
    }
  }

  captureObservation(
    document: AIDrawDocument,
    request: ObservationRequest,
    maxPixels: number,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const utilityRequest: Extract<UtilityRequest, { kind: 'capture-observation' }> = {
      id: createId('utility'),
      kind: 'capture-observation',
      document: structuredClone(document),
      request: structuredClone(request),
      maxPixels,
    };
    return this.enqueue(utilityRequest, { ...control, timeoutMs: control.timeoutMs ?? 120_000 }).then((response) => {
      if (response.kind !== 'capture-observation') throw new Error('Raster utility returned the wrong result kind.');
      return response.result;
    });
  }

  /** Exercise only the fixed isolated packaged-QA observation codec boundary. */
  runE2eObservationCodecProbe(
    document: AIDrawDocument,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    if (!isFnd09ObservationCodecE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_OBSERVATION_CODEC,
    })) {
      return Promise.reject(new Error('The observation codec probe is unavailable outside isolated packaged QA.'));
    }
    const utilityRequest: Extract<UtilityRequest, { kind: 'capture-observation' }> = {
      id: createId('utility'),
      kind: 'capture-observation',
      document: structuredClone(document),
      request: structuredClone(FND09_OBSERVATION_CODEC_E2E_REQUEST),
      maxPixels: FND09_OBSERVATION_CODEC_E2E_MAX_PIXELS,
      e2eCorruptIdat: true,
    };
    return this.enqueue(utilityRequest, { ...control, timeoutMs: control.timeoutMs ?? 15_000 }).then((response) => {
      if (response.kind !== 'capture-observation') throw new Error('Raster utility returned the wrong observation-codec result kind.');
      return response.result;
    });
  }

  generate(
    jobId: string,
    document: AIDrawDocument,
    request: GenerationRequest,
    credential: string | undefined,
    control: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (progress: number, message: string) => void } = {},
  ): Promise<GeneratedOutput[]> {
    const utilityRequest: Extract<UtilityRequest, { kind: 'generation-run' }> = {
      id: createId('utility'),
      kind: 'generation-run',
      jobId,
      document: structuredClone(document),
      request: structuredClone(request),
      credential,
    };
    return this.enqueue(utilityRequest, { ...control, timeoutMs: control.timeoutMs ?? 11 * 60_000 }).then((response) => {
      if (response.kind !== 'generation-run') throw new Error('Generation utility returned the wrong result kind.');
      return response.outputs;
    });
  }

  /** Exercise only the fixed provider-free packaged-QA generation-result boundary. */
  runE2eGenerationResultProbe(
    document: AIDrawDocument,
    fixture: Fnd09GenerationResultFixture,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<GeneratedOutput[]> {
    if (!isFnd09GenerationResultE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_GENERATION_RESULT,
    })) {
      return Promise.reject(new Error('The generation-result probe is unavailable outside isolated packaged QA.'));
    }
    const request: Extract<UtilityRequest, { kind: 'generation-run' }> = {
      id: createId('utility'),
      kind: 'generation-run',
      jobId: 'fnd09-generation-result-local-fixture',
      document: structuredClone(document),
      request: {
        documentId: document.id,
        provider: 'stability',
        mode: 'create',
        prompt: FND09_GENERATION_RESULT_E2E_PROMPT,
        sourceAssetIds: [],
        size: { width: 1, height: 1 },
        resultCount: 1,
        seed: FND09_GENERATION_RESULT_E2E_SEED,
        providerOptions: {},
      },
      e2eResultFixture: fixture,
    };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 15_000 }).then((response) => {
      if (response.kind !== 'generation-run') throw new Error('Generation utility returned the wrong generation-result probe kind.');
      return response.outputs;
    });
  }

  normalizeGeneratedOutput(
    output: GeneratedOutput,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<GeneratedAcceptancePreparation> {
    try { assertNormalizeGenerationAcceptanceInput(output); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    const utilityRequest: Extract<UtilityRequest, { kind: 'normalize-generation-acceptance' }> = {
      id: createId('utility'),
      kind: 'normalize-generation-acceptance',
      output: structuredClone(output),
    };
    return this.enqueue(utilityRequest, control).then((response) => {
      if (response.kind !== 'normalize-generation-acceptance') throw new Error('Raster utility returned the wrong generation-acceptance result kind.');
      return response.result;
    });
  }

  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string } {
    return { running: Boolean(this.worker), pid: this.worker?.pid, queued: this.queue.length, activeTaskId: this.current?.request.id };
  }

  /** Exercise only the fixed isolated packaged-QA crash/hang boundary. */
  runE2eContainmentProbe(
    mode: UtilityContainmentProbeRequest['mode'],
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    const enabled = mode === 'pressure-gate'
      ? process.env.AIDRAW_E2E_UTILITY_PRESSURE === '1'
      : process.env.AIDRAW_E2E_UTILITY_CONTAINMENT === '1';
    if (process.env.NODE_ENV !== 'test' || !enabled) {
      const message = mode === 'pressure-gate'
        ? 'The utility pressure probe is unavailable outside isolated packaged QA.'
        : 'The utility containment probe is unavailable outside isolated packaged QA.';
      return Promise.reject(new Error(message));
    }
    const request: UtilityContainmentProbeRequest = { id: createId('utility'), kind: 'containment-probe', mode };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 15_000 }).then((response) => {
      if (response.kind !== 'containment-probe') throw new Error('Raster utility returned the wrong containment-probe result kind.');
    });
  }

  stop(): void {
    this.stopped = true;
    const error = abortError('Raster utility supervisor stopped.');
    if (this.current) this.finish(this.current, error);
    for (const task of this.queue.splice(0)) this.finish(task, error);
    if (this.cancelling) { clearTimeout(this.cancelling.timer); this.cancelling = undefined; }
    const worker = this.worker;
    this.worker = undefined;
    worker?.kill();
  }

  private cancel(id: string): void {
    const queuedIndex = this.queue.findIndex((task) => task.request.id === id);
    if (queuedIndex >= 0) { this.finish(this.queue.splice(queuedIndex, 1)[0], abortError()); return; }
    if (this.current?.request.id !== id) return;
    const task = this.current;
    const worker = this.worker;
    if (task.request.kind === 'generation-run' && worker) { this.beginGracefulGenerationCancel(task, worker, abortError()); return; }
    this.current = undefined; this.finish(task, abortError()); this.worker = undefined; worker?.kill(); void this.pump();
  }

  private beginGracefulGenerationCancel(task: PendingTask, worker: UtilityProcessLike, error: Error): void {
    this.current = undefined; this.finish(task, error);
    try { worker.postMessage({ id: task.request.id, kind: 'utility-cancel' } satisfies UtilityCancelRequest); }
    catch { if (this.worker === worker) this.worker = undefined; worker.kill(); void this.pump(); return; }
    const timer = setTimeout(() => this.finishGracefulGenerationCancel(worker, task.request.id), 2_500); timer.unref();
    this.cancelling = { worker, taskId: task.request.id, timer };
  }

  private finishGracefulGenerationCancel(worker: UtilityProcessLike, taskId: string, killWorker = true): void {
    if (!this.cancelling || this.cancelling.worker !== worker || this.cancelling.taskId !== taskId) return;
    clearTimeout(this.cancelling.timer); this.cancelling = undefined;
    if (this.worker === worker) this.worker = undefined;
    if (killWorker) worker.kill();
    void this.pump();
  }

  private enqueue(request: UtilityRequest, control: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (progress: number, message: string) => void }): Promise<Extract<UtilityResponse, { ok: true }>> {
    if (this.stopped) return Promise.reject(new Error('Raster utility supervisor is stopped.'));
    if (control.signal?.aborted) return Promise.reject(abortError());
    if (this.queue.length >= MAX_QUEUED_UTILITY_TASKS) return Promise.reject(new UtilityBackpressureError());
    return new Promise((resolve, reject) => {
      const task: PendingTask = { request, timeoutMs: control.timeoutMs ?? 120_000, signal: control.signal, onProgress: control.onProgress, resolve, reject };
      task.onAbort = () => this.cancel(request.id);
      control.signal?.addEventListener('abort', task.onAbort, { once: true });
      this.queue.push(task);
      void this.pump();
    });
  }

  private async ensureWorker(): Promise<UtilityProcessLike> {
    if (this.worker) return this.worker;
    if (!this.starting) this.starting = Promise.resolve(this.fork()).then((worker) => {
      this.starting = undefined;
      if (this.stopped) { worker.kill(); throw new Error('Raster utility supervisor is stopped.'); }
      this.worker = worker;
      worker.on('message', (message) => this.handleMessage(worker, message));
      worker.on('exit', (code) => this.handleExit(worker, code));
      return worker;
    }, (error) => { this.starting = undefined; throw error; });
    return this.starting;
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.current || this.cancelling || this.queue.length === 0) return;
    let worker: UtilityProcessLike;
    try { worker = await this.ensureWorker(); }
    catch (error) {
      const task = this.queue.shift();
      if (task) this.finish(task, error instanceof Error ? error : new Error(String(error)));
      if (this.queue.length) void this.pump();
      return;
    }
    if (this.stopped || this.current || this.cancelling) return;
    const task = this.queue.shift();
    if (!task) return;
    this.current = task;
    task.timer = setTimeout(() => {
      if (this.current !== task) return;
      const error = new Error(`Raster utility task timed out after ${task.timeoutMs} ms.`);
      if (task.request.kind === 'generation-run') { this.beginGracefulGenerationCancel(task, worker, error); return; }
      this.current = undefined; this.finish(task, error); if (this.worker === worker) this.worker = undefined; worker.kill(); void this.pump();
    }, task.timeoutMs);
    task.timer.unref();
    try { worker.postMessage(task.request); }
    catch (error) {
      this.current = undefined;
      this.finish(task, error instanceof Error ? error : new Error(String(error)));
      if (this.worker === worker) this.worker = undefined;
      worker.kill();
      void this.pump();
    }
  }

  private handleMessage(worker: UtilityProcessLike, value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const response = value as UtilityResponse;
    if (this.cancelling?.worker === worker && response.id === this.cancelling.taskId && (!response.ok || response.kind !== 'generation-progress')) { this.finishGracefulGenerationCancel(worker, response.id); return; }
    if (worker !== this.worker || !this.current) return;
    if (response.id !== this.current.request.id) return;
    if (typeof response.ok !== 'boolean') {
      this.rejectInvalidResponse(worker, this.current, new Error('Raster utility returned a malformed response envelope.'));
      return;
    }
    if (response.ok && response.kind === 'generation-progress') {
      if (isGenerationProgressUtilityResponse(this.current.request, response)) this.current.onProgress?.(response.progress, response.message);
      return;
    }
    const task = this.current;
    if (response.ok) {
      try {
        if (response.kind !== task.request.kind) throw new Error('Raster utility returned the wrong result kind.');
        if (task.request.kind === 'validate-image') assertValidateImageUtilityResponse(task.request, response);
        if (task.request.kind === 'quantize-image') assertQuantizeUtilityResponse(task.request, response);
        if (task.request.kind === 'export-document') assertExportUtilityResponse(task.request, response);
        if (task.request.kind === 'capture-observation') assertObservationUtilityResponse(task.request, response);
        if (task.request.kind === 'generation-run') assertGenerationUtilityResponse(task.request, response);
        if (task.request.kind === 'normalize-generation-acceptance') assertNormalizeGenerationAcceptanceUtilityResponse(task.request, response);
        if (task.request.kind === 'import-document') {
          const imported = validateImportUtilityResponse(task.request, response);
          Object.assign(response, imported);
        }
        if (task.request.kind === 'inspect-sprite-sheet') assertInspectSpriteSheetUtilityResponse(task.request, response);
      } catch (error) {
        this.rejectInvalidResponse(worker, task, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    } else if (!isBoundedUtilityErrorResponse(response.error)) {
      this.rejectInvalidResponse(worker, task, new Error('Raster utility returned a malformed error response.'));
      return;
    }
    this.current = undefined;
    if (response.ok) this.finish(task, undefined, response);
    else this.finish(task, new Error(`${response.error.code}: ${response.error.message}`));
    void this.pump();
  }

  private rejectInvalidResponse(worker: UtilityProcessLike, task: PendingTask, error: Error): void {
    this.current = undefined;
    this.finish(task, error);
    if (this.worker === worker) this.worker = undefined;
    worker.kill();
    void this.pump();
  }

  private handleExit(worker: UtilityProcessLike, code: number): void {
    if (this.cancelling?.worker === worker) { const taskId = this.cancelling.taskId; this.finishGracefulGenerationCancel(worker, taskId, false); return; }
    if (worker !== this.worker) return;
    this.worker = undefined;
    if (this.current) {
      const task = this.current;
      this.current = undefined;
      this.finish(task, new Error(`Raster utility exited unexpectedly with code ${code}.`));
    }
    void this.pump();
  }

  private finish(task: PendingTask, error?: Error, response?: Extract<UtilityResponse, { ok: true }>): void {
    if (task.timer) clearTimeout(task.timer);
    task.signal?.removeEventListener('abort', task.onAbort!);
    if (error) task.reject(error);
    else if (response) task.resolve(response);
    else task.reject(new Error('Raster utility completed without a result.'));
  }
}
