import { join } from 'node:path';
import { createId, type AIDrawDocument, type PaletteEntry } from '@aidraw/core';
import type { ExportFormat, ExportOptions } from '../common/contracts';
import type { ExportArtifact } from './export-document';
import type { QuantizeImageOptions } from './quantize-image';
import type { ExportUtilityRequest, QuantizeUtilityRequest, UtilityCancelRequest, UtilityRequest, UtilityResponse } from './utility-contract';
import type { SpriteSheetSliceOptions } from '../common/sprite-sheet';
import type { ObservationRequest } from './capture-observation';
import type { GeneratedOutput, GenerationRequest } from '../common/generation';

export interface UtilityProcessLike {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
  readonly pid?: number;
}

export type UtilityFork = () => UtilityProcessLike | Promise<UtilityProcessLike>;

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

  quantizeImage(
    encoded: Buffer,
    width: number,
    height: number,
    palette: PaletteEntry[],
    options: QuantizeImageOptions,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Array<{ x: number; y: number; index: number }>> {
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

  importDocument(
    filePath: string,
    pixelMode: boolean,
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[] }> {
    const request: Extract<UtilityRequest, { kind: 'import-document' }> = { id: createId('utility'), kind: 'import-document', filePath, pixelMode };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 300_000 }).then((response) => {
      if (response.kind !== 'import-document') throw new Error('Raster utility returned the wrong result kind.');
      return { documents: response.documents, warnings: response.warnings };
    });
  }

  importSpriteSheet(
    filePath: string,
    metadata: { options: SpriteSheetSliceOptions; name: string; mimeType: string; expectedSha256: string },
    control: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[] }> {
    const request: Extract<UtilityRequest, { kind: 'import-document' }> = { id: createId('utility'), kind: 'import-document', filePath, pixelMode: true, spriteSheet: structuredClone(metadata) };
    return this.enqueue(request, { ...control, timeoutMs: control.timeoutMs ?? 300_000 }).then((response) => {
      if (response.kind !== 'import-document') throw new Error('Raster utility returned the wrong result kind.');
      return { documents: response.documents, warnings: response.warnings };
    });
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

  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string } {
    return { running: Boolean(this.worker), pid: this.worker?.pid, queued: this.queue.length, activeTaskId: this.current?.request.id };
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
    return new Promise((resolve, reject) => {
      const task: PendingTask = { request, timeoutMs: control.timeoutMs ?? 120_000, signal: control.signal, onProgress: control.onProgress, resolve, reject };
      if (control.signal?.aborted) { reject(abortError()); return; }
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
    if (response.id !== this.current.request.id || typeof response.ok !== 'boolean') return;
    if (response.ok && response.kind === 'generation-progress') {
      if (Number.isFinite(response.progress) && response.progress >= 0 && response.progress <= 1 && typeof response.message === 'string') this.current.onProgress?.(response.progress, response.message);
      return;
    }
    const task = this.current;
    this.current = undefined;
    if (response.ok) this.finish(task, undefined, response);
    else this.finish(task, new Error(`${response.error.code}: ${response.error.message}`));
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
