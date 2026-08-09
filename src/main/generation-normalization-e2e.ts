import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { crc32, deflateSync } from 'node:zlib';
import type { GenerationRequest } from '../common/generation';
import type { GenerationProviderRunner } from './generation-provider-runner';
import { MAX_INLINE_ASSET_BYTES, MAX_INLINE_IMAGE_PIXELS } from './transaction-policy';
import {
  FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX,
  FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE,
  resolveFnd09GenerationNormalizationE2eConfiguration,
  type Fnd09GenerationNormalizationE2eConfiguration,
} from './generation-normalization-e2e-contract';

export {
  FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX,
  FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE,
  resolveFnd09GenerationNormalizationE2eConfiguration,
  type Fnd09GenerationNormalizationE2eConfiguration,
};

export const FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME = 'FND-09 Generated Preview Normalization';
export const FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID = 'fnd09-normalizable-preview';
export const FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID = 'fnd09-preview-only-preview';
export const FND09_GENERATION_NORMALIZATION_E2E_APPROVAL_TIMEOUT_MS = 60_000;
export const FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS = { width: 8_192, height: 2_049 } as const;

export const FND09_GENERATION_NORMALIZATION_E2E_REQUEST = {
  provider: 'stability',
  mode: 'create',
  prompt: 'Exercise deterministic generated-preview acceptance normalization without a provider call.',
  negativePrompt: 'network, paid request, credential',
  sourceAssetIds: [],
  size: 'auto',
  aspectIntent: 'canvas',
  resultCount: 2,
  seed: 314159,
  providerOptions: { stylePreset: 'digital-art' },
} as const satisfies Omit<GenerationRequest, 'documentId'>;

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, chunk.byteLength - 4);
  return chunk;
}

function appendAncillaryPadding(png: Buffer): Buffer {
  const targetBytes = MAX_INLINE_ASSET_BYTES + 4_096;
  const payload = Buffer.alloc(targetBytes - png.byteLength - 12, 0x5a);
  return Buffer.concat([png.subarray(0, -12), pngChunk('raNd', payload), png.subarray(-12)]);
}

function normalizableOutput(): Buffer {
  const canvas = createCanvas(64, 48);
  const context = canvas.getContext('2d');
  context.fillStyle = '#28354f'; context.fillRect(0, 0, 64, 48);
  context.fillStyle = '#e6738f'; context.fillRect(8, 8, 48, 32);
  context.fillStyle = '#ffda8a'; context.fillRect(16, 14, 32, 20);
  context.fillStyle = '#52c2b5'; context.fillRect(24, 18, 16, 12);
  return appendAncillaryPadding(canvas.toBuffer('image/png'));
}

function previewOnlyOutput(): Buffer {
  const { width, height } = FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS;
  if (width * height <= MAX_INLINE_IMAGE_PIXELS) throw new Error('The fixed preview-only geometry no longer exceeds the editable-asset budget.');
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) raw.fill(y % 2 === 0 ? 0x55 : 0xaa, y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 1; header[9] = 0; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Blocks unexpected non-loopback Node fetches for the exact isolated fixture. */
export function installFnd09GenerationNormalizationE2eNetworkBoundary(configuration: Fnd09GenerationNormalizationE2eConfiguration): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return originalFetch(input, init);
    const sentinel = { version: 1, blocked: true, protocol: url.protocol, hostname: url.hostname, nonLoopbackRequests: 1, externalProviderRequests: 1, paidRequests: 0 };
    await writeFile(configuration.networkSentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    throw new Error('The isolated FND-09 generation-normalization fixture blocked a non-loopback request.');
  };
  return () => { globalThis.fetch = originalFetch; };
}

function assertFixtureRequest(input: Parameters<GenerationProviderRunner>[0]): void {
  if (input.credential !== undefined) throw new Error('The isolated FND-09 normalization runner refuses provider credentials.');
  if (input.document.kind !== 'illustration' || input.document.name !== FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME || input.request.documentId !== input.document.id) {
    throw new Error('The isolated FND-09 normalization runner received an unexpected document.');
  }
  const expected = { documentId: input.document.id, ...FND09_GENERATION_NORMALIZATION_E2E_REQUEST };
  if (JSON.stringify(input.request) !== JSON.stringify(expected)) throw new Error('The isolated FND-09 normalization runner received an unexpected request payload.');
}

export function createFnd09GenerationNormalizationE2eRunner(configuration: Fnd09GenerationNormalizationE2eConfiguration): GenerationProviderRunner {
  return async (input, control) => {
    assertFixtureRequest(input);
    if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
    control.onProgress?.(0.25, 'Preparing deterministic local previews…');
    const normalizable = normalizableOutput();
    const previewOnly = previewOnlyOutput();
    await writeFile(configuration.normalizableOutputPath, normalizable, { flag: 'wx', mode: 0o600 });
    await writeFile(configuration.previewOnlyOutputPath, previewOnly, { flag: 'wx', mode: 0o600 });
    if (control.signal.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const audit = {
      version: 1,
      fixture: 'fnd09-generated-preview-acceptance-normalization',
      transport: 'in-process-deterministic-runner',
      invocationCount: 1,
      requestSha256: sha256(Buffer.from(JSON.stringify(input.request), 'utf8')),
      outputs: [
        { id: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID, file: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE, byteLength: normalizable.byteLength, sha256: sha256(normalizable), width: 64, height: 48 },
        { id: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID, file: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE, byteLength: previewOnly.byteLength, sha256: sha256(previewOnly), ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS },
      ],
      hostedKeyReceived: false,
      nonLoopbackRequests: 0,
      externalProviderRequests: 0,
      paidRequests: 0,
    };
    await writeFile(configuration.auditPath, `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    control.onProgress?.(0.9, 'Finalizing deterministic local previews…');
    return [
      {
        id: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID,
        mimeType: 'image/png',
        data: normalizable.toString('base64'),
        width: 64,
        height: 48,
        seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed,
        providerMetadata: { fixture: 'fnd09-generation-normalization', transport: 'deterministic-local', nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      },
      {
        id: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID,
        mimeType: 'image/png',
        data: previewOnly.toString('base64'),
        ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS,
        seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed + 1,
        providerMetadata: { fixture: 'fnd09-generation-normalization', transport: 'deterministic-local', nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
      },
    ];
  };
}
