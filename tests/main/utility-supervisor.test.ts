import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument, createPixelDocument, type PaletteEntry } from '@aidraw/core';
import { MAX_QUEUED_UTILITY_TASKS, RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';
import { MAX_EXPORT_UTILITY_MEMBERS, MAX_GENERATED_OUTPUT_BYTES, MAX_GENERATION_PROGRESS_MESSAGE_BYTES, MAX_GENERATION_PROVIDER_METADATA_BYTES, MAX_IMPORT_UTILITY_DOCUMENTS, MAX_OBSERVATION_PNG_BYTES, MAX_OBSERVATION_UTILITY_RESULT_SERIALIZED_BYTES, MAX_QUANTIZE_UTILITY_BASE64_CHARACTERS, MAX_QUANTIZE_UTILITY_SOURCE_BYTES, MAX_UTILITY_ERROR_MESSAGE_BYTES, MAX_UTILITY_REPORT_SERIALIZED_BYTES, MAX_UTILITY_TEXT_BYTES, assertExportUtilityResponse, generationApprovalPreviewDimensions, type UtilityResponse } from '@main/utility-contract';
import type { GeneratedOutput, GenerationRequest } from '../../src/common/generation';
import { normalizeGeneratedOutputForAcceptance } from '../../src/main/normalize-generation-output';
import { renderUtilityImagePreview, validateUtilityImage } from '../../src/main/utility-image-validation';

class FakeUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;
  readonly pid = Math.floor(Math.random() * 10_000) + 1;

  postMessage(message: unknown): void { this.messages.push(message); }
  kill(): boolean { this.killed = true; return true; }
  respond(response: UtilityResponse | Record<string, unknown>): void { this.emit('message', response); }
  exit(code: number): void { this.emit('exit', code); }
}

const palette: PaletteEntry[] = [
  { id: 'transparent', name: 'Transparent', color: '#00000000' },
  { id: 'ink', name: 'Ink', color: '#111111ff' },
];

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function observationPng(width: number, height: number): string {
  return createCanvas(width, height).toBuffer('image/png').toString('base64');
}

function importedDocumentWithPng(name: string) {
  const document = createIllustrationDocument(name);
  const bytes = createCanvas(2, 3).toBuffer('image/png');
  const assetId = 'imported-image';
  document.assets[assetId] = {
    id: assetId,
    name: 'Imported image',
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: 'imported',
    data: bytes.toString('base64'),
  };
  return { document, bytes };
}

function observationPngWithCorruptIdat(width: number, height: number): string {
  const bytes = Buffer.from(observationPng(width, height), 'base64');
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (bytes.toString('ascii', typeStart, dataStart) === 'IDAT' && chunkLength > 0) {
      bytes[dataStart] ^= 0xff;
      bytes.writeUInt32BE(crc32(bytes.subarray(typeStart, dataEnd)) >>> 0, dataEnd);
      return bytes.toString('base64');
    }
    offset = dataEnd + 4;
  }
  throw new Error('Observation PNG fixture has no image data.');
}

function validObservationResult(data = observationPng(8, 6)): Record<string, unknown> {
  return {
    available: true,
    mimeType: 'image/png',
    width: 8,
    height: 6,
    scale: 2,
    region: { x: 0, y: 0, width: 4, height: 3 },
    background: 'transparent',
    data,
  };
}

function validGeneratedOutput(overrides: Partial<GeneratedOutput> = {}): GeneratedOutput {
  return {
    id: 'result',
    mimeType: 'image/png',
    data: observationPng(2, 2),
    width: 2,
    height: 2,
    providerMetadata: { fixture: 'utility-supervisor' },
    ...overrides,
  };
}

function generatedImageData(mimeType: GeneratedOutput['mimeType']): string {
  const canvas = createCanvas(2, 2);
  canvas.getContext('2d').fillRect(0, 0, 2, 2);
  return (mimeType === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer(mimeType)).toString('base64');
}

function oversizedGeneratedOutput(): GeneratedOutput {
  const png = Buffer.from(observationPng(2, 2), 'base64'); const type = Buffer.from('raNd'); const payload = Buffer.alloc(MAX_QUANTIZE_UTILITY_SOURCE_BYTES + 129 - png.byteLength - 12, 0x5a); const chunk = Buffer.alloc(payload.byteLength + 12);
  chunk.writeUInt32BE(payload.byteLength, 0); type.copy(chunk, 4); payload.copy(chunk, 8); chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0, chunk.byteLength - 4);
  const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  return validGeneratedOutput({ id: 'oversized-preview', data: bytes.toString('base64') });
}

afterEach(() => vi.unstubAllEnvs());

describe('RasterUtilitySupervisor', () => {
  it('keeps native image decoding in the supervised lane and recovers after decoder-process exit', async () => {
    const bytes = createCanvas(2, 3).toBuffer('image/png');
    await expect(validateUtilityImage(bytes, { mimeType: 'image/png', width: 2, height: 3 })).resolves.toEqual({ width: 2, height: 3 });
    await expect(validateUtilityImage(bytes, { mimeType: 'image/png', width: 2, height: 3 }, async () => ({ width: 3, height: 2 }))).rejects.toThrow('disagree');
    const renderedPreview = await renderUtilityImagePreview(bytes, { mimeType: 'image/png', width: 2, height: 3 }, { width: 1, height: 2 });
    expect([renderedPreview.readUInt32BE(16), renderedPreview.readUInt32BE(20)]).toEqual([1, 2]);

    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const crashed = supervisor.validateImage(bytes, { mimeType: 'image/png', width: 2, height: 3 });
    const recovered = supervisor.validateImage(bytes, { mimeType: 'image/png', width: 2, height: 3 });
    await nextTurn();
    expect(workers[0].messages).toHaveLength(1);
    expect(workers[0].messages[0]).toMatchObject({ kind: 'validate-image', mimeType: 'image/png', width: 2, height: 3 });
    workers[0].exit(139);
    await expect(crashed).rejects.toThrow('exited unexpectedly with code 139');

    await nextTurn();
    const request = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: request.id, ok: true, kind: 'validate-image', width: 2, height: 3 });
    await expect(recovered).resolves.toBeUndefined();
    expect(fork).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });

  it('admits generation approval thumbnails only after exact static-PNG validation and fresh-worker recovery', async () => {
    expect(generationApprovalPreviewDimensions(360, 120)).toEqual({ width: 180, height: 60 });
    expect(generationApprovalPreviewDimensions(90, 240)).toEqual({ width: 45, height: 120 });
    expect(generationApprovalPreviewDimensions(2, 3)).toEqual({ width: 2, height: 3 });
    const { document } = importedDocumentWithPng('Approval preview source');
    const asset = document.assets['imported-image'];
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const malformed = supervisor.renderGenerationApprovalPreview(asset);
    const recovered = supervisor.renderGenerationApprovalPreview(asset);
    await nextTurn();
    const firstRequest = workers[0].messages[0] as Record<string, any>;
    expect(firstRequest).toMatchObject({
      kind: 'render-generation-approval-preview', mimeType: 'image/png', width: 2, height: 3,
      previewWidth: 2, previewHeight: 3,
    });
    workers[0].respond({
      id: firstRequest.id, ok: true, kind: 'render-generation-approval-preview',
      previewDataBase64: observationPng(3, 3),
    });
    await expect(malformed).rejects.toThrow('malformed generation approval preview PNG');
    expect(workers[0].killed).toBe(true);
    await nextTurn();
    const secondRequest = workers[1].messages[0] as Record<string, any>;
    const previewDataBase64 = observationPng(2, 3);
    workers[1].respond({
      id: secondRequest.id, ok: true, kind: 'render-generation-approval-preview', previewDataBase64,
    });
    await expect(recovered).resolves.toEqual({
      width: 2, height: 3, previewPng: Buffer.from(previewDataBase64, 'base64'),
    });
  });

  it('rejects a contradictory image-validation result and retires that worker', async () => {
    const bytes = createCanvas(2, 3).toBuffer('image/png');
    const worker = new FakeUtility();
    const supervisor = new RasterUtilitySupervisor(() => worker);
    const pending = supervisor.validateImage(bytes, { mimeType: 'image/png', width: 2, height: 3 });
    await nextTurn();
    const request = worker.messages[0] as { id: string };
    worker.respond({ id: request.id, ok: true, kind: 'validate-image', width: 3, height: 2 });
    await expect(pending).rejects.toThrow('malformed image-validation result');
    expect(worker.killed).toBe(true);
    supervisor.stop();
  });

  it('rejects unsafe image geometry before starting a decoder worker', async () => {
    const header = Buffer.from(createCanvas(1, 1).toBuffer('image/png').subarray(0, 24));
    header.writeUInt32BE(8_193, 16);
    const fork = vi.fn(() => new FakeUtility());
    const supervisor = new RasterUtilitySupervisor(fork);
    await expect(supervisor.validateImage(header, { mimeType: 'image/png', width: 8_193, height: 1 })).rejects.toThrow('image safety limit');
    expect(fork).not.toHaveBeenCalled();
    supervisor.stop();
  });

  it('admits bounded sprite-sheet previews and retires malformed inspection producers before caller use', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const malformed = supervisor.inspectSpriteSheet('/tmp/sprite-sheet.png');
    const recovered = supervisor.inspectSpriteSheet('/tmp/sprite-sheet.png');
    await nextTurn();
    const firstRequest = workers[0].messages[0] as { id: string; kind: string; filePath: string };
    expect(firstRequest).toMatchObject({ kind: 'inspect-sprite-sheet', filePath: '/tmp/sprite-sheet.png' });
    workers[0].respond({
      id: firstRequest.id, ok: true, kind: 'inspect-sprite-sheet', sha256: 'a'.repeat(64), mimeType: 'image/png',
      width: 8, height: 6, previewDataBase64: observationPng(7, 6),
    });
    await expect(malformed).rejects.toThrow('malformed sprite-sheet preview');
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const secondRequest = workers[1].messages[0] as { id: string };
    const previewData = observationPng(8, 6);
    workers[1].respond({
      id: secondRequest.id, ok: true, kind: 'inspect-sprite-sheet', sha256: 'b'.repeat(64), mimeType: 'image/png',
      width: 8, height: 6, previewDataBase64: previewData,
    });
    await expect(recovered).resolves.toEqual({
      sha256: 'b'.repeat(64), mimeType: 'image/png', width: 8, height: 6,
      previewPng: Buffer.from(previewData, 'base64'),
    });
    expect(fork).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });

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
    const pending = supervisor.exportDocument(createPixelDocument('sprite', 'Worker export'), 'sprite-sheet');
    await nextTurn();
    const request = worker.messages[0] as { id: string; kind: string; document: { name: string } };
    expect(request).toMatchObject({ kind: 'export-document', document: { name: 'Worker export' } });
    const fidelity = [{ code: 'raster-fallback' as const, subjectType: 'layer' as const, subjectId: 'layer-1', subjectName: 'Paint', detail: 'Paint was rasterized.' }];
    worker.respond({ id: request.id, ok: true, kind: 'export-document', artifact: { dataBase64: Buffer.from('png').toString('base64'), mimeType: 'image/png', extension: 'png', report: { warnings: [], rasterized: [], fidelity }, companion: { dataBase64: Buffer.from('{}').toString('base64'), extension: 'json', mimeType: 'application/json' } } });
    const artifact = await pending;
    expect(artifact.data.toString()).toBe('png');
    expect(artifact.companion?.data.toString()).toBe('{}');
    expect(artifact.report.fidelity).toEqual(fidelity);
    supervisor.stop();
  });

  it('rejects unknown structured fidelity reasons and aggregate report envelopes', () => {
    const document = createIllustrationDocument('Guarded report');
    const request = { id: 'report-contract', kind: 'export-document' as const, document, format: 'png' as const, options: {} };
    const artifact = {
      dataBase64: Buffer.from('png').toString('base64'), mimeType: 'image/png', extension: 'png',
      report: { warnings: [], rasterized: [], fidelity: [{ code: 'unknown-reason', subjectType: 'layer', subjectId: 'layer-1', subjectName: 'Paint' }] },
    };
    expect(() => assertExportUtilityResponse(request, { id: request.id, ok: true, kind: request.kind, artifact })).toThrow('malformed export artifact');

    const reportEntry = 'x'.repeat(MAX_UTILITY_TEXT_BYTES - 16);
    const aggregate = { ...artifact, report: { warnings: Array(9).fill(reportEntry), rasterized: Array(9).fill(reportEntry), fidelity: [] } };
    expect(() => assertExportUtilityResponse(request, { id: request.id, ok: true, kind: request.kind, artifact: aggregate })).toThrow(`${MAX_UTILITY_REPORT_SERIALIZED_BYTES}-byte serialized limit`);
  });

  it('rejects malformed export artifact and companion envelopes before base64 coercion and recovers queued work', async () => {
    const workers = [new FakeUtility(), new FakeUtility(), new FakeUtility(), new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const document = createIllustrationDocument('Guarded export');
    let base64Coercions = 0;
    const coercionTrap = { [Symbol.toPrimitive]: () => { base64Coercions += 1; return Buffer.from('poison').toString('base64'); } };
    const validArtifact = () => ({
      dataBase64: Buffer.from('png').toString('base64'),
      mimeType: 'image/png',
      extension: 'png',
      report: { warnings: [], rasterized: [] },
    });

    const malformedArtifact = supervisor.exportDocument(document, 'png');
    const afterMalformedArtifact = supervisor.exportDocument(document, 'png');
    await nextTurn();
    const malformedArtifactRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({
      id: malformedArtifactRequest.id,
      ok: true,
      kind: 'export-document',
      artifact: { ...validArtifact(), dataBase64: coercionTrap },
    });
    await expect(malformedArtifact).rejects.toThrow('Raster utility returned a malformed export artifact.');
    expect(base64Coercions).toBe(0);
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const afterMalformedArtifactRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: afterMalformedArtifactRequest.id, ok: true, kind: 'export-document', artifact: validArtifact() });
    await expect(afterMalformedArtifact).resolves.toMatchObject({ data: Buffer.from('png'), mimeType: 'image/png', extension: 'png' });

    const malformedCompanion = supervisor.exportDocument(document, 'png');
    const afterMalformedCompanion = supervisor.exportDocument(document, 'png');
    await nextTurn();
    const malformedCompanionRequest = workers[1].messages[1] as { id: string };
    workers[1].respond({
      id: malformedCompanionRequest.id,
      ok: true,
      kind: 'export-document',
      artifact: {
        ...validArtifact(),
        companions: [{ dataBase64: Buffer.from('unexpected').toString('base64'), extension: 'png', mimeType: 'image/png', name: 'unexpected.png' }],
      },
    });
    await expect(malformedCompanion).rejects.toThrow('Raster utility returned a malformed export companion.');
    expect(base64Coercions).toBe(0);
    expect(workers[1].killed).toBe(true);

    await nextTurn();
    const afterMalformedCompanionRequest = workers[2].messages[0] as { id: string };
    workers[2].respond({ id: afterMalformedCompanionRequest.id, ok: true, kind: 'export-document', artifact: validArtifact() });
    await expect(afterMalformedCompanion).resolves.toMatchObject({ data: Buffer.from('png'), report: { warnings: [], rasterized: [] } });

    const reportEntry = 'x'.repeat(MAX_UTILITY_TEXT_BYTES - 16);
    const oversizedReport = supervisor.exportDocument(document, 'png');
    const afterOversizedReport = supervisor.exportDocument(document, 'png');
    await nextTurn();
    const oversizedReportRequest = workers[2].messages[1] as { id: string };
    workers[2].respond({ id: oversizedReportRequest.id, ok: true, kind: 'export-document', artifact: { ...validArtifact(), report: { warnings: Array(17).fill(reportEntry), rasterized: [] } } });
    await expect(oversizedReport).rejects.toThrow(`${MAX_UTILITY_REPORT_SERIALIZED_BYTES}-byte serialized limit`);
    expect(workers[2].killed).toBe(true);

    await nextTurn();
    const afterOversizedReportRequest = workers[3].messages[0] as { id: string };
    workers[3].respond({ id: afterOversizedReportRequest.id, ok: true, kind: 'export-document', artifact: validArtifact() });
    await expect(afterOversizedReport).resolves.toMatchObject({ data: Buffer.from('png'), report: { warnings: [], rasterized: [] } });

    const excessiveMembers = supervisor.exportDocument(createPixelDocument('tilemap', 'Guarded Tiled export'), 'tiled-json');
    const afterExcessiveMembers = supervisor.exportDocument(document, 'png');
    await nextTurn();
    const excessiveMembersRequest = workers[3].messages[1] as { id: string };
    const companion = { dataBase64: Buffer.from('png').toString('base64'), extension: 'png', mimeType: 'image/png', name: 'companion.png' };
    workers[3].respond({ id: excessiveMembersRequest.id, ok: true, kind: 'export-document', artifact: { dataBase64: Buffer.from('{}').toString('base64'), mimeType: 'application/json', extension: 'tmj', report: { warnings: [], rasterized: [] }, companions: Array(MAX_EXPORT_UTILITY_MEMBERS).fill(companion) } });
    await expect(excessiveMembers).rejects.toThrow(`${MAX_EXPORT_UTILITY_MEMBERS}-member limit`);
    expect(workers[3].killed).toBe(true);

    await nextTurn();
    const afterExcessiveMembersRequest = workers[4].messages[0] as { id: string };
    workers[4].respond({ id: afterExcessiveMembersRequest.id, ok: true, kind: 'export-document', artifact: validArtifact() });
    await expect(afterExcessiveMembers).resolves.toMatchObject({ data: Buffer.from('png') });
    expect(fork).toHaveBeenCalledTimes(5);
    supervisor.stop();
  });

  it('round-trips imported canonical documents through the supervised lane', async () => {
    const worker = new FakeUtility(); const supervisor = new RasterUtilitySupervisor(() => worker); const pending = supervisor.importDocument('C:\\approved\\drawing.svg', false); await nextTurn(); const request = worker.messages[0] as { id: string; kind: string; filePath: string; pixelMode: boolean }; expect(request).toMatchObject({ kind: 'import-document', filePath: 'C:\\approved\\drawing.svg', pixelMode: false }); const document = createIllustrationDocument('Imported in worker'); worker.respond({ id: request.id, ok: true, kind: 'import-document', documents: [document], warnings: ['One fallback'] }); await expect(pending).resolves.toEqual({ documents: [document], warnings: ['One fallback'] }); supervisor.stop();
  });

  it('round-trips bounded import fidelity and retires a worker that invents a reason code', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const document = createIllustrationDocument('PSD fidelity import');
    const fidelity = [{ code: 'blend-mode-substitution' as const, subjectType: 'layer' as const, subjectId: 'layer-color', subjectName: 'Color layer', detail: 'PSD blend mode "color" was imported as normal.' }];

    const accepted = supervisor.importDocument('C:\\approved\\drawing.psd', false);
    await nextTurn();
    const acceptedRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: acceptedRequest.id, ok: true, kind: 'import-document', documents: [document], warnings: ['One blend mode changed.'], fidelity });
    await expect(accepted).resolves.toEqual({ documents: [document], warnings: ['One blend mode changed.'], fidelity });

    const rejected = supervisor.importDocument('C:\\approved\\invented.psd', false);
    await nextTurn();
    const rejectedRequest = workers[0].messages[1] as { id: string };
    workers[0].respond({ id: rejectedRequest.id, ok: true, kind: 'import-document', documents: [document], warnings: [], fidelity: [{ ...fidelity[0], code: 'invented' }] });
    await expect(rejected).rejects.toThrow('malformed import fidelity reasons');
    expect(workers[0].killed).toBe(true);

    const recovered = supervisor.importDocument('C:\\approved\\recovered.svg', false);
    await nextTurn();
    const recoveredRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: recoveredRequest.id, ok: true, kind: 'import-document', documents: [document], warnings: [] });
    await expect(recovered).resolves.toEqual({ documents: [document], warnings: [] });
    supervisor.stop();
  });

  it('holds imported image documents until their embedded payloads pass supervised decode', async () => {
    const worker = new FakeUtility();
    const supervisor = new RasterUtilitySupervisor(() => worker);
    const { document } = importedDocumentWithPng('Validated imported image');
    const pending = supervisor.importDocument('C:\\approved\\image.svg', false);
    const resolved = vi.fn();
    void pending.then(resolved);
    await nextTurn();
    const importRequest = worker.messages[0] as { id: string };
    worker.respond({ id: importRequest.id, ok: true, kind: 'import-document', documents: [document], warnings: [] });
    await nextTurn();

    expect(resolved).not.toHaveBeenCalled();
    expect(worker.messages).toHaveLength(2);
    const validationRequest = worker.messages[1] as { id: string };
    expect(validationRequest).toMatchObject({ kind: 'validate-image', mimeType: 'image/png', width: 2, height: 3 });
    worker.respond({ id: validationRequest.id, ok: true, kind: 'validate-image', width: 2, height: 3 });
    await expect(pending).resolves.toEqual({ documents: [document], warnings: [] });
    expect(resolved).toHaveBeenCalledOnce();
    supervisor.stop();
  });

  it('rejects malformed imported image envelopes and resumes later imports in a fresh worker', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const { document } = importedDocumentWithPng('Malformed imported image');
    document.assets['imported-image'].sha256 = '0'.repeat(64);
    const malformed = supervisor.importDocument('C:\\approved\\malformed-image.svg', false);
    await nextTurn();
    const malformedRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: malformedRequest.id, ok: true, kind: 'import-document', documents: [document], warnings: [] });
    await expect(malformed).rejects.toThrow('Raster utility returned a malformed imported document.');
    expect(workers[0].killed).toBe(true);

    const canonical = createIllustrationDocument('Recovered import');
    const recovered = supervisor.importDocument('C:\\approved\\recovered.svg', false);
    await nextTurn();
    const recoveredRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: recoveredRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: [] });
    await expect(recovered).resolves.toEqual({ documents: [canonical], warnings: [] });
    expect(fork).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });

  it('returns no imported image document when its supervised decoder process exits', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const { document } = importedDocumentWithPng('Decoder-crash import');
    const pending = supervisor.importDocument('C:\\approved\\decoder-crash.svg', false);
    await nextTurn();
    const importRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: importRequest.id, ok: true, kind: 'import-document', documents: [document], warnings: [] });
    await nextTurn();
    expect(workers[0].messages[1]).toMatchObject({ kind: 'validate-image' });
    workers[0].exit(139);
    await expect(pending).rejects.toThrow('imported image that could not be decoded safely: Raster utility exited unexpectedly with code 139');

    const canonical = createIllustrationDocument('Import after decoder crash');
    const recovered = supervisor.importDocument('C:\\approved\\after-decoder-crash.svg', false);
    await nextTurn();
    const recoveredRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: recoveredRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: [] });
    await expect(recovered).resolves.toEqual({ documents: [canonical], warnings: [] });
    expect(fork).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });

  it('bounds and validates imported canonical documents and warnings before fresh-worker recovery', async () => {
    const workers = [new FakeUtility(), new FakeUtility(), new FakeUtility(), new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const canonical = createIllustrationDocument('Canonical import');
    const boundaryDocuments = Array.from({ length: MAX_IMPORT_UTILITY_DOCUMENTS }, (_, index) => {
      const document = createIllustrationDocument(`PDF page ${index + 1}`);
      document.id = `import-page-${index + 1}`;
      return document;
    });

    const malformedDocument = supervisor.importDocument('C:\\approved\\malformed.svg', false);
    const boundary = supervisor.importDocument('C:\\approved\\boundary.pdf', false);
    await nextTurn();
    const malformedDocumentRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({
      id: malformedDocumentRequest.id,
      ok: true,
      kind: 'import-document',
      documents: [{ ...canonical, schemaVersion: 3 }],
      warnings: [],
    });
    await expect(malformedDocument).rejects.toThrow('Raster utility returned a malformed imported document.');
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const boundaryRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: boundaryRequest.id, ok: true, kind: 'import-document', documents: boundaryDocuments, warnings: ['PDF fallback'] });
    const boundaryResult = await boundary;
    expect(boundaryResult.documents).toHaveLength(MAX_IMPORT_UTILITY_DOCUMENTS);
    expect(boundaryResult.documents.at(-1)).toMatchObject({ id: `import-page-${MAX_IMPORT_UTILITY_DOCUMENTS}`, name: `PDF page ${MAX_IMPORT_UTILITY_DOCUMENTS}`, schemaVersion: 2 });
    expect(boundaryResult.warnings).toEqual(['PDF fallback']);

    const overCount = supervisor.importDocument('C:\\approved\\over-count.pdf', false);
    const afterOverCount = supervisor.importDocument('C:\\approved\\after-over-count.svg', false);
    await nextTurn();
    const overCountRequest = workers[1].messages[1] as { id: string };
    workers[1].respond({ id: overCountRequest.id, ok: true, kind: 'import-document', documents: [...boundaryDocuments, canonical], warnings: [] });
    await expect(overCount).rejects.toThrow(`Raster utility import result must contain 1–${MAX_IMPORT_UTILITY_DOCUMENTS} documents.`);
    expect(workers[1].killed).toBe(true);

    await nextTurn();
    const afterOverCountRequest = workers[2].messages[0] as { id: string };
    workers[2].respond({ id: afterOverCountRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: [] });
    await expect(afterOverCount).resolves.toEqual({ documents: [canonical], warnings: [] });

    let warningCoercions = 0;
    const warningTrap = { [Symbol.toPrimitive]: () => { warningCoercions += 1; return 'poison warning'; } };
    const malformedWarnings = supervisor.importDocument('C:\\approved\\malformed-warnings.svg', false);
    const afterMalformedWarnings = supervisor.importDocument('C:\\approved\\after-malformed-warnings.svg', false);
    await nextTurn();
    const malformedWarningsRequest = workers[2].messages[1] as { id: string };
    workers[2].respond({ id: malformedWarningsRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: [warningTrap] });
    await expect(malformedWarnings).rejects.toThrow('Raster utility returned malformed import warnings.');
    expect(warningCoercions).toBe(0);
    expect(workers[2].killed).toBe(true);

    await nextTurn();
    const afterMalformedWarningsRequest = workers[3].messages[0] as { id: string };
    workers[3].respond({ id: afterMalformedWarningsRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: ['Recovered'] });
    await expect(afterMalformedWarnings).resolves.toEqual({ documents: [canonical], warnings: ['Recovered'] });

    const warningEntry = 'x'.repeat(MAX_UTILITY_TEXT_BYTES - 16);
    const oversizedWarnings = supervisor.importDocument('C:\\approved\\oversized-warnings.svg', false);
    const afterOversizedWarnings = supervisor.importDocument('C:\\approved\\after-oversized-warnings.svg', false);
    await nextTurn();
    const oversizedWarningsRequest = workers[3].messages[1] as { id: string };
    workers[3].respond({ id: oversizedWarningsRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: Array(17).fill(warningEntry) });
    await expect(oversizedWarnings).rejects.toThrow(`${MAX_UTILITY_REPORT_SERIALIZED_BYTES}-byte serialized limit`);
    expect(workers[3].killed).toBe(true);

    await nextTurn();
    const afterOversizedWarningsRequest = workers[4].messages[0] as { id: string };
    workers[4].respond({ id: afterOversizedWarningsRequest.id, ok: true, kind: 'import-document', documents: [canonical], warnings: ['Recovered again'] });
    await expect(afterOversizedWarnings).resolves.toEqual({ documents: [canonical], warnings: ['Recovered again'] });
    expect(fork).toHaveBeenCalledTimes(5);
    supervisor.stop();
  });

  it('round-trips bounded observation captures without exposing worker serialization', async () => {
    const worker = new FakeUtility(); const supervisor = new RasterUtilitySupervisor(() => worker); const document = createIllustrationDocument('Observed in worker');
    const pending = supervisor.captureObservation(document, { scale: 2, background: 'transparent', region: { x: 0, y: 0, width: 4, height: 3 } }, 48);
    await nextTurn();
    const request = worker.messages[0] as { id: string; kind: string; maxPixels: number; request: { scale: number }; document: { id: string } };
    expect(request).toMatchObject({ kind: 'capture-observation', maxPixels: 48, request: { scale: 2 }, document: { id: document.id } });
    const result = validObservationResult();
    worker.respond({ id: request.id, ok: true, kind: 'capture-observation', result });
    await expect(pending).resolves.toEqual(result);
    supervisor.stop();
  });

  it('rejects contradictory, over-budget, malformed-image, and unknown observation results before fresh-worker recovery', async () => {
    const workers = Array.from({ length: 6 }, () => new FakeUtility());
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const document = createIllustrationDocument('Guarded observation');
    const request = (maxPixels = 48) => supervisor.captureObservation(
      document,
      { scale: 2, background: 'transparent', region: { x: 0, y: 0, width: 4, height: 3 } },
      maxPixels,
    );

    const overPixels = request(47);
    const afterOverPixels = request();
    await nextTurn();
    const overPixelsRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: overPixelsRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(overPixels).rejects.toThrow('exceeds or contradicts its 47-pixel request contract');
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const afterOverPixelsRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: afterOverPixelsRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(afterOverPixels).resolves.toEqual(validObservationResult());

    const overBytes = request();
    const afterOverBytes = request();
    await nextTurn();
    const overBytesRequest = workers[1].messages[1] as { id: string };
    const oversizedPngEnvelope = Buffer.alloc(MAX_OBSERVATION_PNG_BYTES + 1).toString('base64');
    workers[1].respond({ id: overBytesRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult(oversizedPngEnvelope) });
    await expect(overBytes).rejects.toThrow(`${MAX_OBSERVATION_PNG_BYTES}-byte PNG limit`);
    expect(workers[1].killed).toBe(true);

    await nextTurn();
    const afterOverBytesRequest = workers[2].messages[0] as { id: string };
    workers[2].respond({ id: afterOverBytesRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(afterOverBytes).resolves.toEqual(validObservationResult());

    const mismatchedImage = request();
    const afterMismatchedImage = request();
    await nextTurn();
    const mismatchedImageRequest = workers[2].messages[1] as { id: string };
    workers[2].respond({ id: mismatchedImageRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult(observationPng(7, 6)) });
    await expect(mismatchedImage).rejects.toThrow('malformed observation image');
    expect(workers[2].killed).toBe(true);

    await nextTurn();
    const afterMismatchedImageRequest = workers[3].messages[0] as { id: string };
    workers[3].respond({ id: afterMismatchedImageRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(afterMismatchedImage).resolves.toEqual(validObservationResult());

    const unknownDiscriminant = request();
    const afterUnknownDiscriminant = request();
    await nextTurn();
    const unknownDiscriminantRequest = workers[3].messages[1] as { id: string };
    workers[3].respond({ id: unknownDiscriminantRequest.id, ok: true, kind: 'capture-observation', result: { error: 'unknown_observation_error' } });
    await expect(unknownDiscriminant).rejects.toThrow('malformed observation result');
    expect(workers[3].killed).toBe(true);

    await nextTurn();
    const afterUnknownDiscriminantRequest = workers[4].messages[0] as { id: string };
    workers[4].respond({ id: afterUnknownDiscriminantRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(afterUnknownDiscriminant).resolves.toEqual(validObservationResult());

    const oversizedResult = request();
    const afterOversizedResult = request();
    await nextTurn();
    const oversizedResultRequest = workers[4].messages[1] as { id: string };
    workers[4].respond({ id: oversizedResultRequest.id, ok: true, kind: 'capture-observation', result: { error: 'invalid_observation_target', message: 'x'.repeat(MAX_OBSERVATION_UTILITY_RESULT_SERIALIZED_BYTES) } });
    await expect(oversizedResult).rejects.toThrow(`${MAX_OBSERVATION_UTILITY_RESULT_SERIALIZED_BYTES}-byte serialized limit`);
    expect(workers[4].killed).toBe(true);

    await nextTurn();
    const afterOversizedResultRequest = workers[5].messages[0] as { id: string };
    workers[5].respond({ id: afterOversizedResultRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(afterOversizedResult).resolves.toEqual(validObservationResult());

    const boundedError = request(47);
    await nextTurn();
    const boundedErrorRequest = workers[5].messages[1] as { id: string };
    const boundedErrorResult = {
      error: 'observation_too_large',
      requested: { width: 8, height: 6, pixels: 48 },
      limit: { pixels: 47 },
      guidance: 'Request a smaller region or scale.',
    };
    workers[5].respond({ id: boundedErrorRequest.id, ok: true, kind: 'capture-observation', result: boundedErrorResult });
    await expect(boundedError).resolves.toEqual(boundedErrorResult);
    expect(fork).toHaveBeenCalledTimes(6);
    supervisor.stop();
  });

  it('rejects a CRC-valid observation with undecodable image data and recovers queued work', async () => {
    const workers = [new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const document = createIllustrationDocument('Codec-guarded observation');
    const request = () => supervisor.captureObservation(
      document,
      { scale: 2, background: 'transparent', region: { x: 0, y: 0, width: 4, height: 3 } },
      48,
    );
    const undecodable = request();
    const recovery = request();
    await nextTurn();
    const badRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: badRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult(observationPngWithCorruptIdat(8, 6)) });
    await expect(undecodable).rejects.toThrow('undecodable observation image');
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const recoveryRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: recoveryRequest.id, ok: true, kind: 'capture-observation', result: validObservationResult() });
    await expect(recovery).resolves.toEqual(validObservationResult());
    expect(fork).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });

  it('relays generation progress and returns provider outputs on a separate supervised request', async () => {
    const worker = new FakeUtility(); const supervisor = new RasterUtilitySupervisor(() => worker); const document = createIllustrationDocument('Generated in worker'); const progress = vi.fn();
    const request = { documentId: document.id, provider: 'openai' as const, mode: 'create' as const, prompt: 'A brass turkey locomotive', sourceAssetIds: [], size: 'auto' as const, resultCount: 1, providerOptions: {} };
    const pending = supervisor.generate('generation-job', document, request, undefined, { onProgress: progress });
    await nextTurn();
    const message = worker.messages[0] as { id: string; kind: string; jobId: string };
    expect(message).toMatchObject({ kind: 'generation-run', jobId: 'generation-job' });
    worker.respond({ id: message.id, ok: true, kind: 'generation-progress', progress: 0.42, message: 'Rendering' });
    expect(progress).toHaveBeenCalledWith(0.42, 'Rendering');
    const output = validGeneratedOutput();
    worker.respond({ id: message.id, ok: true, kind: 'generation-run', outputs: [output] });
    await expect(pending).resolves.toEqual([output]);

    const empty = supervisor.generate('empty-generation-job', document, request, undefined);
    await nextTurn();
    const emptyMessage = worker.messages[1] as { id: string };
    worker.respond({ id: emptyMessage.id, ok: true, kind: 'generation-run', outputs: [] });
    await expect(empty).resolves.toEqual([]);

    const formatsRequest: GenerationRequest = { ...request, provider: 'comfyui', resultCount: 2, providerOptions: { workflow: {} } };
    const formats = supervisor.generate('format-generation-job', document, formatsRequest, undefined);
    await nextTurn();
    const formatsMessage = worker.messages[2] as { id: string };
    const formatOutputs = [
      validGeneratedOutput({ id: 'jpeg-result', mimeType: 'image/jpeg', data: generatedImageData('image/jpeg') }),
      validGeneratedOutput({ id: 'webp-result', mimeType: 'image/webp', data: generatedImageData('image/webp') }),
    ];
    worker.respond({ id: formatsMessage.id, ok: true, kind: 'generation-run', outputs: formatOutputs });
    await expect(formats).resolves.toEqual(formatOutputs);
    supervisor.stop();
  });

  it('keeps malformed and cross-lane generation progress out of caller state without aborting terminal work', async () => {
    const worker = new FakeUtility(); const fork = vi.fn(() => worker); const supervisor = new RasterUtilitySupervisor(fork); const document = createIllustrationDocument('Guarded progress'); const progress = vi.fn();
    const request: GenerationRequest = { documentId: document.id, provider: 'openai', mode: 'create', prompt: 'A deterministic progress contract', sourceAssetIds: [], size: 'auto', resultCount: 1, providerOptions: {} };
    const pending = supervisor.generate('progress-contract-job', document, request, undefined, { onProgress: progress });
    await nextTurn();
    const generationRequest = worker.messages[0] as { id: string };
    let coercions = 0;
    worker.respond({ id: generationRequest.id, ok: true, kind: 'generation-progress', progress: Number.POSITIVE_INFINITY, message: { toString: () => { coercions += 1; return 'must-not-coerce'; } } });
    expect(progress).not.toHaveBeenCalled(); expect(coercions).toBe(0); expect(worker.killed).toBe(false);
    worker.respond({ id: generationRequest.id, ok: true, kind: 'generation-progress', progress: 0.2, message: 'x'.repeat(MAX_GENERATION_PROGRESS_MESSAGE_BYTES + 1) });
    expect(progress).not.toHaveBeenCalled(); expect(worker.killed).toBe(false);
    worker.respond({ id: generationRequest.id, ok: true, kind: 'generation-progress', progress: 0.25, message: 'Rendering locally' });
    expect(progress).toHaveBeenCalledTimes(1); expect(progress).toHaveBeenLastCalledWith(0.25, 'Rendering locally');
    const output = validGeneratedOutput(); worker.respond({ id: generationRequest.id, ok: true, kind: 'generation-run', outputs: [output] });
    await expect(pending).resolves.toEqual([output]);

    const quantized = supervisor.quantizeImage(Buffer.from('wrong-lane-progress'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    await nextTurn();
    const quantizeRequest = worker.messages.at(-1) as { id: string };
    worker.respond({ id: quantizeRequest.id, ok: true, kind: 'generation-progress', progress: 0.75, message: 'Wrong lane' });
    expect(progress).toHaveBeenCalledTimes(1); expect(worker.killed).toBe(false);
    worker.respond({ id: quantizeRequest.id, ok: true, kind: 'quantize-image', changes: [{ x: 0, y: 0, index: 1 }] });
    await expect(quantized).resolves.toEqual([{ x: 0, y: 0, index: 1 }]);
    expect(fork).toHaveBeenCalledTimes(1);
    supervisor.stop();
  });

  it('rejects over-count, duplicate, over-byte, MIME, dimension, seed, and metadata-contradictory generation results before fresh-worker recovery', async () => {
    const workers = Array.from({ length: 8 }, () => new FakeUtility());
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const document = createIllustrationDocument('Guarded generation');
    const openAiRequest: GenerationRequest = { documentId: document.id, provider: 'openai', mode: 'create', prompt: 'A deterministic local fixture', sourceAssetIds: [], size: 'auto', resultCount: 1, providerOptions: {} };
    const stabilityRequest: GenerationRequest = { ...openAiRequest, provider: 'stability', seed: 17 };
    const start = (request: GenerationRequest) => supervisor.generate('fixture-generation-job', document, request, undefined);

    const rejectThenRecover = async (
      workerIndex: number,
      bad: Promise<GeneratedOutput[]>,
      recovery: Promise<GeneratedOutput[]>,
      badOutputs: GeneratedOutput[],
      expectedError: string,
      recoveryOutputs: GeneratedOutput[],
    ) => {
      await nextTurn();
      const badMessage = workers[workerIndex].messages.at(-1) as { id: string };
      workers[workerIndex].respond({ id: badMessage.id, ok: true, kind: 'generation-run', outputs: badOutputs });
      await expect(bad).rejects.toThrow(expectedError);
      expect(workers[workerIndex].killed).toBe(true);
      await nextTurn();
      const recoveryMessage = workers[workerIndex + 1].messages[0] as { id: string };
      workers[workerIndex + 1].respond({ id: recoveryMessage.id, ok: true, kind: 'generation-run', outputs: recoveryOutputs });
      await expect(recovery).resolves.toEqual(recoveryOutputs);
    };

    await rejectThenRecover(
      0,
      start(openAiRequest),
      start(openAiRequest),
      [validGeneratedOutput({ id: 'one' }), validGeneratedOutput({ id: 'two' })],
      'more than the requested 1 result',
      [validGeneratedOutput()],
    );

    const twoResultRequest = { ...openAiRequest, resultCount: 2 };
    await rejectThenRecover(
      1,
      start(twoResultRequest),
      start(openAiRequest),
      [validGeneratedOutput({ id: 'duplicate' }), validGeneratedOutput({ id: 'duplicate' })],
      'malformed result',
      [validGeneratedOutput()],
    );

    let oversizedData = Buffer.alloc(MAX_GENERATED_OUTPUT_BYTES + 1).toString('base64');
    await rejectThenRecover(
      2,
      start(openAiRequest),
      start(openAiRequest),
      [validGeneratedOutput({ data: oversizedData })],
      `${MAX_GENERATED_OUTPUT_BYTES}-byte limit`,
      [validGeneratedOutput()],
    );
    oversizedData = '';

    await rejectThenRecover(
      3,
      start(openAiRequest),
      start(openAiRequest),
      [validGeneratedOutput({ mimeType: 'image/jpeg' })],
      'malformed image result',
      [validGeneratedOutput()],
    );

    await rejectThenRecover(
      4,
      start(openAiRequest),
      start(openAiRequest),
      [validGeneratedOutput({ width: 3 })],
      'malformed image result',
      [validGeneratedOutput()],
    );

    await rejectThenRecover(
      5,
      start(stabilityRequest),
      start(stabilityRequest),
      [validGeneratedOutput({ seed: 99 })],
      'malformed result',
      [validGeneratedOutput({ seed: 17 })],
    );

    await rejectThenRecover(
      6,
      start(openAiRequest),
      start(openAiRequest),
      [validGeneratedOutput({ providerMetadata: { payload: 'x'.repeat(MAX_GENERATION_PROVIDER_METADATA_BYTES) } })],
      `${MAX_GENERATION_PROVIDER_METADATA_BYTES}-byte serialized limit`,
      [validGeneratedOutput()],
    );
    expect(fork).toHaveBeenCalledTimes(8);
    supervisor.stop();
  });

  it('rejects contradictory normalized acceptance provenance before queued work recovers through a fresh worker', async () => {
    const output = oversizedGeneratedOutput(); const prepared = await normalizeGeneratedOutputForAcceptance(output);
    if (prepared.status !== 'ready' || !prepared.normalization) throw new Error('Expected normalized fixture');
    const workers = [new FakeUtility(), new FakeUtility()]; const fork = vi.fn(() => workers[fork.mock.calls.length - 1]); const supervisor = new RasterUtilitySupervisor(fork);
    const invalid = supervisor.normalizeGeneratedOutput(output); const recovery = supervisor.normalizeGeneratedOutput(output); await nextTurn();
    const invalidRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: invalidRequest.id, ok: true, kind: 'normalize-generation-acceptance', result: { ...prepared, normalization: { ...prepared.normalization, acceptedByteLength: prepared.normalization.acceptedByteLength + 1 } } });
    await expect(invalid).rejects.toThrow('contradictory generation normalization provenance'); expect(workers[0].killed).toBe(true);
    await nextTurn(); const recoveryRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: recoveryRequest.id, ok: true, kind: 'normalize-generation-acceptance', result: prepared });
    await expect(recovery).resolves.toEqual(prepared); expect(fork).toHaveBeenCalledTimes(2); supervisor.stop();
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

  it('rejects oversized quantization input before base64 amplification or worker allocation', async () => {
    const worker = new FakeUtility();
    const fork = vi.fn(() => worker);
    const supervisor = new RasterUtilitySupervisor(fork);

    await expect(supervisor.quantizeImage(
      Buffer.alloc(MAX_QUANTIZE_UTILITY_SOURCE_BYTES + 1),
      1,
      1,
      palette,
      { alphaThreshold: 0.5, dithering: 'none' },
    )).rejects.toThrow('Encoded image exceeds the utility input limit.');
    expect(fork).not.toHaveBeenCalled();
    expect(supervisor.status()).toEqual({ running: false, pid: undefined, queued: 0, activeTaskId: undefined });

    const boundary = supervisor.quantizeImage(
      Buffer.alloc(MAX_QUANTIZE_UTILITY_SOURCE_BYTES),
      1,
      1,
      palette,
      { alphaThreshold: 0.5, dithering: 'none' },
    );
    await nextTurn();
    const request = worker.messages[0] as { id: string; encodedBase64: string };
    expect(request.encodedBase64).toHaveLength(MAX_QUANTIZE_UTILITY_BASE64_CHARACTERS);
    worker.respond({ id: request.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(boundary).resolves.toEqual([]);
    supervisor.stop();
  });

  it('rejects malformed or over-budget quantization results before caller use and restarts cleanly', async () => {
    const workers = [new FakeUtility(), new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const options = { alphaThreshold: 0.5, dithering: 'none' as const };
    let acceptedCorruptResults = 0;

    const overBudget = supervisor.quantizeImage(Buffer.from('over-budget'), 1, 1, palette, options).then((changes) => {
      acceptedCorruptResults += 1;
      return changes;
    });
    const afterOverBudget = supervisor.quantizeImage(Buffer.from('after-over-budget'), 1, 1, palette, options);
    await nextTurn();
    const overBudgetRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({
      id: overBudgetRequest.id,
      ok: true,
      kind: 'quantize-image',
      changes: [{ x: 0, y: 0, index: 1 }, { x: 0, y: 0, index: 1 }],
    });
    await expect(overBudget).rejects.toThrow('Raster utility quantization result exceeds its 1-pixel output budget.');
    expect(acceptedCorruptResults).toBe(0);
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const afterOverBudgetRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: afterOverBudgetRequest.id, ok: true, kind: 'quantize-image', changes: [{ x: 0, y: 0, index: 1 }] });
    await expect(afterOverBudget).resolves.toEqual([{ x: 0, y: 0, index: 1 }]);

    const malformed = supervisor.quantizeImage(Buffer.from('malformed'), 2, 1, palette, options).then((changes) => {
      acceptedCorruptResults += 1;
      return changes;
    });
    const afterMalformed = supervisor.quantizeImage(Buffer.from('after-malformed'), 1, 1, palette, options);
    await nextTurn();
    const malformedRequest = workers[1].messages[1] as { id: string };
    workers[1].respond({
      id: malformedRequest.id,
      ok: true,
      kind: 'quantize-image',
      changes: [{ x: 0, y: 0, index: 1 }, { x: 0, y: 0, index: 1 }],
    });
    await expect(malformed).rejects.toThrow('Raster utility returned a malformed quantization result.');
    expect(acceptedCorruptResults).toBe(0);
    expect(workers[1].killed).toBe(true);

    await nextTurn();
    const afterMalformedRequest = workers[2].messages[0] as { id: string };
    workers[2].respond({ id: afterMalformedRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(afterMalformed).resolves.toEqual([]);
    expect(fork).toHaveBeenCalledTimes(3);
    expect(supervisor.status()).toMatchObject({ running: true, queued: 0, activeTaskId: undefined });
    supervisor.stop();
  });

  it('rejects malformed worker response envelopes and restarts queued work cleanly', async () => {
    const workers = [new FakeUtility(), new FakeUtility(), new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);
    const options = { alphaThreshold: 0.5, dithering: 'none' as const };
    const malformedEnvelope = supervisor.quantizeImage(Buffer.from('malformed-envelope'), 1, 1, palette, options);
    const afterEnvelope = supervisor.quantizeImage(Buffer.from('after-malformed-envelope'), 1, 1, palette, options);

    await nextTurn();
    const malformedEnvelopeRequest = workers[0].messages[0] as { id: string };
    workers[0].respond({ id: malformedEnvelopeRequest.id, ok: 'yes' });
    await expect(malformedEnvelope).rejects.toThrow('Raster utility returned a malformed response envelope.');
    expect(workers[0].killed).toBe(true);

    await nextTurn();
    const afterEnvelopeRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: afterEnvelopeRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(afterEnvelope).resolves.toEqual([]);

    const malformedError = supervisor.quantizeImage(Buffer.from('malformed-error'), 1, 1, palette, options);
    const afterError = supervisor.quantizeImage(Buffer.from('after-malformed-error'), 1, 1, palette, options);
    await nextTurn();
    const malformedErrorRequest = workers[1].messages[1] as { id: string };
    workers[1].respond({ id: malformedErrorRequest.id, ok: false });
    await expect(malformedError).rejects.toThrow('Raster utility returned a malformed error response.');
    expect(workers[1].killed).toBe(true);

    await nextTurn();
    const afterErrorRequest = workers[2].messages[0] as { id: string };
    workers[2].respond({ id: afterErrorRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(afterError).resolves.toEqual([]);

    const oversizedError = supervisor.quantizeImage(Buffer.from('oversized-error'), 1, 1, palette, options);
    const afterOversizedError = supervisor.quantizeImage(Buffer.from('after-oversized-error'), 1, 1, palette, options);
    await nextTurn();
    const oversizedErrorRequest = workers[2].messages[1] as { id: string };
    workers[2].respond({ id: oversizedErrorRequest.id, ok: false, error: { code: 'utility_failed', message: 'x'.repeat(MAX_UTILITY_ERROR_MESSAGE_BYTES + 1) } });
    await expect(oversizedError).rejects.toThrow('Raster utility returned a malformed error response.');
    expect(workers[2].killed).toBe(true);

    await nextTurn();
    const afterOversizedErrorRequest = workers[3].messages[0] as { id: string };
    workers[3].respond({ id: afterOversizedErrorRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(afterOversizedError).resolves.toEqual([]);
    expect(fork).toHaveBeenCalledTimes(4);
    supervisor.stop();
  });

  it('bounds retained waiting work, frees capacity on cancellation, and drains admitted work in FIFO order', async () => {
    const worker = new FakeUtility();
    const fork = vi.fn(() => worker);
    const supervisor = new RasterUtilitySupervisor(fork);
    const options = { alphaThreshold: 0.5, dithering: 'none' as const };
    const active = supervisor.quantizeImage(Buffer.from('active'), 1, 1, palette, options);
    await nextTurn();

    const queued = Array.from({ length: MAX_QUEUED_UTILITY_TASKS }, (_, index) => {
      const label = `queued-${index}`;
      const controller = new AbortController();
      return { label, controller, pending: supervisor.quantizeImage(Buffer.from(label), 1, 1, palette, options, { signal: controller.signal }) };
    });
    expect(supervisor.status().queued).toBe(MAX_QUEUED_UTILITY_TASKS);

    const overflow = supervisor.quantizeImage(Buffer.from('overflow'), 1, 1, palette, options);
    await expect(overflow).rejects.toMatchObject({
      name: 'UtilityBackpressureError',
      code: 'utility_queue_full',
      retryable: true,
      message: `Utility queue reached the ${MAX_QUEUED_UTILITY_TASKS}-task waiting limit. Retry after current work completes.`,
    });
    expect(worker.messages).toHaveLength(1);

    const cancelled = queued[10];
    const cancelledResult = expect(cancelled.pending).rejects.toMatchObject({ name: 'AbortError' });
    cancelled.controller.abort();
    await cancelledResult;
    expect(supervisor.status().queued).toBe(MAX_QUEUED_UTILITY_TASKS - 1);

    const replacement = { label: 'replacement', pending: supervisor.quantizeImage(Buffer.from('replacement'), 1, 1, palette, options) };
    expect(supervisor.status().queued).toBe(MAX_QUEUED_UTILITY_TASKS);
    const admitted = [...queued.filter((item) => item !== cancelled), replacement];

    const activeRequest = worker.messages[0] as { id: string };
    worker.respond({ id: activeRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(active).resolves.toEqual([]);
    for (let index = 0; index < admitted.length; index += 1) {
      await nextTurn();
      const request = worker.messages[index + 1] as { id: string; encodedBase64: string };
      expect(Buffer.from(request.encodedBase64, 'base64').toString()).toBe(admitted[index].label);
      worker.respond({ id: request.id, ok: true, kind: 'quantize-image', changes: [] });
      await expect(admitted[index].pending).resolves.toEqual([]);
    }

    expect(worker.messages).toHaveLength(1 + MAX_QUEUED_UTILITY_TASKS);
    expect(supervisor.status()).toMatchObject({ running: true, queued: 0, activeTaskId: undefined });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(worker.killed).toBe(false);
    supervisor.stop();
  });

  it('keeps the fixed packaged containment probe unavailable by default', async () => {
    const supervisor = new RasterUtilitySupervisor(() => new FakeUtility());
    await expect(supervisor.runE2eContainmentProbe('crash')).rejects.toThrow('unavailable outside isolated packaged QA');
    expect(supervisor.status()).toEqual({ running: false, pid: undefined, queued: 0, activeTaskId: undefined });
    supervisor.stop();
  });

  it('contains the exact crash and cancellation probes before queued work restarts cleanly', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_CONTAINMENT', '1');
    const workers = [new FakeUtility(), new FakeUtility(), new FakeUtility()];
    const fork = vi.fn(() => workers[fork.mock.calls.length - 1]);
    const supervisor = new RasterUtilitySupervisor(fork);

    const crashed = supervisor.runE2eContainmentProbe('crash');
    await nextTurn();
    expect(workers[0].messages[0]).toMatchObject({ kind: 'containment-probe', mode: 'crash' });
    const afterCrash = supervisor.quantizeImage(Buffer.from('after-crash'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    workers[0].exit(9);
    await expect(crashed).rejects.toThrow('exited unexpectedly with code 9');
    await nextTurn();
    const afterCrashRequest = workers[1].messages[0] as { id: string };
    workers[1].respond({ id: afterCrashRequest.id, ok: true, kind: 'quantize-image', changes: [{ x: 0, y: 0, index: 1 }] });
    await expect(afterCrash).resolves.toEqual([{ x: 0, y: 0, index: 1 }]);

    const controller = new AbortController();
    const cancelled = supervisor.runE2eContainmentProbe('hang', { signal: controller.signal });
    await nextTurn();
    expect(workers[1].messages[1]).toMatchObject({ kind: 'containment-probe', mode: 'hang' });
    const afterCancel = supervisor.quantizeImage(Buffer.from('after-cancel'), 1, 1, palette, { alphaThreshold: 0.5, dithering: 'none' });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[1].killed).toBe(true);
    await nextTurn();
    const afterCancelRequest = workers[2].messages[0] as { id: string };
    workers[2].respond({ id: afterCancelRequest.id, ok: true, kind: 'quantize-image', changes: [] });
    await expect(afterCancel).resolves.toEqual([]);
    expect(fork).toHaveBeenCalledTimes(3);
    supervisor.stop();
  });
});
