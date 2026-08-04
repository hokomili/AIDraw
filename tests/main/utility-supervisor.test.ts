import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument, type PaletteEntry } from '@aidraw/core';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';
import type { UtilityResponse } from '@main/utility-contract';

class FakeUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;
  readonly pid = Math.floor(Math.random() * 10_000) + 1;

  postMessage(message: unknown): void { this.messages.push(message); }
  kill(): boolean { this.killed = true; return true; }
  respond(response: UtilityResponse): void { this.emit('message', response); }
  exit(code: number): void { this.emit('exit', code); }
}

const palette: PaletteEntry[] = [
  { id: 'transparent', name: 'Transparent', color: '#00000000' },
  { id: 'ink', name: 'Ink', color: '#111111ff' },
];

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('RasterUtilitySupervisor', () => {
  it('runs raster tasks one at a time through one supervised process', async () => {
    const worker = new FakeUtility();
    const supervisor = new RasterUtilitySupervisor(() => worker);
    const first = supervisor.quantizeImage(Buffer.from('first'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    const second = supervisor.quantizeImage(Buffer.from('second'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    await nextTurn();
    expect(worker.messages).toHaveLength(1);
    const firstRequest = worker.messages[0] as { id: string };
    worker.respond({ id: firstRequest.id, ok: true, kind: 'quantize-image', changes: [{ x: 0, y: 0, index: 1 }] });
    await expect(first).resolves.toEqual([{ x: 0, y: 0, index: 1 }]);
    await nextTurn();
    expect(worker.messages).toHaveLength(2);
    const secondRequest = worker.messages[1] as { id: string };
    worker.respond({ id: secondRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(second).resolves.toEqual([]);
    expect(supervisor.status()).toMatchObject({ running: true, queued: 0, activeTaskId: undefined });
    supervisor.stop();
    expect(worker.killed).toBe(true);
  });

  it('round-trips export artifacts without exposing worker serialization to callers', async () => {
    const worker = new FakeUtility();
    const supervisor = new RasterUtilitySupervisor(() => worker);
    const pending = supervisor.exportDocument(createIllustrationDocument('Worker export'), 'png');
    await nextTurn();
    const request = worker.messages[0] as { id: string; kind: string; document: { name: string } };
    expect(request).toMatchObject({ kind: 'export-document', document: { name: 'Worker export' } });
    worker.respond({ id: request.id, ok: true, kind: 'export-document', artifact: { dataBase64: Buffer.from('png').toString('base64'), mimeType: 'image/png', extension: 'png', report: { warnings: [], rasterized: [] }, companion: { dataBase64: Buffer.from('{}').toString('base64'), extension: 'json', mimeType: 'application/json' } } });
    const artifact = await pending;
    expect(artifact.data.toString()).toBe('png');
    expect(artifact.companion?.data.toString()).toBe('{}');
    supervisor.stop();
  });

  it('round-trips imported canonical documents through the supervised lane', async () => {
    const worker = new FakeUtility(); const supervisor = new RasterUtilitySupervisor(() => worker); const pending = supervisor.importDocument('C:\\approved\\drawing.svg', false); await nextTurn(); const request = worker.messages[0] as { id: string; kind: string; filePath: string; pixelMode: boolean }; expect(request).toMatchObject({ kind: 'import-document', filePath: 'C:\\approved\\drawing.svg', pixelMode: false }); const document = createIllustrationDocument('Imported in worker'); worker.respond({ id: request.id, ok: true, kind: 'import-document', documents: [document], warnings: ['One fallback'] }); await expect(pending).resolves.toEqual({ documents: [document], warnings: ['One fallback'] }); supervisor.stop();
  });

  it('round-trips bounded observation captures without exposing worker serialization', async () => {
    const worker = new FakeUtility(); const supervisor = new RasterUtilitySupervisor(() => worker); const document = createIllustrationDocument('Observed in worker');
    const pending = supervisor.captureObservation(document, { scale: 2, background: 'transparent', region: { x: 0, y: 0, width: 4, height: 3 } }, 24);
    await nextTurn();
    const request = worker.messages[0] as { id: string; kind: string; maxPixels: number; request: { scale: number }; document: { id: string } };
    expect(request).toMatchObject({ kind: 'capture-observation', maxPixels: 24, request: { scale: 2 }, document: { id: document.id } });
    worker.respond({ id: request.id, ok: true, kind: 'capture-observation', result: { available: true, width: 8, height: 6, data: 'png' } });
    await expect(pending).resolves.toMatchObject({ available: true, width: 8, height: 6, data: 'png' });
    supervisor.stop();
  });

  it('relays generation progress and returns provider outputs on a separate supervised request', async () => {
    const worker = new FakeUtility(); const supervisor = new RasterUtilitySupervisor(() => worker); const document = createIllustrationDocument('Generated in worker'); const progress = vi.fn();
    const request = { documentId: document.id, provider: 'openai' as const, mode: 'create' as const, prompt: 'A brass turkey locomotive', sourceAssetIds: [], size: 'auto' as const, resultCount: 1, providerOptions: {} };
    const pending = supervisor.generate('generation-job', document, request, 'secret-key', { onProgress: progress });
    await nextTurn();
    const message = worker.messages[0] as { id: string; kind: string; credential: string; jobId: string };
    expect(message).toMatchObject({ kind: 'generation-run', jobId: 'generation-job', credential: 'secret-key' });
    worker.respond({ id: message.id, ok: true, kind: 'generation-progress', progress: 0.42, message: 'Rendering' });
    expect(progress).toHaveBeenCalledWith(0.42, 'Rendering');
    const output = { id: 'result', mimeType: 'image/png' as const, data: 'cG5n', width: 1, height: 1 };
    worker.respond({ id: message.id, ok: true, kind: 'generation-run', outputs: [output] });
    await expect(pending).resolves.toEqual([output]);
    supervisor.stop();
  });

  it('lets generation providers clean up before replacing a cancelled worker', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    let workerIndex = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[workerIndex++]);
    const document = createIllustrationDocument('Cancelled generation');
    const controller = new AbortController();
    const generation = supervisor.generate('cancel-job', document, {
      documentId: document.id,
      provider: 'comfyui',
      mode: 'create',
      prompt: 'A clockwork turkey',
      sourceAssetIds: [],
      size: 'auto',
      resultCount: 1,
      providerOptions: { endpoint: 'http://127.0.0.1:8188', workflowPath: 'C:\\approved\\workflow.json' },
    }, undefined, { signal: controller.signal });
    await nextTurn();
    const generationRequest = workers[0].messages[0] as { id: string; kind: string };
    controller.abort();
    await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].messages[1]).toEqual({ id: generationRequest.id, kind: 'utility-cancel' });
    expect(workers[0].killed).toBe(false);

    const queued = supervisor.quantizeImage(Buffer.from('after-cancel'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    await nextTurn();
    expect(workers[0].messages).toHaveLength(2);
    workers[0].respond({ id: generationRequest.id, ok: false, error: { code: 'utility_failed', message: 'AbortError' } });
    await nextTurn();
    expect(workers[0].killed).toBe(true);
    expect(workers[1].messages).toHaveLength(1);
    const quantizeRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: quantizeRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(queued).resolves.toEqual([]);
    supervisor.stop();
  });

  it('rejects a crashed task and starts queued work in a fresh process', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const first = supervisor.quantizeImage(Buffer.from('first'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    const second = supervisor.quantizeImage(Buffer.from('second'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    await nextTurn();
    workers[0].exit(9);
    await expect(first).rejects.toThrow('exited unexpectedly with code 9');
    await nextTurn();
    expect(fork).toHaveBeenCalledTimes(2);
    const request = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: request.id, ok: true, kind: 'quantize-image', changes: [{ x: 0, y: 0, index: 0 }] });
    await expect(second).resolves.toHaveLength(1);
    supervisor.stop();
  });

  it('kills timed-out work and supports AbortSignal cancellation', async () => {
    const timedOutWorker = new FakeUtility();
    const cancelledWorker = new FakeUtility();
    const workers = [timedOutWorker, cancelledWorker];
    let index = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[index++]);
    const timedOut = supervisor.quantizeImage(Buffer.from('timeout'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' }, { timeoutMs: 5 });
    await expect(timedOut).rejects.toThrow('timed out');
    expect(timedOutWorker.killed).toBe(true);

    const controller = new AbortController();
    const cancelled = supervisor.quantizeImage(Buffer.from('cancel'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' }, { signal: controller.signal });
    await nextTurn();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelledWorker.killed).toBe(true);
    supervisor.stop();
  });
});
