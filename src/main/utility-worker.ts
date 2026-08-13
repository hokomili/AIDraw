import { quantizeImageToPalette } from './quantize-image';
import { runImportUtilityRequest } from './utility-import';
import {
  assertNormalizeGenerationAcceptanceInput,
  assertImportUtilityResponseEnvelope,
  assertQuantizeUtilityParameters,
  assertValidateImageUtilityRequest,
  isGenerationProgressUtilityResponse,
  MAX_QUANTIZE_UTILITY_BASE64_CHARACTERS,
  type SerializedExportArtifact,
  type UtilityRequest,
  type UtilityResponse,
} from './utility-contract';
import { validateUtilityImage } from './utility-image-validation';
import { boundedUtilityErrorMessage } from './utility-resource-policy';
import { isAbsolute } from 'node:path';
import { validateSpriteSheetSliceOptions } from '../common/sprite-sheet';
import { validateGenerationRequest } from '../common/generation-capabilities';
import {
  resolveFnd09GenerationNormalizationE2eFromEnvironment,
  writeFnd09GenerationNormalizationE2eProbe,
} from './generation-normalization-e2e-contract';
import {
  corruptFnd09ObservationIdat,
  FND09_OBSERVATION_CODEC_E2E_HOLD_MS,
  isFnd09ObservationCodecE2eEnabled,
} from './utility-observation-codec-e2e-contract';
import {
  createFnd09InvalidQuantizationResult,
  FND09_QUANTIZATION_RESULT_E2E_HOLD_MS,
  isFnd09QuantizationResultE2eEnabled,
  isFnd09QuantizationResultFault,
} from './utility-quantization-result-e2e-contract';
import {
  createFnd09InvalidExportArtifact,
  FND09_EXPORT_RESULT_E2E_HOLD_MS,
  isFnd09ExportResultE2eEnabled,
  isFnd09ExportResultFault,
} from './utility-export-result-e2e-contract';
import {
  createFnd09InvalidImportResult,
  FND09_IMPORT_RESULT_E2E_HOLD_MS,
  isFnd09ImportResultE2eEnabled,
  isFnd09ImportResultFault,
} from './utility-import-result-e2e-contract';
import {
  createFnd09GenerationResultOutputs,
  FND09_GENERATION_RESULT_E2E_HOLD_MS,
  isFnd09GenerationResultE2eEnabled,
  isFnd09GenerationResultFixture,
  isFnd09GenerationResultRequest,
} from './utility-generation-result-e2e-contract';

const generationControllers = new Map<string, AbortController>();

function validateRequest(value: unknown): UtilityRequest {
  if (!value || typeof value !== 'object') throw new Error('Utility request must be an object.');
  const base = value as { id?: unknown; kind?: unknown };
  if (typeof base.id !== 'string' || !base.id || !['validate-image', 'quantize-image', 'export-document', 'import-document', 'capture-observation', 'generation-run', 'normalize-generation-acceptance', 'containment-probe'].includes(String(base.kind))) throw new Error('Unknown utility request.');
  if (base.kind === 'validate-image') {
    assertValidateImageUtilityRequest(value);
    return value;
  }
  if (base.kind === 'containment-probe') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'containment-probe' }>>;
    if (request.mode !== 'crash' && request.mode !== 'hang' && request.mode !== 'pressure-gate') throw new Error('Unknown utility containment probe mode.');
    const enabled = request.mode === 'pressure-gate'
      ? process.env.AIDRAW_E2E_UTILITY_PRESSURE === '1'
      : process.env.AIDRAW_E2E_UTILITY_CONTAINMENT === '1';
    if (process.env.NODE_ENV !== 'test' || !enabled) {
      const message = request.mode === 'pressure-gate'
        ? 'The utility pressure probe is unavailable outside isolated packaged QA.'
        : 'The utility containment probe is unavailable outside isolated packaged QA.';
      throw new Error(message);
    }
    return request as UtilityRequest;
  }
  if (base.kind === 'generation-run') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'generation-run' }>>;
    if (!request.document || typeof request.document !== 'object' || !['illustration', 'pixel'].includes(request.document.kind)) throw new Error('Generation utility requires a canonical document.');
    if (!request.request || typeof request.request !== 'object') throw new Error('Generation utility requires a provider request.');
    if (typeof request.jobId !== 'string' || !request.jobId || request.jobId.length > 200) throw new Error('Generation utility requires a bounded job id.');
    if (request.credential !== undefined && (typeof request.credential !== 'string' || request.credential.length < 1 || request.credential.length > 8_192)) throw new Error('Generation utility credential is invalid.');
    if (Buffer.byteLength(JSON.stringify(request.request), 'utf8') > 2 * 1024 * 1024) throw new Error('Generation utility request exceeds 2 MiB.');
    validateGenerationRequest(request.document, request.request);
    if (request.e2eResultFixture !== undefined && (!isFnd09GenerationResultFixture(request.e2eResultFixture)
      || !isFnd09GenerationResultE2eEnabled({ nodeEnv: process.env.NODE_ENV, enabled: process.env.AIDRAW_E2E_UTILITY_GENERATION_RESULT })
      || request.credential !== undefined
      || !isFnd09GenerationResultRequest(request.request))) {
      throw new Error('The generation-result probe is unavailable outside isolated packaged QA.');
    }
    return request as UtilityRequest;
  }
  if (base.kind === 'normalize-generation-acceptance') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'normalize-generation-acceptance' }>>;
    assertNormalizeGenerationAcceptanceInput(request.output);
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
    if (request.e2eCorruptIdat !== undefined && (request.e2eCorruptIdat !== true || !isFnd09ObservationCodecE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_OBSERVATION_CODEC,
    }))) {
      throw new Error('The observation codec probe is unavailable outside isolated packaged QA.');
    }
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
    if (request.e2eResultFault !== undefined && (!isFnd09ImportResultFault(request.e2eResultFault) || !isFnd09ImportResultE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_IMPORT_RESULT,
    }) || request.pixelMode || request.spriteSheet !== undefined)) {
      throw new Error('The import-result probe is unavailable outside isolated packaged QA.');
    }
    return request as UtilityRequest;
  }
  if (base.kind === 'export-document') {
    const request = value as Partial<Extract<UtilityRequest, { kind: 'export-document' }>>;
    if (!request.document || typeof request.document !== 'object' || !['illustration', 'pixel'].includes(request.document.kind)) throw new Error('Export utility requires a canonical document.');
    if (typeof request.format !== 'string' || !['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'gif', 'apng', 'sprite-sheet', 'tiled-json', 'tiled-xml'].includes(request.format)) throw new Error('Unsupported export format.');
    if (request.e2eArtifactFault !== undefined && (!isFnd09ExportResultFault(request.e2eArtifactFault) || !isFnd09ExportResultE2eEnabled({
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.AIDRAW_E2E_UTILITY_EXPORT_RESULT,
    }) || request.format !== 'sprite-sheet')) {
      throw new Error('The export-result probe is unavailable outside isolated packaged QA.');
    }
    return request as UtilityRequest;
  }
  const request = value as Partial<Extract<UtilityRequest, { kind: 'quantize-image' }>>;
  if (typeof request.encodedBase64 !== 'string' || request.encodedBase64.length > MAX_QUANTIZE_UTILITY_BASE64_CHARACTERS) throw new Error('Encoded image exceeds the utility input limit.');
  assertQuantizeUtilityParameters(request);
  if (request.e2eResultFault !== undefined && (!isFnd09QuantizationResultFault(request.e2eResultFault) || !isFnd09QuantizationResultE2eEnabled({
    nodeEnv: process.env.NODE_ENV,
    enabled: process.env.AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT,
  }))) {
    throw new Error('The quantization-result probe is unavailable outside isolated packaged QA.');
  }
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
      if (request.kind === 'validate-image') {
        const decoded = await validateUtilityImage(
          Buffer.from(request.encodedBase64, 'base64'),
          { mimeType: request.mimeType, width: request.width, height: request.height },
        );
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, ...decoded } satisfies UtilityResponse);
      } else if (request.kind === 'containment-probe') {
        if (request.mode === 'crash') setTimeout(() => process.crash(), 100);
        if (request.mode === 'crash' || request.mode === 'hang') await new Promise<never>(() => undefined);
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind } satisfies UtilityResponse);
      } else if (request.kind === 'quantize-image') {
        const actualChanges = await quantizeImageToPalette(
          Buffer.from(request.encodedBase64, 'base64'),
          request.width,
          request.height,
          request.palette,
          request.options,
        );
        if (request.e2eResultFault && (actualChanges.length !== 1 || actualChanges[0].x !== 0 || actualChanges[0].y !== 0 || actualChanges[0].index !== 1)) {
          throw new Error('The quantization-result probe requires the exact valid real-quantizer baseline.');
        }
        const changes = request.e2eResultFault
          ? createFnd09InvalidQuantizationResult(request.e2eResultFault)
          : actualChanges;
        if (request.e2eResultFault) await new Promise((resolveWait) => setTimeout(resolveWait, FND09_QUANTIZATION_RESULT_E2E_HOLD_MS));
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, changes } satisfies UtilityResponse);
      } else if (request.kind === 'export-document') {
        const { exportDocument } = await import('./export-document');
        const artifact = await exportDocument(request.document, request.format, request.options);
        const actualSerialized: SerializedExportArtifact = {
          dataBase64: artifact.data.toString('base64'),
          mimeType: artifact.mimeType,
          extension: artifact.extension,
          report: artifact.report,
          companion: artifact.companion ? { dataBase64: artifact.companion.data.toString('base64'), extension: artifact.companion.extension, mimeType: artifact.companion.mimeType, name: artifact.companion.name } : undefined,
          companions: artifact.companions?.map((companion) => ({ dataBase64: companion.data.toString('base64'), extension: companion.extension, mimeType: companion.mimeType, name: companion.name })),
        };
        const serialized = request.e2eArtifactFault
          ? createFnd09InvalidExportArtifact(actualSerialized, request.e2eArtifactFault)
          : actualSerialized;
        if (request.e2eArtifactFault) await new Promise((resolveWait) => setTimeout(resolveWait, FND09_EXPORT_RESULT_E2E_HOLD_MS));
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, artifact: serialized } satisfies UtilityResponse);
      } else if (request.kind === 'import-document') {
        const imported = await runImportUtilityRequest(request);
        assertImportUtilityResponseEnvelope(request, { kind: request.kind, documents: imported.documents, warnings: imported.warnings });
        const returned = request.e2eResultFault
          ? createFnd09InvalidImportResult(imported, request.e2eResultFault)
          : imported;
        if (request.e2eResultFault) await new Promise((resolveWait) => setTimeout(resolveWait, FND09_IMPORT_RESULT_E2E_HOLD_MS));
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, documents: returned.documents, warnings: returned.warnings } as unknown as UtilityResponse);
      } else if (request.kind === 'capture-observation') {
        const { captureObservation } = await import('./capture-observation');
        let result = await captureObservation(request.document, request.request, request.maxPixels);
        if (request.e2eCorruptIdat) {
          if (result.available !== true || typeof result.data !== 'string') throw new Error('The observation codec probe requires one available PNG result.');
          result = { ...result, data: corruptFnd09ObservationIdat(result.data) };
          await new Promise((resolveWait) => setTimeout(resolveWait, FND09_OBSERVATION_CODEC_E2E_HOLD_MS));
        }
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, result } satisfies UtilityResponse);
      } else if (request.kind === 'normalize-generation-acceptance') {
        const { normalizeGeneratedOutputForAcceptance } = await import('./normalize-generation-output');
        const result = await normalizeGeneratedOutputForAcceptance(request.output);
        const fixture = resolveFnd09GenerationNormalizationE2eFromEnvironment();
        if (fixture) await writeFnd09GenerationNormalizationE2eProbe(fixture, request.output, result);
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, result } satisfies UtilityResponse);
      } else {
        const controller = generationController ?? new AbortController();
        let outputs: unknown[];
        if (request.e2eResultFixture) {
          outputs = createFnd09GenerationResultOutputs(request.request, request.e2eResultFixture);
        } else {
          const { runGenerationProvider } = await import('./generation-provider-runner');
          outputs = await runGenerationProvider(request, { signal: controller.signal, onProgress: (progress, message) => {
            const response = { id, ok: true, kind: 'generation-progress' as const, progress, message };
            if (isGenerationProgressUtilityResponse(request, response)) process.parentPort!.postMessage(response satisfies UtilityResponse);
          } });
        }
        if (request.e2eResultFixture !== undefined && request.e2eResultFixture !== 'valid') {
          await new Promise((resolveWait) => setTimeout(resolveWait, FND09_GENERATION_RESULT_E2E_HOLD_MS));
        }
        process.parentPort!.postMessage({ id, ok: true, kind: request.kind, outputs } as unknown as UtilityResponse);
      }
    } catch (error) {
      process.parentPort!.postMessage({ id, ok: false, error: { code: 'utility_failed', message: boundedUtilityErrorMessage(error) } } satisfies UtilityResponse);
    } finally {
      if (generationController) generationControllers.delete(id);
    }
  })();
});
