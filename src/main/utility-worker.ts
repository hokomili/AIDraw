import { quantizeImageToPalette } from './quantize-image';
import type { SerializedExportArtifact, UtilityRequest, UtilityResponse } from './utility-contract';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSpriteSheetSliceOptions } from '../common/sprite-sheet';
import { validateGenerationRequest } from '../common/generation-capabilities';

const generationControllers = new Map<string, AbortController>();

function validateRequest(value: unknown): UtilityRequest {
  if (!value || typeof value !== 'object') throw new Error('Utility request must be an object.');
  const base = value as { id?: unknown; kind?: unknown };
  if (typeof base.id !== 'string' || !base.id || !['quantize-image', 'export-document', 'import-document', 'capture-observation', 'generation-run'].includes(String(base.kind))) throw new Error('Unknown utility request.');
  if (base.kind === 'generation-run') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'generation-run' }>>;
    if (!request.document || typeof request.document !== 'object' || !['illustration', 'pixel'].includes(request.document.kind)) throw new Error('Generation utility requires a canonical document.');
    if (!request.request || typeof request.request !== 'object') throw new Error('Generation utility requires a provider request.');
    if (typeof request.jobId !== 'string' || !request.jobId || request.jobId.length > 200) throw new Error('Generation utility requires a bounded job id.');
    if (request.credential !== undefined && (typeof request.credential !== 'string' || request.credential.length < 1 || request.credential.length > 8_192)) throw new Error('Generation utility credential is invalid.');
    if (Buffer.byteLength(JSON.stringify(request.request), 'utf8') > 2 * 1024 * 1024) throw new Error('Generation utility request exceeds 2 MiB.');
    validateGenerationRequest(request.document, request.request);
    return request as UtilityRequest;
  }
  if (base.kind === 'capture-observation') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'capture-observation' }>>;
    if (!request.document || typeof request.document !== 'object' || !['illustration', 'pixel'].includes(request.document.kind)) throw new Error('Observation utility requires a canonical document.');
    if (!request.request || !Number.isInteger(request.request.scale) || request.request.scale < 1 || request.request.scale > 16) throw new Error('Observation utility requires a 1–16 integer scale.');
    if (typeof request.request.background !== 'string' || !['document', 'transparent'].includes(request.request.background) && !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(request.request.background)) throw new Error('Observation utility requires a valid background.');
    const maxPixels = request.maxPixels;
    if (typeof maxPixels !== 'number' || !Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 4_194_304) throw new Error('Observation utility pixel budget is invalid.');
    const region = request.request.region;
    if (region && (!Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(region.width) || !Number.isInteger(region.height) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1)) throw new Error('Observation utility region is invalid.');
    return request as UtilityRequest;
  }
  if (base.kind === 'import-document') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'import-document' }>>;
    if (typeof request.filePath !== 'string' || request.filePath.length < 1 || request.filePath.length > 32_768 || request.filePath.includes('\0') || !isAbsolute(request.filePath)) throw new Error('Import utility requires one absolute approved path.');
    if (typeof request.pixelMode !== 'boolean') throw new Error('Import utility requires an explicit target mode.');
    if (request.spriteSheet) {
      validateSpriteSheetSliceOptions(request.spriteSheet.options);
      if (typeof request.spriteSheet.name !== 'string' || !request.spriteSheet.name || typeof request.spriteSheet.mimeType !== 'string' || !request.spriteSheet.mimeType.startsWith('image/') || !/^[a-f0-9]{64}$/i.test(request.spriteSheet.expectedSha256)) throw new Error('Invalid sprite-sheet utility metadata.');
    }
    return request as UtilityRequest;
  }
  if (base.kind === 'export-document') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'export-document' }>>;
    if (!request.document || typeof request.document !== 'object' || !['illustration', 'pixel'].includes(request.document.kind)) throw new Error('Export utility requires a canonical document.');
    if (typeof request.format !== 'string' || !['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'gif', 'apng', 'sprite-sheet', 'tiled-json', 'tiled-xml'].includes(request.format)) throw new Error('Unsupported export format.');
    return request as UtilityRequest;
  }
  const request = value as Partial<Extract<UtilityRequest, { kind: 'quantize-image' }>>;
  if (typeof request.encodedBase64 !== 'string' || request.encodedBase64.length > 2_000_000) throw new Error('Encoded image exceeds the utility input limit.');
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || Number(request.width) < 1 || Number(request.height) < 1 || Number(request.width) > 8_192 || Number(request.height) > 8_192 || Number(request.width) * Number(request.height) > 1_000_000) throw new Error('Quantization dimensions exceed the one-million-pixel utility limit.');
  if (!Array.isArray(request.palette) || request.palette.length < 2 || request.palette.length > 256) throw new Error('Quantization requires a 2–256 entry palette.');
  if (!request.options || !['none', 'bayer-4x4', 'floyd-steinberg'].includes(request.options.dithering) || !Number.isFinite(request.options.alphaThreshold) || request.options.alphaThreshold < 0 || request.options.alphaThreshold > 1) throw new Error('Invalid quantization settings.');
  return request as UtilityRequest;
}

if (!process.parentPort) throw new Error('AIDraw utility worker requires an Electron parent port.');

process.parentPort.on('message', (event) => {
  const control = event.data as { id?: unknown; kind?: unknown };
  if (control?.kind === 'utility-cancel' && typeof control.id === 'string') { generationControllers.get(control.id)?.abort(); return; }
  const generationController = control?.kind === 'generation-run' && typeof control.id === 'string'
    ? new AbortController()
    : undefined;
  if (generationController) generationControllers.set(control.id as string, generationController);
  void (async () => {
    let id = typeof control.id === 'string' ? control.id : 'unknown';
    try {
      const request = validateRequest(event.data);
      id = request.id;
      if (request.kind === 'quantize-image') {
        const changes = await quantizeImageToPalette(
          Buffer.from(request.encodedBase64, 'base64'),
          request.width,
          request.height,
          request.palette,
          request.options,
        );
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, changes } satisfies UtilityResponse);
      } else if (request.kind === 'export-document') {
        const { exportDocument } = await import('./export-document');
        const artifact = await exportDocument(request.document, request.format, request.options);
        const serialized: SerializedExportArtifact = {
          dataBase64: artifact.data.toString('base64'),
          mimeType: artifact.mimeType,
          extension: artifact.extension,
          report: artifact.report,
          companion: artifact.companion ? { dataBase64: artifact.companion.data.toString('base64'), extension: artifact.companion.extension, mimeType: artifact.companion.mimeType, name: artifact.companion.name } : undefined,
          companions: artifact.companions?.map((companion) => ({ dataBase64: companion.data.toString('base64'), extension: companion.extension, mimeType: companion.mimeType, name: companion.name })),
        };
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, artifact: serialized } satisfies UtilityResponse);
      } else if (request.kind === 'import-document') {
        const importer = await import('./import-document');
        let imported;
        if (request.spriteSheet) {
          const bytes = await importer.readBoundedImportFile(request.filePath); if (createHash('sha256').update(bytes).digest('hex') !== request.spriteSheet.expectedSha256) throw new Error('The selected sprite-sheet file changed before the utility process read it.');
          imported = await importer.importSlicedSpriteSheetBytes(bytes, request.spriteSheet.name, request.spriteSheet.mimeType, request.spriteSheet.options);
        } else imported = await importer.importDocument(request.filePath, request.pixelMode);
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, documents: imported.documents, warnings: imported.warnings } satisfies UtilityResponse);
      } else if (request.kind === 'capture-observation') {
        const { captureObservation } = await import('./capture-observation');
        const result = await captureObservation(request.document, request.request, request.maxPixels);
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, result } satisfies UtilityResponse);
      } else {
        const { runGenerationProvider } = await import('./generation-provider-runner');
        const controller = generationController ?? new AbortController();
        const outputs = await runGenerationProvider(request, { signal: controller.signal, onProgress: (progress, message) => process.parentPort!.postMessage({ id, ok: true, kind: 'generation-progress', progress, message } satisfies UtilityResponse) });
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, outputs } satisfies UtilityResponse);
      }
    } catch (error) {
      process.parentPort!.postMessage({ id, ok: false, error: { code: 'utility_failed', message: error instanceof Error ? error.message : String(error) } } satisfies UtilityResponse);
    } finally {
      if (generationController) generationControllers.delete(id);
    }
  })();
});
